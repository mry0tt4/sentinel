import { describe, expect, it, vi } from 'vitest';

import { SimulatedLiquiditySource, type LiquiditySource } from './liquiditySource.js';
import {
  LiquidityWorker,
  type LiquidityReadingSink,
  type LiquiditySnapshot,
  type SnapshotWriter,
  type TimerLike,
} from './liquidityWorker.js';

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
class FakeSink implements LiquidityReadingSink {
  public readonly records: LiquiditySnapshot[] = [];
  async record(snapshot: LiquiditySnapshot): Promise<void> {
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

const MARKETS = ['market-1', 'market-2'];

function buildWorker(
  overrides: Partial<{
    source: LiquiditySource;
    cache: FakeCache;
    sink: FakeSink;
    timer: ManualTimer;
    now: () => number;
  }> = {},
) {
  const source =
    overrides.source ??
    new SimulatedLiquiditySource({
      readings: {
        'market-1': { depth: 1000, spread: 5, imbalance: 0.1 },
        'market-2': { depth: 2000, spread: 9, imbalance: -0.2 },
      },
    });
  const cache = overrides.cache ?? new FakeCache();
  const sink = overrides.sink ?? new FakeSink();
  const timer = overrides.timer ?? new ManualTimer();
  const worker = new LiquidityWorker({
    source,
    cache,
    sink,
    markets: MARKETS,
    pollIntervalMs: 1000,
    timer,
    now: overrides.now ?? (() => 1_700_000_000_000),
  });
  return { worker, cache, sink, timer, source };
}

describe('LiquidityWorker.pollOnce', () => {
  it('writes one snapshot per market to the cache and the durable sink', async () => {
    const { worker, cache, sink } = buildWorker();

    const written = await worker.pollOnce();

    expect(written).toHaveLength(2);
    expect(cache.writes).toHaveLength(2);
    expect(sink.records).toHaveLength(2);

    const m1 = cache.latest.get('market-1') as LiquiditySnapshot;
    expect(m1).toEqual({
      marketId: 'market-1',
      liquidityDepth: 1000,
      spreadBps: 5,
      imbalance: 0.1,
      observedAtMs: 1_700_000_000_000,
    });
    expect(sink.records[1]).toMatchObject({
      marketId: 'market-2',
      liquidityDepth: 2000,
      spreadBps: 9,
      imbalance: -0.2,
    });
  });

  it('skips a failing market without aborting the others', async () => {
    const source: LiquiditySource = {
      readLiquidity: async (marketId) => {
        if (marketId === 'market-1') {
          throw new Error('source unavailable');
        }
        return { depth: 2000, spread: 9, imbalance: -0.2 };
      },
    };
    const { worker, cache, sink } = buildWorker({ source });

    const written = await worker.pollOnce();

    expect(written).toHaveLength(1);
    expect(written[0]?.marketId).toBe('market-2');
    expect(cache.writes).toHaveLength(1);
    expect(sink.records).toHaveLength(1);
  });
});

describe('LiquidityWorker start/stop', () => {
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
        new LiquidityWorker({
          source: new SimulatedLiquiditySource(),
          cache,
          sink,
          markets: MARKETS,
          pollIntervalMs: 0,
        }),
    ).toThrow();
  });
});
