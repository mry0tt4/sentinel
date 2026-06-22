// Feature: sentinel-risk-guardian, Property 18: Evidence bundle completeness
//
// For any generated Evidence_Bundle, the serialized JSON SHALL contain all
// required fields (schema version, market/policy identifiers, timestamp,
// data source + scenario id, prices with oracle confidence/freshness,
// liquidity/exposure snapshots, model versions, feature vector, score,
// classes, recommended/executed action, explanation, deterministic rule
// outputs, agent signer, transaction digest, prior action ids, and raw data
// hash). The serialized JSON must round-trip and deep-contain every field.
//
// Validates: Requirements 10.1

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  ACTION_PRIORITY,
  RISK_CLASSES,
  type ActionType,
  type DeterministicRuleOutput,
  type FeatureVector,
  type RiskBand,
  type RiskClass,
  type RiskEvaluation,
} from '../risk/types.js';
import { EvidenceService } from './evidenceService.js';
import {
  EVIDENCE_SCHEMA_VERSION,
  type ActionContext,
  type EvidenceDataSource,
} from './types.js';

const RISK_BANDS: readonly RiskBand[] = [
  'Normal',
  'Warning',
  'Guarded',
  'ParamAdjust',
  'EmergencyPause',
];

const ACTION_TYPES = Object.keys(ACTION_PRIORITY) as ActionType[];

/**
 * A FINITE number arbitrary. The canonical JSON serializer intentionally
 * rejects NaN/Infinity, so every numeric feature/snapshot value fed into a
 * bundle must be finite. We span a varied-but-finite domain (boundaries,
 * fractions, large/small magnitudes, negatives) without ever producing a
 * non-finite value.
 */
// Note: `-0` is intentionally excluded — JSON has no negative zero
// (`JSON.stringify(-0) === "0"`), so it is not a JSON-meaningful value and would
// spuriously break the round-trip identity check without indicating a real bug.
const finiteNumber: fc.Arbitrary<number> = fc.oneof(
  fc.double({ noNaN: true, noDefaultInfinity: true, min: -1e9, max: 1e9 }),
  fc.integer({ min: -1_000_000, max: 1_000_000 }),
  fc.constantFrom(0, 1, -1, 0.5, -0.5, 100, 7_500, 1_700_000_000_000),
).map((n) => (Object.is(n, -0) ? 0 : n));

/** A non-negative finite timestamp-ish number in ms. */
const finiteTimestamp: fc.Arbitrary<number> = fc.integer({ min: 0, max: 2_000_000_000_000 });

/** A FeatureVector arbitrary with strictly finite numeric fields. */
const finiteFeatureVectorArbitrary: fc.Arbitrary<FeatureVector> = fc.record({
  // Oracle
  oraclePrice: finiteNumber,
  oracleConfidence: finiteNumber,
  oracleTimestampMs: finiteTimestamp,
  nowMs: finiteTimestamp,
  freshnessThresholdMs: finiteNumber,
  referencePrice: fc.option(finiteNumber, { nil: undefined, freq: 2 }),
  expectedPegPrice: fc.option(finiteNumber, { nil: undefined, freq: 2 }),

  // Volatility
  priceChange1mPct: finiteNumber,
  priceChange5mPct: finiteNumber,
  priceChange15mPct: finiteNumber,
  realizedVolatilityPct: finiteNumber,

  // Liquidity
  liquidityDepth: finiteNumber,
  spreadBps: finiteNumber,
  imbalance: finiteNumber,

  // Protocol exposure
  utilization: finiteNumber,
  exposure: finiteNumber,
  currentMaxLtvBps: finiteNumber,

  // Governance / config
  borrowPaused: fc.boolean(),
  guardedMode: fc.boolean(),
  policyActive: fc.boolean(),
  guardianRevoked: fc.boolean(),
  priorActionsCount: finiteNumber,
  priorOverridesCount: finiteNumber,
  historicalEvidenceRefs: fc.array(fc.string()),
});

/** A single deterministic rule output. */
const ruleOutputArbitrary: fc.Arbitrary<DeterministicRuleOutput> = fc.record({
  rule: fc.string({ minLength: 1 }),
  fired: fc.boolean(),
  value: fc.string(),
});

/** A non-empty subset of the closed RiskClass set, preserving canonical order. */
const riskClassesArbitrary: fc.Arbitrary<RiskClass[]> = fc
  .subarray([...RISK_CLASSES], { minLength: 1 })
  .map((classes) => classes as RiskClass[]);

/** A varied-but-valid RiskEvaluation with finite numerics. */
const riskEvaluationArbitrary: fc.Arbitrary<RiskEvaluation> = fc.record({
  marketId: fc.string({ minLength: 1 }),
  riskScore: fc.integer({ min: 0, max: 100 }),
  band: fc.constantFrom(...RISK_BANDS),
  classes: riskClassesArbitrary,
  recommendedAction: fc.option(fc.constantFrom(...ACTION_TYPES), { nil: null }),
  confidence: fc.integer({ min: 0, max: 100 }),
  explanation: fc.string(),
  ruleOutputs: fc.array(ruleOutputArbitrary, { maxLength: 6 }),
  modelVersion: fc.string({ minLength: 1 }),
  promptConfigVersion: fc.string({ minLength: 1 }),
  featureVector: finiteFeatureVectorArbitrary,
});

/** A varied ActionContext; optional fields present or absent. */
const actionContextArbitrary: fc.Arbitrary<ActionContext> = fc.record(
  {
    policyId: fc.string({ minLength: 1 }),
    agentSigner: fc.string({ minLength: 1 }),
    dataSource: fc.constantFrom<EvidenceDataSource>('live', 'simulated'),
    scenarioId: fc.option(fc.string(), { nil: undefined, freq: 2 }),
    txDigest: fc.option(fc.string(), { nil: undefined, freq: 2 }),
    priorActionIds: fc.option(fc.array(fc.string()), { nil: undefined, freq: 2 }),
    executedAction: fc.option(fc.constantFrom(...ACTION_TYPES), { nil: undefined, freq: 2 }),
    timestampMs: fc.option(finiteTimestamp, { nil: undefined, freq: 2 }),
    marketId: fc.option(fc.string({ minLength: 1 }), { nil: undefined, freq: 2 }),
    prices: fc.option(
      fc.record({
        price: finiteNumber,
        confidence: finiteNumber,
        oracleTimestampMs: finiteTimestamp,
        freshnessMs: fc.option(finiteNumber, { nil: undefined, freq: 2 }),
      }),
      { nil: undefined, freq: 2 },
    ),
    liquidity: fc.option(
      fc.record({ depth: finiteNumber, spread: finiteNumber, imbalance: finiteNumber }),
      { nil: undefined, freq: 2 },
    ),
    exposureSnapshot: fc.option(
      fc.record({ utilization: finiteNumber, exposure: finiteNumber }),
      { nil: undefined, freq: 2 },
    ),
  },
  { requiredKeys: ['policyId', 'agentSigner', 'dataSource'] },
);

/** Required top-level keys of the serialized Evidence_Bundle (Req 10.1). */
const REQUIRED_TOP_LEVEL_KEYS = [
  'schemaVersion',
  'marketId',
  'policyId',
  'timestampMs',
  'dataSource',
  'scenarioId',
  'prices',
  'liquidity',
  'exposureSnapshot',
  'riskModelVersion',
  'promptConfigVersion',
  'featureVector',
  'riskScore',
  'riskClasses',
  'recommendedAction',
  'executedAction',
  'aiExplanation',
  'deterministicRuleOutputs',
  'agentSigner',
  'txDigest',
  'priorActionIds',
  'rawDataHash',
] as const;

const REQUIRED_PRICE_KEYS = ['price', 'confidence', 'oracleTimestampMs', 'freshnessMs'] as const;
const REQUIRED_LIQUIDITY_KEYS = ['depth', 'spread', 'imbalance'] as const;
const REQUIRED_EXPOSURE_KEYS = ['utilization', 'exposure'] as const;

describe('Property 18: Evidence bundle completeness', () => {
  const service = new EvidenceService();

  it('serialized JSON contains all required Evidence_Bundle fields (Req 10.1)', () => {
    fc.assert(
      fc.property(
        riskEvaluationArbitrary,
        actionContextArbitrary,
        (evaluation, actionContext) => {
          const bundle = service.generate(evaluation, actionContext);
          const serialized = service.serialize(bundle);
          const parsed = JSON.parse(serialized) as Record<string, unknown>;

          // Every required top-level key is present (a key with a `null`
          // value such as scenarioId/recommendedAction still counts as present).
          for (const key of REQUIRED_TOP_LEVEL_KEYS) {
            expect(
              Object.prototype.hasOwnProperty.call(parsed, key),
              `missing top-level field: ${key}`,
            ).toBe(true);
          }

          // Nested price snapshot keys.
          const prices = parsed.prices as Record<string, unknown>;
          for (const key of REQUIRED_PRICE_KEYS) {
            expect(
              Object.prototype.hasOwnProperty.call(prices, key),
              `missing prices field: ${key}`,
            ).toBe(true);
          }

          // Nested liquidity snapshot keys.
          const liquidity = parsed.liquidity as Record<string, unknown>;
          for (const key of REQUIRED_LIQUIDITY_KEYS) {
            expect(
              Object.prototype.hasOwnProperty.call(liquidity, key),
              `missing liquidity field: ${key}`,
            ).toBe(true);
          }

          // Nested exposure snapshot keys.
          const exposure = parsed.exposureSnapshot as Record<string, unknown>;
          for (const key of REQUIRED_EXPOSURE_KEYS) {
            expect(
              Object.prototype.hasOwnProperty.call(exposure, key),
              `missing exposureSnapshot field: ${key}`,
            ).toBe(true);
          }

          // schemaVersion is the known constant; rawDataHash is a 64-hex digest.
          expect(parsed.schemaVersion).toBe(EVIDENCE_SCHEMA_VERSION);
          expect(parsed.rawDataHash).toMatch(/^[0-9a-f]{64}$/);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('serialized JSON round-trips and deep-contains the bundle fields (Req 10.1)', () => {
    fc.assert(
      fc.property(
        riskEvaluationArbitrary,
        actionContextArbitrary,
        (evaluation, actionContext) => {
          const bundle = service.generate(evaluation, actionContext);
          const parsed = JSON.parse(service.serialize(bundle)) as Record<string, unknown>;

          // Round-trip identity for scalar / structured fields.
          expect(parsed.schemaVersion).toBe(bundle.schemaVersion);
          expect(parsed.marketId).toBe(bundle.marketId);
          expect(parsed.policyId).toBe(bundle.policyId);
          expect(parsed.timestampMs).toBe(bundle.timestampMs);
          expect(parsed.dataSource).toBe(bundle.dataSource);
          expect(parsed.scenarioId ?? null).toEqual(bundle.scenarioId);
          expect(parsed.prices).toEqual(bundle.prices);
          expect(parsed.liquidity).toEqual(bundle.liquidity);
          expect(parsed.exposureSnapshot).toEqual(bundle.exposureSnapshot);
          expect(parsed.riskModelVersion).toBe(bundle.riskModelVersion);
          expect(parsed.promptConfigVersion).toBe(bundle.promptConfigVersion);
          expect(parsed.featureVector).toEqual(bundle.featureVector);
          expect(parsed.riskScore).toBe(bundle.riskScore);
          expect(parsed.riskClasses).toEqual(bundle.riskClasses);
          expect(parsed.recommendedAction ?? null).toEqual(bundle.recommendedAction);
          expect(parsed.executedAction ?? null).toEqual(bundle.executedAction);
          expect(parsed.aiExplanation).toBe(bundle.aiExplanation);
          expect(parsed.deterministicRuleOutputs).toEqual(bundle.deterministicRuleOutputs);
          expect(parsed.agentSigner).toBe(bundle.agentSigner);
          expect(parsed.txDigest ?? null).toEqual(bundle.txDigest);
          expect(parsed.priorActionIds).toEqual(bundle.priorActionIds);
          expect(parsed.rawDataHash).toBe(bundle.rawDataHash);
        },
      ),
      { numRuns: 200 },
    );
  });
});
