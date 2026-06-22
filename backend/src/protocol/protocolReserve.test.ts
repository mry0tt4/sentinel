import { describe, expect, it, vi } from 'vitest';

import { createDefiLlamaReserveReader, type FetchLike } from './protocolReserve.js';

/** A fake DefiLlama response shaped like the real `currentChainTvls`. */
function fakeFetch(body: unknown, ok = true): FetchLike {
  return vi.fn(async () => ({ ok, json: async () => body })) as unknown as FetchLike;
}

const SUILEND_BODY = {
  name: 'Suilend',
  currentChainTvls: {
    Sui: 106_000_000, // net TVL (deposits − borrows)
    'Sui-borrowed': 49_000_000,
    borrowed: 49_000_000,
  },
};

describe('createDefiLlamaReserveReader', () => {
  it('derives deposits, exposure, and utilization from real reserve figures', async () => {
    const reader = createDefiLlamaReserveReader({ fetchFn: fakeFetch(SUILEND_BODY) });
    const reserve = await reader.read();

    expect(reserve).not.toBeNull();
    // deposits = net TVL + borrowed = 155M
    expect(reserve?.suppliedUsd).toBe(155_000_000);
    expect(reserve?.borrowedUsd).toBe(49_000_000);
    // utilization = borrowed / deposits ≈ 0.3161
    expect(reserve?.utilization).toBeCloseTo(0.3161, 3);
    expect(reserve?.name).toBe('Suilend');
    expect(reserve?.slug).toBe('suilend');
    expect(reserve?.url).toContain('suilend');
  });

  it('caches within the TTL and refetches after it elapses', async () => {
    let t = 1_000;
    const fetchFn = fakeFetch(SUILEND_BODY);
    const reader = createDefiLlamaReserveReader({
      fetchFn,
      ttlMs: 1_000,
      now: () => t,
    });

    await reader.read();
    await reader.read(); // within TTL → served from cache
    expect(fetchFn).toHaveBeenCalledTimes(1);

    t += 2_000; // past TTL
    await reader.read();
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('fails soft (returns null) when the fetch throws and there is no cached value', async () => {
    const throwing: FetchLike = vi.fn(async () => {
      throw new Error('network down');
    }) as unknown as FetchLike;
    const reader = createDefiLlamaReserveReader({ fetchFn: throwing });
    expect(await reader.read()).toBeNull();
  });

  it('serves the last good value when a later fetch fails', async () => {
    let mode: 'ok' | 'fail' = 'ok';
    let t = 0;
    const fetchFn: FetchLike = vi.fn(async () => {
      if (mode === 'fail') throw new Error('blip');
      return { ok: true, json: async () => SUILEND_BODY };
    }) as unknown as FetchLike;
    const reader = createDefiLlamaReserveReader({ fetchFn, ttlMs: 0, now: () => t });

    const first = await reader.read();
    expect(first?.suppliedUsd).toBe(155_000_000);

    mode = 'fail';
    t += 10;
    const second = await reader.read();
    expect(second?.suppliedUsd).toBe(155_000_000); // last good value retained
  });

  it('returns null when the payload has no usable supplied figure', async () => {
    const reader = createDefiLlamaReserveReader({
      fetchFn: fakeFetch({ name: 'Empty', currentChainTvls: {} }),
    });
    expect(await reader.read()).toBeNull();
  });
});
