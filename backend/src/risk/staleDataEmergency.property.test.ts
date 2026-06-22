// Feature: sentinel-risk-guardian, Property 6: Stale-data emergency recommendation
//
// Property 6: Stale-data emergency recommendation — when the oracle reading's
// age exceeds the market's configured freshness threshold AND policy permits an
// emergency stale-data pause AND no hard refusal is active, the Risk_Engine
// SHALL escalate to an emergency `pause_new_borrows`, record a non-empty
// stale-data justification, clear any refusal reason, and append a fired
// STALE_DATA_PAUSE_RULE rule output to the evidence trail.
//
// Validates: Requirements 6.14
//
// The fail-closed precedence (decideFailClosed) is:
//   1. evaluation incomplete            → REFUSE   (hard)
//   2. oracle absent/unparseable        → REFUSE   (hard)
//   3. not Sui Testnet                  → REFUSE   (hard)
//   4. guardian revoked                 → REFUSE   (hard)
//   5. stale AND policyPermitsStalePause → ESCALATE (this property)
//   6. action exceeds policy bounds     → REFUSE
//   7. otherwise                        → PASS
//
// This file exercises rule 5. The positive property generates contexts where
// NO hard refusal is active (eval complete, oracle present, on testnet, guardian
// live), the oracle is provably stale (age > threshold), and the policy permits
// the stale pause — for ANY such context and ANY deterministic candidate action,
// the escalation must fire. A complementary negative property fixes
// policyPermitsStalePause=false and asserts the escalation does NOT fire.

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

import {
  applyFailClosed,
  STALE_DATA_PAUSE_RULE,
  type FailClosedGuardContext,
  type PolicyActionBounds,
  type ProposedActionMagnitude,
} from './failClosedRiskEngine.js';
import type { ActionType, FeatureVector, RiskEvaluation } from './types.js';

const NUM_RUNS = 200;

const ALL_ACTIONS: ActionType[] = [
  'pause_new_borrows',
  'reduce_max_ltv',
  'enter_guarded_mode',
  'increase_maintenance_margin',
];

/** A deterministic candidate action (or null — engine recommended nothing). */
function arbCandidate(): fc.Arbitrary<ActionType | null> {
  return fc.oneof(fc.constant(null), fc.constantFrom(...ALL_ACTIONS));
}

/** Arbitrary, possibly over-cap proposed magnitudes (escalation must ignore bounds). */
function arbMagnitude(): fc.Arbitrary<ProposedActionMagnitude> {
  return fc.record({
    ltvDeltaBps: fc.option(fc.integer({ min: 0, max: 50_000 }), { nil: undefined }),
    marginDeltaBps: fc.option(fc.integer({ min: 0, max: 50_000 }), { nil: undefined }),
    pauseDurationMs: fc.option(fc.integer({ min: 0, max: 100_000_000 }), { nil: undefined }),
  });
}

/** Arbitrary policy bounds, including ones that may exclude the candidate action. */
function arbPolicy(): fc.Arbitrary<PolicyActionBounds> {
  return fc.record({
    allowedActions: fc.subarray(ALL_ACTIONS),
    maxLtvDeltaBps: fc.option(fc.integer({ min: 0, max: 10_000 }), { nil: undefined }),
    maxMarginDeltaBps: fc.option(fc.integer({ min: 0, max: 10_000 }), { nil: undefined }),
    pauseDurationLimitMs: fc.option(fc.integer({ min: 0, max: 10_000_000 }), { nil: undefined }),
  });
}

/**
 * Generate a (freshnessThresholdMs, oracleAgeMs) pair that is guaranteed stale:
 * age is strictly greater than the threshold. Threshold can be 0..120_000ms and
 * the staleness margin is at least 1ms.
 */
function arbStaleAges(): fc.Arbitrary<{ freshnessThresholdMs: number; oracleAgeMs: number }> {
  return fc
    .tuple(fc.integer({ min: 0, max: 120_000 }), fc.integer({ min: 1, max: 10_000_000 }))
    .map(([freshnessThresholdMs, margin]) => ({
      freshnessThresholdMs,
      oracleAgeMs: freshnessThresholdMs + margin,
    }));
}

/**
 * A guard context where NO hard refusal is active. `evaluationComplete` is
 * generated as either `true` or `undefined` (both mean "complete" per the
 * documented default), oracle is present, network is testnet, guardian is live.
 * Ages are stale and policy/magnitude are arbitrary. `policyPermitsStalePause`
 * is supplied by the caller so both the positive and negative properties reuse
 * this generator.
 */
function arbSafeStaleContext(policyPermitsStalePause: boolean): fc.Arbitrary<FailClosedGuardContext> {
  return fc
    .record({
      evaluationComplete: fc.constantFrom<true | undefined>(true, undefined),
      oracleDetail: fc.option(fc.string(), { nil: undefined }),
      ages: arbStaleAges(),
      policy: arbPolicy(),
      proposedMagnitude: arbMagnitude(),
    })
    .map(({ evaluationComplete, oracleDetail, ages, policy, proposedMagnitude }) => ({
      evaluationComplete,
      // present:true is the only field that matters for the hard refusal; detail
      // is irrelevant when present.
      oracle: { present: true as const, detail: oracleDetail },
      isSuiTestnet: true,
      guardianRevoked: false,
      policy,
      proposedMagnitude,
      oracleAgeMs: ages.oracleAgeMs,
      freshnessThresholdMs: ages.freshnessThresholdMs,
      policyPermitsStalePause,
    }));
}

/** A minimal deterministic-style RiskEvaluation carrying a chosen candidate action. */
function baseEvaluation(recommendedAction: ActionType | null): RiskEvaluation {
  return {
    marketId: 'market-prop6',
    riskScore: 70,
    band: 'Guarded',
    classes: ['oracle staleness'],
    recommendedAction,
    confidence: 80,
    explanation: '',
    ruleOutputs: [{ rule: 'high_utilization', fired: true, value: 'utilization=0.9' }],
    modelVersion: 'm@1',
    promptConfigVersion: 'p@1',
    featureVector: {} as FeatureVector,
  };
}

describe('Property 6: Stale-data emergency recommendation (Req 6.14)', () => {
  it('escalates to an emergency pause with a recorded justification for ANY safe + stale + permitted context', () => {
    fc.assert(
      fc.property(arbCandidate(), arbSafeStaleContext(true), (candidate, ctx) => {
        const evaluation = baseEvaluation(candidate);
        const result = applyFailClosed(evaluation, ctx);

        // Sanity: the generated context is actually stale and free of hard refusals.
        expect(ctx.oracleAgeMs).toBeGreaterThan(ctx.freshnessThresholdMs);
        expect(ctx.oracle.present).toBe(true);
        expect(ctx.isSuiTestnet).toBe(true);
        expect(ctx.guardianRevoked).toBe(false);
        expect(ctx.evaluationComplete === false).toBe(false);
        expect(ctx.policyPermitsStalePause).toBe(true);

        // 1) Recommends the emergency pause regardless of the candidate or bounds.
        expect(result.recommendedAction).toBe('pause_new_borrows');

        // 2) Records a non-empty stale-data justification.
        expect(typeof result.staleDataJustification).toBe('string');
        expect((result.staleDataJustification ?? '').length).toBeGreaterThan(0);

        // 3) A positive recommendation clears any refusal reason.
        expect(result.refusalReason).toBeUndefined();

        // 4) A fired STALE_DATA_PAUSE_RULE rule output is appended to the trail.
        const staleRule = result.ruleOutputs.find((r) => r.rule === STALE_DATA_PAUSE_RULE);
        expect(staleRule).toBeDefined();
        expect(staleRule?.fired).toBe(true);
        // The original deterministic rule outputs are preserved (appended, not replaced).
        expect(result.ruleOutputs.length).toBe(evaluation.ruleOutputs.length + 1);

        // 5) Deterministic core fields are never altered by the escalation.
        expect(result.riskScore).toBe(evaluation.riskScore);
        expect(result.band).toBe(evaluation.band);
        expect(result.classes).toEqual(evaluation.classes);
        expect(result.confidence).toBe(evaluation.confidence);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('does NOT escalate to a stale pause when policy does not permit it (no hard refusal, stale)', () => {
    fc.assert(
      fc.property(arbCandidate(), arbSafeStaleContext(false), (candidate, ctx) => {
        const evaluation = baseEvaluation(candidate);
        const result = applyFailClosed(evaluation, ctx);

        // Stale but not permitted: the stale escalation must not fire.
        expect(result.staleDataJustification).toBeUndefined();
        const staleRule = result.ruleOutputs.find((r) => r.rule === STALE_DATA_PAUSE_RULE);
        expect(staleRule).toBeUndefined();

        // Without the escalation the outcome is either a clean pass-through of the
        // candidate or a bounds refusal — never the stale-data pause justification.
        if (result.refusalReason === undefined) {
          // Pass-through preserves the deterministic candidate and rule outputs.
          expect(result.recommendedAction).toBe(candidate);
          expect(result.ruleOutputs).toEqual(evaluation.ruleOutputs);
        } else {
          // A bounds refusal nulls the action and is NOT a stale-data justification.
          expect(result.recommendedAction).toBeNull();
          expect(result.refusalReason).toMatch(/Risk_Policy bounds/);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
