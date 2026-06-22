/**
 * Walrus client port + HTTP implementation.
 *
 * The {@link WalrusClient} interface is the injectable seam between the
 * Evidence Service's upload lifecycle and the Walrus network. Keeping it an
 * interface lets unit tests drive the retry/status state machine with an
 * in-memory fake — no live Walrus, no real network, no 5s waits — while the
 * production path uses {@link HttpWalrusClient} to PUT bytes to the Walrus
 * Testnet publisher. (Req 10.2)
 *
 * A successful store yields a Walrus `Blob_ID`. Any other outcome (non-2xx
 * response, transport failure, unparseable body, missing blob id) throws a
 * {@link WalrusStoreError}, which the upload lifecycle treats as a failed
 * attempt eligible for bounded retry. (Req 10.6)
 */

/** Result of a successful Walrus store: the network-assigned blob identifier. */
export interface WalrusStoreResult {
  blobId: string;
}

/**
 * The seam between the evidence upload lifecycle and Walrus. Implementations
 * persist `jsonBytes` (the canonical Evidence_Bundle JSON) to Walrus and return
 * the resulting blob id. Implementations MUST throw on any failure so the
 * caller can apply its bounded-retry policy.
 */
export interface WalrusClient {
  /** Store the given bytes on Walrus, returning the assigned blob id. */
  store(jsonBytes: Uint8Array): Promise<WalrusStoreResult>;
}

/** Thrown when a Walrus store attempt fails for any reason. */
export class WalrusStoreError extends Error {
  /** Underlying error/value that caused the failure, if any. */
  readonly reason?: unknown;

  constructor(message: string, reason?: unknown) {
    super(message);
    this.name = 'WalrusStoreError';
    this.reason = reason;
  }
}

/** Minimal `fetch` shape used by {@link HttpWalrusClient} (injectable for tests). */
export type FetchLike = (
  input: string,
  init?: {
    method?: string;
    body?: Uint8Array;
    headers?: Record<string, string>;
    signal?: AbortSignal;
  },
) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

/** Options for {@link HttpWalrusClient}. */
export interface HttpWalrusClientOptions {
  /** Walrus publisher base URL (e.g. the testnet publisher). */
  publisherUrl: string;
  /** Injected fetch implementation; defaults to the global `fetch`. */
  fetchFn?: FetchLike;
  /**
   * Per-attempt timeout in ms. A single store attempt is aborted after this to
   * keep the overall upload within the conceptual 30s budget. (Req 10.2)
   */
  timeoutMs?: number;
}

/**
 * Default per-attempt store timeout. Generous enough for a healthy testnet
 * publisher while keeping a single attempt well inside the 30s budget so a
 * stuck request fails fast and frees the bounded-retry loop. (Req 10.2)
 */
const DEFAULT_STORE_TIMEOUT_MS = 20_000;

/**
 * HTTP {@link WalrusClient} that PUTs bytes to the Walrus publisher's
 * `/v1/blobs` endpoint and extracts the assigned blob id from the response.
 *
 * The Walrus publisher returns either a `newlyCreated` descriptor (first time a
 * blob is stored) or an `alreadyCertified` descriptor (the blob already
 * exists); both carry the blob id. Either shape is accepted.
 */
export class HttpWalrusClient implements WalrusClient {
  private readonly publisherUrl: string;
  private readonly fetchFn: FetchLike;
  private readonly timeoutMs: number;

  constructor(options: HttpWalrusClientOptions) {
    if (options.publisherUrl.trim() === '') {
      throw new Error('HttpWalrusClient requires a non-empty publisherUrl');
    }
    this.publisherUrl = options.publisherUrl.replace(/\/+$/, '');
    const globalFetch = (globalThis as { fetch?: FetchLike }).fetch;
    const fetchFn = options.fetchFn ?? globalFetch;
    if (fetchFn === undefined) {
      throw new Error('HttpWalrusClient requires a fetch implementation');
    }
    this.fetchFn = fetchFn;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_STORE_TIMEOUT_MS;
  }

  async store(jsonBytes: Uint8Array): Promise<WalrusStoreResult> {
    const url = `${this.publisherUrl}/v1/blobs`;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, this.timeoutMs);

    let bodyText: string;
    try {
      const res = await this.fetchFn(url, {
        method: 'PUT',
        body: jsonBytes,
        headers: { 'content-type': 'application/json' },
        signal: controller.signal,
      });
      if (!res.ok) {
        const detail = await safeText(res);
        throw new WalrusStoreError(
          `Walrus publisher returned HTTP ${res.status}${detail ? `: ${detail}` : ''}`,
        );
      }
      bodyText = await res.text();
    } catch (err) {
      if (err instanceof WalrusStoreError) {
        throw err;
      }
      throw new WalrusStoreError(`Walrus store request failed: ${errMessage(err)}`, err);
    } finally {
      clearTimeout(timer);
    }

    const blobId = parseBlobId(bodyText);
    if (blobId === null) {
      throw new WalrusStoreError(
        `Walrus publisher response did not contain a blob id: ${truncate(bodyText, 200)}`,
      );
    }
    return { blobId };
  }
}

/** Extract a blob id from a Walrus publisher JSON response, or `null`. */
function parseBlobId(body: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object') {
    return null;
  }
  const obj = parsed as Record<string, unknown>;

  // { newlyCreated: { blobObject: { blobId } } }
  const newlyCreated = obj.newlyCreated as
    | { blobObject?: { blobId?: unknown } }
    | undefined;
  const newId = newlyCreated?.blobObject?.blobId;
  if (typeof newId === 'string' && newId !== '') {
    return newId;
  }

  // { alreadyCertified: { blobId } }
  const alreadyCertified = obj.alreadyCertified as { blobId?: unknown } | undefined;
  const certifiedId = alreadyCertified?.blobId;
  if (typeof certifiedId === 'string' && certifiedId !== '') {
    return certifiedId;
  }

  // Fallback: a top-level { blobId } shape.
  if (typeof obj.blobId === 'string' && obj.blobId !== '') {
    return obj.blobId;
  }

  return null;
}

async function safeText(res: { text(): Promise<string> }): Promise<string> {
  try {
    return truncate((await res.text()).trim(), 200);
  } catch {
    return '';
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}
