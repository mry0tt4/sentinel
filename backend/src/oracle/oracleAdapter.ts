/**
 * Oracle Adapter — configurable price-feed reader (Pyth on Sui Testnet).
 *
 * The Risk Engine consumes oracle price, confidence, and timestamp as core
 * inputs (Req 6.1). The {@link OracleAdapter} abstracts *where* those values
 * come from behind a single `readFeed` method so the source is swappable:
 *
 *   - {@link PythOracleAdapter} reads live prices from the Pyth Hermes price
 *     service HTTP API (the off-chain price source backing Pyth on Sui
 *     Testnet). It is configured with a base URL and an injectable `fetch`
 *     implementation so unit tests never touch the network — the dedicated
 *     live integration test lives in task 8.3.
 *   - {@link MockOracleAdapter} produces *deterministic* readings for unit
 *     tests and local/demo use, with no network dependency.
 *
 * Choosing the Hermes HTTP API (rather than an on-chain Pyth SDK dependency)
 * keeps the adapter dependency-free, trivially mockable, and faithful to the
 * `{ price, confidence, timestampMs }` contract from the design.
 */

/**
 * A single oracle reading. Prices and confidence intervals are native
 * fixed-point integers (`bigint`) exactly as the design's `OracleAdapter`
 * interface specifies; the feed's exponent (typically `-8` for Pyth) is a
 * fixed property of the feed mapping and is applied by downstream consumers.
 */
export interface OracleReading {
  /** Raw fixed-point price mantissa from the feed. */
  price: bigint;
  /** Raw fixed-point confidence-interval mantissa from the feed. */
  confidence: bigint;
  /** Publish time of the reading in milliseconds since the Unix epoch. */
  timestampMs: number;
}

/**
 * Reads a price feed by its feed identifier and returns the latest price,
 * confidence interval, and publish timestamp. (Req 6.1)
 */
export interface OracleAdapter {
  readFeed(feedId: string): Promise<OracleReading>;
}

// ---------------------------------------------------------------------------
// Pyth Hermes HTTP adapter
// ---------------------------------------------------------------------------

/** Default Pyth Hermes endpoint backing Pyth price feeds on Sui Testnet. */
export const DEFAULT_HERMES_URL = 'https://hermes.pyth.network';

/**
 * Minimal subset of the WHATWG `fetch` response the adapter relies on. The
 * global `fetch`'s `Response` is structurally assignable to this, while tests
 * can supply a lightweight fake.
 */
export interface HttpResponseLike {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

/** Minimal `fetch` signature; defaults to the global `fetch` in production. */
export type FetchLike = (url: string) => Promise<HttpResponseLike>;

export interface PythOracleAdapterOptions {
  /** Hermes base URL (no trailing slash). Defaults to {@link DEFAULT_HERMES_URL}. */
  baseUrl?: string;
  /** Injectable `fetch`; defaults to the global `fetch`. */
  fetchFn?: FetchLike;
}

/** Raised when a feed response is missing, malformed, or unparseable. */
export class OracleReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OracleReadError';
  }
}

/** Shape of the relevant slice of a Hermes `parsed` price entry. */
interface HermesParsedPrice {
  id?: string;
  price?: {
    price?: string | number;
    conf?: string | number;
    expo?: number;
    publish_time?: number;
  };
}

/**
 * Reads live prices from the Pyth Hermes price service.
 *
 * Uses the Hermes v2 endpoint
 * `GET /v2/updates/price/latest?ids[]=<feedId>&parsed=true`, whose `parsed`
 * array contains, per feed, an integer `price`/`conf` mantissa, an `expo`, and
 * a `publish_time` in seconds. We map those to {@link OracleReading}, scaling
 * the publish time to milliseconds.
 */
export class PythOracleAdapter implements OracleAdapter {
  private readonly baseUrl: string;
  private readonly fetchFn: FetchLike;

  constructor(options: PythOracleAdapterOptions = {}) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_HERMES_URL).replace(/\/+$/, '');
    const fetchFn = options.fetchFn ?? (globalThis.fetch as FetchLike | undefined);
    if (fetchFn === undefined) {
      throw new OracleReadError(
        'No fetch implementation available; pass options.fetchFn to PythOracleAdapter',
      );
    }
    this.fetchFn = fetchFn;
  }

  async readFeed(feedId: string): Promise<OracleReading> {
    if (feedId.trim() === '') {
      throw new OracleReadError('feedId must be a non-empty Pyth price feed id');
    }

    const url =
      `${this.baseUrl}/v2/updates/price/latest` +
      `?ids[]=${encodeURIComponent(feedId)}&parsed=true`;

    let response: HttpResponseLike;
    try {
      response = await this.fetchFn(url);
    } catch (err) {
      throw new OracleReadError(
        `Failed to reach Pyth Hermes for feed "${feedId}": ${errorMessage(err)}`,
      );
    }

    if (!response.ok) {
      throw new OracleReadError(
        `Pyth Hermes returned HTTP ${response.status} for feed "${feedId}"`,
      );
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch (err) {
      throw new OracleReadError(
        `Pyth Hermes response for feed "${feedId}" was not valid JSON: ${errorMessage(err)}`,
      );
    }

    return parseHermesReading(body, feedId);
  }
}

/**
 * Parse a Hermes `/v2/updates/price/latest` body into an {@link OracleReading}.
 * Exported for unit testing of the parsing contract (Req 6.1) independent of
 * any HTTP transport.
 */
export function parseHermesReading(body: unknown, feedId: string): OracleReading {
  const parsed = (body as { parsed?: unknown })?.parsed;
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new OracleReadError(`Pyth Hermes returned no price data for feed "${feedId}"`);
  }

  // Match the requested feed id when present; otherwise take the first entry.
  const normalized = feedId.replace(/^0x/, '').toLowerCase();
  const entry =
    (parsed as HermesParsedPrice[]).find(
      (p) => (p.id ?? '').replace(/^0x/, '').toLowerCase() === normalized,
    ) ?? (parsed[0] as HermesParsedPrice);

  const price = entry.price;
  if (
    price === undefined ||
    price.price === undefined ||
    price.conf === undefined ||
    price.publish_time === undefined
  ) {
    throw new OracleReadError(
      `Pyth Hermes price entry for feed "${feedId}" is missing price/conf/publish_time`,
    );
  }

  let priceMantissa: bigint;
  let confMantissa: bigint;
  try {
    priceMantissa = BigInt(price.price);
    confMantissa = BigInt(price.conf);
  } catch (err) {
    throw new OracleReadError(
      `Pyth Hermes price/conf for feed "${feedId}" are not integers: ${errorMessage(err)}`,
    );
  }

  const publishTimeSec = price.publish_time;
  if (!Number.isFinite(publishTimeSec)) {
    throw new OracleReadError(
      `Pyth Hermes publish_time for feed "${feedId}" is not a finite number`,
    );
  }

  return {
    price: priceMantissa,
    confidence: confMantissa,
    timestampMs: Math.round(publishTimeSec * 1000),
  };
}

// ---------------------------------------------------------------------------
// Deterministic mock adapter (tests + local/demo)
// ---------------------------------------------------------------------------

export interface MockOracleAdapterOptions {
  /**
   * Optional fixed readings keyed by feed id. Feeds not present here fall back
   * to a deterministic value derived from the feed id and {@link baseTimeMs}.
   */
  readings?: Record<string, OracleReading>;
  /** Base publish time used for derived readings. Defaults to a fixed instant. */
  baseTimeMs?: number;
}

/**
 * Deterministic, network-free {@link OracleAdapter}. Returns either a
 * pre-seeded reading for a feed id or a value derived purely from the feed id,
 * so repeated calls for the same feed always yield the same reading — ideal for
 * unit tests and offline demos.
 */
export class MockOracleAdapter implements OracleAdapter {
  private readonly readings: Record<string, OracleReading>;
  private readonly baseTimeMs: number;

  constructor(options: MockOracleAdapterOptions = {}) {
    this.readings = options.readings ?? {};
    this.baseTimeMs = options.baseTimeMs ?? 1_700_000_000_000;
  }

  async readFeed(feedId: string): Promise<OracleReading> {
    if (feedId.trim() === '') {
      throw new OracleReadError('feedId must be a non-empty feed id');
    }
    const seeded = this.readings[feedId];
    if (seeded !== undefined) {
      return seeded;
    }
    // Derive a stable reading from a simple hash of the feed id.
    const hash = stableHash(feedId);
    return {
      price: BigInt(1_000_000 + (hash % 1_000_000)),
      confidence: BigInt(100 + (hash % 900)),
      timestampMs: this.baseTimeMs + (hash % 1000),
    };
  }
}

/** Small deterministic non-negative hash of a string. */
function stableHash(input: string): number {
  let hash = 0;
  for (let i = 0; i < input.length; i += 1) {
    hash = (hash * 31 + input.charCodeAt(i)) % 1_000_000_007;
  }
  return hash;
}

// ---------------------------------------------------------------------------
// Factory (configurable / swappable)
// ---------------------------------------------------------------------------

export type OracleAdapterKind = 'pyth' | 'mock';

export interface CreateOracleAdapterOptions
  extends PythOracleAdapterOptions,
    MockOracleAdapterOptions {
  kind: OracleAdapterKind;
}

/**
 * Build an {@link OracleAdapter} for the requested kind. Lets the worker (and
 * wiring code) choose the live Pyth adapter or the deterministic mock without
 * depending on a concrete class. (Req 6.1)
 */
export function createOracleAdapter(options: CreateOracleAdapterOptions): OracleAdapter {
  switch (options.kind) {
    case 'pyth':
      return new PythOracleAdapter(options);
    case 'mock':
      return new MockOracleAdapter(options);
    default: {
      const exhaustive: never = options.kind;
      throw new OracleReadError(`Unknown oracle adapter kind: ${String(exhaustive)}`);
    }
  }
}

/** Extract a human-readable message from an unknown thrown value. */
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
