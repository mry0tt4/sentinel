// Feature: sentinel-risk-guardian, Property 32: Override reason is required and recorded in evidence
/**
 * Property test for task 19.2 — Override reason is required and recorded in
 * evidence.
 *
 * Property 32 (Validates: Requirements 11.6, 11.4):
 *
 *  (a) REASON REQUIRED (Req 11.6): for arbitrary override/reverse requests with
 *      a MISSING or empty/blank reason, both `assertValidOverrideRequest` and
 *      `OverrideExecutor.execute` reject with an `OverrideRequestError` naming
 *      the `reason` field — no evidence is generated and nothing is submitted.
 *
 *  (b) REASON RECORDED (Req 11.6, 11.4): for arbitrary override/reverse requests
 *      with a NON-EMPTY reason, after a successful `execute` the reason appears
 *      in BOTH the generated Evidence_Bundle (`bundle.overrideReason === reason`)
 *      AND the recorded ActionLog override row (`override_reason === reason`).
 *      For reversal operations the original action is additionally marked
 *      reversed (Req 11.4).
 *
 * The real {@link EvidenceService} is used so the bundle is genuinely generated;
 * fake network/submitter/recorder ports capture the recorded row and the
 * uploaded bundle, mirroring `overrideExecutor.test.ts`.
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import {
  OverrideExecutor,
  assertValidOverrideRequest,
  type OverrideActionRecord,
  type OverrideActionRecorder,
  type OverrideExecuteRequest,
} from './overrideExecutor.js';
import {
  OVERRIDE_OPERATION,
  REVERSAL_OPERATIONS,
  OverrideRequestError,
  type OverrideActionRequest,
  type OverrideOperation,
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

// --- Evaluation / context fixtures (mirrors overrideExecutor.test.ts) -------

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

// --- Fakes that capture the uploaded bundle + recorded row ------------------

interface Fakes {
  callLog: string[];
  network: NetworkVerifier;
  evidence: EvidenceCoordinator;
  submitter: TransactionSubmitter;
  simulator: TransactionSimulator;
  recorder: OverrideActionRecorder;
  generatedBundles: EvidenceBundle[];
  createdRecords: OverrideActionRecord[];
  reversedCalls: Array<{ id: string; by: string; digest: string }>;
}

function makeFakes(): Fakes {
  const callLog: string[] = [];
  const generatedBundles: EvidenceBundle[] = [];
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

  // Uses the REAL EvidenceService.generate so we assert the override reason
  // genuinely lands in the generated bundle's overrideReason. (Req 11.6)
  const evidence: EvidenceCoordinator = {
    generate(evaluation: RiskEvaluation, actionContext: ActionContext): EvidenceBundle {
      callLog.push('evidence.generate');
      const bundle = realEvidence.generate(evaluation, actionContext);
      generatedBundles.push(bundle);
      return bundle;
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
    generatedBundles,
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

function executeInput(request: OverrideActionRequest): OverrideExecuteRequest {
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
    },
  };
}

// --- Generators -------------------------------------------------------------

/**
 * Build a structurally-valid override request for the given operation and
 * reason. All non-reason fields are valid so the only variable under test is
 * the reason (and operation).
 */
function buildRequest(operation: OverrideOperation, reason: string): OverrideActionRequest {
  const base = {
    reason,
    policyObjectId: '0xa1',
    overrideCapObjectId: '0xb2',
  };
  switch (operation) {
    case OVERRIDE_OPERATION.OVERRIDE_ACTION:
    case OVERRIDE_OPERATION.REVERSE_ACTION:
      return {
        ...base,
        operation,
        actionLogObjectId: '0xc3',
        marketStateObjectId: '0xd4',
      };
    case OVERRIDE_OPERATION.REVOKE_GUARDIAN:
      return { ...base, operation, guardianCapObjectId: '0xe5' };
    case OVERRIDE_OPERATION.UPDATE_THRESHOLDS:
      return {
        ...base,
        operation,
        newMaxLtvDeltaBps: 500,
        newMaxMarginDeltaBps: 300,
        newPauseDurationLimitMs: 3_600_000,
        newCooldownMs: 60_000,
        newRiskThresholds: [40, 60, 75, 90],
      };
    case OVERRIDE_OPERATION.UNPAUSE_MARKET:
      return { ...base, operation, marketStateObjectId: '0xd4' };
    default: {
      const never: never = operation;
      throw new Error(`unreachable operation ${String(never)}`);
    }
  }
}

const operationArb: fc.Arbitrary<OverrideOperation> = fc.constantFrom(
  ...(Object.values(OVERRIDE_OPERATION) as OverrideOperation[]),
);

/** Non-empty reason strings (must survive a `.trim()` non-empty check). */
const nonEmptyReasonArb: fc.Arbitrary<string> = fc
  .string({ minLength: 1, maxLength: 200 })
  .filter((s) => s.trim().length > 0);

/** Empty / whitespace-only reasons that MUST be rejected. */
const blankReasonArb: fc.Arbitrary<string> = fc.stringOf(
  fc.constantFrom(' ', '\t', '\n', '\r', '\f', '\v'),
  { minLength: 0, maxLength: 8 },
);

// === Property 32 ============================================================

describe('Property 32: override reason is required and recorded in evidence', () => {
  // (a) REASON REQUIRED (Req 11.6) — blank/missing reasons are rejected and
  //     nothing is generated or submitted.
  it('rejects blank/whitespace reasons naming the reason field, with no side effects (Req 11.6)', async () => {
    await fc.assert(
      fc.asyncProperty(operationArb, blankReasonArb, async (operation, blankReason) => {
        // assertValidOverrideRequest rejects with field='reason'.
        const req = buildRequest(operation, blankReason);
        try {
          assertValidOverrideRequest(req);
          throw new Error('expected assertValidOverrideRequest to throw');
        } catch (err) {
          expect(err).toBeInstanceOf(OverrideRequestError);
          expect((err as OverrideRequestError).field).toBe('reason');
        }

        // execute rejects at the validation stage — no network/evidence/submit.
        const fakes = makeFakes();
        const executor = makeExecutor(fakes);
        const result = await executor.execute(executeInput(req));

        expect(result.success).toBe(false);
        expect(result.stage).toBe('validation');
        expect(result.failureReason).toMatch(/override reason is required/i);
        expect(fakes.callLog).toEqual([]);
        expect(fakes.generatedBundles).toHaveLength(0);
        expect(fakes.createdRecords).toHaveLength(0);
        expect(fakes.reversedCalls).toHaveLength(0);
      }),
      { numRuns: 150 },
    );
  });

  // (a') REASON REQUIRED — a missing reason field is rejected the same way.
  it('rejects a missing reason field naming the reason field (Req 11.6)', async () => {
    await fc.assert(
      fc.asyncProperty(operationArb, async (operation) => {
        const { reason: _omit, ...noReason } = buildRequest(operation, 'placeholder');
        const req = noReason as unknown as OverrideActionRequest;

        try {
          assertValidOverrideRequest(req);
          throw new Error('expected assertValidOverrideRequest to throw');
        } catch (err) {
          expect(err).toBeInstanceOf(OverrideRequestError);
          expect((err as OverrideRequestError).field).toBe('reason');
        }

        const fakes = makeFakes();
        const result = await makeExecutor(fakes).execute(executeInput(req));
        expect(result.success).toBe(false);
        expect(result.stage).toBe('validation');
        expect(fakes.callLog).toEqual([]);
      }),
      { numRuns: 150 },
    );
  });

  // (b) REASON RECORDED (Req 11.6, 11.4) — a non-empty reason appears in both
  //     the generated Evidence_Bundle and the recorded ActionLog row.
  it('records the reason in both the evidence bundle and the ActionLog row (Req 11.6, 11.4)', async () => {
    await fc.assert(
      fc.asyncProperty(operationArb, nonEmptyReasonArb, async (operation, reason) => {
        const fakes = makeFakes();
        const executor = makeExecutor(fakes);
        const req = buildRequest(operation, reason);

        const result = await executor.execute(executeInput(req));

        expect(result.success).toBe(true);
        expect(result.stage).toBe('completed');
        expect(result.overrideReason).toBe(reason);

        // The reason landed in the genuinely-generated Evidence_Bundle. (Req 11.6)
        expect(fakes.generatedBundles).toHaveLength(1);
        expect(fakes.generatedBundles[0].overrideReason).toBe(reason);

        // The reason landed on the recorded override ActionLog row. (Req 11.6)
        expect(fakes.createdRecords).toHaveLength(1);
        expect(fakes.createdRecords[0].override_reason).toBe(reason);
        expect(fakes.createdRecords[0].actor_type).toBe('dao');
        expect(fakes.createdRecords[0].action_type).toBe(operation);

        // For reversal operations, the original action is marked reversed. (Req 11.4)
        if (REVERSAL_OPERATIONS.includes(operation)) {
          expect(result.originalActionReversed).toBe(true);
          expect(fakes.reversedCalls).toEqual([
            { id: 'original-action-1', by: '0xDAO', digest: TX_DIGEST },
          ]);
        } else {
          expect(result.originalActionReversed).toBe(false);
          expect(fakes.reversedCalls).toHaveLength(0);
        }
      }),
      { numRuns: 150 },
    );
  });
});
