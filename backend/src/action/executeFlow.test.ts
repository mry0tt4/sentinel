/**
 * Unit tests for the Action Executor's full network-gated execution flow
 * (task 11.4). These exercise the fail-closed ordering with injected fakes for
 * the Network Guard, Evidence Service, and transaction submitter:
 *
 *  - network-fail        → no evidence upload, no PTB build, no submit
 *  - upload-fail         → no PTB built/submitted; evidence left pending
 *  - simulation-fail     → no submit; failed transaction surfaced
 *  - happy path          → upload → build → simulate → submit → link (in order)
 *  - submit/abort        → no successful action recorded
 *
 * Ordering is asserted via a shared call log; in particular evidence upload
 * MUST precede PTB build (Req 9.1). The dedicated property test for ordering is
 * task 11.5.
 */

import { describe, it, expect, vi } from 'vitest';

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
import { ACTION_TYPE } from './types.js';
import type { ActionContext, EvidenceBundle } from '../evidence/types.js';
import type { RiskEvaluation } from '../risk/types.js';

const POLICY_PACKAGE = '0xabc';
const PYTH_PACKAGE = '0xdef';
const BLOB_ID = 'walrus-blob-123';
const EVIDENCE_HASH = 'deadbeefcafef00d';
const TX_DIGEST = 'DIGEST_ABC123';

/** A bundle stand-in; the fake evidence coordinator ignores its contents. */
const FAKE_BUNDLE = { schemaVersion: '1.0' } as unknown as EvidenceBundle;

interface Fakes {
  callLog: string[];
  network: NetworkVerifier;
  evidence: EvidenceCoordinator;
  submitter: TransactionSubmitter;
  simulator: TransactionSimulator;
}

interface FakeOptions {
  networkFails?: boolean;
  uploadFails?: boolean;
  simulationStatus?: 'success' | 'failure';
  submitStatus?: 'success' | 'failure';
  digestConfirmed?: boolean;
  linkFails?: boolean;
}

function makeFakes(opts: FakeOptions = {}): Fakes {
  const callLog: string[] = [];

  const network: NetworkVerifier = {
    async verifySubmissionTarget(packageId: string): Promise<void> {
      callLog.push(`network.verifySubmissionTarget:${packageId}`);
      if (opts.networkFails) {
        throw new Error('SUBMISSION_TARGET_MISMATCH: not a configured testnet package');
      }
    },
    async verifyDigestOrigin(txDigest: string): Promise<boolean> {
      callLog.push(`network.verifyDigestOrigin:${txDigest}`);
      return opts.digestConfirmed ?? true;
    },
  };

  const evidence: EvidenceCoordinator = {
    generate(_evaluation: RiskEvaluation, _actionContext: ActionContext): EvidenceBundle {
      callLog.push('evidence.generate');
      return FAKE_BUNDLE;
    },
    async upload(_bundle: EvidenceBundle): Promise<{ blobId: string; evidenceHash: string }> {
      callLog.push('evidence.upload');
      if (opts.uploadFails) {
        throw new Error('EvidenceUploadError: 5 attempts exhausted');
      }
      return { blobId: BLOB_ID, evidenceHash: EVIDENCE_HASH };
    },
    async link(blobId: string, actionLogId: string, evidenceHash: string): Promise<void> {
      callLog.push(`evidence.link:${blobId}:${actionLogId}:${evidenceHash}`);
      if (opts.linkFails) {
        throw new Error('EvidenceLinkError: on-chain hash recording failed');
      }
    },
  };

  const submitter: TransactionSubmitter = {
    async submit(): Promise<SubmitResponseLike> {
      callLog.push('submitter.submit');
      return {
        txDigest: TX_DIGEST,
        events: [{ type: 'RiskActionExecuted' }],
        effects: { status: { status: opts.submitStatus ?? 'success' } },
      };
    },
  };

  const simulator: TransactionSimulator = {
    async dryRun(): Promise<DryRunResponseLike> {
      callLog.push('simulator.dryRun');
      const status = opts.simulationStatus ?? 'success';
      return {
        effects: {
          status:
            status === 'success'
              ? { status: 'success' }
              : { status: 'failure', error: 'MoveAbort: EGuardianRevoked' },
        },
        events: status === 'success' ? [{ type: 'RiskActionExecuted' }] : [],
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

/** Spy on buildActionPtb so PTB construction is observable in the call log. */
function instrumentBuild(executor: ActionExecutor, callLog: string[]): void {
  const original = executor.buildActionPtb.bind(executor);
  vi.spyOn(executor, 'buildActionPtb').mockImplementation((req) => {
    callLog.push('buildActionPtb');
    return original(req);
  });
}

function baseInput(overrides: Partial<ExecuteRequest['action']> = {}): ExecuteRequest {
  return {
    action: {
      policyObjectId: '0xa1',
      guardianCapObjectId: '0xb2',
      marketStateObjectId: '0xc3',
      actionType: ACTION_TYPE.PAUSE_BORROWS,
      newParamValue: 0,
      pauseDurationMs: 3_600_000,
      riskScore: 95,
      ...overrides,
    },
    evaluation: {} as RiskEvaluation,
    actionContext: {} as ActionContext,
    actionLogId: 'action-log-1',
  };
}

describe('ActionExecutor.execute — network gate (Req 16.6, 17.1)', () => {
  it('refuses with no upload, build, or submit when network verification fails', async () => {
    const fakes = makeFakes({ networkFails: true });
    const executor = makeExecutor(fakes);
    instrumentBuild(executor, fakes.callLog);

    const result = await executor.execute(baseInput());

    expect(result.success).toBe(false);
    expect(result.stage).toBe('network_verification');
    expect(result.txDigest).toBeUndefined();
    // No evidence generation/upload, no build, no simulate, no submit.
    expect(fakes.callLog).toEqual(['network.verifySubmissionTarget:0xabc']);
  });
});

describe('ActionExecutor.execute — evidence upload precedes PTB build (Req 9.1, 9.6, 17.2)', () => {
  it('does not build or submit the PTB when upload fails and marks evidence pending', async () => {
    const fakes = makeFakes({ uploadFails: true });
    const executor = makeExecutor(fakes);
    instrumentBuild(executor, fakes.callLog);

    const result = await executor.execute(baseInput());

    expect(result.success).toBe(false);
    expect(result.stage).toBe('evidence_upload');
    expect(result.evidencePending).toBe(true);
    // Upload was attempted, but nothing was built/simulated/submitted.
    expect(fakes.callLog).toContain('evidence.upload');
    expect(fakes.callLog).not.toContain('buildActionPtb');
    expect(fakes.callLog).not.toContain('simulator.dryRun');
    expect(fakes.callLog).not.toContain('submitter.submit');
  });

  it('uploads evidence BEFORE building the action PTB on the happy path', async () => {
    const fakes = makeFakes();
    const executor = makeExecutor(fakes);
    instrumentBuild(executor, fakes.callLog);

    await executor.execute(baseInput());

    const uploadIdx = fakes.callLog.indexOf('evidence.upload');
    const buildIdx = fakes.callLog.indexOf('buildActionPtb');
    expect(uploadIdx).toBeGreaterThanOrEqual(0);
    expect(buildIdx).toBeGreaterThanOrEqual(0);
    expect(uploadIdx).toBeLessThan(buildIdx);
  });
});

describe('ActionExecutor.execute — simulate before submit (Req 16.5, 17.3)', () => {
  it('does not submit and surfaces the failed transaction when simulation fails', async () => {
    const fakes = makeFakes({ simulationStatus: 'failure' });
    const executor = makeExecutor(fakes);
    instrumentBuild(executor, fakes.callLog);

    const result = await executor.execute(baseInput());

    expect(result.success).toBe(false);
    expect(result.stage).toBe('simulation');
    expect(result.failureReason).toContain('EGuardianRevoked');
    expect(fakes.callLog).toContain('simulator.dryRun');
    expect(fakes.callLog).not.toContain('submitter.submit');
    // Evidence was uploaded but never linked (no successful action).
    expect(fakes.callLog.some((c) => c.startsWith('evidence.link'))).toBe(false);
  });
});

describe('ActionExecutor.execute — policy-validation failure on submit (Req 9.7)', () => {
  it('records no successful action and surfaces the failed transaction on an on-chain abort', async () => {
    const fakes = makeFakes({ submitStatus: 'failure' });
    const executor = makeExecutor(fakes);
    instrumentBuild(executor, fakes.callLog);

    const result = await executor.execute(baseInput());

    expect(result.success).toBe(false);
    expect(result.stage).toBe('submission');
    expect(result.txDigest).toBe(TX_DIGEST); // failed tx surfaced
    expect(fakes.callLog).toContain('submitter.submit');
    // No evidence link => no successful action recorded.
    expect(fakes.callLog.some((c) => c.startsWith('evidence.link'))).toBe(false);
  });

  it('surfaces a failed transaction when the digest cannot be confirmed on testnet (Req 16.6)', async () => {
    const fakes = makeFakes({ digestConfirmed: false });
    const executor = makeExecutor(fakes);

    const result = await executor.execute(baseInput());

    expect(result.success).toBe(false);
    expect(result.stage).toBe('submission');
    expect(result.failureReason).toContain('could not be confirmed on Sui Testnet');
  });
});

describe('ActionExecutor.execute — happy path (Req 9.2, 9.5)', () => {
  it('runs upload → build → simulate → submit → link in order and returns the digest', async () => {
    const fakes = makeFakes();
    const executor = makeExecutor(fakes);
    instrumentBuild(executor, fakes.callLog);

    const result = await executor.execute(baseInput());

    expect(result.success).toBe(true);
    expect(result.stage).toBe('completed');
    expect(result.txDigest).toBe(TX_DIGEST);
    expect(result.blobId).toBe(BLOB_ID);
    expect(result.evidenceHash).toBe(EVIDENCE_HASH);
    expect(result.events).toEqual([{ type: 'RiskActionExecuted' }]);

    // Full ordering: network → generate → upload → build → simulate → submit
    // → digest verify → link.
    expect(fakes.callLog).toEqual([
      'network.verifySubmissionTarget:0xabc',
      'evidence.generate',
      'evidence.upload',
      'buildActionPtb',
      'simulator.dryRun',
      'submitter.submit',
      `network.verifyDigestOrigin:${TX_DIGEST}`,
      `evidence.link:${BLOB_ID}:action-log-1:${EVIDENCE_HASH}`,
    ]);
  });

  it('passes the uploaded blob id + evidence hash into the built PTB request', async () => {
    const fakes = makeFakes();
    const executor = makeExecutor(fakes);
    const buildSpy = vi.spyOn(executor, 'buildActionPtb');

    await executor.execute(baseInput());

    expect(buildSpy).toHaveBeenCalledTimes(1);
    const builtReq = buildSpy.mock.calls[0][0];
    expect(builtReq.evidenceBlobId).toBe(BLOB_ID);
    // Hex evidence hash decoded into bytes for the vector<u8> argument.
    expect(builtReq.evidenceHash).toEqual([0xde, 0xad, 0xbe, 0xef, 0xca, 0xfe, 0xf0, 0x0d]);
  });

  it('surfaces a link failure after a successful submit', async () => {
    const fakes = makeFakes({ linkFails: true });
    const executor = makeExecutor(fakes);

    const result = await executor.execute(baseInput());

    expect(result.success).toBe(false);
    expect(result.stage).toBe('evidence_link');
    expect(result.txDigest).toBe(TX_DIGEST);
    expect(result.failureReason).toContain('EvidenceLinkError');
  });
});

describe('ActionExecutor.execute — missing dependencies', () => {
  it('throws when execution dependencies are not injected', async () => {
    const fakes = makeFakes();
    const executor = new ActionExecutor(
      { policyPackageId: POLICY_PACKAGE },
      fakes.simulator,
    );
    await expect(executor.execute(baseInput())).rejects.toThrow(/requires injected/);
  });
});
