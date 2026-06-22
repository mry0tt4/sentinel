/**
 * Override Executor — server-defined PTB templates + execution for the
 * DAO/governor Override_Console (Req 11.4, 11.5, 11.6, 12.1).
 *
 * Where {@link ./actionExecutor.ts} drives *agent* actions (GuardianCap,
 * bounds-checked, `execute_guardian_action`), this module drives *human*
 * interventions authorized by an OverrideCap (DAO):
 *
 *   - `override_action` / `reverse_action` — reverse a prior autonomous action.
 *     The on-chain function marks the original ActionLog reversed, applies the
 *     inverse market mutation, records a NEW reversal ActionLog, and emits
 *     `RiskActionOverridden` with the governor's reason. (Req 11.4)
 *   - `revoke_guardian` — revoke the agent's GuardianCap. (Req 12.1)
 *   - `update_thresholds` — retune policy bounds + thresholds. (Req 8.9, 12.5)
 *   - `unpause_market` — unpause borrows on the policy's market. (Req 8.13)
 *
 * Two principles mirror the agent executor exactly:
 *
 *  1. **Server-defined templates only.** {@link OverrideExecutor.buildOverridePtb}
 *     composes a PTB from a fixed per-operation template targeting
 *     `sentinel_policy::policy::<fn>` with the configured policy package id and
 *     the typed request fields. There is no field that accepts raw PTB
 *     structure, and {@link assertValidOverrideRequest} rejects malformed
 *     requests and any attempt to smuggle arbitrary structure. (Req 16.4)
 *
 *  2. **An override reason is required.** Every Override_Console operation
 *     REQUIRES a non-empty `reason` (Req 11.6). It is validated up front (a
 *     descriptive {@link OverrideRequestError} otherwise), woven into the
 *     generated Evidence_Bundle (`overrideReason`) and the recorded off-chain
 *     ActionLog (`override_reason`), and — for reversal operations — passed to
 *     the on-chain function as a `vector<u8>`.
 *
 * {@link OverrideExecutor.execute} runs the same fail-closed flow as the agent
 * executor (verify network → generate + upload evidence BEFORE building the PTB
 * → build → simulate → submit → link evidence) and then records the override in
 * the off-chain ActionLog mirror: a new override/reversal action row carrying
 * the reason, and — for reversals — marking the original action reversed.
 */

import { Transaction } from '@mysten/sui/transactions';
import { SUI_CLOCK_OBJECT_ID } from '@mysten/sui/utils';

import type { ActionContext, EvidenceBundle } from '../evidence/types.js';
import type { RiskEvaluation } from '../risk/types.js';
import type {
  EvidenceCoordinator,
  NetworkVerifier,
  TransactionSimulator,
  TransactionSubmitter,
} from './actionExecutor.js';
import { TransactionSubmissionError } from './actionExecutor.js';
import {
  ActionTemplateError,
  FORBIDDEN_REQUEST_KEYS,
  OVERRIDE_OPERATION,
  OverrideRequestError,
  REVERSAL_OPERATIONS,
  VALID_OVERRIDE_OPERATIONS,
  type ByteInput,
  type OverrideActionRequest,
  type OverrideOperation,
  type SimulationResult,
  type SubmitResult,
} from './types.js';

/** The fixed module every override template targets. */
export const POLICY_MODULE = 'policy';

/**
 * A new override / reversal action row to persist in the off-chain ActionLog
 * mirror (the `actions` table). Structurally a subset of the repository's
 * `ActionInsert`, so {@link import('../db/repositories/actions.js').ActionsRepository}
 * satisfies {@link OverrideActionRecorder} directly.
 */
export interface OverrideActionRecord {
  policy_id: string;
  market_id: string;
  actor: string;
  actor_type: 'dao';
  action_type: string;
  risk_score?: number | null;
  old_value?: string | null;
  new_value?: string | null;
  walrus_evidence_blob_id?: string | null;
  evidence_hash?: string | null;
  tx_digest?: string | null;
  is_reversed?: boolean;
  reversed_by?: string | null;
  reversal_tx_digest?: string | null;
  /** The human override reason (Req 11.6, 11.4). */
  override_reason: string;
  timestamp_ms: number | string;
}

/**
 * Narrow port over the `actions` repository for persisting overrides. The real
 * {@link import('../db/repositories/actions.js').ActionsRepository} is
 * structurally assignable; tests inject a fake.
 */
export interface OverrideActionRecorder {
  /** Insert a new override/reversal action row and return its id. */
  create(input: OverrideActionRecord): Promise<{ id: string }>;
  /** Mark a prior action reversed (Req 11.4). */
  markReversed(
    id: string,
    reversedBy: string,
    reversalTxDigest: string,
  ): Promise<unknown>;
}

/** Injected collaborators for the full override execution flow. */
export interface OverrideExecutorDeps {
  network?: NetworkVerifier;
  evidence?: EvidenceCoordinator;
  submitter?: TransactionSubmitter;
  recorder?: OverrideActionRecorder;
}

/** Server configuration for the fixed override templates. */
export interface OverrideExecutorConfig {
  /** Deployed `sentinel_policy` package id (from app config `packageIds.policy`). */
  policyPackageId: string;
  /** Override the clock object id used when a request omits one. Defaults to 0x6. */
  defaultClockObjectId?: string;
}

/** Stage of the override flow a {@link OverrideResult} stopped at. */
export type OverrideStage =
  | 'validation'
  | 'network_verification'
  | 'evidence_upload'
  | 'ptb_build'
  | 'simulation'
  | 'submission'
  | 'evidence_link'
  | 'record'
  | 'completed';

/**
 * Off-chain bookkeeping the executor needs to persist the override in the
 * ActionLog mirror. These are DB-level identifiers (not on-chain object ids).
 */
export interface OverrideRecordContext {
  /** Off-chain policy id the action row belongs to. */
  policyId: string;
  /** Off-chain market id the action row belongs to. */
  marketId: string;
  /** OverrideCap holder (DAO/governor) address — recorded as the row's actor. */
  daoAddress: string;
  /** Risk score recorded on the row, when known. */
  riskScore?: number | null;
  /**
   * Id of the original action being reversed. REQUIRED for reversal operations
   * so the executor can mark it reversed (Req 11.4); ignored otherwise.
   */
  originalActionId?: string;
  /** Override the action_type label written to the row (defaults to operation). */
  actionTypeLabel?: string;
}

/** Input to {@link OverrideExecutor.execute}. */
export interface OverrideExecuteRequest {
  /** The structured, server-controlled override template request. */
  request: OverrideActionRequest;
  /** Risk evaluation the evidence bundle is generated from. */
  evaluation: RiskEvaluation;
  /**
   * Action-flow context for evidence generation. The executor injects the
   * override `reason` into `overrideReason` regardless of what the caller set,
   * so the reason always appears in the bundle. (Req 11.6)
   */
  actionContext: ActionContext;
  /** On-chain ActionLog id evidence is linked to after a successful submit. */
  actionLogId: string;
  /** Off-chain bookkeeping for the recorded ActionLog row. */
  record: OverrideRecordContext;
}

/** Structured outcome of {@link OverrideExecutor.execute}. */
export interface OverrideResult {
  success: boolean;
  stage: OverrideStage;
  operation: OverrideOperation;
  /** The override reason that was required + recorded. (Req 11.6) */
  overrideReason?: string;
  txDigest?: string;
  blobId?: string;
  evidenceHash?: string;
  /** Id of the newly recorded override/reversal action row. */
  recordedActionId?: string;
  /** True when the original action row was marked reversed. (Req 11.4) */
  originalActionReversed?: boolean;
  events?: unknown[];
  failureReason?: string;
  /** True when an upload failure left evidence pending/retrying (no PTB built). */
  evidencePending?: boolean;
}

/**
 * Builds override PTBs from server-defined templates, dry-runs them, submits
 * them, and persists the resulting off-chain ActionLog. Collaborators are
 * injected for testability.
 */
export class OverrideExecutor {
  private readonly policyPackageId: string;
  private readonly defaultClockObjectId: string;
  private readonly network?: NetworkVerifier;
  private readonly evidence?: EvidenceCoordinator;
  private readonly submitter?: TransactionSubmitter;
  private readonly recorder?: OverrideActionRecorder;

  constructor(
    config: OverrideExecutorConfig,
    private readonly simulator?: TransactionSimulator,
    deps: OverrideExecutorDeps = {},
  ) {
    if (!isNonEmptyString(config.policyPackageId)) {
      throw new ActionTemplateError(
        'OverrideExecutor requires a configured sentinel_policy package id',
      );
    }
    this.policyPackageId = config.policyPackageId;
    this.defaultClockObjectId = config.defaultClockObjectId ?? SUI_CLOCK_OBJECT_ID;
    this.network = deps.network;
    this.evidence = deps.evidence;
    this.submitter = deps.submitter;
    this.recorder = deps.recorder;
  }

  /**
   * Build the override PTB from the fixed per-operation template. The request
   * is validated first (including the required reason); an unknown operation, a
   * malformed field, a missing reason, or any attempt to supply arbitrary PTB
   * structure causes an {@link OverrideRequestError} before a PTB is created.
   * (Req 11.6, 16.4)
   */
  buildOverridePtb(req: OverrideActionRequest): Transaction {
    assertValidOverrideRequest(req);

    const tx = new Transaction();
    const pkg = this.policyPackageId;
    const clockId = req.clockObjectId ?? this.defaultClockObjectId;

    switch (req.operation) {
      case OVERRIDE_OPERATION.OVERRIDE_ACTION:
      case OVERRIDE_OPERATION.REVERSE_ACTION: {
        // (policy, override_cap, action_log, market, reason, reversal_tx_digest, clock, ctx)
        tx.moveCall({
          target: `${pkg}::${POLICY_MODULE}::${req.operation}`,
          arguments: [
            tx.object(req.policyObjectId),
            tx.object(req.overrideCapObjectId),
            tx.object(req.actionLogObjectId),
            tx.object(req.marketStateObjectId),
            tx.pure.vector('u8', utf8Bytes(req.reason)),
            tx.pure.vector('u8', toBytes(req.reversalTxDigest ?? [])),
            tx.object(clockId),
          ],
        });
        break;
      }
      case OVERRIDE_OPERATION.REVOKE_GUARDIAN: {
        // (policy, override_cap, guardian_cap, clock, ctx)
        tx.moveCall({
          target: `${pkg}::${POLICY_MODULE}::${OVERRIDE_OPERATION.REVOKE_GUARDIAN}`,
          arguments: [
            tx.object(req.policyObjectId),
            tx.object(req.overrideCapObjectId),
            tx.object(req.guardianCapObjectId),
            tx.object(clockId),
          ],
        });
        break;
      }
      case OVERRIDE_OPERATION.UPDATE_THRESHOLDS: {
        // (policy, override_cap, ltv, margin, pause_limit, cooldown, thresholds, clock, ctx)
        tx.moveCall({
          target: `${pkg}::${POLICY_MODULE}::${OVERRIDE_OPERATION.UPDATE_THRESHOLDS}`,
          arguments: [
            tx.object(req.policyObjectId),
            tx.object(req.overrideCapObjectId),
            tx.pure.u64(BigInt(req.newMaxLtvDeltaBps)),
            tx.pure.u64(BigInt(req.newMaxMarginDeltaBps)),
            tx.pure.u64(BigInt(req.newPauseDurationLimitMs)),
            tx.pure.u64(BigInt(req.newCooldownMs)),
            tx.pure.vector(
              'u64',
              req.newRiskThresholds.map((t) => BigInt(t)),
            ),
            tx.object(clockId),
          ],
        });
        break;
      }
      case OVERRIDE_OPERATION.UNPAUSE_MARKET: {
        // (policy, override_cap, market, ctx)  — no clock argument
        tx.moveCall({
          target: `${pkg}::${POLICY_MODULE}::${OVERRIDE_OPERATION.UNPAUSE_MARKET}`,
          arguments: [
            tx.object(req.policyObjectId),
            tx.object(req.overrideCapObjectId),
            tx.object(req.marketStateObjectId),
          ],
        });
        break;
      }
      default: {
        // Exhaustiveness guard — assertValidOverrideRequest already rejects
        // unknown operations, but keep this fail-closed.
        const never: never = req;
        throw new OverrideRequestError(
          `Unsupported override operation: ${String((never as OverrideActionRequest).operation)}`,
          'operation',
        );
      }
    }

    return tx;
  }

  /**
   * Dry-run a PTB before submission, mapping to a {@link SimulationResult}. A
   * `success` effect status yields `{ success: true }`; any other status (or a
   * thrown error) yields `{ success: false, error }` so the caller can refuse
   * to submit. (Req 16.5, 17.3)
   */
  async simulate(tx: Transaction): Promise<SimulationResult> {
    if (!this.simulator) {
      throw new ActionTemplateError(
        'OverrideExecutor.simulate requires a TransactionSimulator; none was injected',
      );
    }

    try {
      const response = await this.simulator.dryRun(tx);
      const status = response.effects?.status?.status;
      const events = response.events ?? [];
      if (status === 'success') {
        return { success: true, events };
      }
      return {
        success: false,
        error:
          response.effects?.status?.error ??
          `Simulation reported status "${status ?? 'unknown'}"`,
        events,
      };
    } catch (err) {
      return { success: false, error: errorMessage(err), events: [] };
    }
  }

  /**
   * Network-gated submission of a built override PTB. Signs + submits through
   * the injected submitter, then (when a {@link NetworkVerifier} is present)
   * confirms the resulting digest originates from testnet. An on-chain abort or
   * an unconfirmable digest throws a {@link TransactionSubmissionError}.
   */
  async submit(tx: Transaction): Promise<SubmitResult> {
    if (!this.submitter) {
      throw new ActionTemplateError(
        'OverrideExecutor.submit requires a TransactionSubmitter; none was injected',
      );
    }

    const response = await this.submitter.submit(tx);

    const status = response.effects?.status?.status;
    if (status !== undefined && status !== 'success') {
      throw new TransactionSubmissionError(
        response.effects?.status?.error ??
          `Transaction reported status "${status}" on submit`,
        response.txDigest,
      );
    }

    if (this.network) {
      const confirmed = await this.network.verifyDigestOrigin(response.txDigest);
      if (!confirmed) {
        throw new TransactionSubmissionError(
          `Transaction digest "${response.txDigest}" could not be confirmed on Sui Testnet`,
          response.txDigest,
        );
      }
    }

    return { txDigest: response.txDigest, events: response.events ?? [] };
  }

  /**
   * Run the full network-gated override flow with fail-closed ordering:
   *
   *  0. Validate the request — REQUIRE a non-empty reason (Req 11.6) — before
   *     touching the network or generating evidence.
   *  1. Verify the network/submission target. (Req 16.6, 17.1)
   *  2. Generate the Evidence_Bundle (with the reason woven into
   *     `overrideReason`) and upload it BEFORE building the PTB. (Req 9.1, 11.6)
   *  3. Build the override PTB from the server-defined template. (Req 16.4)
   *  4. Simulate (dry-run) before submit. (Req 16.5, 17.3)
   *  5. Submit; an on-chain abort surfaces as a failed transaction. (Req 9.7)
   *  6. Link the evidence to the resulting ActionLog. (Req 9.5)
   *  7. Record the override in the off-chain ActionLog mirror with the reason
   *     (`override_reason`); for reversals, mark the original action reversed.
   *     (Req 11.4)
   */
  async execute(input: OverrideExecuteRequest): Promise<OverrideResult> {
    const { request } = input;
    const operation = request.operation;

    // --- 0. Validate up front; the reason is REQUIRED (Req 11.6) ------------
    try {
      assertValidOverrideRequest(request);
    } catch (err) {
      return {
        success: false,
        stage: 'validation',
        operation,
        failureReason: errorMessage(err),
      };
    }

    const { network, evidence, recorder } = this.requireExecutionDeps();
    const reason = request.reason;

    // --- 1. Network verification BEFORE anything else -----------------------
    try {
      await network.verifySubmissionTarget(this.policyPackageId);
    } catch (err) {
      return {
        success: false,
        stage: 'network_verification',
        operation,
        failureReason: errorMessage(err),
      };
    }

    // --- 2. Generate + UPLOAD evidence FIRST, with the reason woven in ------
    const actionContext: ActionContext = { ...input.actionContext, overrideReason: reason };
    let bundle: EvidenceBundle;
    try {
      bundle = evidence.generate(input.evaluation, actionContext);
    } catch (err) {
      return { success: false, stage: 'evidence_upload', operation, failureReason: errorMessage(err) };
    }

    let uploaded: { blobId: string; evidenceHash: string };
    try {
      uploaded = await evidence.upload(bundle);
    } catch (err) {
      return {
        success: false,
        stage: 'evidence_upload',
        operation,
        evidencePending: true,
        failureReason: errorMessage(err),
      };
    }

    // --- 3. Build the override PTB from the fixed template ------------------
    let tx: Transaction;
    try {
      tx = this.buildOverridePtb(request);
    } catch (err) {
      return {
        success: false,
        stage: 'ptb_build',
        operation,
        blobId: uploaded.blobId,
        evidenceHash: uploaded.evidenceHash,
        failureReason: errorMessage(err),
      };
    }

    // --- 4. Simulate (dry-run) BEFORE submit --------------------------------
    const simulation = await this.simulate(tx);
    if (!simulation.success) {
      return {
        success: false,
        stage: 'simulation',
        operation,
        blobId: uploaded.blobId,
        evidenceHash: uploaded.evidenceHash,
        events: simulation.events,
        failureReason: simulation.error,
      };
    }

    // --- 5. Submit ----------------------------------------------------------
    let submitResult: SubmitResult;
    try {
      submitResult = await this.submit(tx);
    } catch (err) {
      const txDigest = err instanceof TransactionSubmissionError ? err.txDigest : undefined;
      return {
        success: false,
        stage: 'submission',
        operation,
        blobId: uploaded.blobId,
        evidenceHash: uploaded.evidenceHash,
        txDigest,
        failureReason: errorMessage(err),
      };
    }

    // --- 6. Record the override in the off-chain ActionLog mirror FIRST -----
    //        so the evidence link can reference a real action id (the
    //        walrus_blobs.action_id FK). The reason is recorded as
    //        `override_reason` (Req 11.6, 11.4).
    const isReversal = REVERSAL_OPERATIONS.includes(operation);
    let recordedActionId: string | undefined;
    let originalActionReversed = false;
    try {
      const record: OverrideActionRecord = {
        policy_id: input.record.policyId,
        market_id: input.record.marketId,
        actor: input.record.daoAddress,
        actor_type: 'dao',
        action_type: input.record.actionTypeLabel ?? operation,
        risk_score: input.record.riskScore ?? null,
        walrus_evidence_blob_id: uploaded.blobId,
        evidence_hash: uploaded.evidenceHash,
        tx_digest: submitResult.txDigest,
        override_reason: reason,
        timestamp_ms: actionContext.timestampMs ?? input.evaluation.featureVector.nowMs,
      };
      const created = await recorder.create(record);
      recordedActionId = created.id;

      // For a reversal, also mark the ORIGINAL action reversed (Req 11.4).
      if (isReversal && isNonEmptyString(input.record.originalActionId)) {
        await recorder.markReversed(
          input.record.originalActionId,
          input.record.daoAddress,
          submitResult.txDigest,
        );
        originalActionReversed = true;
      }
    } catch (err) {
      return {
        success: false,
        stage: 'record',
        operation,
        overrideReason: reason,
        txDigest: submitResult.txDigest,
        blobId: uploaded.blobId,
        evidenceHash: uploaded.evidenceHash,
        events: submitResult.events,
        recordedActionId,
        originalActionReversed,
        failureReason: errorMessage(err),
      };
    }

    // --- 7. Link the evidence to the recorded action (-> linked_on_chain) ---
    //        Uses the freshly-recorded action id so the walrus_blobs.action_id
    //        FK resolves. (Req 9.5)
    try {
      await evidence.link(uploaded.blobId, recordedActionId, uploaded.evidenceHash);
    } catch (err) {
      return {
        success: false,
        stage: 'evidence_link',
        operation,
        overrideReason: reason,
        txDigest: submitResult.txDigest,
        blobId: uploaded.blobId,
        evidenceHash: uploaded.evidenceHash,
        events: submitResult.events,
        recordedActionId,
        originalActionReversed,
        failureReason: errorMessage(err),
      };
    }

    return {
      success: true,
      stage: 'completed',
      operation,
      overrideReason: reason,
      txDigest: submitResult.txDigest,
      blobId: uploaded.blobId,
      evidenceHash: uploaded.evidenceHash,
      events: submitResult.events,
      recordedActionId,
      originalActionReversed,
    };
  }

  /** Require the collaborators {@link OverrideExecutor.execute} depends on. */
  private requireExecutionDeps(): {
    network: NetworkVerifier;
    evidence: EvidenceCoordinator;
    submitter: TransactionSubmitter;
    recorder: OverrideActionRecorder;
  } {
    if (!this.network || !this.evidence || !this.submitter || !this.recorder) {
      throw new ActionTemplateError(
        'OverrideExecutor.execute requires injected network, evidence, submitter, and recorder dependencies',
      );
    }
    return {
      network: this.network,
      evidence: this.evidence,
      submitter: this.submitter,
      recorder: this.recorder,
    };
  }
}

/**
 * Validate an {@link OverrideActionRequest} before any PTB is built.
 *
 * Rejects (with {@link OverrideRequestError}) an unknown operation, a missing /
 * empty override reason (Req 11.6), malformed or missing structured fields, and
 * any attempt to smuggle raw transaction structure through forbidden
 * properties. This is the explicit reason-required + template-only enforcement
 * point. (Req 11.6, 16.4)
 */
export function assertValidOverrideRequest(req: OverrideActionRequest): void {
  if (req === null || typeof req !== 'object') {
    throw new OverrideRequestError('Override request must be a structured object', 'request');
  }

  // Reject any attempt to inject arbitrary PTB / Move-call structure.
  const record = req as unknown as Record<string, unknown>;
  for (const key of FORBIDDEN_REQUEST_KEYS) {
    if (Object.prototype.hasOwnProperty.call(record, key)) {
      throw new OverrideRequestError(
        `Override request must not supply arbitrary transaction structure (forbidden field "${key}"); ` +
          'PTBs are built from server-defined templates only',
        key,
      );
    }
  }

  if (!VALID_OVERRIDE_OPERATIONS.includes(req.operation)) {
    throw new OverrideRequestError(
      `Unknown override operation ${String(req.operation)}; expected one of ` +
        `[${VALID_OVERRIDE_OPERATIONS.join(', ')}]`,
      'operation',
    );
  }

  // An override reason is REQUIRED and non-empty for EVERY operation (Req 11.6).
  if (!isNonEmptyString(req.reason)) {
    throw new OverrideRequestError(
      'An override reason is required for every override operation and must be a non-empty string',
      'reason',
    );
  }

  // Shared authority object ids.
  assertObjectId(req.overrideCapObjectId, 'overrideCapObjectId');
  assertObjectId(req.policyObjectId, 'policyObjectId');
  if (req.clockObjectId !== undefined) {
    assertObjectId(req.clockObjectId, 'clockObjectId');
  }

  switch (req.operation) {
    case OVERRIDE_OPERATION.OVERRIDE_ACTION:
    case OVERRIDE_OPERATION.REVERSE_ACTION:
      assertObjectId(req.actionLogObjectId, 'actionLogObjectId');
      assertObjectId(req.marketStateObjectId, 'marketStateObjectId');
      if (req.reversalTxDigest !== undefined) {
        assertByteInput(req.reversalTxDigest, 'reversalTxDigest');
      }
      break;
    case OVERRIDE_OPERATION.REVOKE_GUARDIAN:
      assertObjectId(req.guardianCapObjectId, 'guardianCapObjectId');
      break;
    case OVERRIDE_OPERATION.UPDATE_THRESHOLDS:
      assertU64(req.newMaxLtvDeltaBps, 'newMaxLtvDeltaBps');
      assertU64(req.newMaxMarginDeltaBps, 'newMaxMarginDeltaBps');
      assertU64(req.newPauseDurationLimitMs, 'newPauseDurationLimitMs');
      assertU64(req.newCooldownMs, 'newCooldownMs');
      if (!Array.isArray(req.newRiskThresholds)) {
        throw new OverrideRequestError(
          'newRiskThresholds must be an array of non-negative integers',
          'newRiskThresholds',
        );
      }
      req.newRiskThresholds.forEach((t, i) => assertU64(t, `newRiskThresholds[${i}]`));
      break;
    case OVERRIDE_OPERATION.UNPAUSE_MARKET:
      assertObjectId(req.marketStateObjectId, 'marketStateObjectId');
      break;
    default: {
      const never: never = req;
      throw new OverrideRequestError(
        `Unknown override operation ${String((never as OverrideActionRequest).operation)}`,
        'operation',
      );
    }
  }
}

// === internal helpers ===

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function assertObjectId(value: unknown, field: string): void {
  if (!isNonEmptyString(value)) {
    throw new OverrideRequestError(`${field} must be a non-empty object id string`, field);
  }
}

function assertU64(value: unknown, field: string): void {
  if (typeof value === 'bigint') {
    if (value < 0n) {
      throw new OverrideRequestError(`${field} must be a non-negative integer`, field);
    }
    return;
  }
  if (typeof value === 'number') {
    if (!Number.isInteger(value) || value < 0) {
      throw new OverrideRequestError(`${field} must be a non-negative integer`, field);
    }
    return;
  }
  throw new OverrideRequestError(`${field} must be a number or bigint`, field);
}

function assertByteInput(value: unknown, field: string): void {
  if (value instanceof Uint8Array) {
    return;
  }
  if (Array.isArray(value) && value.every((b) => Number.isInteger(b) && b >= 0 && b <= 255)) {
    return;
  }
  throw new OverrideRequestError(
    `${field} must be a Uint8Array or an array of byte values (0..255)`,
    field,
  );
}

function toBytes(input: ByteInput): number[] {
  if (input instanceof Uint8Array) {
    return Array.from(input);
  }
  return Array.from(input);
}

function utf8Bytes(value: string): number[] {
  return Array.from(new TextEncoder().encode(value));
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
