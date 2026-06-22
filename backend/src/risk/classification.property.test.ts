// Feature: sentinel-risk-guardian, Property 3: Risk classification is a non-empty subset of the allowed set
//
// **Validates: Requirements 6.4**
//
// Property 3: For ANY feature vector — including extreme, adversarial, and
// missing (undefined optional) values — the deterministic risk engine's
// `classes` array is
//   (a) NON-EMPTY,
//   (b) composed only of members of the canonical RISK_CLASSES set, and
//   (c) free of duplicates.
//
// The generator below intentionally produces hostile inputs (NaN, ±Infinity,
// huge/tiny magnitudes, negative prices, out-of-domain utilization/imbalance,
// present/absent optional reference and peg prices) so the invariant is
// exercised across the whole input space, not just well-formed markets.

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_SCORING_CONFIG,
  DeterministicRiskEngine,
  assessRisk,
  classify,
  computeSubscores,
} from './scoringEngine.js';
import { RISK_CLASSES, type FeatureVector } from './types.js';

/**
 * A broad numeric arbitrary covering ordinary, extreme, and adversarial values.
 * Includes non-finite values (NaN, ±Infinity) and boundary-breaking magnitudes
 * so the engine's robustness guarantees are stressed.
 */
const adversarialNumber = (): fc.Arbitrary<number> =>
  fc.oneof(
    // Ordinary finite doubles, including negatives and very large magnitudes.
    fc.double({ min: -1e12, max: 1e12, noNaN: false, noDefaultInfinity: false }),
    // Explicit hostile constants the engine must survive.
    fc.constantFrom(
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      0,
      -0,
      Number.MAX_VALUE,
      -Number.MAX_VALUE,
      Number.MIN_VALUE,
      Number.MAX_SAFE_INTEGER,
      Number.MIN_SAFE_INTEGER,
    ),
  );

/** Optional adversarial number: sometimes absent (undefined) to model missing inputs. */
const optionalAdversarialNumber = (): fc.Arbitrary<number | undefined> =>
  fc.option(adversarialNumber(), { nil: undefined });

/** A broad FeatureVector arbitrary spanning extreme / adversarial / missing values. */
const featureVectorArb = (): fc.Arbitrary<FeatureVector> =>
  fc.record<FeatureVector>({
    // Oracle group
    oraclePrice: adversarialNumber(),
    oracleConfidence: adversarialNumber(),
    oracleTimestampMs: adversarialNumber(),
    nowMs: adversarialNumber(),
    freshnessThresholdMs: adversarialNumber(),
    referencePrice: optionalAdversarialNumber(),
    expectedPegPrice: optionalAdversarialNumber(),

    // Volatility group
    priceChange1mPct: adversarialNumber(),
    priceChange5mPct: adversarialNumber(),
    priceChange15mPct: adversarialNumber(),
    realizedVolatilityPct: adversarialNumber(),

    // Liquidity group
    liquidityDepth: adversarialNumber(),
    spreadBps: adversarialNumber(),
    imbalance: adversarialNumber(),

    // Protocol exposure
    utilization: adversarialNumber(),
    exposure: adversarialNumber(),
    currentMaxLtvBps: adversarialNumber(),

    // Governance / config
    borrowPaused: fc.boolean(),
    guardedMode: fc.boolean(),
    policyActive: fc.boolean(),
    guardianRevoked: fc.boolean(),
    priorActionsCount: adversarialNumber(),
    priorOverridesCount: adversarialNumber(),
    historicalEvidenceRefs: fc.array(fc.string(), { maxLength: 5 }),
  });

const ALLOWED = new Set<string>(RISK_CLASSES);

/** Assert the Property 3 invariant on any classes array. */
function assertNonEmptyAllowedNoDuplicates(classes: readonly string[]): void {
  // (a) NON-EMPTY
  expect(classes.length).toBeGreaterThan(0);
  // (b) every element is a member of RISK_CLASSES
  for (const c of classes) {
    expect(ALLOWED.has(c)).toBe(true);
  }
  // (c) no duplicates
  expect(new Set(classes).size).toBe(classes.length);
}

describe('Property 3: risk classification is a non-empty subset of the allowed set', () => {
  it('classify() yields a non-empty, in-set, duplicate-free class list for any feature vector', () => {
    fc.assert(
      fc.property(featureVectorArb(), (f) => {
        const sub = computeSubscores(f, DEFAULT_SCORING_CONFIG);
        const { classes } = classify(f, sub, DEFAULT_SCORING_CONFIG);
        assertNonEmptyAllowedNoDuplicates(classes);
      }),
      { numRuns: 200 },
    );
  });

  it('assessRisk() (full deterministic path) preserves the invariant for any feature vector', () => {
    fc.assert(
      fc.property(featureVectorArb(), (f) => {
        const { classes } = assessRisk(f);
        assertNonEmptyAllowedNoDuplicates(classes);
      }),
      { numRuns: 200 },
    );
  });

  it('DeterministicRiskEngine.evaluateSync() emits a valid class subset for any feature vector', () => {
    const engine = new DeterministicRiskEngine();
    fc.assert(
      fc.property(featureVectorArb(), (f) => {
        const { classes } = engine.evaluateSync('market-prop-3', f);
        assertNonEmptyAllowedNoDuplicates(classes);
      }),
      { numRuns: 200 },
    );
  });
});
