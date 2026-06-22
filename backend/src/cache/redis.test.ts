import { describe, expect, it } from 'vitest';

import {
  JobQueue,
  type RedisLike,
  SnapshotCache,
  queueKey,
  snapshotKey,
} from './redis.js';

/**
 * In-memory fake implementing the narrow {@link RedisLike} surface: a string
 * key/value store plus per-key lists for queues. Lets us exercise the cache and
 * queue helpers without a live Redis server.
 */
class FakeRedis implements RedisLike {
  public readonly store = new Map<string, string>();
  public readonly lists = new Map<string, string[]>();

  async set(key: string, value: string): Promise<unknown> {
    this.store.set(key, value);
    return 'OK';
  }
  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }
  async del(key: string): Promise<number> {
    return this.store.delete(key) ? 1 : 0;
  }
  async rpush(key: string, value: string): Promise<number> {
    const list = this.lists.get(key) ?? [];
    list.push(value);
    this.lists.set(key, list);
    return list.length;
  }
  async lpop(key: string): Promise<string | null> {
    const list = this.lists.get(key);
    if (list === undefined || list.length === 0) {
      return null;
    }
    return list.shift() ?? null;
  }
  async llen(key: string): Promise<number> {
    return this.lists.get(key)?.length ?? 0;
  }
  async quit(): Promise<unknown> {
    return 'OK';
  }
}

describe('key namespacing', () => {
  it('namespaces snapshot and queue keys distinctly', () => {
    expect(snapshotKey('m1')).toBe('sentinel:snapshot:m1');
    expect(queueKey('evidence')).toBe('sentinel:queue:evidence');
  });
});

describe('SnapshotCache', () => {
  it('round-trips the latest snapshot per market as JSON', async () => {
    const redis = new FakeRedis();
    const cache = new SnapshotCache(redis);
    const snapshot = { riskScore: 73, band: 'Warning', ts: 1700 };

    await cache.setLatest('m1', snapshot);
    expect(redis.store.get('sentinel:snapshot:m1')).toBe(JSON.stringify(snapshot));

    const read = await cache.getLatest<typeof snapshot>('m1');
    expect(read).toEqual(snapshot);
  });

  it('returns null for a market with no cached snapshot', async () => {
    const cache = new SnapshotCache(new FakeRedis());
    expect(await cache.getLatest('missing')).toBeNull();
  });

  it('invalidate evicts the cached entry', async () => {
    const redis = new FakeRedis();
    const cache = new SnapshotCache(redis);
    await cache.setLatest('m1', { a: 1 });
    await cache.invalidate('m1');
    expect(redis.store.has('sentinel:snapshot:m1')).toBe(false);
    expect(await cache.getLatest('m1')).toBeNull();
  });

  it('latest write wins for the same market', async () => {
    const cache = new SnapshotCache(new FakeRedis());
    await cache.setLatest('m1', { v: 1 });
    await cache.setLatest('m1', { v: 2 });
    expect(await cache.getLatest('m1')).toEqual({ v: 2 });
  });
});

describe('JobQueue', () => {
  it('enqueues and dequeues jobs in FIFO order', async () => {
    const queue = new JobQueue(new FakeRedis(), 'evidence');
    await queue.enqueue({ id: 1 });
    await queue.enqueue({ id: 2 });
    await queue.enqueue({ id: 3 });

    expect(await queue.size()).toBe(3);
    expect(await queue.dequeue<{ id: number }>()).toEqual({ id: 1 });
    expect(await queue.dequeue<{ id: number }>()).toEqual({ id: 2 });
    expect(await queue.dequeue<{ id: number }>()).toEqual({ id: 3 });
  });

  it('returns null when dequeuing an empty queue', async () => {
    const queue = new JobQueue(new FakeRedis(), 'empty');
    expect(await queue.dequeue()).toBeNull();
    expect(await queue.size()).toBe(0);
  });

  it('keeps separate queues isolated by name', async () => {
    const redis = new FakeRedis();
    const a = new JobQueue(redis, 'a');
    const b = new JobQueue(redis, 'b');
    await a.enqueue({ q: 'a' });
    expect(await b.size()).toBe(0);
    expect(await a.size()).toBe(1);
  });
});
