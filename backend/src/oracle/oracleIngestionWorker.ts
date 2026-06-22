/**
 * Oracle Ingestion Worker.
 *
 * Polls the configured {@link OracleAdapter} (Pyth on Sui Testnet) on a fixed
 * interval and, for each configured market→feed mapping, fetches the latest
 * price/confidence/timestamp and:
 *
 *   1. writes the reading to the Redis *hot-snapshot cache* so the dashboard
 *      hot path and the Risk Engine can read the freshest value without
 *      touching Postgres, and
 *   2. hands the reading to a durable {@link OracleReadingSink}.
 *
 * **Persistence choice (documented per task 8.1):** a raw oracle reading is
 * *not* a `risk_snapshots` row — that table requires Risk Engine output (score,
 * band, classes, rule outputs, model/prompt versions). Shoehorning raw readings
 * into it would violate its CHECK constraints and conflate two concerns.
 * Instead the worker hands each reading to a narrow `OracleReadingSink` port.
 * In the fully-wired system (task 21) that sink forwards readings to the Risk
 * Engine, which produces and persists the durable `risk_snapshots` record; the
 * port also allows a lightweight durable time-series store to be plugged in
 * without changing the worker. This keeps the worker cohesive with the existing
 * repositories rather than misusing one.
 *
 * Every collaborator — adapter, cache, sink, the poll timer, and the clock — is
 * injected, so the poll loop is fully unit-testable without a live RPC/Pyth
 * endpoint, Redis, or Postgres.
 */

import type { OracleAdapter, OracleReading } from './oracleAdapter.js';

/** A market and the oracle feed id it is monitored against. */
export interface OracleFeedMapping {
  marketId: string;
  feedId: string;
}

/**
 * JSON-safe snapshot written to the cache and the durable sink. `bigint` price
 * and confidence are serialized as decimal strings because `JSON.stringify`
 * (used by the cache) cannot encode `bigint`.
 */
export interface OracleSnapshot {
  marketId: string;
  feedId: string;
  /** Decimal string of the fixed-point price mantissa. */
  price: string;
  /** Decimal string of the fixed-point confidence mantissa. */
  confidence: string;
  /** Oracle publish time (ms since epoch). */
  timestampMs: number;
  /** Wall-clock time the worker observed the reading (ms since epoch). */
  observedAtMs: number;
}

/**
 * Narrow view of the Redis hot-snapshot cache the worker needs. The concrete
 * {@link import('../cache/redis.js').SnapshotCache} satisfies this; tests pass
 * a fake.
 */
export interface SnapshotWriter {
  setLatest<T>(marketId: string, snapshot: T): Promise<void>;
}

/**
 * Durable handoff for raw oracle readings. In production this forwards to the
 * Risk Engine (and/or a durable time-series store); in tests it is a spy.
 */
export interface OracleReadingSink {
  record(snapshot: OracleSnapshot): Promise<void>;
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

export interface OracleIngestionWorkerOptions {
  adapter: OracleAdapter;
  cache: SnapshotWriter;
  sink: OracleReadingSink;
  /** Market→feed mappings to poll each tick. */
  feeds: OracleFeedMapping[];
  /** Poll interval in milliseconds. */
  pollIntervalMs: number;
  /** Clock for `observedAtMs`; defaults to `Date.now`. Injectable for tests. */
  now?: () => number;
  /** Timer surface; defaults to `setInterval`/`clearInterval`. */
  timer?: TimerLike;
  logger?: WorkerLogger;
}

/**
 * Polls oracle feeds on an interval and writes snapshots to the hot cache and
 * the durable sink. {@link start} begins polling; {@link stop} clears the timer
 * so no interval/timer is leaked. Overlapping ticks are prevented by a guard so
 * a slow poll can never stack up.
 */
export class OracleIngestionWorker {
  private readonly adapter: OracleAdapter;
  private readonly cache: SnapshotWriter;
  private readonly sink: OracleReadingSink;
  private readonly feeds: OracleFeedMapping[];
  private readonly pollIntervalMs: number;
  private readonly now: () => number;
  private readonly timer: TimerLike;
  private readonly logger: WorkerLogger;

  private handle: unknown = undefined;
  private polling = false;

  constructor(options: OracleIngestionWorkerOptions) {
    if (options.pollIntervalMs <= 0) {
      throw new Error('pollIntervalMs must be a positive number');
    }
    this.adapter = options.adapter;
    this.cache = options.cache;
    this.sink = options.sink;
    this.feeds = [...options.feeds];
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
    this.logger.info('Oracle ingestion worker started', {
      feeds: this.feeds.length,
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
    this.logger.info('Oracle ingestion worker stopped');
  }

  /**
   * Run a single poll cycle: read every configured feed and write a snapshot to
   * the cache and the durable sink. A failure reading one feed is logged and
   * skipped so it cannot abort the others (the Risk Engine fail-closes on
   * missing data downstream). Returns the snapshots successfully written.
   * Overlapping invocations are skipped while one is in flight.
   */
  async pollOnce(): Promise<OracleSnapshot[]> {
    if (this.polling) {
      return [];
    }
    this.polling = true;
    const written: OracleSnapshot[] = [];
    try {
      for (const feed of this.feeds) {
        try {
          const reading = await this.adapter.readFeed(feed.feedId);
          const snapshot = toSnapshot(feed, reading, this.now());
          await this.cache.setLatest(feed.marketId, snapshot);
          await this.sink.record(snapshot);
          written.push(snapshot);
        } catch (err) {
          this.logger.error('Failed to ingest oracle feed', {
            marketId: feed.marketId,
            feedId: feed.feedId,
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

/** Build a JSON-safe {@link OracleSnapshot} from a reading. */
function toSnapshot(
  feed: OracleFeedMapping,
  reading: OracleReading,
  observedAtMs: number,
): OracleSnapshot {
  return {
    marketId: feed.marketId,
    feedId: feed.feedId,
    price: reading.price.toString(),
    confidence: reading.confidence.toString(),
    timestampMs: reading.timestampMs,
    observedAtMs,
  };
}
