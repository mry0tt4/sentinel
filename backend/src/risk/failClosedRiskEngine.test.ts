import { describe, expect, it } from 'vitest';

import { DeterministicRiskEngine } from './scoringEngine.js';
import {
  FailClosedRiskEngine,
  applyFailClosed,
  decideFailClosed,
  exceedsPolicyBounds,
  isOracleStale,
  STALE_DATA_PAUSE_RULE,
  type FailClosedGuardContext,
} from './failClosedRiskEngine.js';
import type { ActionType, FeatureVector, RiskEvaluation } from './types.js';

/**
 * A guard context for a healthy, in-bounds, fresh Sui Testnet market. Tests
 * override individual fields to exercise each precedence rule.
 */
function baseContext(overrides: Partial<FailClosedGuardContext> = {}): FailClosedGuardContext {
  return {
    evaluationComplete: true,
    oracle: { present: true },
    isSuiTestnet: true,
    guardianRevoked: false,
    policy: {
      allowedActions: [
        'pause_new_borrows',
        'reduce_max_ltv',
        'enter_guarded_mode',
        'increase_maintenance_margin',
      ],
      maxLtvDeltaBps: 1_000,
      maxMarginDeltaBps: 500,
      pauseDurationLimitMs: 3_600_000,
    },
    proposedMagnitude: {},
    oracleAgeMs: 500,
    freshnessThresholdMs: 30_000,
    policyPermitsStalePause: true,
    ...overrides,
  };
}

/** A minimal deterministic-style RiskEvaluation carrying a chosen candidate action. */
function baseEvaluation(
  recommendedAction: ActionType | null,
  overrides: Partial<RiskEvaluation> = {},
): RiskEvaluation {
  return {
    marketId: 'market-1',
    riskScore: 70,
    band: 'Guarded',
    classes: ['high utilization'],
    recommendedAction,
    confidence: 85,
    explanation: '',
    ruleOutputs: [{ rule: 'high_utilization', fired: true, value: 'utilization=0.9' }],
    modelVersion: 'm@1',
    promptConfigVersion: 'p@1',
    featureVector: {} as FeatureVector,
    ...overrides,
  };
}

describe('isOracleStale', () => {
  it('is true only when age strictly exceeds the threshold', () => {
    expect(isOracleStale(31_000, 30_000)).toBe(true);
    expect(isOracleStale(30_000, 30_000)).toBe(false);
    expect(isOracleStale(100, 30_000)).toBe(false);
  });

  it('treats non-finite inputs as not stale (handled by the refusal path instead)', () => {
    expect(isOracleStale(Number.NaN, 30_000)).toBe(false);
    expect(isOracleStale(31_000, Number.POSITIVE_INFINITY)).toBe(false);
  });
});

describe('exceedsPolicyBounds', () => {
  const policy = {
    allowedActions: ['reduce_max_ltv', 'increase_maintenance_margin', 'pause_new_borrows'] as ActionType[],
    maxLtvDeltaBps: 1_000,
    maxMarginDeltaBps: 500,
    pauseDurationLimitMs: 3_600_000,
  };

  it('refuses actions outside the policy allowed set', () => {
    const r = exceedsPolicyBounds('enter_guarded_mode', policy);
    expect(r.exceeded).toBe(true);
    expect(r.reason).toMatch(/allowed actions/);
  });

  it('flags an LTV reduction over the cap and allows one within', () => {
    expect(exceedsPolicyBounds('reduce_max_ltv', policy, { ltvDeltaBps: 1_500 }).exceeded).toBe(true);
    expect(exceedsPolicyBounds('reduce_max_ltv', policy, { ltvDeltaBps: 800 }).exceeded).toBe(false);
  });

  it('flags a margin increase over the cap and a pause over the duration limit', () => {
    expect(exceedsPolicyBounds('increase_maintenance_margin', policy, { marginDeltaBps: 600 }).exceeded).toBe(true);
    expect(exceedsPolicyBounds('pause_new_borrows', policy, { pauseDurationMs: 7_200_000 }).exceeded).toBe(true);
  });

  it('treats absent magnitudes and absent caps as within bounds', () => {
    expect(exceedsPolicyBounds('reduce_max_ltv', policy).exceeded).toBe(false);
    expect(exceedsPolicyBounds('reduce_max_ltv', { allowedActions: ['reduce_max_ltv'] }, { ltvDeltaBps: 9_999 }).exceeded).toBe(false);
  });
});

describe('decideFailClosed — refusals (Req 6.7–6.10, 17.1, 17.2)', () => {
  it('refuses with a reason when the evaluation did not complete (Req 17.2)', () => {
    const d = decideFailClosed('reduce_max_ltv', baseContext({ evaluationComplete: false }));
    expect(d.kind).toBe('refuse');
    expect(d.action).toBeNull();
    if (d.kind === 'refuse') expect(d.refusalReason).toMatch(/did not complete/);
  });

  it('refuses when oracle price/confidence/timestamp is absent or unparseable (Req 6.7)', () => {
    const d = decideFailClosed('reduce_max_ltv', baseContext({ oracle: { present: false, detail: 'timestamp unparseable' } }));
    expect(d.kind).toBe('refuse');
    if (d.kind === 'refuse') {
      expect(d.refusalReason).toMatch(/oracle/);
      expect(d.refusalReason).toMatch(/timestamp unparseable/);
    }
  });

  it('refuses when the network is not Sui Testnet (Req 6.8, 17.1)', () => {
    const d = decideFailClosed('reduce_max_ltv', baseContext({ isSuiTestnet: false }));
    expect(d.kind).toBe('refuse');
    if (d.kind === 'refuse') expect(d.refusalReason).toMatch(/Sui Testnet/);
  });

  it('refuses when the GuardianCap is revoked (Req 6.9)', () => {
    const d = decideFailClosed('pause_new_borrows', baseContext({ guardianRevoked: true }));
    expect(d.kind).toBe('refuse');
    if (d.kind === 'refuse') expect(d.refusalReason).toMatch(/revoked/);
  });

  it('refuses when the recommended action would exceed policy bounds (Req 6.10)', () => {
    const d = decideFailClosed(
      'reduce_max_ltv',
      baseContext({ proposedMagnitude: { ltvDeltaBps: 5_000 } }),
    );
    expect(d.kind).toBe('refuse');
    if (d.kind === 'refuse') expect(d.refusalReason).toMatch(/exceeds Risk_Policy bounds/);
  });

  it('refuses when the recommended action is outside the policy allowed actions (Req 6.10)', () => {
    const d = decideFailClosed(
      'enter_guarded_mode',
      baseContext({ policy: { allowedActions: ['pause_new_borrows'] }, policyPermitsStalePause: false }),
    );
    expect(d.kind).toBe('refuse');
  });
});

describe('decideFailClosed — stale-data emergency escalation (Req 6.14)', () => {
  it('escalates to an emergency pause with a recorded justification when stale and permitted', () => {
    const d = decideFailClosed(
      null, // deterministic engine recommended nothing
      baseContext({ oracleAgeMs: 60_000, freshnessThresholdMs: 30_000, policyPermitsStalePause: true }),
    );
    expect(d.kind).toBe('stale_pause');
    if (d.kind === 'stale_pause') {
      expect(d.action).toBe('pause_new_borrows');
      expect(d.justification).toMatch(/exceeds the configured freshness threshold/);
    }
  });

  it('does not escalate when stale but policy does not permit a stale pause', () => {
    const d = decideFailClosed(
      'enter_guarded_mode',
      baseContext({ oracleAgeMs: 60_000, freshnessThresholdMs: 30_000, policyPermitsStalePause: false }),
    );
    expect(d.kind).toBe('pass');
    if (d.kind === 'pass') expect(d.action).toBe('enter_guarded_mode');
  });

  it('does not escalate when the oracle is fresh', () => {
    const d = decideFailClosed('enter_guarded_mode', baseContext({ oracleAgeMs: 100, freshnessThresholdMs: 30_000 }));
    expect(d.kind).toBe('pass');
  });
});

describe('decideFailClosed — precedence ordering', () => {
  it('refuses on missing oracle data even when a stale pause would otherwise apply (6.7 > 6.14)', () => {
    const d = decideFailClosed(
      null,
      baseContext({
        oracle: { present: false },
        oracleAgeMs: 120_000,
        freshnessThresholdMs: 30_000,
        policyPermitsStalePause: true,
      }),
    );
    expect(d.kind).toBe('refuse');
  });

  it('refuses on a revoked guardian even when a stale pause would otherwise apply (6.9 > 6.14)', () => {
    const d = decideFailClosed(
      null,
      baseContext({
        guardianRevoked: true,
        oracleAgeMs: 120_000,
        freshnessThresholdMs: 30_000,
        policyPermitsStalePause: true,
      }),
    );
    expect(d.kind).toBe('refuse');
    if (d.kind === 'refuse') expect(d.refusalReason).toMatch(/revoked/);
  });

  it('refuses off-testnet even when a stale pause would otherwise apply (6.8 > 6.14)', () => {
    const d = decideFailClosed(
      null,
      baseContext({
        isSuiTestnet: false,
        oracleAgeMs: 120_000,
        freshnessThresholdMs: 30_000,
        policyPermitsStalePause: true,
      }),
    );
    expect(d.kind).toBe('refuse');
    if (d.kind === 'refuse') expect(d.refusalReason).toMatch(/Sui Testnet/);
  });

  it('escalates to a stale pause ahead of a would-be bounds refusal (6.14 > 6.10)', () => {
    const d = decideFailClosed(
      'reduce_max_ltv',
      baseContext({
        proposedMagnitude: { ltvDeltaBps: 9_999 }, // would exceed bounds on its own
        oracleAgeMs: 120_000,
        freshnessThresholdMs: 30_000,
        policyPermitsStalePause: true,
      }),
    );
    expect(d.kind).toBe('stale_pause');
  });
});

describe('applyFailClosed — RiskEvaluation transform', () => {
  it('nulls the action and records the reason on a refusal', () => {
    const evaluation = baseEvaluation('reduce_max_ltv');
    const result = applyFailClosed(evaluation, baseContext({ guardianRevoked: true }));
    expect(result.recommendedAction).toBeNull();
    expect(result.refusalReason).toMatch(/revoked/);
    expect(result.staleDataJustification).toBeUndefined();
    // Deterministic fields are preserved unchanged.
    expect(result.riskScore).toBe(evaluation.riskScore);
    expect(result.band).toBe(evaluation.band);
    expect(result.classes).toEqual(evaluation.classes);
    expect(result.confidence).toBe(evaluation.confidence);
  });

  it('escalates to a stale-data pause, records the justification, and appends a rule output', () => {
    const evaluation = baseEvaluation(null);
    const result = applyFailClosed(
      evaluation,
      baseContext({ oracleAgeMs: 90_000, freshnessThresholdMs: 30_000, policyPermitsStalePause: true }),
    );
    expect(result.recommendedAction).toBe('pause_new_borrows');
    expect(result.refusalReason).toBeUndefined();
    expect(result.staleDataJustification).toMatch(/freshness threshold/);
    const staleRule = result.ruleOutputs.find((r) => r.rule === STALE_DATA_PAUSE_RULE);
    expect(staleRule?.fired).toBe(true);
  });

  it('passes a clean in-bounds testnet recommendation through unchanged', () => {
    const evaluation = baseEvaluation('reduce_max_ltv');
    const result = applyFailClosed(
      evaluation,
      baseContext({ proposedMagnitude: { ltvDeltaBps: 800 }, policyPermitsStalePause: false }),
    );
    expect(result.recommendedAction).toBe('reduce_max_ltv');
    expect(result.refusalReason).toBeUndefined();
    expect(result.staleDataJustification).toBeUndefined();
    expect(result.ruleOutputs).toEqual(evaluation.ruleOutputs);
  });

  it('maintains the invariant: refusalReason is set iff the action is null due to refusal', () => {
    const refused = applyFailClosed(baseEvaluation('reduce_max_ltv'), baseContext({ isSuiTestnet: false }));
    expect(refused.recommendedAction).toBeNull();
    expect(typeof refused.refusalReason).toBe('string');

    const passed = applyFailClosed(baseEvaluation('reduce_max_ltv'), baseContext({ proposedMagnitude: { ltvDeltaBps: 100 }, policyPermitsStalePause: false }));
    expect(passed.recommendedAction).not.toBeNull();
    expect(passed.refusalReason).toBeUndefined();
  });
});

describe('FailClosedRiskEngine — composition over the deterministic engine', () => {
  const features: FeatureVector = {
    oraclePrice: 100,
    oracleConfidence: 0.05,
    oracleTimestampMs: 1_000_000,
    nowMs: 1_000_500,
    freshnessThresholdMs: 30_000,
    priceChange1mPct: 0,
    priceChange5mPct: 0,
    priceChange15mPct: 0,
    realizedVolatilityPct: 1,
    liquidityDepth: 5_000_000,
    spreadBps: 2,
    imbalance: 0,
    utilization: 0.2,
    exposure: 500_000,
    currentMaxLtvBps: 5_000,
    borrowPaused: false,
    guardedMode: false,
    policyActive: true,
    guardianRevoked: false,
    priorActionsCount: 0,
    priorOverridesCount: 0,
    historicalEvidenceRefs: [],
  };

  it('passes a calm-market deterministic result through unchanged on a healthy context', () => {
    const engine = new FailClosedRiskEngine(new DeterministicRiskEngine());
    const result = engine.evaluate('market-1', features, baseContext({ policyPermitsStalePause: false }));
    // Calm market → no action recommended → null with no refusal reason.
    expect(result.recommendedAction).toBeNull();
    expect(result.refusalReason).toBeUndefined();
    expect(result.riskScore).toBeGreaterThanOrEqual(0);
    expect(result.riskScore).toBeLessThan(40);
  });

  it('refuses (null + reason) when the network is not testnet', () => {
    const engine = new FailClosedRiskEngine(new DeterministicRiskEngine());
    const result = engine.evaluate('market-1', features, baseContext({ isSuiTestnet: false }));
    expect(result.recommendedAction).toBeNull();
    expect(result.refusalReason).toMatch(/Sui Testnet/);
  });

  it('fails closed when the inner engine throws (Req 17.2)', () => {
    const throwing = {
      evaluateSync() {
        throw new Error('boom');
      },
    };
    const engine = new FailClosedRiskEngine(throwing);
    const result = engine.evaluate('market-1', features, baseContext());
    expect(result.recommendedAction).toBeNull();
    expect(result.refusalReason).toMatch(/did not complete/);
    expect(result.refusalReason).toMatch(/boom/);
  });
});
