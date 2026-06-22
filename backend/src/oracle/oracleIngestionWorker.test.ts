import { describe, expect, it, vi } from 'vitest';

import { MockOracleAdapter, type OracleAdapter } from './oracleAdapter.js';
import {
  OracleIngestionWorker,
  type OracleReadingSink,
  type OracleSnapshot,
  type SnapshotWriter,
  type TimerLike,
} from './oracleIngestionWorker.js';

/** Fake hot-snapshot cache capturing the latest write per market. */
class FakeCache implements SnapshotWriter {
  public readonly writes: Array<{ marketId: string; snapshot: unknown }> = [];
  public readonly latest = new Map<string, unknown>();

  async setLatest<T>(marketId: string, snapshot: T): Promise<void> {
    this.writes.push({ marketId, snapshot });
    this.latest.set(marketId, snapshot);
  }
}

/** Fake durable sink recording every handed-off snapshot. */
class FakeSink implements OracleReadingSink {
  public readonly records: OracleSnapshot[] = [];
  async record(snapshot: OracleSnapshot): Promise<void> {
    this.records.push(snapshot);
  }
}

/** Controllable timer: captures the registered handler so tests can fire ticks. */
class ManualTimer implements TimerLike {
  public handler: (() => void) | undefined;
  public cleared = false;
  public setCount = 0;

  set(handler: () => void): unknown {
    this.handler = handler;
    this.setCount += 1;
    return Symbol('handle');
  }
  clear(): void {
    this.cleared = true;
    this.handler = undefined;
  }
  tick(): void {
    this.handler?.();
  }
}

const FEEDS = [
  { marketId: 'market-1', feedId: 'feed-a' },
  { marketId: 'market-2', feedId: 'feed-b' },
];

function buildWorker(overrides: Partial<{
  adapter: OracleAdapter;
  cache: FakeCache;
  sink: FakeSink;
  timer: ManualTimer;
  now: () => number;
}> = {}) {
  const adapter =
    overrides.adapter ??
    new MockOracleAdapter({
      readings: {
        'feed-a': { price: 100n, confidence: 5n, timestampMs: 1000 },
        'feed-b': { price: 200n, confidence: 9n, timestampMs: 2000 },
      },
    });
  const cache = overrides.cache ?? new FakeCache();
  const sink = overrides.sink ?? new FakeSink();
  const timer = overrides.timer ?? new ManualTimer();
  const worker = new OracleIngestionWorker({
    adapter,
    cache,
    sink,
    feeds: FEEDS,
    pollIntervalMs: 1000,
    timer,
    now: overrides.now ?? (() => 1_700_000_000_000),
  });
  return { worker, cache, sink, timer, adapter };
}

describe('OracleIngestionWorker.pollOnce', () => {
  it('writes one snapshot per feed to the cache and the durable sink', async () => {
    const { worker, cache, sink } = buildWorker();

    const written = await worker.pollOnce();

    expect(written).toHaveLength(2);
    expect(cache.writes).toHaveLength(2);
    expect(sink.records).toHaveLength(2);

    const m1 = cache.latest.get('market-1') as OracleSnapshot;
    expect(m1).toMatchObject({
      marketId: 'market-1',
      feedId: 'feed-a',
      price: '100',
      confidence: '5',
      timestampMs: 1000,
      observedAtMs: 1_700_000_000_000,
    });
    // bigint values are serialized as decimal strings for JSON safety.
    expect(typeof m1.price).toBe('string');
    expect(sink.records[1]).toMatchObject({ marketId: 'market-2', price: '200' });
  });

  it('skips a failing feed without aborting the others', async () => {
    const adapter: OracleAdapter = {
      readFeed: async (feedId) => {
        if (feedId === 'feed-a') {
          throw new Error('feed unavailable');
        }
        return { price: 200n, confidence: 9n, timestampMs: 2000 };
      },
    };
    const { worker, cache, sink } = buildWorker({ adapter });

    const written = await worker.pollOnce();

    expect(written).toHaveLength(1);
    expect(written[0]?.marketId).toBe('market-2');
    expect(cache.writes).toHaveLength(1);
    expect(sink.records).toHaveLength(1);
  });
});

describe('OracleIngestionWorker start/stop', () => {
  it('polls on each timer tick once started', async () => {
    const { worker, cache, timer } = buildWorker();

    worker.start();
    expect(worker.isRunning).toBe(true);
    expect(timer.setCount).toBe(1);

    timer.tick();
    await vi.waitFor(() => expect(cache.writes).toHaveLength(2));

    timer.tick();
    await vi.waitFor(() => expect(cache.writes).toHaveLength(4));
  });

  it('does not create a second timer when start is called twice', () => {
    const { worker, timer } = buildWorker();
    worker.start();
    worker.start();
    expect(timer.setCount).toBe(1);
  });

  it('clears the timer cleanly on stop and leaves nothing running', () => {
    const { worker, timer } = buildWorker();
    worker.start();
    worker.stop();

    expect(timer.cleared).toBe(true);
    expect(worker.isRunning).toBe(false);
    expect(timer.handler).toBeUndefined();
  });

  it('stop is idempotent and safe before start', () => {
    const { worker } = buildWorker();
    expect(() => worker.stop()).not.toThrow();
    expect(worker.isRunning).toBe(false);
  });

  it('rejects a non-positive poll interval', () => {
    const { cache, sink } = buildWorker();
    expect(
      () =>
        new OracleIngestionWorker({
          adapter: new MockOracleAdapter(),
          cache,
          sink,
          feeds: FEEDS,
          pollIntervalMs: 0,
        }),
    ).toThrow();
  });
});
