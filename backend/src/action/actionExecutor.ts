/**
 * Action Executor — server-defined PTB templates and simulation.
 *
 * This module builds and dry-runs the Programmable Transaction Blocks (PTBs)
 * that drive Sentinel's autonomous on-chain actions. Two principles are
 * structural, not optional:
 *
 *  1. **Server-defined templates only.** {@link ActionExecutor.buildActionPtb}
 *     composes a PTB from a single fixed template — an optional
 *     `pyth::update_price_feed` call followed by the
 *     `sentinel_policy::policy::execute_guardian_action` call — using the
 *     policy package id from server configuration and the typed fields of a
 *     {@link BoundedActionRequest}. Arbitrary transaction structure supplied by
 *     a caller is rejected: there is no field that accepts a raw PTB, and a
 *     runtime guard rejects malformed requests. (Req 9.2, 9.3, 16.4)
 *
 *  2. **Simulate before submit.** {@link ActionExecutor.simulate} dry-runs the
 *     PTB through an injected, narrow {@link TransactionSimulator} port so the
 *     caller can refuse to submit when the dry-run fails. The port keeps unit
 *     tests free of any live RPC dependency while a real `SuiClient` adapter is
 *     used in production. (Req 16.5, 17.3)
 *
 * {@link ActionExecutor.submit} performs network-gated submission through an
 * injected transaction-submitter port (and verifies the resulting digest
 * originates from testnet), and {@link ActionExecutor.execute} orchestrates the
 * full fail-closed flow: verify network → generate + upload evidence **before**
 * building the PTB → build → simulate → submit → link evidence. (task 11.4)
 */

import { Transaction } from '@mysten/sui/transactions';
import { SUI_CLOCK_OBJECT_ID } from '@mysten/sui/utils';

import type { RiskEvaluation } from '../risk/types.js';
import type { ActionContext, EvidenceBundle } from '../evidence/types.js';
import {
  ActionTemplateError,
  FORBIDDEN_REQUEST_KEYS,
  VALID_ACTION_TYPE_CODES,
  type BoundedActionRequest,
  type ByteInput,
  type SimulationResult,
  type SubmitResult,
} from './types.js';

/** The fixed module + function the guardian-action template always targets. */
export const POLICY_MODULE = 'policy';
export const EXECUTE_GUARDIAN_ACTION = 'execute_guardian_action';

/** Default Move-call coordinates for the optional price-feed update template. */
const DEFAULT_PYTH_MODULE = 'pyth';
const DEFAULT_PYTH_FUNCTION = 'update_price_feed';

/**
 * Narrow port for dry-running a transaction. A production adapter wraps a real
 * `@mysten/sui` `SuiClient` (see {@link createSuiClientSimulator}); unit tests
 * inject a fake so no live RPC is required. The return shape mirrors the subset
 * of a Sui dry-run / dev-inspect response the executor reads.
 */
export interface TransactionSimulator {
  dryRun(tx: Transaction): Promise<DryRunResponseLike>;
}

/** The subset of a Sui dry-run / dev-inspect response the executor consumes. */
export interface DryRunResponseLike {
  effects?: {
    status?: {
      status?: 'success' | 'failure' | string;
      error?: string | null;
    };
  };
  events?: unknown[];
}

/**
 * Narrow port over the Network Guard the executor needs for network-gated
 * execution. The real {@link import('../network/networkGuard.js').NetworkGuard}
 * is structurally assignable; tests inject a fake. (Req 16.6, 17.1, 1.8)
 */
export interface NetworkVerifier {
  /** Verify the submission target (policy package + RPC chain) is testnet; throws on mismatch. */
  verifySubmissionTarget(packageId: string): Promise<void>;
  /** Verify a tx digest originates from testnet before it is treated as displayable. */
  verifyDigestOrigin(txDigest: string): Promise<boolean>;
}

/**
 * Narrow port over the Evidence Service the executor needs to generate, upload,
 * and link evidence. The real
 * {@link import('../evidence/evidenceService.js').EvidenceService} (constructed
 * with upload dependencies) is structurally assignable; tests inject a fake.
 * (Req 9.1, 9.5, 9.6)
 */
export interface EvidenceCoordinator {
  generate(evaluation: RiskEvaluation, actionContext: ActionContext): EvidenceBundle;
  upload(bundle: EvidenceBundle): Promise<{ blobId: string; evidenceHash: string }>;
  link(blobId: string, actionLogId: string, evidenceHash: string): Promise<void>;
}

/** The subset of a Sui execute response the submitter port surfaces. */
export interface SubmitResponseLike {
  txDigest: string;
  events?: unknown[];
  effects?: {
    status?: {
      status?: 'success' | 'failure' | string;
      error?: string | null;
    };
  };
}

/**
 * Narrow port that signs + submits a built PTB to Sui Testnet. A production
 * adapter wraps a real `SuiClient.signAndExecuteTransaction`; unit tests inject
 * a fake so no live RPC is required.
 */
export interface TransactionSubmitter {
  submit(tx: Transaction): Promise<SubmitResponseLike>;
}

/**
 * Injected collaborators for the full execution flow. All three are required by
 * {@link ActionExecutor.execute}; {@link ActionExecutor.submit} requires
 * `submitter` (and uses `network` for digest-origin verification when present).
 */
export interface ActionExecutorDeps {
  network?: NetworkVerifier;
  evidence?: EvidenceCoordinator;
  submitter?: TransactionSubmitter;
}

/** Stage of the execution flow a {@link ActionResult} stopped at. */
export type ActionStage =
  | 'network_verification'
  | 'evidence_upload'
  | 'ptb_build'
  | 'simulation'
  | 'submission'
  | 'evidence_link'
  | 'completed';

/**
 * Structured outcome of {@link ActionExecutor.execute}. `success` is true only
 * when the whole flow completed (evidence uploaded, PTB simulated + submitted,
 * evidence linked). On any failure, `stage` identifies where the flow stopped
 * and `failureReason` carries detail; `evidencePending` is set when an evidence
 * upload failure left the bundle pending/retrying. (Req 9.5, 9.6, 9.7, 17.2)
 */
export interface ActionResult {
  success: boolean;
  stage: ActionStage;
  txDigest?: string;
  blobId?: string;
  evidenceHash?: string;
  events?: unknown[];
  failureReason?: string;
  /** True when an upload failure left evidence pending/retrying (no PTB built). */
  evidencePending?: boolean;
}

/**
 * Input to {@link ActionExecutor.execute}. Evidence references are intentionally
 * absent from the action template: the blob id + evidence hash only exist after
 * the bundle is uploaded, which the flow does *before* building the PTB
 * (Req 9.1). They are filled in from the upload result.
 */
export interface ExecuteRequest {
  /** Action template parameters, minus the evidence references the upload provides. */
  action: Omit<BoundedActionRequest, 'evidenceBlobId' | 'evidenceHash'>;
  /** Risk evaluation the evidence bundle is generated from. */
  evaluation: RiskEvaluation;
  /** Action-flow context for evidence generation (signer, data source, etc.). */
  actionContext: ActionContext;
  /** ActionLog id the evidence is linked to after a successful submit. (Req 9.5) */
  actionLogId: string;
}

/**
 * Raised when a submitted transaction reports an on-chain failure/abort, or the
 * resulting digest cannot be confirmed on testnet. Carries the tx digest (when
 * one was returned) so the caller can surface the failed transaction. (Req 9.7,
 * 16.6)
 */
export class TransactionSubmissionError extends Error {
  readonly txDigest?: string;

  constructor(message: string, txDigest?: string) {
    super(message);
    this.name = 'TransactionSubmissionError';
    this.txDigest = txDigest;
  }
}

/** Server configuration for the fixed templates. All targets are server-owned. */
export interface ActionExecutorConfig {
  /** Deployed `sentinel_policy` package id (from app config `packageIds.policy`). */
  policyPackageId: string;
  /**
   * Optional configuration for the price-feed update template. The package id
   * is server-owned; `module`/`function` default to `pyth::update_price_feed`.
   * If a request includes a `priceFeedUpdate` but no pyth package is
   * configured, building the PTB is refused (fail-closed).
   */
  pyth?: {
    packageId: string;
    module?: string;
    function?: string;
  };
  /** Override the clock object id used when a request omits one. Defaults to 0x6. */
  defaultClockObjectId?: string;
}

/**
 * Builds PTBs from server-defined templates, dry-runs them, and (in task 11.4)
 * submits/executes them. The simulator port is injected for testability.
 */
export class ActionExecutor {
  private readonly policyPackageId: string;
  private readonly pyth?: { packageId: string; module: string; function: string };
  private readonly defaultClockObjectId: string;
  private readonly network?: NetworkVerifier;
  private readonly evidence?: EvidenceCoordinator;
  private readonly submitter?: TransactionSubmitter;

  constructor(
    config: ActionExecutorConfig,
    private readonly simulator?: TransactionSimulator,
    deps: ActionExecutorDeps = {},
  ) {
    if (!isNonEmptyString(config.policyPackageId)) {
      throw new ActionTemplateError(
        'ActionExecutor requires a configured sentinel_policy package id',
      );
    }
    this.policyPackageId = config.policyPackageId;
    this.defaultClockObjectId = config.defaultClockObjectId ?? SUI_CLOCK_OBJECT_ID;
    if (config.pyth) {
      if (!isNonEmptyString(config.pyth.packageId)) {
        throw new ActionTemplateError('Configured pyth target requires a package id');
      }
      this.pyth = {
        packageId: config.pyth.packageId,
        module: config.pyth.module ?? DEFAULT_PYTH_MODULE,
        function: config.pyth.function ?? DEFAULT_PYTH_FUNCTION,
      };
    }
    this.network = deps.network;
    this.evidence = deps.evidence;
    this.submitter = deps.submitter;
  }

  /**
   * Build the action PTB from the fixed server-defined template.
   *
   * Composes (optionally) the price-feed update Move call, then the
   * `execute_guardian_action` Move call with the configured policy package id
   * and the typed request arguments. The request is validated first; an unknown
   * action type, a malformed field, or any attempt to supply arbitrary PTB
   * structure causes an {@link ActionTemplateError} before a PTB is created.
   * (Req 9.2, 9.3, 16.4)
   */
  buildActionPtb(req: BoundedActionRequest): Transaction {
    assertValidActionRequest(req);

    const tx = new Transaction();
    const clockId = req.clockObjectId ?? this.defaultClockObjectId;

    // (optional) Template step 1: refresh the price feed in the same PTB. (Req 9.3)
    if (req.priceFeedUpdate) {
      if (!this.pyth) {
        throw new ActionTemplateError(
          'priceFeedUpdate was requested but no pyth target is configured; refusing to build PTB',
        );
      }
      tx.moveCall({
        target: `${this.pyth.packageId}::${this.pyth.module}::${this.pyth.function}`,
        arguments: [
          tx.object(req.priceFeedUpdate.priceInfoObjectId),
          tx.pure.vector('u8', toBytes(req.priceFeedUpdate.priceUpdateData)),
          tx.object(clockId),
        ],
      });
    }

    // Template step 2: the bounded guardian action. Validation + the bounded
    // mutation happen atomically on-chain; an abort reverts the whole PTB.
    tx.moveCall({
      target: `${this.policyPackageId}::${POLICY_MODULE}::${EXECUTE_GUARDIAN_ACTION}`,
      arguments: [
        tx.object(req.policyObjectId),
        tx.object(req.guardianCapObjectId),
        tx.object(req.marketStateObjectId),
        tx.pure.u8(req.actionType),
        tx.pure.u64(BigInt(req.newParamValue)),
        tx.pure.u64(BigInt(req.pauseDurationMs)),
        tx.pure.u8(req.riskScore),
        tx.pure.vector('u8', toBytes(utf8Bytes(req.evidenceBlobId))),
        tx.pure.vector('u8', toBytes(req.evidenceHash)),
        tx.pure.vector('u8', toBytes(req.txDigest ?? [])),
        tx.object(clockId),
      ],
    });

    return tx;
  }

  /**
   * Dry-run a PTB before submission and map the result to a
   * {@link SimulationResult}. A `success` effect status yields
   * `{ success: true }`; any other status (or a thrown error) yields
   * `{ success: false, error }` so the caller can refuse to submit.
   * (Req 16.5, 17.3)
   */
  async simulate(tx: Transaction): Promise<SimulationResult> {
    if (!this.simulator) {
      throw new ActionTemplateError(
        'ActionExecutor.simulate requires a TransactionSimulator; none was injected',
      );
    }

    let response: DryRunResponseLike;
    try {
      response = await this.simulator.dryRun(tx);
    } catch (err) {
      return { success: false, error: errorMessage(err), events: [] };
    }

    const status = response.effects?.status?.status;
    const events = response.events ?? [];
    if (status === 'success') {
      return { success: true, events };
    }
    return {
      success: false,
      error: response.effects?.status?.error ?? `Simulation reported status "${status ?? 'unknown'}"`,
      events,
    };
  }

  /**
   * Network-gated submission of a built PTB to Sui Testnet.
   *
   * Signs + submits through the injected {@link TransactionSubmitter}, then —
   * when a {@link NetworkVerifier} is present — confirms the resulting digest
   * originates from testnet before treating it as displayable (Req 16.6, 1.8).
   * If the on-chain effects report a `failure` status (a policy abort) or the
   * digest cannot be confirmed on testnet, a {@link TransactionSubmissionError}
   * is thrown carrying the digest so the caller can surface the failed
   * transaction. (Req 9.7)
   */
  async submit(tx: Transaction): Promise<SubmitResult> {
    if (!this.submitter) {
      throw new ActionTemplateError(
        'ActionExecutor.submit requires a TransactionSubmitter; none was injected',
      );
    }

    const response = await this.submitter.submit(tx);

    // An on-chain abort surfaces as a non-success effect status. Treat it as a
    // failed transaction: no successful action is recorded. (Req 9.7)
    const status = response.effects?.status?.status;
    if (status !== undefined && status !== 'success') {
      throw new TransactionSubmissionError(
        response.effects?.status?.error ??
          `Transaction reported status "${status}" on submit`,
        response.txDigest,
      );
    }

    // Network-gated: a digest is only displayable once confirmed on testnet.
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
   * Run the full network-gated execution flow with strict, fail-closed
   * ordering:
   *
   *  1. Verify the network (submission target package + RPC chain) **before**
   *     anything else; on failure refuse with no submission. (Req 16.6, 17.1)
   *  2. Generate the Evidence_Bundle and **upload it first — before building the
   *     action PTB** (Req 9.1). If the upload fails, do **not** build or submit
   *     the PTB; the evidence is left pending/retrying. (Req 9.6, 17.2)
   *  3. Build the PTB from the server-defined template using the returned blob
   *     id + evidence hash. (Req 9.2)
   *  4. Simulate (dry-run) before submit; if it fails, do **not** submit and
   *     surface the failed transaction. (Req 16.5, 17.3)
   *  5. Submit the PTB; an on-chain policy-validation abort surfaces as a failed
   *     transaction with no successful action recorded. (Req 9.7)
   *  6. Link the evidence to the resulting ActionLog (-> linked_on_chain).
   *     (Req 9.5)
   *
   * Returns a structured {@link ActionResult}; `success` is true only when the
   * whole flow completes.
   */
  async execute(input: ExecuteRequest): Promise<ActionResult> {
    const { network, evidence } = this.requireExecutionDeps();

    // --- 1. Network verification BEFORE anything else (Req 16.6, 17.1) -------
    try {
      await network.verifySubmissionTarget(this.policyPackageId);
    } catch (err) {
      // The guard records the environment-check failure; refuse with no submission.
      return { success: false, stage: 'network_verification', failureReason: errorMessage(err) };
    }

    // --- 2. Generate + UPLOAD evidence FIRST, before building the PTB --------
    //        (Req 9.1; fail-closed on upload failure per Req 9.6, 17.2)
    let bundle: EvidenceBundle;
    try {
      bundle = evidence.generate(input.evaluation, input.actionContext);
    } catch (err) {
      return { success: false, stage: 'evidence_upload', failureReason: errorMessage(err) };
    }

    let uploaded: { blobId: string; evidenceHash: string };
    try {
      uploaded = await evidence.upload(bundle);
    } catch (err) {
      // Upload failed: do NOT build or submit the PTB. The evidence is preserved
      // pending/retrying by the Evidence Service. (Req 9.6, 17.2, 17.4)
      return {
        success: false,
        stage: 'evidence_upload',
        evidencePending: true,
        failureReason: errorMessage(err),
      };
    }

    // --- 3. Build the PTB now that we have the blob id + evidence hash -------
    //        (Req 9.2)
    let tx: Transaction;
    try {
      tx = this.buildActionPtb({
        ...input.action,
        evidenceBlobId: uploaded.blobId,
        evidenceHash: hexToBytes(uploaded.evidenceHash),
      });
    } catch (err) {
      return {
        success: false,
        stage: 'ptb_build',
        blobId: uploaded.blobId,
        evidenceHash: uploaded.evidenceHash,
        failureReason: errorMessage(err),
      };
    }

    // --- 4. Simulate (dry-run) BEFORE submit (Req 16.5, 17.3) ---------------
    const simulation = await this.simulate(tx);
    if (!simulation.success) {
      // A failed dry-run (incl. a policy-validation abort) blocks submission and
      // surfaces the failed transaction; no successful action. (Req 9.7, 17.3)
      return {
        success: false,
        stage: 'simulation',
        blobId: uploaded.blobId,
        evidenceHash: uploaded.evidenceHash,
        events: simulation.events,
        failureReason: simulation.error,
      };
    }

    // --- 5. Submit; an on-chain abort surfaces as a failed transaction ------
    //        (Req 9.7, 16.6)
    let submitResult: SubmitResult;
    try {
      submitResult = await this.submit(tx);
    } catch (err) {
      const txDigest = err instanceof TransactionSubmissionError ? err.txDigest : undefined;
      return {
        success: false,
        stage: 'submission',
        blobId: uploaded.blobId,
        evidenceHash: uploaded.evidenceHash,
        txDigest,
        failureReason: errorMessage(err),
      };
    }

    // --- 6. Link the evidence to the ActionLog (-> linked_on_chain) ---------
    //        (Req 9.5)
    try {
      await evidence.link(uploaded.blobId, input.actionLogId, uploaded.evidenceHash);
    } catch (err) {
      return {
        success: false,
        stage: 'evidence_link',
        txDigest: submitResult.txDigest,
        blobId: uploaded.blobId,
        evidenceHash: uploaded.evidenceHash,
        events: submitResult.events,
        failureReason: errorMessage(err),
      };
    }

    return {
      success: true,
      stage: 'completed',
      txDigest: submitResult.txDigest,
      blobId: uploaded.blobId,
      evidenceHash: uploaded.evidenceHash,
      events: submitResult.events,
    };
  }

  /** Require the collaborators {@link ActionExecutor.execute} depends on. */
  private requireExecutionDeps(): {
    network: NetworkVerifier;
    evidence: EvidenceCoordinator;
    submitter: TransactionSubmitter;
  } {
    if (!this.network || !this.evidence || !this.submitter) {
      throw new ActionTemplateError(
        'ActionExecutor.execute requires injected network, evidence, and submitter dependencies',
      );
    }
    return { network: this.network, evidence: this.evidence, submitter: this.submitter };
  }
}

/**
 * Adapt a real `@mysten/sui` `SuiClient` into a {@link TransactionSimulator}.
 *
 * Builds the transaction bytes against the client (so object/gas data is
 * resolved) and dry-runs them. Kept separate from {@link ActionExecutor} so the
 * executor never depends on a live RPC in tests.
 */
export function createSuiClientSimulator(
  client: {
    dryRunTransactionBlock(input: {
      transactionBlock: Uint8Array;
    }): Promise<DryRunResponseLike>;
  },
  buildOptions: { sender?: string } = {},
): TransactionSimulator {
  return {
    async dryRun(tx: Transaction): Promise<DryRunResponseLike> {
      if (buildOptions.sender) {
        tx.setSenderIfNotSet(buildOptions.sender);
      }
      // `client` carries the build dependencies a real SuiClient exposes.
      const transactionBlock = await tx.build({ client: client as never });
      return client.dryRunTransactionBlock({ transactionBlock });
    },
  };
}

/**
 * Adapt a real `@mysten/sui` `SuiClient` + signer into a
 * {@link TransactionSubmitter}.
 *
 * Signs and executes the built PTB, requesting effects + events so the executor
 * can detect an on-chain abort and surface the digest. Kept separate from
 * {@link ActionExecutor} so the executor never depends on a live RPC/signer in
 * tests. (Req 9.7, 16.6)
 */
export function createSuiClientSubmitter<S>(
  client: {
    signAndExecuteTransaction(input: {
      transaction: Transaction;
      signer: S;
      options?: { showEffects?: boolean; showEvents?: boolean };
    }): Promise<{
      digest: string;
      effects?: DryRunResponseLike['effects'] | null;
      events?: unknown[] | null;
    }>;
    /** Optional: wait until the digest is indexed so post-submit reads resolve. */
    waitForTransaction?(input: { digest: string }): Promise<unknown>;
  },
  signer: S,
): TransactionSubmitter {
  return {
    async submit(tx: Transaction): Promise<SubmitResponseLike> {
      const res = await client.signAndExecuteTransaction({
        transaction: tx,
        signer,
        options: { showEffects: true, showEvents: true },
      });
      // Wait for the fullnode to index the tx so a subsequent digest-origin
      // verification (read-after-write) resolves instead of racing. Best-effort.
      if (client.waitForTransaction) {
        try {
          await client.waitForTransaction({ digest: res.digest });
        } catch {
          /* fall through — verification will retry/handle resolvability */
        }
      }
      return { txDigest: res.digest, events: res.events ?? [], effects: res.effects ?? undefined };
    },
  };
}

/**
 * Validate a {@link BoundedActionRequest} before any PTB is built.
 *
 * Rejects (with {@link ActionTemplateError}) unknown action types, malformed or
 * missing structured fields, and any attempt to smuggle raw transaction
 * structure through forbidden properties. This is the explicit template-only
 * enforcement point. (Req 16.4)
 */
export function assertValidActionRequest(req: BoundedActionRequest): void {
  if (req === null || typeof req !== 'object') {
    throw new ActionTemplateError('Action request must be a structured object');
  }

  // Reject any attempt to inject arbitrary PTB / Move-call structure.
  const record = req as unknown as Record<string, unknown>;
  for (const key of FORBIDDEN_REQUEST_KEYS) {
    if (Object.prototype.hasOwnProperty.call(record, key)) {
      throw new ActionTemplateError(
        `Action request must not supply arbitrary transaction structure (forbidden field "${key}"); ` +
          'PTBs are built from server-defined templates only',
      );
    }
  }

  // Action type must be one of the known, template-supported codes.
  if (!VALID_ACTION_TYPE_CODES.includes(req.actionType)) {
    throw new ActionTemplateError(
      `Unknown action type ${String(req.actionType)}; expected one of ` +
        `[${VALID_ACTION_TYPE_CODES.join(', ')}]`,
    );
  }

  // Required object ids must be present, non-empty strings.
  assertObjectId(req.policyObjectId, 'policyObjectId');
  assertObjectId(req.guardianCapObjectId, 'guardianCapObjectId');
  assertObjectId(req.marketStateObjectId, 'marketStateObjectId');
  if (req.clockObjectId !== undefined) {
    assertObjectId(req.clockObjectId, 'clockObjectId');
  }

  // Bounded numeric parameters must be non-negative integers (u64 domain).
  assertU64(req.newParamValue, 'newParamValue');
  assertU64(req.pauseDurationMs, 'pauseDurationMs');

  // risk score is a u8 in 0..255; Sentinel scores are 0..100.
  if (
    typeof req.riskScore !== 'number' ||
    !Number.isInteger(req.riskScore) ||
    req.riskScore < 0 ||
    req.riskScore > 255
  ) {
    throw new ActionTemplateError(
      `riskScore must be an integer in [0, 255], got ${String(req.riskScore)}`,
    );
  }

  if (!isNonEmptyString(req.evidenceBlobId)) {
    throw new ActionTemplateError('evidenceBlobId must be a non-empty string');
  }

  assertByteInput(req.evidenceHash, 'evidenceHash');
  if (req.txDigest !== undefined) {
    assertByteInput(req.txDigest, 'txDigest');
  }

  if (req.priceFeedUpdate !== undefined) {
    const pfu = req.priceFeedUpdate;
    if (pfu === null || typeof pfu !== 'object') {
      throw new ActionTemplateError('priceFeedUpdate must be a structured object when provided');
    }
    assertObjectId(pfu.priceInfoObjectId, 'priceFeedUpdate.priceInfoObjectId');
    assertByteInput(pfu.priceUpdateData, 'priceFeedUpdate.priceUpdateData');
  }
}

// === internal helpers ===

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function assertObjectId(value: unknown, field: string): void {
  if (!isNonEmptyString(value)) {
    throw new ActionTemplateError(`${field} must be a non-empty object id string`);
  }
}

function assertU64(value: unknown, field: string): void {
  if (typeof value === 'bigint') {
    if (value < 0n) {
      throw new ActionTemplateError(`${field} must be a non-negative integer`);
    }
    return;
  }
  if (typeof value === 'number') {
    if (!Number.isInteger(value) || value < 0) {
      throw new ActionTemplateError(`${field} must be a non-negative integer`);
    }
    return;
  }
  throw new ActionTemplateError(`${field} must be a number or bigint`);
}

function assertByteInput(value: unknown, field: string): void {
  if (value instanceof Uint8Array) {
    return;
  }
  if (Array.isArray(value) && value.every((b) => Number.isInteger(b) && b >= 0 && b <= 255)) {
    return;
  }
  throw new ActionTemplateError(`${field} must be a Uint8Array or an array of byte values (0..255)`);
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

/**
 * Decode a hex string (optionally `0x`-prefixed) into a byte-number list for a
 * `vector<u8>` argument. Used to turn the Evidence Service's hex evidence hash
 * into the bytes the guardian-action template expects. (Req 9.2)
 */
function hexToBytes(hex: string): number[] {
  const clean = hex.startsWith('0x') || hex.startsWith('0X') ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0) {
    throw new ActionTemplateError(`evidence hash hex string has an odd length: "${hex}"`);
  }
  const bytes: number[] = [];
  for (let i = 0; i < clean.length; i += 2) {
    const byte = Number.parseInt(clean.slice(i, i + 2), 16);
    if (Number.isNaN(byte)) {
      throw new ActionTemplateError(`evidence hash contains invalid hex: "${hex}"`);
    }
    bytes.push(byte);
  }
  return bytes;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
