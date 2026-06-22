import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

import {
  DeepBookLiquiditySource,
  type DeepBookPoolReader,
  LiquidityReadError,
  type LiquiditySource,
  type OrderBookSnapshot,
  SimulatedLiquiditySource,
  createLiquiditySource,
  deriveLiquidityFromOrderBook,
} from './liquiditySource.js';

describe('SimulatedLiquiditySource.readLiquidity', () => {
  it('returns seeded readings verbatim', async () => {
    const source = new SimulatedLiquiditySource({
      readings: { 'market-1': { depth: 42, spread: 3, imbalance: 0.1 } },
    });
    const reading = await source.readLiquidity('market-1');
    expect(reading).toEqual({ depth: 42, spread: 3, imbalance: 0.1 });
  });

  it('returns depth, spread, and imbalance for an unseeded market', async () => {
    const source = new SimulatedLiquiditySource();
    const reading = await source.readLiquidity('demo-market');

    expect(typeof reading.depth).toBe('number');
    expect(typeof reading.spread).toBe('number');
    expect(typeof reading.imbalance).toBe('number');
    expect(reading.depth).toBeGreaterThan(0);
    expect(reading.spread).toBeGreaterThan(0);
    expect(reading.imbalance).toBeGreaterThanOrEqual(-1);
    expect(reading.imbalance).toBeLessThanOrEqual(1);
  });

  it('is deterministic for unseeded markets (same input -> same output)', async () => {
    const source = new SimulatedLiquiditySource();
    const first = await source.readLiquidity('SUI/USDC');
    const second = await source.readLiquidity('SUI/USDC');
    expect(second).toEqual(first);
  });

  it('rejects an empty market id', async () => {
    const source = new SimulatedLiquiditySource();
    await expect(source.readLiquidity('   ')).rejects.toBeInstanceOf(LiquidityReadError);
  });
});

describe('deriveLiquidityFromOrderBook', () => {
  it('derives depth, spread (bps), and imbalance from a level-2 book', () => {
    const book: OrderBookSnapshot = {
      bids: [
        { price: 99, quantity: 10 },
        { price: 98, quantity: 20 },
      ],
      asks: [
        { price: 101, quantity: 5 },
        { price: 102, quantity: 5 },
      ],
    };
    const reading = deriveLiquidityFromOrderBook(book);

    // depth = 99*10 + 98*20 + 101*5 + 102*5 = 990 + 1960 + 505 + 510 = 3965
    expect(reading.depth).toBe(3965);
    // spread = (101 - 99) / 100 * 10000 = 200 bps (mid = 100)
    expect(reading.spread).toBeCloseTo(200, 6);
    // imbalance = (30 - 10) / 40 = 0.5
    expect(reading.imbalance).toBeCloseTo(0.5, 6);
  });

  it('returns zero spread and imbalance for an empty book', () => {
    const reading = deriveLiquidityFromOrderBook({ bids: [], asks: [] });
    expect(reading).toEqual({ depth: 0, spread: 0, imbalance: 0 });
  });

  // **Validates: Requirements 6.1**
  it('always produces imbalance within [-1, 1] and non-negative depth/spread', () => {
    const level = fc.record({
      price: fc.double({ min: 0.0001, max: 1_000_000, noNaN: true }),
      quantity: fc.double({ min: 0, max: 1_000_000, noNaN: true }),
    });
    fc.assert(
      fc.property(fc.array(level, { maxLength: 20 }), fc.array(level, { maxLength: 20 }), (bids, asks) => {
        const reading = deriveLiquidityFromOrderBook({ bids, asks });
        expect(reading.imbalance).toBeGreaterThanOrEqual(-1);
        expect(reading.imbalance).toBeLessThanOrEqual(1);
        expect(reading.depth).toBeGreaterThanOrEqual(0);
        expect(reading.spread).toBeGreaterThanOrEqual(0);
      }),
    );
  });
});

describe('DeepBookLiquiditySource (best-effort)', () => {
  it('derives a reading from the order book when a pool and reader are configured', async () => {
    const fallback = new SimulatedLiquiditySource();
    const reader: DeepBookPoolReader = async () => ({
      bids: [{ price: 100, quantity: 10 }],
      asks: [{ price: 102, quantity: 10 }],
    });
    const source = new DeepBookLiquiditySource({
      fallback,
      pools: { 'market-1': 'pool-abc' },
      reader,
    });

    const reading = await source.readLiquidity('market-1');
    // mid = 101, spread = 2/101*10000 ≈ 198.02 bps; imbalance = 0
    expect(reading.spread).toBeCloseTo((2 / 101) * 10_000, 4);
    expect(reading.imbalance).toBeCloseTo(0, 6);
    expect(reading.depth).toBe(100 * 10 + 102 * 10);
  });

  it('delegates to the fallback when no pool is mapped for the market', async () => {
    const fallback = new SimulatedLiquiditySource({
      readings: { 'market-2': { depth: 7, spread: 7, imbalance: 0 } },
    });
    let readerCalled = false;
    const reader: DeepBookPoolReader = async () => {
      readerCalled = true;
      return null;
    };
    const source = new DeepBookLiquiditySource({ fallback, pools: {}, reader });

    const reading = await source.readLiquidity('market-2');
    expect(reading).toEqual({ depth: 7, spread: 7, imbalance: 0 });
    expect(readerCalled).toBe(false);
  });

  it('delegates to the fallback when the DeepBook read throws', async () => {
    const fallback = new SimulatedLiquiditySource({
      readings: { 'market-3': { depth: 5, spread: 5, imbalance: 0.2 } },
    });
    const reader: DeepBookPoolReader = async () => {
      throw new Error('rpc down');
    };
    const reasons: string[] = [];
    const source = new DeepBookLiquiditySource({
      fallback,
      pools: { 'market-3': 'pool-x' },
      reader,
      onFallback: (_m, reason) => reasons.push(reason),
    });

    const reading = await source.readLiquidity('market-3');
    expect(reading).toEqual({ depth: 5, spread: 5, imbalance: 0.2 });
    expect(reasons.some((r) => r.includes('DeepBook read failed'))).toBe(true);
  });

  it('delegates to the fallback when the book is empty', async () => {
    const fallback = new SimulatedLiquiditySource({
      readings: { 'market-4': { depth: 1, spread: 1, imbalance: 0 } },
    });
    const reader: DeepBookPoolReader = async () => ({ bids: [], asks: [] });
    const source = new DeepBookLiquiditySource({
      fallback,
      pools: { 'market-4': 'pool-y' },
      reader,
    });

    const reading = await source.readLiquidity('market-4');
    expect(reading).toEqual({ depth: 1, spread: 1, imbalance: 0 });
  });
});

describe('createLiquiditySource', () => {
  it('builds a simulated source', async () => {
    const source = createLiquiditySource({ kind: 'simulated' });
    expect(source).toBeInstanceOf(SimulatedLiquiditySource);
  });

  it('builds a deepbook source backed by a simulated fallback', async () => {
    const source: LiquiditySource = createLiquiditySource({ kind: 'deepbook' });
    expect(source).toBeInstanceOf(DeepBookLiquiditySource);
    // With no reader configured, it falls back to deterministic simulated data.
    const reading = await source.readLiquidity('demo');
    expect(reading.depth).toBeGreaterThan(0);
  });
});
