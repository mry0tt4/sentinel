/**
 * Unit tests for the Override Executor (task 19.1): server-defined PTB
 * templates for the DAO Override_Console operations, the required override
 * reason, and the full fail-closed execution flow that weaves the reason into
 * the Evidence_Bundle and the recorded off-chain ActionLog.
 *
 * These are example-based; the dedicated property test (override reason in
 * evidence) is task 19.2.
 */

import { describe, it, expect } from 'vitest';
import { normalizeSuiObjectId } from '@mysten/sui/utils';
import type { Transaction } from '@mysten/sui/transactions';

import {
  OverrideExecutor,
  POLICY_MODULE,
  type OverrideActionRecord,
  type OverrideActionRecorder,
  type OverrideExecuteRequest,
} from './overrideExecutor.js';
import {
  OVERRIDE_OPERATION,
  OverrideRequestError,
  FORBIDDEN_REQUEST_KEYS,
  type OverrideActionRequest,
  type ReverseActionOverrideRequest,
} from './types.js';
import { EvidenceService } from '../evidence/evidenceService.js';
import type {
  EvidenceCoordinator,
  NetworkVerifier,
  TransactionSimulator,
  TransactionSubmitter,
  DryRunResponseLike,
  SubmitResponseLike,
} from './actionExecutor.js';
import type { ActionContext, EvidenceBundle } from '../evidence/types.js';
import type { FeatureVector, RiskEvaluation } from '../risk/types.js';

const POLICY_PACKAGE = '0xabc';
const BLOB_ID = 'walrus-blob-override';
const EVIDENCE_HASH = 'deadbeefcafef00d';
const TX_DIGEST = 'OVERRIDE_DIGEST_1';

// --- Request builders -------------------------------------------------------

function reverseRequest(
  overrides: Partial<ReverseActionOverrideRequest> = {},
): ReverseActionOverrideRequest {
  return {
    operation: OVERRIDE_OPERATION.REVERSE_ACTION,
    reason: 'Oracle recovered; pause no longer warranted',
    policyObjectId: '0xa1',
    overrideCapObjectId: '0xb2',
    actionLogObjectId: '0xc3',
    marketStateObjectId: '0xd4',
    ...overrides,
  };
}

function revokeRequest(): OverrideActionRequest {
  return {
    operation: OVERRIDE_OPERATION.REVOKE_GUARDIAN,
    reason: 'Agent key suspected compromised',
    policyObjectId: '0xa1',
    overrideCapObjectId: '0xb2',
    guardianCapObjectId: '0xe5',
  };
}

function updateThresholdsRequest(): OverrideActionRequest {
  return {
    operation: OVERRIDE_OPERATION.UPDATE_THRESHOLDS,
    reason: 'Retuning bands after market review',
    policyObjectId: '0xa1',
    overrideCapObjectId: '0xb2',
    newMaxLtvDeltaBps: 500,
    newMaxMarginDeltaBps: 300,
    newPauseDurationLimitMs: 3_600_000,
    newCooldownMs: 60_000,
    newRiskThresholds: [40, 60, 75, 90],
  };
}

function unpauseRequest(): OverrideActionRequest {
  return {
    operation: OVERRIDE_OPERATION.UNPAUSE_MARKET,
    reason: 'Conditions normalized; restoring borrows',
    policyObjectId: '0xa1',
    overrideCapObjectId: '0xb2',
    marketStateObjectId: '0xd4',
  };
}

/** Extract the MoveCall commands from a built Transaction's data. */
function moveCalls(
  tx: Transaction,
): Array<{ package: string; module: string; function: string; arguments: unknown[] }> {
  const data = tx.getData();
  return data.commands
    .filter((c): c is typeof c & { MoveCall: NonNullable<unknown> } =>
      'MoveCall' in c && c.MoveCall != null,
    )
    .map((c) => {
      const mc = (
        c as unknown as {
          MoveCall: { package: string; module: string; function: string; arguments: unknown[] };
        }
      ).MoveCall;
      return {
        package: mc.package,
        module: mc.module,
        function: mc.function,
        arguments: mc.arguments,
      };
    });
}

// === buildOverridePtb — server-defined templates ===========================

describe('OverrideExecutor.buildOverridePtb — server-defined templates', () => {
  const executor = new OverrideExecutor({ policyPackageId: POLICY_PACKAGE });

  it('builds reverse_action from the fixed policy template', () => {
    const calls = moveCalls(executor.buildOverridePtb(reverseRequest()));
    expect(calls).toHaveLength(1);
    expect(calls[0].package).toBe(normalizeSuiObjectId(POLICY_PACKAGE));
    expect(calls[0].module).toBe(POLICY_MODULE);
    expect(calls[0].function).toBe('reverse_action');
    // policy, override_cap, action_log, market, reason, reversal_tx_digest, clock
    expect(calls[0].arguments).toHaveLength(7);
  });

  it('builds override_action from the fixed policy template', () => {
    const calls = moveCalls(
      executor.buildOverridePtb(reverseRequest({ operation: OVERRIDE_OPERATION.OVERRIDE_ACTION })),
    );
    expect(calls[0].function).toBe('override_action');
    expect(calls[0].arguments).toHaveLength(7);
  });

  it('builds revoke_guardian from the fixed policy template', () => {
    const calls = moveCalls(executor.buildOverridePtb(revokeRequest()));
    expect(calls).toHaveLength(1);
    expect(calls[0].package).toBe(normalizeSuiObjectId(POLICY_PACKAGE));
    expect(calls[0].module).toBe(POLICY_MODULE);
    expect(calls[0].function).toBe('revoke_guardian');
    // policy, override_cap, guardian_cap, clock
    expect(calls[0].arguments).toHaveLength(4);
  });

  it('builds update_thresholds from the fixed policy template', () => {
    const calls = moveCalls(executor.buildOverridePtb(updateThresholdsRequest()));
    expect(calls[0].function).toBe('update_thresholds');
    // policy, override_cap, ltv, margin, pause_limit, cooldown, thresholds, clock
    expect(calls[0].arguments).toHaveLength(8);
  });

  it('builds unpause_market from the fixed policy template (no clock arg)', () => {
    const calls = moveCalls(executor.buildOverridePtb(unpauseRequest()));
    expect(calls[0].function).toBe('unpause_market');
    // policy, override_cap, market
    expect(calls[0].arguments).toHaveLength(3);
  });
});

// === buildOverridePtb — reason required + rejects arbitrary structure ======

describe('OverrideExecutor.buildOverridePtb — validation', () => {
  const executor = new OverrideExecutor({ policyPackageId: POLICY_PACKAGE });

  it('rejects a reverse override with no reason (Req 11.6)', () => {
    expect(() => executor.buildOverridePtb(reverseRequest({ reason: '' }))).toThrow(
      OverrideRequestError,
    );
    expect(() => executor.buildOverridePtb(reverseRequest({ reason: '   ' }))).toThrow(
      /override reason is required/i,
    );
  });

  it('rejects a reverse override with a missing reason field (Req 11.6)', () => {
    const { reason: _omit, ...noReason } = reverseRequest();
    expect(() =>
      executor.buildOverridePtb(noReason as unknown as OverrideActionRequest),
    ).toThrow(OverrideRequestError);
  });

  it('names the offending field on a reason error', () => {
    try {
      executor.buildOverridePtb(reverseRequest({ reason: '' }));
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(OverrideRequestError);
      expect((err as OverrideRequestError).field).toBe('reason');
    }
  });

  it('rejects an unknown override operation', () => {
    const bad = { ...reverseRequest(), operation: 'delete_everything' } as unknown as OverrideActionRequest;
    expect(() => executor.buildOverridePtb(bad)).toThrow(/Unknown override operation/);
  });

  it('rejects requests that attempt to supply arbitrary PTB structure', () => {
    for (const key of FORBIDDEN_REQUEST_KEYS) {
      const malicious = { ...reverseRequest(), [key]: { foo: 'bar' } } as OverrideActionRequest;
      expect(() => executor.buildOverridePtb(malicious)).toThrow(OverrideRequestError);
    }
  });

  it('rejects malformed structured fields', () => {
    expect(() => executor.buildOverridePtb(reverseRequest({ policyObjectId: '' }))).toThrow(
      OverrideRequestError,
    );
    expect(() => executor.buildOverridePtb(reverseRequest({ actionLogObjectId: '' }))).toThrow(
      OverrideRequestError,
    );
  });
});

// === Full execution flow with fakes ========================================

function makeFeatureVector(): FeatureVector {
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
    borrowPaused: true,
    guardedMode: false,
    policyActive: true,
    guardianRevoked: false,
    priorActionsCount: 1,
    priorOverridesCount: 0,
    historicalEvidenceRefs: [],
  };
}

function makeEvaluation(): RiskEvaluation {
  return {
    marketId: 'market-1',
    riskScore: 42,
    band: 'Warning',
    classes: ['liquidity collapse'],
    recommendedAction: null,
    confidence: 70,
    explanation: 'Conditions normalized.',
    ruleOutputs: [],
    modelVersion: 'risk-model@1.0.0',
    promptConfigVersion: 'prompt@1.0.0',
    featureVector: makeFeatureVector(),
  };
}

function makeContext(): ActionContext {
  return {
    policyId: 'policy-1',
    agentSigner: '0xAGENTPUBLIC',
    dataSource: 'live',
  };
}

interface Fakes {
  callLog: string[];
  network: NetworkVerifier;
  evidence: EvidenceCoordinator;
  submitter: TransactionSubmitter;
  simulator: TransactionSimulator;
  recorder: OverrideActionRecorder;
  generatedContexts: ActionContext[];
  createdRecords: OverrideActionRecord[];
  reversedCalls: Array<{ id: string; by: string; digest: string }>;
}

function makeFakes(): Fakes {
  const callLog: string[] = [];
  const generatedContexts: ActionContext[] = [];
  const createdRecords: OverrideActionRecord[] = [];
  const reversedCalls: Array<{ id: string; by: string; digest: string }> = [];
  const realEvidence = new EvidenceService();

  const network: NetworkVerifier = {
    async verifySubmissionTarget(packageId: string): Promise<void> {
      callLog.push(`network.verifySubmissionTarget:${packageId}`);
    },
    async verifyDigestOrigin(txDigest: string): Promise<boolean> {
      callLog.push(`network.verifyDigestOrigin:${txDigest}`);
      return true;
    },
  };

  // The evidence coordinator uses the REAL EvidenceService.generate so we can
  // assert the override reason actually lands in the bundle's overrideReason.
  const evidence: EvidenceCoordinator = {
    generate(evaluation: RiskEvaluation, actionContext: ActionContext): EvidenceBundle {
      callLog.push('evidence.generate');
      generatedContexts.push(actionContext);
      return realEvidence.generate(evaluation, actionContext);
    },
    async upload(): Promise<{ blobId: string; evidenceHash: string }> {
      callLog.push('evidence.upload');
      return { blobId: BLOB_ID, evidenceHash: EVIDENCE_HASH };
    },
    async link(blobId: string, actionLogId: string, evidenceHash: string): Promise<void> {
      callLog.push(`evidence.link:${blobId}:${actionLogId}:${evidenceHash}`);
    },
  };

  const submitter: TransactionSubmitter = {
    async submit(): Promise<SubmitResponseLike> {
      callLog.push('submitter.submit');
      return {
        txDigest: TX_DIGEST,
        events: [{ type: 'RiskActionOverridden' }],
        effects: { status: { status: 'success' } },
      };
    },
  };

  const simulator: TransactionSimulator = {
    async dryRun(): Promise<DryRunResponseLike> {
      callLog.push('simulator.dryRun');
      return { effects: { status: { status: 'success' } }, events: [] };
    },
  };

  const recorder: OverrideActionRecorder = {
    async create(input: OverrideActionRecord): Promise<{ id: string }> {
      callLog.push('recorder.create');
      createdRecords.push(input);
      return { id: 'reversal-action-1' };
    },
    async markReversed(id: string, reversedBy: string, reversalTxDigest: string): Promise<unknown> {
      callLog.push(`recorder.markReversed:${id}`);
      reversedCalls.push({ id, by: reversedBy, digest: reversalTxDigest });
      return undefined;
    },
  };

  return {
    callLog,
    network,
    evidence,
    submitter,
    simulator,
    recorder,
    generatedContexts,
    createdRecords,
    reversedCalls,
  };
}

function makeExecutor(fakes: Fakes): OverrideExecutor {
  return new OverrideExecutor({ policyPackageId: POLICY_PACKAGE }, fakes.simulator, {
    network: fakes.network,
    evidence: fakes.evidence,
    submitter: fakes.submitter,
    recorder: fakes.recorder,
  });
}

function executeInput(
  request: OverrideActionRequest,
  recordOverrides: Partial<OverrideExecuteRequest['record']> = {},
): OverrideExecuteRequest {
  return {
    request,
    evaluation: makeEvaluation(),
    actionContext: makeContext(),
    actionLogId: 'on-chain-log-1',
    record: {
      policyId: 'policy-1',
      marketId: 'market-1',
      daoAddress: '0xDAO',
      originalActionId: 'original-action-1',
      ...recordOverrides,
    },
  };
}

describe('OverrideExecutor.execute — reason required', () => {
  it('fails at the validation stage when the reason is empty (no network/evidence)', async () => {
    const fakes = makeFakes();
    const executor = makeExecutor(fakes);

    const result = await executor.execute(executeInput(reverseRequest({ reason: '' })));

    expect(result.success).toBe(false);
    expect(result.stage).toBe('validation');
    expect(result.failureReason).toMatch(/override reason is required/i);
    // Nothing was attempted: no network check, no evidence generation.
    expect(fakes.callLog).toEqual([]);
  });
});

describe('OverrideExecutor.execute — reverse happy path (Req 11.4, 11.6)', () => {
  it('weaves the reason into the evidence bundle and the recorded ActionLog', async () => {
    const fakes = makeFakes();
    const executor = makeExecutor(fakes);
    const reason = 'Oracle recovered; pause no longer warranted';

    const result = await executor.execute(executeInput(reverseRequest({ reason })));

    expect(result.success).toBe(true);
    expect(result.stage).toBe('completed');
    expect(result.txDigest).toBe(TX_DIGEST);
    expect(result.overrideReason).toBe(reason);

    // The reason was woven into the action context passed to evidence.generate
    // and therefore into the generated bundle's overrideReason. (Req 11.6)
    expect(fakes.generatedContexts).toHaveLength(1);
    expect(fakes.generatedContexts[0].overrideReason).toBe(reason);
    const bundle = new EvidenceService().generate(makeEvaluation(), {
      ...makeContext(),
      overrideReason: reason,
    });
    expect(bundle.overrideReason).toBe(reason);

    // The reason was recorded on the new (reversal) ActionLog row. (Req 11.4)
    expect(fakes.createdRecords).toHaveLength(1);
    expect(fakes.createdRecords[0].override_reason).toBe(reason);
    expect(fakes.createdRecords[0].actor_type).toBe('dao');
    expect(fakes.createdRecords[0].action_type).toBe('reverse_action');
    expect(fakes.createdRecords[0].tx_digest).toBe(TX_DIGEST);
    expect(result.recordedActionId).toBe('reversal-action-1');
  });

  it('marks the original action reversed (Req 11.4)', async () => {
    const fakes = makeFakes();
    const executor = makeExecutor(fakes);

    const result = await executor.execute(executeInput(reverseRequest()));

    expect(result.originalActionReversed).toBe(true);
    expect(fakes.reversedCalls).toEqual([
      { id: 'original-action-1', by: '0xDAO', digest: TX_DIGEST },
    ]);
  });

  it('runs the fail-closed flow in order: network → evidence → build → simulate → submit → record → link', async () => {
    const fakes = makeFakes();
    const executor = makeExecutor(fakes);

    await executor.execute(executeInput(reverseRequest()));

    expect(fakes.callLog).toEqual([
      `network.verifySubmissionTarget:${POLICY_PACKAGE}`,
      'evidence.generate',
      'evidence.upload',
      'simulator.dryRun',
      'submitter.submit',
      `network.verifyDigestOrigin:${TX_DIGEST}`,
      'recorder.create',
      'recorder.markReversed:original-action-1',
      `evidence.link:${BLOB_ID}:reversal-action-1:${EVIDENCE_HASH}`,
    ]);
  });
});

describe('OverrideExecutor.execute — revoke_guardian (Req 12.1)', () => {
  it('records the override with its reason and does NOT mark any action reversed', async () => {
    const fakes = makeFakes();
    const executor = makeExecutor(fakes);

    const result = await executor.execute(
      executeInput(revokeRequest(), { originalActionId: undefined }),
    );

    expect(result.success).toBe(true);
    expect(result.operation).toBe('revoke_guardian');
    expect(result.overrideReason).toBe('Agent key suspected compromised');
    expect(result.originalActionReversed).toBe(false);
    expect(fakes.reversedCalls).toEqual([]);
    expect(fakes.createdRecords[0].action_type).toBe('revoke_guardian');
    expect(fakes.createdRecords[0].override_reason).toBe('Agent key suspected compromised');
  });
});

describe('OverrideExecutor.execute — missing dependencies', () => {
  it('throws when execution dependencies are not injected', async () => {
    const fakes = makeFakes();
    const executor = new OverrideExecutor({ policyPackageId: POLICY_PACKAGE }, fakes.simulator);
    await expect(executor.execute(executeInput(reverseRequest()))).rejects.toThrow(
      /requires injected/,
    );
  });
});
