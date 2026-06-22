// Feature: sentinel-risk-guardian, Property 1: Risk score is always within range
//
// For any feature vector (including extreme, missing-defaulted, and adversarial
// values), the Risk_Engine produces a risk score that is an integer in [0, 100]
// and a confidence that is an integer in [0, 100].
//
// Validates: Requirements 6.2, 6.5, 3.3, 14.2

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { featureVectorArbitrary } from './featureVectorArbitrary.js';
import { DeterministicRiskEngine, assessRisk } from './scoringEngine.js';

/** An integer in the inclusive [0, 100] range. */
function isIntegerInUnitPercentRange(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= 100;
}

describe('Property 1: Risk score is always within range', () => {
  it('riskScore and confidence are integers in [0, 100] for any feature vector', () => {
    fc.assert(
      fc.property(featureVectorArbitrary, (features) => {
        const assessment = assessRisk(features);

        expect(isIntegerInUnitPercentRange(assessment.riskScore)).toBe(true);
        expect(isIntegerInUnitPercentRange(assessment.confidence)).toBe(true);
      }),
      { numRuns: 500 },
    );
  });

  it('holds through the full engine evaluation for any feature vector', () => {
    const engine = new DeterministicRiskEngine();

    fc.assert(
      fc.property(featureVectorArbitrary, (features) => {
        const evaluation = engine.evaluateSync('market-prop-1', features);

        expect(isIntegerInUnitPercentRange(evaluation.riskScore)).toBe(true);
        expect(isIntegerInUnitPercentRange(evaluation.confidence)).toBe(true);
      }),
      { numRuns: 500 },
    );
  });
});
