// Feature: sentinel-risk-guardian, Property 7: Evidence-before-PTB ordering
//
// *For any* action execution, the Evidence_Bundle SHALL be uploaded (yielding a
// Walrus blob id + evidence hash) BEFORE the action PTB is built; and if the
// upload fails, NO PTB SHALL be built or submitted and the evidence SHALL be
// left pending/retrying.
//
// Validates: Requirements 9.1, 9.2, 9.6
//
// Strategy: drive ActionExecutor.execute over arbitrary scenarios where the
// evidence-upload outcome (and the downstream simulate/submit/digest outcomes)
// are randomized, while the upstream gates (network verification + evidence
// generation) always pass so the flow always reaches the upload step. A shared
// call log instruments the relative ordering of evidence.upload vs
// buildActionPtb (the latter via a spy), and the built request is captured so
// we can assert the uploaded references flow into the PTB. Across every run:
//
//  (a) Upload SUCCEEDS → evidence.upload appears strictly BEFORE buildActionPtb
//      (Req 9.1), and the built PTB request carries the uploaded blobId +
//      evidenceHash (Req 9.2).
//  (b) Upload FAILS → buildActionPtb is NEVER called, no simulate, no submit;
//      the ActionResult is unsuccessful with stage 'evidence_upload' and
//      evidencePending true (evidence marked pending/retrying) (Req 9.6).

import fc from 'fast-check';

import { describe, expect, it, vi } from 'vitest';

import {
  ActionExecutor,
  type ActionExecutorDeps,
  type DryRunResponseLike,
  type EvidenceCoordinator,
  type ExecuteRequest,
  type NetworkVerifier,
  type SubmitResponseLike,
  type TransactionSimulator,
  type TransactionSubmitter,
} from './actionExecutor.js';
import { ACTION_TYPE, type BoundedActionRequest } from './types.js';
import type { ActionContext, EvidenceBundle } from '../evidence/types.js';
import type { RiskEvaluation } from '../risk/types.js';

const POLICY_PACKAGE = '0xabc';
const PYTH_PACKAGE = '0xdef';
const BLOB_ID = 'walrus-blob-123';
const EVIDENCE_HASH = 'deadbeefcafef00d';
/** The uploaded hex hash decoded into the bytes the vector<u8> argument expects. */
const EVIDENCE_HASH_BYTES = [0xde, 0xad, 0xbe, 0xef, 0xca, 0xfe, 0xf0, 0x0d];
const TX_DIGEST = 'DIGEST_ABC123';

/** A bundle stand-in; the fake evidence coordinator ignores its contents. */
const FAKE_BUNDLE = { schemaVersion: '1.0' } as unknown as EvidenceBundle;

interface Scenario {
  /** Randomized evidence-upload outcome — the variable under test. */
  uploadSucceeds: boolean;
  /** Randomized dry-run outcome (only reachable when upload succeeds). */
  simulationStatus: 'success' | 'failure';
  /** Randomized on-chain submit outcome (only reachable when simulation passes). */
  submitStatus: 'success' | 'failure';
  /** Randomized testnet digest confirmation (only reachable after a submit). */
  digestConfirmed: boolean;
}

interface Fakes {
  callLog: string[];
  network: NetworkVerifier;
  evidence: EvidenceCoordinator;
  submitter: TransactionSubmitter;
  simulator: TransactionSimulator;
}

/**
 * Build fakes whose upstream gates (network verification + evidence generation)
 * always pass so the flow always reaches the upload step; only the upload
 * outcome (and the downstream simulate/submit/digest outcomes) vary.
 */
function makeFakes(scenario: Scenario): Fakes {
  const callLog: string[] = [];

  const network: NetworkVerifier = {
    async verifySubmissionTarget(packageId: string): Promise<void> {
      callLog.push(`network.verifySubmissionTarget:${packageId}`);
    },
    async verifyDigestOrigin(txDigest: string): Promise<boolean> {
      callLog.push(`network.verifyDigestOrigin:${txDigest}`);
      return scenario.digestConfirmed;
    },
  };

  const evidence: EvidenceCoordinator = {
    generate(_evaluation: RiskEvaluation, _actionContext: ActionContext): EvidenceBundle {
      callLog.push('evidence.generate');
      return FAKE_BUNDLE;
    },
    async upload(_bundle: EvidenceBundle): Promise<{ blobId: string; evidenceHash: string }> {
      callLog.push('evidence.upload');
      if (!scenario.uploadSucceeds) {
        throw new Error('EvidenceUploadError: 5 attempts exhausted');
      }
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
        events: [{ type: 'RiskActionExecuted' }],
        effects: { status: { status: scenario.submitStatus } },
      };
    },
  };

  const simulator: TransactionSimulator = {
    async dryRun(): Promise<DryRunResponseLike> {
      callLog.push('simulator.dryRun');
      return {
        effects: {
          status:
            scenario.simulationStatus === 'success'
              ? { status: 'success' }
              : { status: 'failure', error: 'MoveAbort: EGuardianRevoked' },
        },
        events: scenario.simulationStatus === 'success' ? [{ type: 'RiskActionExecuted' }] : [],
      };
    },
  };

  return { callLog, network, evidence, submitter, simulator };
}

function makeExecutor(fakes: Fakes): ActionExecutor {
  const deps: ActionExecutorDeps = {
    network: fakes.network,
    evidence: fakes.evidence,
    submitter: fakes.submitter,
  };
  return new ActionExecutor(
    { policyPackageId: POLICY_PACKAGE, pyth: { packageId: PYTH_PACKAGE } },
    fakes.simulator,
    deps,
  );
}

/**
 * Spy on buildActionPtb so PTB construction is observable in the call log, and
 * capture the request it received so the uploaded references can be asserted.
 */
function instrumentBuild(
  executor: ActionExecutor,
  callLog: string[],
): { calls: BoundedActionRequest[] } {
  const captured = { calls: [] as BoundedActionRequest[] };
  const original = executor.buildActionPtb.bind(executor);
  vi.spyOn(executor, 'buildActionPtb').mockImplementation((req) => {
    callLog.push('buildActionPtb');
    captured.calls.push(req);
    return original(req);
  });
  return captured;
}

function baseInput(): ExecuteRequest {
  return {
    action: {
      policyObjectId: '0xa1',
      guardianCapObjectId: '0xb2',
      marketStateObjectId: '0xc3',
      actionType: ACTION_TYPE.PAUSE_BORROWS,
      newParamValue: 0,
      pauseDurationMs: 3_600_000,
      riskScore: 95,
    },
    evaluation: {} as RiskEvaluation,
    actionContext: {} as ActionContext,
    actionLogId: 'action-log-1',
  };
}

const scenarioArb: fc.Arbitrary<Scenario> = fc.record({
  uploadSucceeds: fc.boolean(),
  simulationStatus: fc.constantFrom('success', 'failure'),
  submitStatus: fc.constantFrom('success', 'failure'),
  digestConfirmed: fc.boolean(),
});

describe('Property 7: Evidence-before-PTB ordering (Req 9.1, 9.2, 9.6)', () => {
  it('uploads evidence before building the PTB, and a failed upload blocks build/submit', async () => {
    await fc.assert(
      fc.asyncProperty(scenarioArb, async (scenario) => {
        const fakes = makeFakes(scenario);
        const executor = makeExecutor(fakes);
        const build = instrumentBuild(executor, fakes.callLog);

        const result = await executor.execute(baseInput());

        const uploadIdx = fakes.callLog.indexOf('evidence.upload');
        const buildIdx = fakes.callLog.indexOf('buildActionPtb');

        // The flow always reaches the upload step (upstream gates pass).
        expect(uploadIdx).toBeGreaterThanOrEqual(0);

        if (scenario.uploadSucceeds) {
          // (a) Req 9.1 — upload (blob id + hash) ran strictly BEFORE the build.
          expect(buildIdx).toBeGreaterThanOrEqual(0);
          expect(uploadIdx).toBeLessThan(buildIdx);

          // (a)/(b) Req 9.2 — the built PTB request carries the uploaded refs.
          expect(build.calls).toHaveLength(1);
          expect(build.calls[0].evidenceBlobId).toBe(BLOB_ID);
          expect(build.calls[0].evidenceHash).toEqual(EVIDENCE_HASH_BYTES);
        } else {
          // (b) Req 9.6 — a failed upload builds/simulates/submits NOTHING and
          // leaves the evidence pending/retrying.
          expect(buildIdx).toBe(-1);
          expect(build.calls).toHaveLength(0);
          expect(fakes.callLog).not.toContain('simulator.dryRun');
          expect(fakes.callLog).not.toContain('submitter.submit');
          expect(fakes.callLog.some((c) => c.startsWith('evidence.link'))).toBe(false);

          expect(result.success).toBe(false);
          expect(result.stage).toBe('evidence_upload');
          expect(result.evidencePending).toBe(true);
        }
      }),
      { numRuns: 200 },
    );
  });
});
