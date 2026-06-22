// Feature: sentinel-risk-guardian, Property 4: Explanation never gates decisions (deterministic independence)
//
// **Validates: Requirements 6.5, 6.11, 6.13**
//
// Property 4: For ANY feature vector — including extreme, adversarial, and
// missing (undefined optional) values — the deterministic gating outputs
// (riskScore, band, classes, recommendedAction, confidence) are IDENTICAL
// regardless of what the AI Explanation Service produces, and every produced
// explanation is at most MAX_EXPLANATION_CHARS (1000) characters.
//
// We prove independence by:
//   1. Computing the deterministic evaluation ONCE (the source of truth).
//   2. Driving the LlmExplanationService with a stub LlmClient that returns a
//      wide range of adversarial strings (empty, blank, short, 5000-char,
//      special/control characters, multi-line, non-finite-looking text), plus
//      the deterministic template fallback, plus a throwing client.
//   3. Asserting that for EVERY explanation variant, attaching the explanation
//      leaves the gating fields byte-for-byte identical to the source-of-truth
//      evaluation, and that the explanation length never exceeds the bound.
//
// The explanation is structurally incapable of feeding back into the gating
// path: `attachExplanation` copies the deterministic fields unchanged and only
// sets `explanation`. This test pins that guarantee across the input space.

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  LlmExplanationService,
  MAX_EXPLANATION_CHARS,
  TemplateExplanationService,
  attachExplanation,
  explainEvaluation,
  type AiExplanationService,
  type LlmClient,
} from './aiExplanationService.js';
import { DeterministicRiskEngine } from './scoringEngine.js';
import type { RiskEvaluation } from './types.js';
import { featureVectorArbitrary } from './featureVectorArbitrary.js';

/** A stub LlmClient that always returns a fixed string, ignoring the prompt. */
function fixedLlmClient(response: string): LlmClient {
  return { complete: async () => response };
}

/** A stub LlmClient that always rejects, modelling a failing/unavailable model. */
const throwingLlmClient: LlmClient = {
  complete: async () => {
    throw new Error('llm unavailable');
  },
};

/**
 * Adversarial explanation strings the AI service might emit. These deliberately
 * include empties, blanks, control characters, multi-line content, and a
 * pathologically long (5000-char) string to stress the 1000-char guarantee.
 */
const explanationStringArbitrary: fc.Arbitrary<string> = fc.oneof(
  fc.constant(''),
  fc.constant('   '),
  fc.constant('\n\n\t  \r'),
  fc.constant('A short explanation.'),
  fc.constant('x'.repeat(5000)),
  fc.constant('💥 emoji and spëcïäl çhärs — \u0000\u001f control \u007f bytes 🚨🚨🚨'),
  fc.constant('line one\nline two\nline three\n'.repeat(200)),
  fc.constant('NaN Infinity -Infinity null undefined { score: 0 } DROP TABLE markets;'),
  fc.string(),
  fc.string({ minLength: 1001, maxLength: 6000 }),
  fc.array(fc.constantFrom('risk', 'score', 'band', 'pause', ' '), { maxLength: 2000 }).map((a) => a.join('')),
);

/** The deterministic gating fields that MUST be invariant to the explanation. */
function gatingFields(e: RiskEvaluation) {
  return {
    marketId: e.marketId,
    riskScore: e.riskScore,
    band: e.band,
    classes: [...e.classes],
    recommendedAction: e.recommendedAction,
    refusalReason: e.refusalReason,
    confidence: e.confidence,
    modelVersion: e.modelVersion,
    promptConfigVersion: e.promptConfigVersion,
  };
}

const engine = new DeterministicRiskEngine();
const MARKET_ID = 'market-prop-4';

describe('Property 4: explanation never gates decisions (deterministic independence)', () => {
  it('gating outputs are identical across many different explanation strings, and explanation <= 1000 chars', async () => {
    await fc.assert(
      fc.asyncProperty(
        featureVectorArbitrary,
        fc.array(explanationStringArbitrary, { minLength: 2, maxLength: 6 }),
        async (features, explanations) => {
          // Source of truth: deterministic evaluation computed ONCE.
          const baseline = engine.evaluateSync(MARKET_ID, features);
          const baselineGating = gatingFields(baseline);

          // The placeholder evaluation carries no explanation yet.
          expect(baseline.explanation).toBe('');

          for (const explanation of explanations) {
            // 1. Direct attach of an arbitrary explanation string.
            const attached = attachExplanation(baseline, explanation);
            expect(gatingFields(attached)).toEqual(baselineGating);
            expect(attached.explanation.length).toBeLessThanOrEqual(MAX_EXPLANATION_CHARS);

            // 2. Full LLM service path with a stub returning this string.
            const llmService = new LlmExplanationService(fixedLlmClient(explanation));
            const viaLlm = await explainEvaluation(llmService, baseline);
            expect(gatingFields(viaLlm)).toEqual(baselineGating);
            expect(viaLlm.explanation.length).toBeLessThanOrEqual(MAX_EXPLANATION_CHARS);
          }

          // 3. Deterministic template fallback service.
          const templateService: AiExplanationService = new TemplateExplanationService();
          const viaTemplate = await explainEvaluation(templateService, baseline);
          expect(gatingFields(viaTemplate)).toEqual(baselineGating);
          expect(viaTemplate.explanation.length).toBeLessThanOrEqual(MAX_EXPLANATION_CHARS);

          // 4. A failing LLM client must fall back without touching gating.
          const failing = new LlmExplanationService(throwingLlmClient);
          const viaFailing = await explainEvaluation(failing, baseline);
          expect(gatingFields(viaFailing)).toEqual(baselineGating);
          expect(viaFailing.explanation.length).toBeLessThanOrEqual(MAX_EXPLANATION_CHARS);
        },
      ),
      { numRuns: 150 },
    );
  });

  it('the explanation length bound holds for every explanation variant in isolation', async () => {
    await fc.assert(
      fc.asyncProperty(featureVectorArbitrary, explanationStringArbitrary, async (features, explanation) => {
        const baseline = engine.evaluateSync(MARKET_ID, features);

        const attached = attachExplanation(baseline, explanation);
        expect(attached.explanation.length).toBeLessThanOrEqual(MAX_EXPLANATION_CHARS);

        const llmService = new LlmExplanationService(fixedLlmClient(explanation));
        const explained = await explainEvaluation(llmService, baseline);
        expect(explained.explanation.length).toBeLessThanOrEqual(MAX_EXPLANATION_CHARS);
      }),
      { numRuns: 150 },
    );
  });
});
