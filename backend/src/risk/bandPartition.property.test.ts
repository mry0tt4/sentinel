// Feature: sentinel-risk-guardian, Property 2: Band assignment partitions the score range
//
// Property 2: Band assignment partitions the score range — every score maps to
// exactly one band per the documented mapping.
//   Normal         → 0–39
//   Warning        → 40–59
//   Guarded        → 60–74
//   ParamAdjust    → 75–89
//   EmergencyPause → 90–100
//
// Validates: Requirements 6.3
//
// The property is verified three ways:
//   1. Totality + disjointness — for any integer score in [0, 100], assignBand
//      returns exactly one band whose documented range contains the score.
//   2. Clamping — out-of-range and non-integer scores are clamped into [0, 100]
//      and still map to exactly one band consistent with the clamped value.
//   3. Engine-level — scores produced by the full DeterministicRiskEngine over
//      arbitrary feature vectors always land in exactly one band.

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

import { DeterministicRiskEngine, assignBand } from './scoringEngine.js';
import type { FeatureVector, RiskBand } from './types.js';

const NUM_RUNS = 200;

/**
 * The single source of truth for the documented mapping, expressed as an
 * ordered, contiguous partition of [0, 100]. The test derives the expected
 * band independently from `assignBand` so a drift in either side is caught.
 */
const BANDS: ReadonlyArray<{ band: RiskBand; lo: number; hi: number }> = [
  { band: 'Normal', lo: 0, hi: 39 },
  { band: 'Warning', lo: 40, hi: 59 },
  { band: 'Guarded', lo: 60, hi: 74 },
  { band: 'ParamAdjust', lo: 75, hi: 89 },
  { band: 'EmergencyPause', lo: 90, hi: 100 },
];

/** Independently determine which band(s) a score in [0, 100] belongs to. */
function bandsContaining(score: number): RiskBand[] {
  return BANDS.filter(({ lo, hi }) => score >= lo && score <= hi).map((b) => b.band);
}

/** Clamp the same way the scoring engine does, for the out-of-range cases. */
function clampScore(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}

/**
 * Generate a wide, adversarial FeatureVector so the engine-level partition
 * check exercises extreme/non-finite/out-of-domain inputs as well as nominal
 * ones. Constrained intelligently to the feature space (booleans are booleans,
 * timestamps are ms-scale) while allowing extremes.
 */
function arbFeatureVector(): fc.Arbitrary<FeatureVector> {
  const wildNum = fc.oneof(
    fc.double({ min: -1e9, max: 1e9, noNaN: false }),
    fc.constantFrom(NaN, Infinity, -Infinity, 0, -0),
    fc.integer({ min: -1_000_000, max: 1_000_000 }),
  );
  const ms = fc.integer({ min: 0, max: 10_000_000 });

  return fc.record({
    oraclePrice: wildNum,
    oracleConfidence: wildNum,
    oracleTimestampMs: ms,
    nowMs: ms,
    freshnessThresholdMs: fc.integer({ min: 0, max: 120_000 }),
    referencePrice: fc.option(wildNum, { nil: undefined }),
    expectedPegPrice: fc.option(wildNum, { nil: undefined }),
    priceChange1mPct: wildNum,
    priceChange5mPct: wildNum,
    priceChange15mPct: wildNum,
    realizedVolatilityPct: wildNum,
    liquidityDepth: wildNum,
    spreadBps: wildNum,
    imbalance: fc.double({ min: -2, max: 2, noNaN: false }),
    utilization: fc.double({ min: -1, max: 2, noNaN: false }),
    exposure: wildNum,
    currentMaxLtvBps: wildNum,
    borrowPaused: fc.boolean(),
    guardedMode: fc.boolean(),
    policyActive: fc.boolean(),
    guardianRevoked: fc.boolean(),
    priorActionsCount: fc.integer({ min: 0, max: 1000 }),
    priorOverridesCount: fc.integer({ min: 0, max: 1000 }),
    historicalEvidenceRefs: fc.array(fc.string(), { maxLength: 5 }),
  });
}

describe('Property 2: Band assignment partitions the score range', () => {
  it('maps every integer score in [0, 100] to exactly one band matching the documented range', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 100 }), (score) => {
        const band = assignBand(score);

        // Disjointness: the score is contained in exactly one documented range,
        // and the returned band is precisely that one.
        const containing = bandsContaining(score);
        expect(containing).toHaveLength(1);
        expect(band).toBe(containing[0]);

        // The returned band's own documented range must contain the score.
        const def = BANDS.find((b) => b.band === band)!;
        expect(score).toBeGreaterThanOrEqual(def.lo);
        expect(score).toBeLessThanOrEqual(def.hi);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('is total over [0, 100]: every score is assigned, leaving no gaps', () => {
    // Exhaustive check that the partition covers the full integer range with no
    // gaps and no overlaps — a concrete complement to the randomized property.
    for (let score = 0; score <= 100; score += 1) {
      expect(bandsContaining(score)).toHaveLength(1);
      expect(assignBand(score)).toBe(bandsContaining(score)[0]);
    }
  });

  it('clamps out-of-range and non-integer scores, still mapping to exactly one band', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.double({ min: -1e6, max: 1e6, noNaN: false }),
          fc.constantFrom(NaN, Infinity, -Infinity, -1, 100.5, 39.6, 89.999, 150),
        ),
        (raw) => {
          const band = assignBand(raw);
          const clamped = clampScore(raw);

          // assignBand clamps to [0, 100], so the result must agree with the
          // band of the clamped value. assignBand's internal boundaries operate
          // on the (possibly fractional) clamped score, so derive the expected
          // band the same way the engine does rather than via integer ranges.
          const expected =
            clamped <= 39
              ? 'Normal'
              : clamped <= 59
                ? 'Warning'
                : clamped <= 74
                  ? 'Guarded'
                  : clamped <= 89
                    ? 'ParamAdjust'
                    : 'EmergencyPause';

          expect(band).toBe(expected);
          // The returned value is always one of the five valid bands.
          expect(BANDS.map((b) => b.band)).toContain(band);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('engine-produced scores always land in exactly one band', async () => {
    const engine = new DeterministicRiskEngine();
    await fc.assert(
      fc.asyncProperty(arbFeatureVector(), async (features) => {
        const evaluation = await engine.evaluate('market-under-test', features);

        // The score itself must be an integer in [0, 100] for the partition to
        // be meaningful (guaranteed by Property 1, re-asserted here as a guard).
        expect(Number.isInteger(evaluation.riskScore)).toBe(true);
        expect(evaluation.riskScore).toBeGreaterThanOrEqual(0);
        expect(evaluation.riskScore).toBeLessThanOrEqual(100);

        // The emitted band must equal the band the score maps to, and that band
        // must be the single one whose documented range contains the score.
        const containing = bandsContaining(evaluation.riskScore);
        expect(containing).toHaveLength(1);
        expect(evaluation.band).toBe(containing[0]);
        expect(evaluation.band).toBe(assignBand(evaluation.riskScore));
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
