import { describe, expect, it, vi } from 'vitest';

import {
  LlmExplanationService,
  MAX_EXPLANATION_CHARS,
  TemplateExplanationService,
  attachExplanation,
  createAiExplanationService,
  explainEvaluation,
  truncateExplanation,
  type ExplanationInput,
  type LlmClient,
} from './aiExplanationService.js';
import { DeterministicRiskEngine } from './scoringEngine.js';
import { RISK_CLASSES, type DeterministicRuleOutput, type FeatureVector, type RiskEvaluation } from './types.js';

/** A representative explanation input with a couple of fired rules. */
function baseInput(overrides: Partial<ExplanationInput> = {}): ExplanationInput {
  return {
    score: 82,
    band: 'ParamAdjust',
    classes: ['flash crash', 'high utilization'],
    ruleOutputs: [
      { rule: 'flash_crash', fired: true, value: '1m=-12% 5m=-18%' },
      { rule: 'high_utilization', fired: true, value: 'utilization=0.9' },
      { rule: 'oracle_staleness', fired: false, value: 'ageMs=500 thresholdMs=30000' },
    ],
    ...overrides,
  };
}

/** A minimal, calm feature vector for engine-backed tests. */
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

describe('truncateExplanation', () => {
  it('returns short strings unchanged (whitespace-normalized)', () => {
    expect(truncateExplanation('hello world')).toBe('hello world');
    expect(truncateExplanation('hello   \n  world')).toBe('hello world');
  });

  it('hard-truncates to at most MAX_EXPLANATION_CHARS with an ellipsis', () => {
    const long = 'a'.repeat(5000);
    const out = truncateExplanation(long);
    expect(out.length).toBeLessThanOrEqual(MAX_EXPLANATION_CHARS);
    expect(out.endsWith('…')).toBe(true);
  });

  it('handles non-string and empty inputs safely', () => {
    expect(truncateExplanation(undefined)).toBe('');
    expect(truncateExplanation(null)).toBe('');
    expect(truncateExplanation(12345).length).toBeLessThanOrEqual(MAX_EXPLANATION_CHARS);
  });

  it('respects a custom max', () => {
    expect(truncateExplanation('abcdef', 3)).toBe('ab…');
    expect(truncateExplanation('abcdef', 1)).toBe('…');
    expect(truncateExplanation('abcdef', 0)).toBe('');
  });
});

describe('TemplateExplanationService', () => {
  it('produces a non-empty explanation within the char limit', async () => {
    const svc = new TemplateExplanationService();
    const text = await svc.explain(baseInput());
    expect(text.length).toBeGreaterThan(0);
    expect(text.length).toBeLessThanOrEqual(MAX_EXPLANATION_CHARS);
    expect(text).toContain('82/100');
    expect(text).toContain('ParamAdjust');
  });

  it('enforces truncation even with all classes and long rule outputs', async () => {
    const svc = new TemplateExplanationService();
    const ruleOutputs: DeterministicRuleOutput[] = Array.from({ length: 50 }, (_, i) => ({
      rule: `verbose_rule_${i}`,
      fired: true,
      value: 'x'.repeat(200),
    }));
    const text = await svc.explain({
      score: 100,
      band: 'EmergencyPause',
      classes: [...RISK_CLASSES],
      ruleOutputs,
    });
    expect(text.length).toBeLessThanOrEqual(MAX_EXPLANATION_CHARS);
    expect(text.endsWith('…')).toBe(true);
  });

  it('handles an empty class list and no fired rules', async () => {
    const svc = new TemplateExplanationService();
    const text = await svc.explain({ score: 5, band: 'Normal', classes: [], ruleOutputs: [] });
    expect(text.length).toBeGreaterThan(0);
    expect(text).toContain('No deterministic rules fired.');
  });
});

describe('LlmExplanationService', () => {
  it('uses the injected client output', async () => {
    const llm: LlmClient = { complete: vi.fn().mockResolvedValue('Model-authored narrative.') };
    const svc = new LlmExplanationService(llm);
    const text = await svc.explain(baseInput());
    expect(llm.complete).toHaveBeenCalledOnce();
    expect(text).toBe('Model-authored narrative.');
  });

  it('truncates a verbose model response', async () => {
    const llm: LlmClient = { complete: vi.fn().mockResolvedValue('y'.repeat(5000)) };
    const svc = new LlmExplanationService(llm);
    const text = await svc.explain(baseInput());
    expect(text.length).toBeLessThanOrEqual(MAX_EXPLANATION_CHARS);
    expect(text.endsWith('…')).toBe(true);
  });

  it('falls back to the template when the client throws', async () => {
    const llm: LlmClient = { complete: vi.fn().mockRejectedValue(new Error('no network')) };
    const svc = new LlmExplanationService(llm);
    const text = await svc.explain(baseInput());
    expect(text.length).toBeGreaterThan(0);
    expect(text.length).toBeLessThanOrEqual(MAX_EXPLANATION_CHARS);
    expect(text).toContain('82/100');
  });

  it('falls back when the client returns a blank string', async () => {
    const llm: LlmClient = { complete: vi.fn().mockResolvedValue('   \n  ') };
    const svc = new LlmExplanationService(llm);
    const text = await svc.explain(baseInput());
    expect(text.length).toBeGreaterThan(0);
  });

  it('builds a prompt that instructs the model not to take actions', () => {
    const svc = new LlmExplanationService({ complete: vi.fn() });
    const prompt = svc.buildPrompt(baseInput());
    expect(prompt).toContain('do not recommend or take any action');
    expect(prompt).toContain('82/100');
  });
});

describe('createAiExplanationService', () => {
  it('returns the template service when no LLM is configured', () => {
    expect(createAiExplanationService()).toBeInstanceOf(TemplateExplanationService);
  });

  it('returns the LLM service when an LLM is provided', () => {
    expect(createAiExplanationService({ llm: { complete: vi.fn() } })).toBeInstanceOf(LlmExplanationService);
  });
});

describe('attachExplanation / explainEvaluation (no authority over gating fields)', () => {
  function sampleEvaluation(): RiskEvaluation {
    return new DeterministicRiskEngine().evaluateSync('market-1', baseFeatures({ utilization: 0.95 }));
  }

  it('fills the explanation without mutating the original evaluation', () => {
    const evaluation = sampleEvaluation();
    const snapshot = JSON.stringify(evaluation);
    const next = attachExplanation(evaluation, 'because reasons');

    // Original untouched.
    expect(JSON.stringify(evaluation)).toBe(snapshot);
    expect(evaluation.explanation).toBe('');
    // New object carries the explanation.
    expect(next.explanation).toBe('because reasons');
    expect(next).not.toBe(evaluation);
  });

  it('preserves every deterministic gating field unchanged', () => {
    const evaluation = sampleEvaluation();
    const next = attachExplanation(evaluation, 'z'.repeat(5000));

    expect(next.riskScore).toBe(evaluation.riskScore);
    expect(next.band).toBe(evaluation.band);
    expect(next.classes).toEqual(evaluation.classes);
    expect(next.recommendedAction).toBe(evaluation.recommendedAction);
    expect(next.confidence).toBe(evaluation.confidence);
    expect(next.refusalReason).toBe(evaluation.refusalReason);
    // Explanation still bounded.
    expect(next.explanation.length).toBeLessThanOrEqual(MAX_EXPLANATION_CHARS);
  });

  it('copies array fields so mutating the result cannot affect the original', () => {
    const evaluation = sampleEvaluation();
    const next = attachExplanation(evaluation, 'x');
    next.classes.push('data integrity');
    next.ruleOutputs[0].fired = !next.ruleOutputs[0].fired;
    expect(next.classes).not.toEqual(evaluation.classes);
  });

  it('explainEvaluation produces a bounded explanation and keeps gating identical', async () => {
    const evaluation = sampleEvaluation();
    const llm: LlmClient = { complete: vi.fn().mockResolvedValue('w'.repeat(4000)) };
    const next = await explainEvaluation(createAiExplanationService({ llm }), evaluation);

    expect(next.explanation.length).toBeLessThanOrEqual(MAX_EXPLANATION_CHARS);
    expect(next.riskScore).toBe(evaluation.riskScore);
    expect(next.band).toBe(evaluation.band);
    expect(next.classes).toEqual(evaluation.classes);
    expect(next.recommendedAction).toBe(evaluation.recommendedAction);
    // The explanation service only receives a value copy; the evaluation object
    // it cannot reach is unchanged.
    expect(evaluation.explanation).toBe('');
  });
});
