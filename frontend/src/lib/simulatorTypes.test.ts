import { describe, expect, it } from 'vitest';

import {
  buildActionOutcomeData,
  buildLabeledData,
  buildLiveOracleData,
  buildSimulatedStepData,
  DATA_SOURCE_LABELS,
  isDataSourceLabel,
  SCENARIO_IDS,
  type SimStepOutcome,
} from './simulatorTypes';

function step(overrides: Partial<SimStepOutcome> = {}): SimStepOutcome {
  return {
    scenarioId: 'sui-flash-crash',
    stepIndex: 1,
    stepLabel: 'flash crash',
    totalSteps: 3,
    features: {
      oraclePrice: 1.3,
      oracleConfidence: 0.06,
      realizedVolatilityPct: 80,
      liquidityDepth: 60_000,
      spreadBps: 350,
      utilization: 0.9,
      exposure: 8_000_000,
    },
    risk: {
      riskScore: 88,
      band: 'EmergencyPause',
      recommendedAction: 'pause_new_borrows',
      classes: ['flash crash'],
      confidence: 90,
    },
    thresholdCrossed: true,
    ...overrides,
  };
}

describe('simulator data-source labeling', () => {
  it('exposes exactly the four allowed labels (Req 14.6)', () => {
    expect(DATA_SOURCE_LABELS).toEqual([
      'live oracle data',
      'simulated scenario data',
      'real testnet transaction',
      'Walrus evidence',
    ]);
  });

  it('registers exactly nine scenarios (Req 14.1)', () => {
    expect(SCENARIO_IDS).toHaveLength(9);
  });

  it('labels live oracle readings as live oracle data', () => {
    const data = buildLiveOracleData({ price: 2, confidence: 0.002, timestampMs: 1 });
    expect(data).toHaveLength(2);
    expect(data.every((d) => d.source === 'live oracle data')).toBe(true);
  });

  it('labels every simulated step datum as simulated scenario data, never live (Req 14.7)', () => {
    const data = buildSimulatedStepData(step());
    expect(data.length).toBeGreaterThan(0);
    expect(data.every((d) => d.source === 'simulated scenario data')).toBe(true);
    expect(data.some((d) => d.source === 'live oracle data')).toBe(false);
    // Risk_Engine outputs are included and also simulated.
    expect(data.find((d) => d.key === 'sim-risk-score')?.value).toBe('88');
  });

  it('labels tx digests as real testnet transaction and blob/hash as Walrus evidence', () => {
    const data = buildActionOutcomeData({
      attempted: true,
      blocked: false,
      success: true,
      txDigest: 'DIGEST123',
      blobId: 'BLOB456',
      evidenceHash: 'HASH789',
    });
    expect(data.find((d) => d.key === 'action-tx-digest')?.source).toBe('real testnet transaction');
    expect(data.find((d) => d.key === 'action-blob-id')?.source).toBe('Walrus evidence');
    expect(data.find((d) => d.key === 'action-evidence-hash')?.source).toBe('Walrus evidence');
  });

  it('assembles a full labeled set where every datum carries exactly one valid label', () => {
    const data = buildLabeledData({
      liveOracle: { price: 2, confidence: 0.002, timestampMs: 1 },
      latestStep: step(),
      action: {
        attempted: true,
        blocked: false,
        success: true,
        txDigest: 'D',
        blobId: 'B',
        evidenceHash: 'H',
      },
    });
    for (const datum of data) {
      expect(isDataSourceLabel(datum.source)).toBe(true);
    }
    // Simulated values never carry the live oracle label.
    const simulated = data.filter((d) => d.key.startsWith('sim-'));
    expect(simulated.every((d) => d.source === 'simulated scenario data')).toBe(true);
  });

  it('returns no data for empty inputs', () => {
    expect(buildLabeledData({})).toEqual([]);
  });
});
