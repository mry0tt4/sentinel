// Feature: sentinel-risk-guardian, Property 28: Simulate-before-submit
//
// *For any* action execution, transaction simulation SHALL precede submission,
// and if simulation fails the transaction SHALL NOT be submitted.
//
// Validates: Requirements 16.5, 17.3
//
// Strategy: drive ActionExecutor.execute over arbitrary scenarios where the
// simulation outcome (and the submit outcome / digest confirmation) are
// randomized, while the upstream gates (network verification, evidence
// generation + upload) always pass. A shared call log instruments the relative
// ordering of simulator.dryRun vs submitter.submit. Across every run we assert:
//
//  (a) Whenever a submit happens, simulator.dryRun appears in the call log
//      strictly BEFORE submitter.submit (simulation precedes submission). [16.5]
//  (b) Whenever simulation FAILS, submitter.submit is NEVER called and the
//      ActionResult is unsuccessful with stage 'simulation'.               [17.3]
//  (c) When simulation succeeds (and submit succeeds), submit is called
//      exactly once, after simulate.

import fc from 'fast-check';

import { describe, expect, it } from 'vitest';

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

interface Scenario {
  /** Randomized dry-run outcome — the variable under test. */
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
 * Build fakes whose upstream gates (network + evidence) always pass so the flow
 * always reaches the simulate step; only the simulate/submit outcomes vary.
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
  simulationStatus: fc.constantFrom('success', 'failure'),
  submitStatus: fc.constantFrom('success', 'failure'),
  digestConfirmed: fc.boolean(),
});

describe('Property 28: Simulate-before-submit (Req 16.5, 17.3)', () => {
  it('simulation precedes submission and a failed simulation prevents submission', async () => {
    await fc.assert(
      fc.asyncProperty(scenarioArb, async (scenario) => {
        const fakes = makeFakes(scenario);
        const executor = makeExecutor(fakes);

        const result = await executor.execute(baseInput());

        const dryRunIdx = fakes.callLog.indexOf('simulator.dryRun');
        const submitIdx = fakes.callLog.indexOf('submitter.submit');
        const submitCount = fakes.callLog.filter((c) => c === 'submitter.submit').length;

        // The flow always reaches the simulate step (upstream gates pass).
        expect(dryRunIdx).toBeGreaterThanOrEqual(0);

        // (a) Req 16.5 — whenever a submit happens, simulate ran strictly before it.
        if (submitIdx >= 0) {
          expect(dryRunIdx).toBeLessThan(submitIdx);
        }

        if (scenario.simulationStatus === 'failure') {
          // (b) Req 17.3 — a failed simulation prevents submission entirely.
          expect(submitIdx).toBe(-1);
          expect(submitCount).toBe(0);
          expect(result.success).toBe(false);
          expect(result.stage).toBe('simulation');
        } else {
          // (c) Simulation passed → submit is attempted exactly once, after simulate.
          expect(submitCount).toBe(1);
          expect(submitIdx).toBeGreaterThan(dryRunIdx);

          if (scenario.submitStatus === 'success' && scenario.digestConfirmed) {
            // A fully successful path completes end-to-end.
            expect(result.success).toBe(true);
            expect(result.stage).toBe('completed');
            expect(result.txDigest).toBe(TX_DIGEST);
          } else {
            // Submit-side failure (abort or unconfirmed digest) is a failed tx,
            // but it never invalidates the simulate-before-submit ordering.
            expect(result.success).toBe(false);
            expect(result.stage).toBe('submission');
          }
        }
      }),
      { numRuns: 200 },
    );
  });
});
