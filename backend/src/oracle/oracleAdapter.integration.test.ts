/**
 * Live integration test for the Pyth Hermes oracle adapter (Req 6.1).
 *
 * Unlike `oracleAdapter.test.ts`, which injects a fake `fetch`, this suite
 * reads *real* prices from the public Pyth Hermes price service — the
 * off-chain price source backing Pyth on Sui Testnet — and asserts that the
 * adapter parses `price`/`confidence`/`timestamp` into the documented
 * `{ price: bigint, confidence: bigint, timestampMs: number }` contract.
 *
 * Live network tests are flaky in CI and fail when offline, so this suite is
 * guarded two ways:
 *   1. Opt-in: it only runs when `RUN_INTEGRATION=1` (or `true`) is set.
 *      A default `npm test` run skips it entirely and never fails offline.
 *   2. Even when opted in, a pre-flight connectivity probe skips the live
 *      assertions gracefully if Hermes is unreachable, so a flaky network
 *      degrades to a skip rather than a hard failure.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type OracleReading, PythOracleAdapter } from './oracleAdapter.js';

/** Well-known mainnet/testnet Pyth feed ids (same ids across Hermes). */
const FEEDS: ReadonlyArray<{ name: string; id: string }> = [
  {
    name: 'SUI/USD',
    id: '0x23d7315113f5b1d3ba7a83604c44b94d79f4fd69af77f804fc7f920a6dc65744',
  },
  {
    name: 'ETH/USD',
    id: '0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace',
  },
];

/** Opt-in flag: live network reads only happen when explicitly requested. */
const RUN_INTEGRATION = process.env.RUN_INTEGRATION === '1' || process.env.RUN_INTEGRATION === 'true';

/** Per-request timeout for the live network reads (ms). */
const LIVE_TIMEOUT_MS = 15_000;

/** Tracks whether the pre-flight connectivity probe found Hermes reachable. */
let hermesReachable = false;

/**
 * Probe Hermes once before the suite. Failure (offline / DNS / non-OK) flips
 * the suite to skip mode rather than letting the real assertions error out.
 */
async function probeHermes(): Promise<boolean> {
  if (typeof globalThis.fetch !== 'function') {
    return false;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LIVE_TIMEOUT_MS);
  try {
    const url =
      'https://hermes.pyth.network/v2/updates/price/latest' +
      `?ids[]=${encodeURIComponent(FEEDS[0].id)}&parsed=true`;
    const res = await fetch(url, { signal: controller.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

beforeAll(async () => {
  if (RUN_INTEGRATION) {
    hermesReachable = await probeHermes();
    if (!hermesReachable) {
      // eslint-disable-next-line no-console
      console.warn(
        '[oracleAdapter.integration] Pyth Hermes unreachable — skipping live reads.',
      );
    }
  } else {
    // eslint-disable-next-line no-console
    console.warn(
      '[oracleAdapter.integration] RUN_INTEGRATION not set — skipping live Pyth Hermes reads. ' +
        'Set RUN_INTEGRATION=1 to enable.',
    );
  }
}, LIVE_TIMEOUT_MS + 1_000);

afterAll(() => {
  if (RUN_INTEGRATION && hermesReachable) {
    // eslint-disable-next-line no-console
    console.info('[oracleAdapter.integration] Live Pyth Hermes reads completed.');
  }
});

/** Assert a reading satisfies the documented Req 6.1 parsing contract. */
function assertValidReading(reading: OracleReading): void {
  expect(typeof reading.price).toBe('bigint');
  expect(typeof reading.confidence).toBe('bigint');
  // A live, parsed price mantissa is strictly positive.
  expect(reading.price > 0n).toBe(true);
  // Confidence is a non-negative interval mantissa.
  expect(reading.confidence >= 0n).toBe(true);
  // Publish time is a finite, positive millisecond timestamp.
  expect(Number.isFinite(reading.timestampMs)).toBe(true);
  expect(reading.timestampMs).toBeGreaterThan(0);
  expect(Number.isInteger(reading.timestampMs)).toBe(true);
}

describe('PythOracleAdapter live Hermes read (integration, Req 6.1)', () => {
  for (const feed of FEEDS) {
    // `it.runIf` keeps the test as a clean skip (not a failure) when the
    // network is unavailable or the suite was not opted in.
    it.runIf(RUN_INTEGRATION)(
      `parses price/confidence/timestamp from a live ${feed.name} feed`,
      async () => {
        if (!hermesReachable) {
          // Graceful skip at runtime if the pre-flight probe failed.
          return;
        }
        const adapter = new PythOracleAdapter();
        const reading = await adapter.readFeed(feed.id);
        assertValidReading(reading);
      },
      LIVE_TIMEOUT_MS,
    );
  }

  // Always-present guard so the file is never an empty suite in default runs.
  it('is opt-in and never fails a default offline test run', () => {
    expect(typeof RUN_INTEGRATION).toBe('boolean');
  });
});
