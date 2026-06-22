import { describe, expect, it } from 'vitest';

import type { FeatureVector, RiskEvaluation } from '../risk/types.js';
import { canonicalJsonStringify } from './canonicalJson.js';
import { EvidenceService } from './evidenceService.js';
import { EVIDENCE_SCHEMA_VERSION, type ActionContext } from './types.js';

/** A representative feature vector for tests. */
function makeFeatureVector(overrides: Partial<FeatureVector> = {}): FeatureVector {
  return {
    oraclePrice: 1850.25,
    oracleConfidence: 0.5,
    oracleTimestampMs: 1_700_000_000_000,
    nowMs: 1_700_000_003_000,
    freshnessThresholdMs: 10_000,
    priceChange1mPct: -1.2,
    priceChange5mPct: -3.4,
    priceChange15mPct: -5.6,
    realizedVolatilityPct: 12.5,
    liquidityDepth: 250_000,
    spreadBps: 18,
    imbalance: -0.35,
    utilization: 0.82,
    exposure: 4_200_000,
    currentMaxLtvBps: 7_500,
    borrowPaused: false,
    guardedMode: false,
    policyActive: true,
    guardianRevoked: false,
    priorActionsCount: 1,
    priorOverridesCount: 0,
    historicalEvidenceRefs: ['blob-a', 'blob-b'],
    ...overrides,
  };
}

/** A representative completed risk evaluation for tests. */
function makeEvaluation(overrides: Partial<RiskEvaluation> = {}): RiskEvaluation {
  return {
    marketId: 'market-1',
    riskScore: 82,
    band: 'ParamAdjust',
    classes: ['high utilization', 'liquidity collapse'],
    recommendedAction: 'reduce_max_ltv',
    confidence: 90,
    explanation: 'Utilization and falling liquidity warrant an LTV reduction.',
    ruleOutputs: [
      { rule: 'utilization_high', fired: true, value: '0.82' },
      { rule: 'oracle_stale', fired: false, value: '3000ms' },
    ],
    modelVersion: 'risk-model@1.2.3',
    promptConfigVersion: 'prompt@4.5.6',
    featureVector: makeFeatureVector(),
    ...overrides,
  };
}

/** A representative action context for tests. */
function makeContext(overrides: Partial<ActionContext> = {}): ActionContext {
  return {
    policyId: 'policy-1',
    agentSigner: '0xAGENTPUBLICADDRESS',
    dataSource: 'live',
    scenarioId: null,
    txDigest: 'DIGEST123',
    priorActionIds: ['action-1'],
    executedAction: 'reduce_max_ltv',
    ...overrides,
  };
}

describe('EvidenceService.generate', () => {
  const service = new EvidenceService();

  it('includes every required Evidence_Bundle field (Req 10.1)', () => {
    const bundle = service.generate(makeEvaluation(), makeContext());

    // Identity / timing
    expect(bundle.schemaVersion).toBe(EVIDENCE_SCHEMA_VERSION);
    expect(bundle.marketId).toBe('market-1');
    expect(bundle.policyId).toBe('policy-1');
    expect(bundle.timestampMs).toBe(1_700_000_003_000); // defaults to fv.nowMs
    expect(bundle.dataSource).toBe('live');
    expect(bundle.scenarioId).toBeNull();

    // Snapshots derived from the feature vector
    expect(bundle.prices).toEqual({
      price: '1850.25',
      confidence: '0.5',
      oracleTimestampMs: 1_700_000_000_000,
      freshnessMs: 3_000,
    });
    expect(bundle.liquidity).toEqual({ depth: '250000', spread: '18', imbalance: '-0.35' });
    expect(bundle.exposureSnapshot).toEqual({ utilization: '0.82', exposure: '4200000' });

    // Model versions + features
    expect(bundle.riskModelVersion).toBe('risk-model@1.2.3');
    expect(bundle.promptConfigVersion).toBe('prompt@4.5.6');
    expect(bundle.featureVector).toEqual(makeFeatureVector());

    // Score / classes / actions / explanation / rules
    expect(bundle.riskScore).toBe(82);
    expect(bundle.riskClasses).toEqual(['high utilization', 'liquidity collapse']);
    expect(bundle.recommendedAction).toBe('reduce_max_ltv');
    expect(bundle.executedAction).toBe('reduce_max_ltv');
    expect(bundle.aiExplanation).toContain('LTV reduction');
    expect(bundle.deterministicRuleOutputs).toHaveLength(2);

    // Signer / digest / prior actions / hash
    expect(bundle.agentSigner).toBe('0xAGENTPUBLICADDRESS');
    expect(bundle.txDigest).toBe('DIGEST123');
    expect(bundle.priorActionIds).toEqual(['action-1']);
    expect(bundle.rawDataHash).toMatch(/^[0-9a-f]{64}$/);

    // Confirm no required key is missing or undefined
    const requiredKeys = [
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
    for (const key of requiredKeys) {
      expect(bundle[key], `missing field: ${key}`).toBeDefined();
    }
  });

  it('produces a deterministic rawDataHash for identical inputs', () => {
    const h1 = service.generate(makeEvaluation(), makeContext()).rawDataHash;
    const h2 = service.generate(makeEvaluation(), makeContext()).rawDataHash;
    expect(h1).toBe(h2);
  });

  it('changes the rawDataHash when any input changes', () => {
    const base = service.generate(makeEvaluation(), makeContext()).rawDataHash;
    const diffScore = service.generate(
      makeEvaluation({ riskScore: 83 }),
      makeContext(),
    ).rawDataHash;
    const diffSigner = service.generate(
      makeEvaluation(),
      makeContext({ agentSigner: '0xOTHER' }),
    ).rawDataHash;
    expect(diffScore).not.toBe(base);
    expect(diffSigner).not.toBe(base);
  });

  it('the rawDataHash verifies against a fresh canonical hash of the bundle data', async () => {
    const { createHash } = await import('node:crypto');
    const bundle = service.generate(makeEvaluation(), makeContext());
    const { rawDataHash, ...rest } = bundle;
    const recomputed = createHash('sha256')
      .update(canonicalJsonStringify(rest), 'utf8')
      .digest('hex');
    expect(recomputed).toBe(rawDataHash);
  });

  it('defaults optional context fields (nullable action/digest/scenario, empty priors)', () => {
    const bundle = service.generate(
      makeEvaluation({ recommendedAction: null }),
      { policyId: 'policy-2', agentSigner: '0xPUB', dataSource: 'simulated' },
    );
    expect(bundle.recommendedAction).toBeNull();
    expect(bundle.executedAction).toBeNull();
    expect(bundle.txDigest).toBeNull();
    expect(bundle.scenarioId).toBeNull();
    expect(bundle.priorActionIds).toEqual([]);
    expect(bundle.dataSource).toBe('simulated');
  });

  it('honors context snapshot overrides over feature-vector-derived values', () => {
    const bundle = service.generate(
      makeEvaluation(),
      makeContext({
        prices: { price: 2000, confidence: 1, oracleTimestampMs: 1_700_000_001_000 },
        liquidity: { depth: 999, spread: 5, imbalance: 0.1 },
        exposureSnapshot: { utilization: 0.5, exposure: 100 },
      }),
    );
    expect(bundle.prices.price).toBe('2000');
    expect(bundle.prices.freshnessMs).toBe(2_000); // 1_700_000_003_000 - 1_700_000_001_000
    expect(bundle.liquidity.depth).toBe('999');
    expect(bundle.exposureSnapshot.exposure).toBe('100');
  });

  it('uses a simulated scenario id when provided', () => {
    const bundle = service.generate(
      makeEvaluation(),
      makeContext({ dataSource: 'simulated', scenarioId: 'flash-crash-1' }),
    );
    expect(bundle.dataSource).toBe('simulated');
    expect(bundle.scenarioId).toBe('flash-crash-1');
  });

  it('never includes secret/private-key fields (Req 10.8)', () => {
    const bundle = service.generate(makeEvaluation(), makeContext());
    const serialized = service.serialize(bundle).toLowerCase();
    for (const bad of ['privatekey', 'private_key', 'secret', 'mnemonic', 'passphrase']) {
      expect(serialized).not.toContain(bad);
    }
  });
});

describe('EvidenceService.serialize', () => {
  const service = new EvidenceService();

  it('serializes a bundle deterministically (stable key order)', () => {
    const bundle = service.generate(makeEvaluation(), makeContext());
    expect(service.serialize(bundle)).toBe(service.serialize(bundle));
  });
});
