/**
 * Liquidity Worker.
 *
 * Polls the configured {@link LiquiditySource} (DeepBook when available,
 * otherwise the demo-market simulated source) on a fixed interval and, for each
 * monitored market, reads depth/spread/imbalance and:
 *
 *   1. writes the reading to the Redis *hot-snapshot cache* so the dashboard
 *      hot path and the Risk Engine can read the freshest liquidity without
 *      touching Postgres, and
 *   2. hands the reading to a durable {@link LiquidityReadingSink}.
 *
 * **Persistence choice (documented, consistent with the Oracle Ingestion
 * Worker):** a raw liquidity reading is *not* a `risk_snapshots` row — that
 * table requires Risk Engine output (score, band, classes, rule outputs,
 * model/prompt versions) and would violate its CHECK constraints if fed a raw
 * reading. Instead the worker hands each reading to a narrow
 * `LiquidityReadingSink` port. In the fully-wired system that sink forwards
 * readings to the Risk Engine (which produces and persists the durable
 * `risk_snapshots` record), and the port also allows a lightweight durable
 * time-series store to be plugged in without changing the worker.
 *
 * Every collaborator — source, cache, sink, the poll timer, and the clock — is
 * injected, so the poll loop is fully unit-testable without a live DeepBook/RPC
 * endpoint, Redis, or Postgres.
 */

import type { LiquidityReading, LiquiditySource } from './liquiditySource.js';

/**
 * JSON-safe liquidity snapshot written to the cache and the durable sink. Field
 * names mirror the Risk Engine `FeatureVector` so downstream consumers can map
 * a snapshot to feature inputs directly. All values are finite `number`s, so
 * (unlike the oracle snapshot) no bigint→string serialization is required.
 */
export interface LiquiditySnapshot {
  marketId: string;
  /** Available liquidity depth in quote units. */
  liquidityDepth: number;
  /** Bid/ask spread in basis points. */
  spreadBps: number;
  /** Order-book imbalance in [-1, 1]. */
  imbalance: number;
  /** Wall-clock time the worker observed the reading (ms since epoch). */
  observedAtMs: number;
}

/**
 * Narrow view of the Redis hot-snapshot cache the worker needs. The concrete
 * `SnapshotCache` satisfies this; tests pass a fake.
 */
export interface SnapshotWriter {
  setLatest<T>(marketId: string, snapshot: T): Promise<void>;
}

/**
 * Durable handoff for raw liquidity readings. In production this forwards to the
 * Risk Engine (and/or a durable time-series store); in tests it is a spy.
 */
export interface LiquidityReadingSink {
  record(snapshot: LiquiditySnapshot): Promise<void>;
}

/** Optional structured logger; defaults to a no-op so tests stay quiet. */
export interface WorkerLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

/** Injectable timer surface so tests can drive ticks with fake timers. */
export interface TimerLike {
  set(handler: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const NOOP_LOGGER: WorkerLogger = {
  info: () => undefined,
  error: () => undefined,
};

const DEFAULT_TIMER: TimerLike = {
  set: (handler, ms) => setInterval(handler, ms),
  clear: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

export interface LiquidityWorkerOptions {
  source: LiquiditySource;
  cache: SnapshotWriter;
  sink: LiquidityReadingSink;
  /** Market ids to poll each tick. */
  markets: string[];
  /** Poll interval in milliseconds. */
  pollIntervalMs: number;
  /** Clock for `observedAtMs`; defaults to `Date.now`. Injectable for tests. */
  now?: () => number;
  /** Timer surface; defaults to `setInterval`/`clearInterval`. */
  timer?: TimerLike;
  logger?: WorkerLogger;
}

/**
 * Polls liquidity for the configured markets on an interval and writes
 * snapshots to the hot cache and the durable sink. {@link start} begins
 * polling; {@link stop} clears the timer so no interval/timer is leaked.
 * Overlapping ticks are prevented by a guard so a slow poll can never stack up.
 */
export class LiquidityWorker {
  private readonly source: LiquiditySource;
  private readonly cache: SnapshotWriter;
  private readonly sink: LiquidityReadingSink;
  private readonly markets: string[];
  private readonly pollIntervalMs: number;
  private readonly now: () => number;
  private readonly timer: TimerLike;
  private readonly logger: WorkerLogger;

  private handle: unknown = undefined;
  private polling = false;

  constructor(options: LiquidityWorkerOptions) {
    if (options.pollIntervalMs <= 0) {
      throw new Error('pollIntervalMs must be a positive number');
    }
    this.source = options.source;
    this.cache = options.cache;
    this.sink = options.sink;
    this.markets = [...options.markets];
    this.pollIntervalMs = options.pollIntervalMs;
    this.now = options.now ?? Date.now;
    this.timer = options.timer ?? DEFAULT_TIMER;
    this.logger = options.logger ?? NOOP_LOGGER;
  }

  /** Whether the polling timer is currently active. */
  get isRunning(): boolean {
    return this.handle !== undefined;
  }

  /**
   * Begin polling on the configured interval. Idempotent: calling `start` while
   * already running is a no-op (no duplicate timers). The first poll fires after
   * one interval; call {@link pollOnce} directly for an immediate read.
   */
  start(): void {
    if (this.handle !== undefined) {
      return;
    }
    this.handle = this.timer.set(() => {
      void this.pollOnce();
    }, this.pollIntervalMs);
    this.logger.info('Liquidity worker started', {
      markets: this.markets.length,
      pollIntervalMs: this.pollIntervalMs,
    });
  }

  /**
   * Stop polling and release the timer so nothing is left running. Idempotent.
   */
  stop(): void {
    if (this.handle === undefined) {
      return;
    }
    this.timer.clear(this.handle);
    this.handle = undefined;
    this.logger.info('Liquidity worker stopped');
  }

  /**
   * Run a single poll cycle: read liquidity for every configured market and
   * write a snapshot to the cache and the durable sink. A failure reading one
   * market is logged and skipped so it cannot abort the others (the Risk Engine
   * fail-closes on missing data downstream). Returns the snapshots successfully
   * written. Overlapping invocations are skipped while one is in flight.
   */
  async pollOnce(): Promise<LiquiditySnapshot[]> {
    if (this.polling) {
      return [];
    }
    this.polling = true;
    const written: LiquiditySnapshot[] = [];
    try {
      for (const marketId of this.markets) {
        try {
          const reading = await this.source.readLiquidity(marketId);
          const snapshot = toSnapshot(marketId, reading, this.now());
          await this.cache.setLatest(marketId, snapshot);
          await this.sink.record(snapshot);
          written.push(snapshot);
        } catch (err) {
          this.logger.error('Failed to ingest liquidity', {
            marketId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    } finally {
      this.polling = false;
    }
    return written;
  }
}

/** Build a JSON-safe {@link LiquiditySnapshot} from a reading. */
function toSnapshot(
  marketId: string,
  reading: LiquidityReading,
  observedAtMs: number,
): LiquiditySnapshot {
  return {
    marketId,
    liquidityDepth: reading.depth,
    spreadBps: reading.spread,
    imbalance: reading.imbalance,
    observedAtMs,
  };
}
