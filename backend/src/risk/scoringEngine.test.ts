import { describe, expect, it } from 'vitest';

import {
  DEFAULT_SCORING_CONFIG,
  DeterministicRiskEngine,
  aggregateScore,
  assessRisk,
  assignBand,
  classify,
  computeConfidence,
  computeSubscores,
  detectAnomaly,
  selectRecommendedAction,
} from './scoringEngine.js';
import { RISK_CLASSES, type FeatureVector, type RiskClass } from './types.js';

/**
 * A calm, healthy baseline market: fresh oracle, tight confidence, no moves,
 * deep liquidity, low utilization, active policy, no overrides. Tests override
 * individual fields to exercise each rule/group.
 */
function baseFeatures(overrides: Partial<FeatureVector> = {}): FeatureVector {
  return {
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
    ...overrides,
  };
}

describe('aggregateScore', () => {
  it('produces an integer in [0, 100] and respects the weighting', () => {
    // All-zero subscores → 0.
    expect(aggregateScore({ oracle: 0, volatility: 0, liquidity: 0, exposure: 0, governance: 0 }, DEFAULT_SCORING_CONFIG)).toBe(0);
    // All-max subscores → 100.
    expect(aggregateScore({ oracle: 100, volatility: 100, liquidity: 100, exposure: 100, governance: 100 }, DEFAULT_SCORING_CONFIG)).toBe(100);
    // Only oracle (weight 0.25) saturated → 25.
    expect(aggregateScore({ oracle: 100, volatility: 0, liquidity: 0, exposure: 0, governance: 0 }, DEFAULT_SCORING_CONFIG)).toBe(25);
    // Only governance (weight 0.10) saturated → 10.
    expect(aggregateScore({ oracle: 0, volatility: 0, liquidity: 0, exposure: 0, governance: 100 }, DEFAULT_SCORING_CONFIG)).toBe(10);
  });

  it('clamps non-finite intermediate values to [0, 100]', () => {
    const score = aggregateScore(
      { oracle: Number.NaN, volatility: Infinity, liquidity: -50, exposure: 200, governance: 0 },
      DEFAULT_SCORING_CONFIG,
    );
    expect(Number.isInteger(score)).toBe(true);
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(100);
  });
});

describe('assignBand', () => {
  it('partitions [0, 100] into exactly the five bands at the boundaries', () => {
    expect(assignBand(0)).toBe('Normal');
    expect(assignBand(39)).toBe('Normal');
    expect(assignBand(40)).toBe('Warning');
    expect(assignBand(59)).toBe('Warning');
    expect(assignBand(60)).toBe('Guarded');
    expect(assignBand(74)).toBe('Guarded');
    expect(assignBand(75)).toBe('ParamAdjust');
    expect(assignBand(89)).toBe('ParamAdjust');
    expect(assignBand(90)).toBe('EmergencyPause');
    expect(assignBand(100)).toBe('EmergencyPause');
  });

  it('clamps out-of-range scores before banding', () => {
    expect(assignBand(-10)).toBe('Normal');
    expect(assignBand(150)).toBe('EmergencyPause');
  });
});

describe('subscores', () => {
  it('scores a calm market near zero', () => {
    const sub = computeSubscores(baseFeatures(), DEFAULT_SCORING_CONFIG);
    expect(sub.oracle).toBeLessThan(20);
    expect(sub.volatility).toBeLessThan(20);
    expect(sub.liquidity).toBeLessThan(20);
    expect(sub.governance).toBe(0);
  });

  it('saturates oracle risk on a stale feed', () => {
    const sub = computeSubscores(
      baseFeatures({ oracleTimestampMs: 0, nowMs: 1_000_000, freshnessThresholdMs: 30_000 }),
      DEFAULT_SCORING_CONFIG,
    );
    expect(sub.oracle).toBe(100);
  });

  it('drives governance to 100 when the guardian is revoked', () => {
    const sub = computeSubscores(baseFeatures({ guardianRevoked: true }), DEFAULT_SCORING_CONFIG);
    expect(sub.governance).toBe(100);
  });

  it('raises liquidity risk when depth collapses', () => {
    const sub = computeSubscores(baseFeatures({ liquidityDepth: 0 }), DEFAULT_SCORING_CONFIG);
    expect(sub.liquidity).toBe(100);
  });
});

describe('classify', () => {
  it('always returns a non-empty subset of the allowed classes', () => {
    const f = baseFeatures();
    const sub = computeSubscores(f, DEFAULT_SCORING_CONFIG);
    const { classes } = classify(f, sub, DEFAULT_SCORING_CONFIG);
    expect(classes.length).toBeGreaterThan(0);
    for (const c of classes) {
      expect(RISK_CLASSES).toContain(c);
    }
  });

  it('detects a flash crash on a sharp negative move', () => {
    const f = baseFeatures({ priceChange1mPct: -25 });
    const sub = computeSubscores(f, DEFAULT_SCORING_CONFIG);
    const { classes } = classify(f, sub, DEFAULT_SCORING_CONFIG);
    expect(classes).toContain<RiskClass>('flash crash');
  });

  it('detects oracle staleness past the freshness threshold', () => {
    const f = baseFeatures({ oracleTimestampMs: 0, nowMs: 1_000_000, freshnessThresholdMs: 30_000 });
    const sub = computeSubscores(f, DEFAULT_SCORING_CONFIG);
    const { classes } = classify(f, sub, DEFAULT_SCORING_CONFIG);
    expect(classes).toContain<RiskClass>('oracle staleness');
  });

  it('detects a stablecoin depeg against the expected peg', () => {
    const f = baseFeatures({ oraclePrice: 0.95, expectedPegPrice: 1 });
    const sub = computeSubscores(f, DEFAULT_SCORING_CONFIG);
    const { classes } = classify(f, sub, DEFAULT_SCORING_CONFIG);
    expect(classes).toContain<RiskClass>('stablecoin depeg');
  });

  it('detects guardian revocation and governance override', () => {
    const f = baseFeatures({ guardianRevoked: true, priorOverridesCount: 2 });
    const sub = computeSubscores(f, DEFAULT_SCORING_CONFIG);
    const { classes } = classify(f, sub, DEFAULT_SCORING_CONFIG);
    expect(classes).toContain<RiskClass>('guardian revocation');
    expect(classes).toContain<RiskClass>('governance override');
  });

  it('flags data integrity on non-finite / out-of-domain inputs', () => {
    const f = baseFeatures({ utilization: 5, imbalance: 9, oraclePrice: Number.NaN });
    const sub = computeSubscores(f, DEFAULT_SCORING_CONFIG);
    const { classes } = classify(f, sub, DEFAULT_SCORING_CONFIG);
    expect(classes).toContain<RiskClass>('data integrity');
  });
});

describe('detectAnomaly', () => {
  it('flags a move far exceeding realized volatility', () => {
    const a = detectAnomaly(baseFeatures({ priceChange1mPct: 30, realizedVolatilityPct: 2 }), DEFAULT_SCORING_CONFIG);
    expect(a.isAnomaly).toBe(true);
  });

  it('does not flag a move in line with realized volatility', () => {
    const a = detectAnomaly(baseFeatures({ priceChange1mPct: 2, realizedVolatilityPct: 10 }), DEFAULT_SCORING_CONFIG);
    expect(a.isAnomaly).toBe(false);
  });
});

describe('selectRecommendedAction', () => {
  it('maps bands to the expected mitigation action', () => {
    expect(selectRecommendedAction('EmergencyPause', [], { isAnomaly: false })).toBe('pause_new_borrows');
    expect(selectRecommendedAction('ParamAdjust', [], { isAnomaly: false })).toBe('reduce_max_ltv');
    expect(selectRecommendedAction('ParamAdjust', ['liquidation cascade'], { isAnomaly: false })).toBe(
      'reduce_max_ltv',
    );
    expect(selectRecommendedAction('Guarded', [], { isAnomaly: false })).toBe('enter_guarded_mode');
    expect(selectRecommendedAction('Normal', [], { isAnomaly: false })).toBeNull();
  });

  it('escalates a Warning band to guarded mode on a detected anomaly', () => {
    expect(selectRecommendedAction('Warning', [], { isAnomaly: false })).toBeNull();
    expect(selectRecommendedAction('Warning', [], { isAnomaly: true })).toBe('enter_guarded_mode');
  });
});

describe('computeConfidence', () => {
  it('is high for clean, fresh, agreeing inputs', () => {
    const f = baseFeatures();
    const sub = computeSubscores(f, DEFAULT_SCORING_CONFIG);
    const c = computeConfidence(f, sub, DEFAULT_SCORING_CONFIG, false);
    expect(c).toBeGreaterThanOrEqual(80);
    expect(c).toBeLessThanOrEqual(100);
  });

  it('drops when data integrity fires', () => {
    const f = baseFeatures();
    const sub = computeSubscores(f, DEFAULT_SCORING_CONFIG);
    const clean = computeConfidence(f, sub, DEFAULT_SCORING_CONFIG, false);
    const dirty = computeConfidence(f, sub, DEFAULT_SCORING_CONFIG, true);
    expect(dirty).toBeLessThan(clean);
    expect(dirty).toBeGreaterThanOrEqual(0);
  });
});

describe('assessRisk', () => {
  it('scores a calm market in the Normal band with no action', () => {
    const a = assessRisk(baseFeatures());
    expect(a.band).toBe('Normal');
    expect(a.recommendedAction).toBeNull();
    expect(a.riskScore).toBeGreaterThanOrEqual(0);
    expect(a.riskScore).toBeLessThan(40);
  });

  it('escalates a revoked, crashing, illiquid market to a pause recommendation', () => {
    const a = assessRisk(
      baseFeatures({
        guardianRevoked: true,
        priceChange1mPct: -40,
        priceChange5mPct: -50,
        realizedVolatilityPct: 80,
        liquidityDepth: 0,
        spreadBps: 500,
        utilization: 0.98,
        oracleTimestampMs: 0,
        nowMs: 1_000_000,
      }),
    );
    expect(a.band).toBe('EmergencyPause');
    expect(a.recommendedAction).toBe('pause_new_borrows');
    expect(a.classes).toContain<RiskClass>('guardian revocation');
  });
});

describe('DeterministicRiskEngine', () => {
  it('records model version, prompt/config version, and the feature vector (Req 6.12)', async () => {
    const engine = new DeterministicRiskEngine();
    const features = baseFeatures();
    const evaluation = await engine.evaluate('market-1', features);

    expect(evaluation.marketId).toBe('market-1');
    expect(evaluation.modelVersion).toBe(DEFAULT_SCORING_CONFIG.modelVersion);
    expect(evaluation.promptConfigVersion).toBe(DEFAULT_SCORING_CONFIG.promptConfigVersion);
    expect(evaluation.featureVector).toEqual(features);
  });

  it('leaves the explanation empty for the AI service to fill (task 7.5)', async () => {
    const engine = new DeterministicRiskEngine();
    const evaluation = await engine.evaluate('market-1', baseFeatures());
    expect(evaluation.explanation).toBe('');
  });

  it('is deterministic: identical inputs yield identical gating outputs', () => {
    const engine = new DeterministicRiskEngine();
    const features = baseFeatures({ priceChange1mPct: -12, utilization: 0.92 });
    const a = engine.evaluateSync('m', features);
    const b = engine.evaluateSync('m', features);
    expect(a.riskScore).toBe(b.riskScore);
    expect(a.band).toBe(b.band);
    expect(a.classes).toEqual(b.classes);
    expect(a.recommendedAction).toBe(b.recommendedAction);
    expect(a.confidence).toBe(b.confidence);
  });
});
