/**
 * Liquidity Source — configurable order-book liquidity reader.
 *
 * The Risk Engine consumes three liquidity signals as core inputs (Req 6.1 /
 * Req 6 acceptance criterion 1): **depth**, **spread**, and **imbalance**. The
 * {@link LiquiditySource} interface abstracts *where* those values come from
 * behind a single `readLiquidity` method so the source is swappable, mirroring
 * the Oracle Adapter design:
 *
 *   - {@link DeepBookLiquiditySource} is a *best-effort* reader for Sui
 *     DeepBook. DeepBook integration is explicitly optional in the design
 *     ("DeepBook optional, otherwise demo market simulated values"), so this
 *     source reads a level-2 order book through an injectable reader (which in
 *     production would query DeepBook pools via `@mysten/sui`) and derives the
 *     three signals from it. When no reader/pool is configured for a market, or
 *     a read fails, it transparently delegates to a fallback simulated source so
 *     the worker always produces a snapshot.
 *   - {@link SimulatedLiquiditySource} produces *deterministic* values for the
 *     demo market, unit tests, and offline use, with no network dependency.
 *
 * **Type choice (documented):** depth, spread, and imbalance are plain
 * `number`s — not `bigint`s like the oracle price mantissas. This is deliberate
 * and matches the Risk Engine's `FeatureVector` liquidity fields exactly
 * (`liquidityDepth: number`, `spreadBps: number`, `imbalance: number` in
 * `src/risk/types.ts`): depth is in quote units, spread is in basis points
 * (naturally small integers), and imbalance is a fractional ratio in [-1, 1]
 * that cannot be represented by an integer `bigint`. Keeping the source aligned
 * with the consuming feature vector avoids a lossy conversion at the boundary.
 */

/**
 * A single liquidity reading for a market. Field names mirror the Risk Engine
 * `FeatureVector` so the worker can map a reading to a snapshot 1:1.
 */
export interface LiquidityReading {
  /** Available liquidity depth in quote units. Lower = riskier. */
  depth: number;
  /** Bid/ask spread in basis points. Higher = riskier. */
  spread: number;
  /** Order-book imbalance in [-1, 1]; magnitude is the risk signal. */
  imbalance: number;
}

/**
 * Reads liquidity for a market and returns its depth, spread, and imbalance.
 * (Req 6.1)
 */
export interface LiquiditySource {
  readLiquidity(marketId: string): Promise<LiquidityReading>;
}

/** Raised when a liquidity source cannot produce a reading. */
export class LiquidityReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LiquidityReadError';
  }
}

// ---------------------------------------------------------------------------
// Order-book math (pure, shared by the DeepBook source)
// ---------------------------------------------------------------------------

/** A single price level of an order book. */
export interface OrderBookLevel {
  /** Price of the level in quote units. */
  price: number;
  /** Resting quantity at this level in base units. */
  quantity: number;
}

/**
 * A level-2 order book snapshot. `bids` are descending by price (best bid
 * first), `asks` ascending (best ask first), but the derivations below do not
 * rely on the ordering beyond picking the best price on each side.
 */
export interface OrderBookSnapshot {
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
}

/**
 * Derive {@link LiquidityReading} signals from a level-2 order book.
 *
 *   - **depth**: total notional resting in the book (Σ price·quantity over both
 *     sides), in quote units.
 *   - **spread**: (bestAsk − bestBid) / mid, in basis points. Zero when either
 *     side is empty or the mid is non-positive (no meaningful spread).
 *   - **imbalance**: (bidQty − askQty) / (bidQty + askQty), in [-1, 1]. Zero
 *     when the book is empty.
 *
 * Pure and side-effect free so it can be unit-tested independently of any
 * transport. (Req 6.1)
 */
export function deriveLiquidityFromOrderBook(book: OrderBookSnapshot): LiquidityReading {
  const bidQty = sumQuantity(book.bids);
  const askQty = sumQuantity(book.asks);
  const depth = sumNotional(book.bids) + sumNotional(book.asks);

  const bestBid = bestPrice(book.bids, 'bid');
  const bestAsk = bestPrice(book.asks, 'ask');

  let spread = 0;
  if (bestBid !== undefined && bestAsk !== undefined) {
    const mid = (bestBid + bestAsk) / 2;
    if (mid > 0 && bestAsk >= bestBid) {
      spread = ((bestAsk - bestBid) / mid) * 10_000;
    }
  }

  const totalQty = bidQty + askQty;
  const imbalance = totalQty > 0 ? (bidQty - askQty) / totalQty : 0;

  return { depth, spread, imbalance };
}

function sumQuantity(levels: OrderBookLevel[]): number {
  return levels.reduce((acc, l) => acc + Math.max(0, l.quantity), 0);
}

function sumNotional(levels: OrderBookLevel[]): number {
  return levels.reduce((acc, l) => acc + Math.max(0, l.price) * Math.max(0, l.quantity), 0);
}

function bestPrice(levels: OrderBookLevel[], side: 'bid' | 'ask'): number | undefined {
  const prices = levels.map((l) => l.price).filter((p) => Number.isFinite(p) && p > 0);
  if (prices.length === 0) {
    return undefined;
  }
  return side === 'bid' ? Math.max(...prices) : Math.min(...prices);
}

// ---------------------------------------------------------------------------
// Deterministic simulated source (demo market + tests)
// ---------------------------------------------------------------------------

export interface SimulatedLiquiditySourceOptions {
  /**
   * Optional fixed readings keyed by market id. Markets not present here fall
   * back to a deterministic value derived purely from the market id.
   */
  readings?: Record<string, LiquidityReading>;
}

/**
 * Deterministic, network-free {@link LiquiditySource} for the demo market and
 * unit tests. Returns either a pre-seeded reading for a market id or a value
 * derived purely from the market id, so repeated calls for the same market
 * always yield the same reading.
 */
export class SimulatedLiquiditySource implements LiquiditySource {
  private readonly readings: Record<string, LiquidityReading>;

  constructor(options: SimulatedLiquiditySourceOptions = {}) {
    this.readings = options.readings ?? {};
  }

  async readLiquidity(marketId: string): Promise<LiquidityReading> {
    if (marketId.trim() === '') {
      throw new LiquidityReadError('marketId must be a non-empty market id');
    }
    const seeded = this.readings[marketId];
    if (seeded !== undefined) {
      return seeded;
    }
    // Derive a stable, plausible reading from a simple hash of the market id.
    const hash = stableHash(marketId);
    return {
      // Depth between ~1,000,000 and ~6,000,000 quote units.
      depth: 1_000_000 + (hash % 5_000_001),
      // Spread between 1 and 50 basis points.
      spread: 1 + (hash % 50),
      // Imbalance in [-0.5, 0.5], deterministic per market.
      imbalance: ((hash % 1001) - 500) / 1000,
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
// Best-effort DeepBook source (optional)
// ---------------------------------------------------------------------------

/**
 * Reads a level-2 order book for a DeepBook pool. In production this would wrap
 * a `@mysten/sui` client call against the pool object; it is injected so unit
 * tests never touch the network. Returning `null` signals "no book available"
 * (the source then delegates to the fallback).
 */
export type DeepBookPoolReader = (poolId: string) => Promise<OrderBookSnapshot | null>;

export interface DeepBookLiquiditySourceOptions {
  /** Fallback used when DeepBook has no pool/book for a market, or read fails. */
  fallback: LiquiditySource;
  /** Map of market id → DeepBook pool object id. Missing markets use fallback. */
  pools?: Record<string, string>;
  /** Injectable order-book reader (DeepBook via `@mysten/sui` in production). */
  reader?: DeepBookPoolReader;
  /** Optional logger for best-effort fallbacks; defaults to no-op. */
  onFallback?: (marketId: string, reason: string) => void;
}

/**
 * Best-effort DeepBook {@link LiquiditySource}. Because DeepBook is optional in
 * the design, this source never *fails* a read: if there is no reader, no pool
 * mapping for the market, the book is empty/unavailable, or the read throws, it
 * transparently delegates to the configured {@link SimulatedLiquiditySource}
 * (or any other fallback). When a pool *is* available it derives depth, spread,
 * and imbalance from the live order book via {@link deriveLiquidityFromOrderBook}.
 */
export class DeepBookLiquiditySource implements LiquiditySource {
  private readonly fallback: LiquiditySource;
  private readonly pools: Record<string, string>;
  private readonly reader: DeepBookPoolReader | undefined;
  private readonly onFallback: (marketId: string, reason: string) => void;

  constructor(options: DeepBookLiquiditySourceOptions) {
    this.fallback = options.fallback;
    this.pools = options.pools ?? {};
    this.reader = options.reader;
    this.onFallback = options.onFallback ?? (() => undefined);
  }

  async readLiquidity(marketId: string): Promise<LiquidityReading> {
    if (marketId.trim() === '') {
      throw new LiquidityReadError('marketId must be a non-empty market id');
    }

    const poolId = this.pools[marketId];
    if (this.reader === undefined || poolId === undefined) {
      this.onFallback(marketId, 'no DeepBook reader or pool configured');
      return this.fallback.readLiquidity(marketId);
    }

    let book: OrderBookSnapshot | null;
    try {
      book = await this.reader(poolId);
    } catch (err) {
      this.onFallback(marketId, `DeepBook read failed: ${errorMessage(err)}`);
      return this.fallback.readLiquidity(marketId);
    }

    if (book === null || (book.bids.length === 0 && book.asks.length === 0)) {
      this.onFallback(marketId, 'DeepBook returned an empty book');
      return this.fallback.readLiquidity(marketId);
    }

    return deriveLiquidityFromOrderBook(book);
  }
}

// ---------------------------------------------------------------------------
// Factory (configurable / swappable)
// ---------------------------------------------------------------------------

export type LiquiditySourceKind = 'deepbook' | 'simulated';

export interface CreateLiquiditySourceOptions
  extends SimulatedLiquiditySourceOptions,
    Omit<DeepBookLiquiditySourceOptions, 'fallback'> {
  kind: LiquiditySourceKind;
}

/**
 * Build a {@link LiquiditySource} for the requested kind. The `deepbook` source
 * is always backed by a {@link SimulatedLiquiditySource} fallback so it degrades
 * gracefully when DeepBook is unavailable. (Req 6.1)
 */
export function createLiquiditySource(options: CreateLiquiditySourceOptions): LiquiditySource {
  const simulated = new SimulatedLiquiditySource({ readings: options.readings });
  switch (options.kind) {
    case 'simulated':
      return simulated;
    case 'deepbook':
      return new DeepBookLiquiditySource({
        fallback: simulated,
        pools: options.pools,
        reader: options.reader,
        onFallback: options.onFallback,
      });
    default: {
      const exhaustive: never = options.kind;
      throw new LiquidityReadError(`Unknown liquidity source kind: ${String(exhaustive)}`);
    }
  }
}

/** Extract a human-readable message from an unknown thrown value. */
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
