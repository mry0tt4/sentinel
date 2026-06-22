// Feature: sentinel-risk-guardian, Property 5: Fail-closed — no action recommended under uncertainty
//
// Property 5: Fail-closed — no action recommended under uncertainty — whenever
// at least one refusal condition holds the engine yields a `null`
// recommendation AND records a non-empty refusal reason, rather than acting on
// untrustworthy data.
//
// Refusal conditions covered (all four categories exercised across the space):
//   1. Missing / unparseable oracle data   — oracle.present === false   (Req 6.7)
//   2. Active network is not Sui Testnet    — isSuiTestnet === false     (Req 6.8, 17.1)
//   3. GuardianCap revoked                  — guardianRevoked === true   (Req 6.9)
//   4. Recommended action out of bounds     — exceedsPolicyBounds true   (Req 6.10)
//
// Validates: Requirements 6.7, 6.8, 6.9, 6.10, 17.1, 17.2
//
// Precedence note (mirrors the implemented order in decideFailClosed):
//   - The three hard refusals (oracle absent / non-testnet / revoked) sit ABOVE
//     the stale-data escalation, so they refuse even when the stale escalation
//     would otherwise fire. The generators for those categories therefore leave
//     the stale fields arbitrary.
//   - The bounds refusal sits BELOW the stale escalation, so the bounds category
//     disables the escalation (policyPermitsStalePause === false) to guarantee
//     the bounds rule is reached and the result is a refusal.

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

import {
  applyFailClosed,
  decideFailClosed,
  exceedsPolicyBounds,
  type FailClosedGuardContext,
  type PolicyActionBounds,
  type ProposedActionMagnitude,
} from './failClosedRiskEngine.js';
import type { ActionType, FeatureVector, RiskEvaluation } from './types.js';

const NUM_RUNS = 200;

const ACTION_TYPES: readonly ActionType[] = [
  'pause_new_borrows',
  'reduce_max_ltv',
  'enter_guarded_mode',
  'increase_maintenance_margin',
];

type RefusalCategory = 'oracle_absent' | 'non_testnet' | 'revoked' | 'out_of_bounds';

/** A generated refusal scenario: the candidate action plus its guard context. */
interface RefusalScenario {
  category: RefusalCategory;
  candidate: ActionType | null;
  ctx: FailClosedGuardContext;
}

// --- Shared building-block arbitraries --------------------------------------

const actionType: fc.Arbitrary<ActionType> = fc.constantFrom(...ACTION_TYPES);
const candidateAction: fc.Arbitrary<ActionType | null> = fc.option(actionType, { nil: null });

const policyArb: fc.Arbitrary<PolicyActionBounds> = fc.record({
  allowedActions: fc.subarray([...ACTION_TYPES]),
  maxLtvDeltaBps: fc.option(fc.integer({ min: 0, max: 2_000 }), { nil: undefined }),
  maxMarginDeltaBps: fc.option(fc.integer({ min: 0, max: 2_000 }), { nil: undefined }),
  pauseDurationLimitMs: fc.option(fc.integer({ min: 0, max: 7_200_000 }), { nil: undefined }),
});

const magnitudeArb: fc.Arbitrary<ProposedActionMagnitude> = fc.record({
  ltvDeltaBps: fc.option(fc.integer({ min: 0, max: 10_000 }), { nil: undefined }),
  marginDeltaBps: fc.option(fc.integer({ min: 0, max: 10_000 }), { nil: undefined }),
  pauseDurationMs: fc.option(fc.integer({ min: 0, max: 14_400_000 }), { nil: undefined }),
});

/** Fields not pinned by a hard-refusal category — kept fully arbitrary, including stale settings. */
const wildStaleAndPolicy = fc.record({
  policy: policyArb,
  proposedMagnitude: magnitudeArb,
  oracleAgeMs: fc.integer({ min: 0, max: 1_000_000 }),
  freshnessThresholdMs: fc.integer({ min: 0, max: 1_000_000 }),
  policyPermitsStalePause: fc.boolean(),
});

// --- Per-category scenario generators ---------------------------------------

// 1. Missing / unparseable oracle data (Req 6.7). Refuses at rule 2, which sits
//    above the stale escalation, so the stale fields stay arbitrary.
const oracleAbsentScenario: fc.Arbitrary<RefusalScenario> = fc
  .tuple(candidateAction, wildStaleAndPolicy, fc.option(fc.string(), { nil: undefined }))
  .map(([candidate, rest, detail]) => ({
    category: 'oracle_absent' as const,
    candidate,
    ctx: {
      evaluationComplete: true,
      oracle: { present: false, detail },
      isSuiTestnet: true,
      guardianRevoked: false,
      ...rest,
    },
  }));

// 2. Non-testnet (Req 6.8, 17.1). Refuses at rule 3 (above the stale escalation).
const nonTestnetScenario: fc.Arbitrary<RefusalScenario> = fc
  .tuple(candidateAction, wildStaleAndPolicy)
  .map(([candidate, rest]) => ({
    category: 'non_testnet' as const,
    candidate,
    ctx: {
      evaluationComplete: true,
      oracle: { present: true },
      isSuiTestnet: false,
      guardianRevoked: false,
      ...rest,
    },
  }));

// 3. Revoked GuardianCap (Req 6.9). Refuses at rule 4 (above the stale escalation).
const revokedScenario: fc.Arbitrary<RefusalScenario> = fc
  .tuple(candidateAction, wildStaleAndPolicy)
  .map(([candidate, rest]) => ({
    category: 'revoked' as const,
    candidate,
    ctx: {
      evaluationComplete: true,
      oracle: { present: true },
      isSuiTestnet: true,
      guardianRevoked: true,
      ...rest,
    },
  }));

// 4a. Out-of-bounds via an action outside the policy's allowed set (Req 6.10).
const outsideAllowedSpec = actionType.chain((candidate) => {
  const others = ACTION_TYPES.filter((a) => a !== candidate);
  return fc.tuple(fc.subarray([...others]), magnitudeArb).map(([allowed, magnitude]) => ({
    candidate,
    // `allowed` never contains `candidate`, so exceedsPolicyBounds is guaranteed true.
    policy: { allowedActions: allowed } as PolicyActionBounds,
    magnitude,
  }));
});

// 4b. Out-of-bounds via a magnitude that strictly exceeds a configured cap (Req 6.10).
const cappedAction = fc.constantFrom<Extract<ActionType, 'reduce_max_ltv' | 'increase_maintenance_margin' | 'pause_new_borrows'>>(
  'reduce_max_ltv',
  'increase_maintenance_margin',
  'pause_new_borrows',
);
const overCapSpec = fc
  .tuple(cappedAction, fc.integer({ min: 0, max: 1_000 }), fc.integer({ min: 1, max: 5_000 }))
  .map(([action, cap, over]) => {
    const value = cap + over; // strictly greater than the cap
    const policy: PolicyActionBounds = { allowedActions: [action] };
    const magnitude: ProposedActionMagnitude = {};
    if (action === 'reduce_max_ltv') {
      policy.maxLtvDeltaBps = cap;
      magnitude.ltvDeltaBps = value;
    } else if (action === 'increase_maintenance_margin') {
      policy.maxMarginDeltaBps = cap;
      magnitude.marginDeltaBps = value;
    } else {
      policy.pauseDurationLimitMs = cap;
      magnitude.pauseDurationMs = value;
    }
    return { candidate: action, policy, magnitude };
  });

const outOfBoundsScenario: fc.Arbitrary<RefusalScenario> = fc
  .tuple(fc.oneof(outsideAllowedSpec, overCapSpec), fc.integer({ min: 0, max: 1_000_000 }), fc.integer({ min: 0, max: 1_000_000 }))
  .map(([spec, oracleAgeMs, freshnessThresholdMs]) => ({
    category: 'out_of_bounds' as const,
    candidate: spec.candidate,
    ctx: {
      evaluationComplete: true,
      oracle: { present: true },
      isSuiTestnet: true,
      guardianRevoked: false,
      policy: spec.policy,
      proposedMagnitude: spec.magnitude,
      oracleAgeMs,
      freshnessThresholdMs,
      // Disable the stale escalation so the bounds rule (which sits below it) is
      // reached and the result is a refusal rather than an emergency pause.
      policyPermitsStalePause: false,
    },
  }));

/** Any scenario in which AT LEAST ONE refusal condition holds. */
const refusalScenario: fc.Arbitrary<RefusalScenario> = fc.oneof(
  oracleAbsentScenario,
  nonTestnetScenario,
  revokedScenario,
  outOfBoundsScenario,
);

/** A minimal deterministic RiskEvaluation carrying the chosen candidate action. */
function evaluationFor(recommendedAction: ActionType | null): RiskEvaluation {
  return {
    marketId: 'market-under-test',
    riskScore: 70,
    band: 'Guarded',
    classes: ['high utilization'],
    recommendedAction,
    confidence: 80,
    explanation: '',
    ruleOutputs: [{ rule: 'high_utilization', fired: true, value: 'utilization=0.9' }],
    modelVersion: 'm@1',
    promptConfigVersion: 'p@1',
    featureVector: {} as FeatureVector,
  };
}

describe('Property 5: Fail-closed — no action recommended under uncertainty', () => {
  it('refuses (null action + non-empty reason) whenever a refusal condition holds', () => {
    const seen = new Set<RefusalCategory>();

    fc.assert(
      fc.property(refusalScenario, (scenario) => {
        seen.add(scenario.category);

        // Sanity: the out-of-bounds category must genuinely violate the policy
        // (and the stale escalation is disabled so the bounds rule is reached).
        if (scenario.category === 'out_of_bounds' && scenario.candidate !== null) {
          expect(
            exceedsPolicyBounds(scenario.candidate, scenario.ctx.policy, scenario.ctx.proposedMagnitude).exceeded,
          ).toBe(true);
        }

        // Pure decision: must be a refusal with a null action.
        const decision = decideFailClosed(scenario.candidate, scenario.ctx);
        expect(decision.kind).toBe('refuse');
        expect(decision.action).toBeNull();

        // Applied to a RiskEvaluation: null recommendation + recorded reason.
        const guarded = applyFailClosed(evaluationFor(scenario.candidate), scenario.ctx);
        expect(guarded.recommendedAction).toBeNull();
        expect(typeof guarded.refusalReason).toBe('string');
        expect((guarded.refusalReason ?? '').length).toBeGreaterThan(0);
        // A refusal never records a stale-data justification.
        expect(guarded.staleDataJustification).toBeUndefined();
      }),
      { numRuns: NUM_RUNS },
    );

    // All four refusal categories must have been exercised across the space.
    expect(seen).toEqual(new Set<RefusalCategory>(['oracle_absent', 'non_testnet', 'revoked', 'out_of_bounds']));
  });

  it('covers each refusal category deterministically with a concrete context', () => {
    const cases: Array<{ category: RefusalCategory; candidate: ActionType | null; ctx: FailClosedGuardContext }> = [
      {
        category: 'oracle_absent',
        candidate: 'reduce_max_ltv',
        ctx: {
          evaluationComplete: true,
          oracle: { present: false, detail: 'timestamp unparseable' },
          isSuiTestnet: true,
          guardianRevoked: false,
          policy: { allowedActions: [...ACTION_TYPES] },
          proposedMagnitude: {},
          // Stale + permitted would escalate, but the missing-oracle refusal takes precedence.
          oracleAgeMs: 120_000,
          freshnessThresholdMs: 30_000,
          policyPermitsStalePause: true,
        },
      },
      {
        category: 'non_testnet',
        candidate: 'pause_new_borrows',
        ctx: {
          evaluationComplete: true,
          oracle: { present: true },
          isSuiTestnet: false,
          guardianRevoked: false,
          policy: { allowedActions: [...ACTION_TYPES] },
          proposedMagnitude: {},
          oracleAgeMs: 120_000,
          freshnessThresholdMs: 30_000,
          policyPermitsStalePause: true,
        },
      },
      {
        category: 'revoked',
        candidate: 'enter_guarded_mode',
        ctx: {
          evaluationComplete: true,
          oracle: { present: true },
          isSuiTestnet: true,
          guardianRevoked: true,
          policy: { allowedActions: [...ACTION_TYPES] },
          proposedMagnitude: {},
          oracleAgeMs: 120_000,
          freshnessThresholdMs: 30_000,
          policyPermitsStalePause: true,
        },
      },
      {
        category: 'out_of_bounds',
        candidate: 'reduce_max_ltv',
        ctx: {
          evaluationComplete: true,
          oracle: { present: true },
          isSuiTestnet: true,
          guardianRevoked: false,
          policy: { allowedActions: ['reduce_max_ltv'], maxLtvDeltaBps: 1_000 },
          proposedMagnitude: { ltvDeltaBps: 5_000 },
          oracleAgeMs: 500,
          freshnessThresholdMs: 30_000,
          policyPermitsStalePause: false,
        },
      },
    ];

    for (const { candidate, ctx } of cases) {
      const decision = decideFailClosed(candidate, ctx);
      expect(decision.kind).toBe('refuse');
      expect(decision.action).toBeNull();

      const guarded = applyFailClosed(evaluationFor(candidate), ctx);
      expect(guarded.recommendedAction).toBeNull();
      expect(typeof guarded.refusalReason).toBe('string');
      expect((guarded.refusalReason ?? '').length).toBeGreaterThan(0);
    }
  });
});
