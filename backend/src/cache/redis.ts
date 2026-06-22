/**
 * Redis client: hot-snapshot cache + simple job queue.
 *
 * Redis backs two concerns from the design's data layer (Req 15.3):
 *   1. A *hot snapshot cache* — the latest risk/oracle snapshot per market,
 *      read on the dashboard hot path without touching Postgres.
 *   2. A *job queue* — a lightweight FIFO list workers push work onto and pull
 *      work off of (e.g. evidence uploads, indexing jobs).
 *
 * The connection string is read from the validated application configuration
 * (`REDIS_URL`, environment variables only — Req 16.3). The helpers depend on a
 * narrow {@link RedisLike} interface (a subset of the `ioredis` API) so tests
 * can inject an in-memory fake without a live Redis server.
 */

import { Redis } from 'ioredis';

import { loadConfig } from '../config/env.js';

/**
 * Minimal subset of the `ioredis` command surface used by the helpers. Both the
 * real client and test doubles satisfy this interface.
 */
export interface RedisLike {
  set(key: string, value: string): Promise<unknown>;
  set(key: string, value: string, mode: 'EX', ttlSeconds: number): Promise<unknown>;
  get(key: string): Promise<string | null>;
  del(key: string): Promise<number>;
  rpush(key: string, value: string): Promise<number>;
  lpop(key: string): Promise<string | null>;
  llen(key: string): Promise<number>;
  quit(): Promise<unknown>;
}

/** Key namespaces so cache entries and queues never collide. */
const SNAPSHOT_PREFIX = 'sentinel:snapshot:';
const QUEUE_PREFIX = 'sentinel:queue:';

/** Build the cache key for a market's latest snapshot. */
export function snapshotKey(marketId: string): string {
  return `${SNAPSHOT_PREFIX}${marketId}`;
}

/** Build the list key for a named job queue. */
export function queueKey(name: string): string {
  return `${QUEUE_PREFIX}${name}`;
}

let client: Redis | undefined;

/** Return the process-wide ioredis client, creating it on first use. */
export function getRedis(): Redis {
  if (client === undefined) {
    const { config } = loadConfig();
    client = new Redis(config.redisUrl, { lazyConnect: true, maxRetriesPerRequest: 2 });
  }
  return client;
}

/** Close the shared client (graceful shutdown / tests). */
export async function closeRedis(): Promise<void> {
  if (client !== undefined) {
    await client.quit();
    client = undefined;
  }
}

/**
 * Hot-snapshot cache. Stores the latest snapshot object per market as JSON,
 * with an optional TTL so stale entries self-expire.
 */
export class SnapshotCache {
  /** @param ttlSeconds optional expiry; omit/0 to keep entries until overwritten. */
  constructor(
    private readonly redis: RedisLike,
    private readonly ttlSeconds = 0,
  ) {}

  /** Cache the latest snapshot for a market. */
  async setLatest<T>(marketId: string, snapshot: T): Promise<void> {
    const payload = JSON.stringify(snapshot);
    if (this.ttlSeconds > 0) {
      await this.redis.set(snapshotKey(marketId), payload, 'EX', this.ttlSeconds);
    } else {
      await this.redis.set(snapshotKey(marketId), payload);
    }
  }

  /** Read the latest cached snapshot for a market, or `null` if absent. */
  async getLatest<T>(marketId: string): Promise<T | null> {
    const raw = await this.redis.get(snapshotKey(marketId));
    if (raw === null) {
      return null;
    }
    return JSON.parse(raw) as T;
  }

  /** Evict a market's cached snapshot. */
  async invalidate(marketId: string): Promise<void> {
    await this.redis.del(snapshotKey(marketId));
  }
}

/**
 * Simple FIFO job queue backed by a Redis list. {@link enqueue} appends to the
 * tail (`RPUSH`) and {@link dequeue} pops from the head (`LPOP`), giving
 * first-in/first-out ordering. Jobs are serialized as JSON.
 */
export class JobQueue {
  constructor(
    private readonly redis: RedisLike,
    private readonly name: string,
  ) {}

  /** Append a job to the queue; returns the resulting queue length. */
  async enqueue<T>(job: T): Promise<number> {
    return this.redis.rpush(queueKey(this.name), JSON.stringify(job));
  }

  /** Remove and return the oldest job, or `null` if the queue is empty. */
  async dequeue<T>(): Promise<T | null> {
    const raw = await this.redis.lpop(queueKey(this.name));
    if (raw === null) {
      return null;
    }
    return JSON.parse(raw) as T;
  }

  /** Current number of queued jobs. */
  async size(): Promise<number> {
    return this.redis.llen(queueKey(this.name));
  }
}
