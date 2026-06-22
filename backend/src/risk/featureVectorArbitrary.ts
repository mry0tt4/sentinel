/**
 * Shared fast-check arbitraries for the Risk_Engine property tests.
 *
 * The `featureVectorArbitrary` deliberately spans the *entire* numeric domain —
 * including NaN, ±Infinity, ±0, enormous magnitudes, negative prices, and
 * values that violate the documented field domains (e.g. utilization outside
 * [0,1], imbalance outside [-1,1]) — plus optional oracle fields present or
 * absent. This models the "extreme / missing-defaulted / adversarial" inputs
 * the design's Properties 1–6 must hold against, so the engine's [0,100]
 * guarantees are exercised against inputs that try hard to escape them.
 *
 * Per the design (PBT "Generators" section) this arbitrary covers Properties
 * 1–6 and is reused by the band-partition (7.3) and classification-subset (7.4)
 * property tests.
 */

import fc from 'fast-check';

import type { FeatureVector } from './types.js';

/**
 * An "adversarial" finite-or-non-finite number. Mixes:
 *  - arbitrary 64-bit doubles (fast-check's `double` already yields NaN, ±0 and
 *    ±Infinity by default),
 *  - explicit boundary/special constants, and
 *  - a dense band of ordinary small values so common cases are well covered.
 */
export const extremeNumber: fc.Arbitrary<number> = fc.oneof(
  fc.double(),
  fc.constantFrom(
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    0,
    -0,
    1,
    -1,
    Number.MAX_VALUE,
    -Number.MAX_VALUE,
    Number.MIN_VALUE,
    Number.MAX_SAFE_INTEGER,
    Number.MIN_SAFE_INTEGER,
    1e308,
    -1e308,
  ),
  fc.integer({ min: -1_000_000, max: 1_000_000 }),
  fc.double({ min: -1e6, max: 1e6, noNaN: true }),
);

/** An optional adversarial number that is present or genuinely absent. */
const optionalExtremeNumber: fc.Arbitrary<number | undefined> = fc.option(extremeNumber, {
  nil: undefined,
  freq: 2,
});

/**
 * A `FeatureVector` arbitrary covering extreme, missing-defaulted, and
 * adversarial inputs. Every numeric field draws from {@link extremeNumber};
 * the two oracle reference fields are independently present or absent; booleans
 * and the evidence-ref array round out the structure.
 */
export const featureVectorArbitrary: fc.Arbitrary<FeatureVector> = fc.record({
  // Oracle
  oraclePrice: extremeNumber,
  oracleConfidence: extremeNumber,
  oracleTimestampMs: extremeNumber,
  nowMs: extremeNumber,
  freshnessThresholdMs: extremeNumber,
  referencePrice: optionalExtremeNumber,
  expectedPegPrice: optionalExtremeNumber,

  // Volatility
  priceChange1mPct: extremeNumber,
  priceChange5mPct: extremeNumber,
  priceChange15mPct: extremeNumber,
  realizedVolatilityPct: extremeNumber,

  // Liquidity
  liquidityDepth: extremeNumber,
  spreadBps: extremeNumber,
  imbalance: extremeNumber,

  // Protocol exposure
  utilization: extremeNumber,
  exposure: extremeNumber,
  currentMaxLtvBps: extremeNumber,

  // Governance / config
  borrowPaused: fc.boolean(),
  guardedMode: fc.boolean(),
  policyActive: fc.boolean(),
  guardianRevoked: fc.boolean(),
  priorActionsCount: extremeNumber,
  priorOverridesCount: extremeNumber,
  historicalEvidenceRefs: fc.array(fc.string()),
});
