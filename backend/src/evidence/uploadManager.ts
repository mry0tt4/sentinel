/**
 * Evidence upload lifecycle + bounded retry.
 *
 * This is the upload half of the design's `EvidenceService`. It serializes an
 * Evidence_Bundle to canonical JSON, computes its SHA-256 evidence hash,
 * uploads the bytes to Walrus, and drives the status lifecycle through the
 * allowed set:
 *
 *   pending_upload → uploaded                       (first attempt succeeds)
 *   pending_upload → retrying → … → uploaded        (a later attempt succeeds)
 *   pending_upload → retrying → … → failed_upload   (all attempts exhausted)
 *
 * Retry policy (Req 10.6, 10.7, 17.4):
 *  - At most {@link MAX_UPLOAD_ATTEMPTS} (5) attempts.
 *  - Consecutive attempts are spaced at least {@link MIN_RETRY_INTERVAL_MS}
 *    (5s) apart via an injected delay function.
 *  - After the 5th failed attempt the status becomes `failed_upload`, the
 *    unuploaded bundle payload is preserved in the store for reprocessing, and
 *    an {@link EvidenceUploadError} is thrown.
 *
 * On success the status is `uploaded` and `{ blobId, evidenceHash }` is
 * returned — within the conceptual 30s budget (Req 10.2), which the per-attempt
 * timeout in {@link HttpWalrusClient} and the bounded attempt count keep
 * achievable.
 *
 * Every dependency — the Walrus client, the persistence store, the clock, and
 * the delay function — is injected, so unit tests exercise the full retry bound
 * and ≥5s spacing WITHOUT real waiting and WITHOUT a live Walrus or database.
 *
 * Linking, immutability, secret exclusion, and encryption are out of scope here
 * (task 9.6).
 */

import { createHash } from 'node:crypto';
import { randomUUID } from 'node:crypto';

import type { WalrusBlobInsert, WalrusBlobRow, WalrusStatus } from '../db/types.js';
import { canonicalJsonStringify } from './canonicalJson.js';
import { assertNoSecrets } from './secretGuard.js';
import type { EvidenceBundle } from './types.js';
import type { WalrusClient } from './walrusClient.js';

/**
 * The exact, exhaustive set of evidence statuses. The persisted status is
 * always exactly one of these. (Req 10.3 — Property 19)
 */
export const EVIDENCE_STATUSES = [
  'pending_upload',
  'uploaded',
  'linked_on_chain',
  'failed_upload',
  'retrying',
  'private_encrypted',
] as const;

/** A single, valid evidence status. Mirrors the DB CHECK constraint. */
export type EvidenceStatus = (typeof EVIDENCE_STATUSES)[number];

/** Type guard: is `value` exactly one of the allowed evidence statuses? */
export function isEvidenceStatus(value: unknown): value is EvidenceStatus {
  return (
    typeof value === 'string' && (EVIDENCE_STATUSES as readonly string[]).includes(value)
  );
}

/** Maximum number of upload attempts before giving up. (Req 10.6) */
export const MAX_UPLOAD_ATTEMPTS = 5;

/** Minimum spacing between consecutive upload attempts, in ms. (Req 10.6) */
export const MIN_RETRY_INTERVAL_MS = 5_000;

/**
 * Persistence seam for evidence-blob lifecycle tracking. Structurally a subset
 * of `WalrusBlobsRepository`, so the real repository satisfies it directly and
 * tests can supply an in-memory fake.
 */
export interface EvidenceBlobStore {
  create(input: WalrusBlobInsert): Promise<WalrusBlobRow>;
  recordAttempt(
    blobId: string,
    status: WalrusStatus,
    attemptAt: Date | string,
  ): Promise<WalrusBlobRow | null>;
  updateStatus(blobId: string, status: WalrusStatus): Promise<WalrusBlobRow | null>;
  getById(blobId: string): Promise<WalrusBlobRow | null>;
  /**
   * Re-key the provisional lifecycle row (created under a generated `pending-…`
   * id before Walrus assigns a blob id) to the real Walrus-assigned blob id, so
   * the record can be found by its on-chain blob id at link time. If a row
   * already exists under `toBlobId` (a content-addressed re-run yields the same
   * id), the provisional row is dropped and the existing row is reused.
   */
  rekey(fromBlobId: string, toBlobId: string): Promise<WalrusBlobRow | null>;
  /**
   * Associate a blob with an executed action, persist the on-chain evidence
   * hash, and move the record to `linked_on_chain`. Returns the updated row, or
   * `null` if no such record exists. (Req 10.4)
   */
  linkToAction(
    blobId: string,
    actionId: string,
    evidenceHash: string,
  ): Promise<WalrusBlobRow | null>;
}

/**
 * Context handed to an {@link OnChainHashRecorder} when linking evidence to an
 * on-chain ActionLog.
 */
export interface OnChainLinkContext {
  /** Tracking/blob id of the evidence record being linked. */
  blobId: string;
  /** Identifier of the on-chain ActionLog the evidence attaches to. */
  actionLogId: string;
  /** SHA-256 (hex) evidence hash to record on-chain. */
  evidenceHash: string;
}

/**
 * Injectable port that records an evidence hash on-chain during linking. The
 * real implementation submits to `sentinel_policy`; tests mock it to exercise
 * both the success and failure branches of {@link EvidenceUploader.link}.
 * (Req 10.4, 10.5)
 */
export type OnChainHashRecorder = (ctx: OnChainLinkContext) => Promise<void>;

/** Monotonic-enough clock seam; injectable so tests control time. */
export interface Clock {
  /** Current time in ms since the Unix epoch. */
  now(): number;
}

/** Sleep for `ms` milliseconds. Injectable so tests skip real waits. */
export type DelayFn = (ms: number) => Promise<void>;

/** Dependencies for {@link EvidenceUploader}. */
export interface EvidenceUploadDeps {
  /** Walrus network client (port). */
  walrus: WalrusClient;
  /** Lifecycle persistence store. */
  store: EvidenceBlobStore;
  /** Clock used for `last_attempt_at` timestamps. Defaults to `Date.now`. */
  clock?: Clock;
  /** Delay function used between attempts. Defaults to real `setTimeout`. */
  delay?: DelayFn;
  /**
   * Spacing between consecutive attempts, in ms. Clamped up to
   * {@link MIN_RETRY_INTERVAL_MS} so the ≥5s rule can never be violated by
   * configuration. (Req 10.6)
   */
  retryIntervalMs?: number;
  /**
   * Port that records the evidence hash on-chain during linking. Required to
   * call {@link EvidenceUploader.link}; omit it for upload-only usage.
   * (Req 10.4, 10.5)
   */
  recordOnChain?: OnChainHashRecorder;
}

/** Successful upload result. */
export interface UploadResult {
  /** Walrus-assigned blob id. */
  blobId: string;
  /** SHA-256 (hex) of the canonical bundle bytes. */
  evidenceHash: string;
}

/**
 * Thrown when all upload attempts are exhausted. Carries the tracking record id
 * (whose row preserves the unuploaded bundle for reprocessing), the evidence
 * hash, and the attempt count. (Req 10.7, 17.4)
 */
export class EvidenceUploadError extends Error {
  readonly recordId: string;
  readonly evidenceHash: string;
  readonly attempts: number;
  /** Underlying error/value from the final failed attempt, if any. */
  readonly reason?: unknown;

  constructor(
    message: string,
    recordId: string,
    evidenceHash: string,
    attempts: number,
    reason?: unknown,
  ) {
    super(message);
    this.name = 'EvidenceUploadError';
    this.recordId = recordId;
    this.evidenceHash = evidenceHash;
    this.attempts = attempts;
    this.reason = reason;
  }
}

/**
 * Thrown when an attempt is made to modify or delete `linked_on_chain`
 * evidence. The stored bundle and recorded hash are left unchanged. (Req 10.10)
 */
export class EvidenceImmutableError extends Error {
  readonly blobId: string;

  constructor(blobId: string) {
    super(`Evidence "${blobId}" is linked_on_chain and immutable; modify/delete rejected (Req 10.10)`);
    this.name = 'EvidenceImmutableError';
    this.blobId = blobId;
  }
}

/**
 * Thrown when on-chain hash recording fails during linking. The stored blob id
 * is retained and the record is moved to `failed_upload`. (Req 10.5)
 */
export class EvidenceLinkError extends Error {
  readonly blobId: string;
  /** Underlying error/value from the failed on-chain recording, if any. */
  readonly reason?: unknown;

  constructor(blobId: string, reason?: unknown) {
    super(
      `On-chain evidence linking did not complete for "${blobId}"; status set to failed_upload (Req 10.5): ${errMessage(reason)}`,
    );
    this.name = 'EvidenceLinkError';
    this.blobId = blobId;
    this.reason = reason;
  }
}

/** Default delay: a real timer. Replaced in tests with an injected no-wait fn. */
const realDelay: DelayFn = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const systemClock: Clock = { now: () => Date.now() };

/**
 * Drives the Walrus upload lifecycle with bounded, spaced retries.
 *
 * A single tracking row (keyed by a generated record id) is created in
 * `pending_upload` with the bundle payload preserved, then transitioned through
 * `retrying` on each failed attempt and finally to `uploaded` or
 * `failed_upload`. The Walrus-assigned blob id obtained on success is returned
 * to the caller; associating it with an on-chain ActionLog is task 9.6's
 * `link`.
 */
export class EvidenceUploader {
  private readonly walrus: WalrusClient;
  private readonly store: EvidenceBlobStore;
  private readonly clock: Clock;
  private readonly delay: DelayFn;
  private readonly retryIntervalMs: number;
  private readonly recordOnChain?: OnChainHashRecorder;

  constructor(deps: EvidenceUploadDeps) {
    this.walrus = deps.walrus;
    this.store = deps.store;
    this.clock = deps.clock ?? systemClock;
    this.delay = deps.delay ?? realDelay;
    this.recordOnChain = deps.recordOnChain;
    // Never allow a configured interval below the 5s floor. (Req 10.6)
    this.retryIntervalMs = Math.max(
      deps.retryIntervalMs ?? MIN_RETRY_INTERVAL_MS,
      MIN_RETRY_INTERVAL_MS,
    );
  }

  /**
   * Upload `bundle` to Walrus with bounded, ≥5s-spaced retries.
   *
   * @returns the Walrus blob id + evidence hash on success.
   * @throws {EvidenceUploadError} after 5 failed attempts; the tracking row is
   *   left in `failed_upload` with the bundle payload preserved.
   */
  async upload(bundle: EvidenceBundle): Promise<UploadResult> {
    // Secrets/private keys must never be persisted in a non-private bundle.
    // The upload path produces `pending_upload`/`uploaded` records, so guard
    // before anything touches the store. (Req 10.8, 16.1)
    assertNoSecrets(bundle);

    const canonical = canonicalJsonStringify(bundle as unknown);
    const evidenceHash = createHash('sha256').update(canonical, 'utf8').digest('hex');
    const bytes = new TextEncoder().encode(canonical);

    // A provisional tracking id keys the lifecycle row before (and if) Walrus
    // assigns a real blob id. The payload is preserved from the outset so an
    // exhausted upload leaves the bundle recoverable for reprocessing.
    const recordId = `pending-${randomUUID()}`;

    await this.store.create({
      blob_id: recordId,
      status: 'pending_upload',
      evidence_hash: evidenceHash,
      attempt_count: 0,
      payload: bundle as unknown as WalrusBlobInsert['payload'],
    });

    let lastError: unknown;

    for (let attempt = 1; attempt <= MAX_UPLOAD_ATTEMPTS; attempt += 1) {
      // Space consecutive attempts at least 5s apart (no delay before the 1st).
      if (attempt > 1) {
        await this.delay(this.retryIntervalMs);
      }

      try {
        const { blobId } = await this.walrus.store(bytes);
        // Re-key the provisional row to the real Walrus blob id so a later
        // `link(blobId, …)` lookup finds it (the executor links by the Walrus
        // blob id it embeds on-chain, not by the internal provisional id).
        await this.store.rekey(recordId, blobId);
        await this.store.updateStatus(blobId, 'uploaded');
        return { blobId, evidenceHash };
      } catch (err) {
        lastError = err;
        const isLastAttempt = attempt === MAX_UPLOAD_ATTEMPTS;
        const nextStatus: WalrusStatus = isLastAttempt ? 'failed_upload' : 'retrying';
        // Increment attempt_count + stamp last_attempt_at, transitioning the
        // status. The store's `attempt_count <= 5` CHECK backstops the bound.
        await this.store.recordAttempt(
          recordId,
          nextStatus,
          new Date(this.clock.now()).toISOString(),
        );
      }
    }

    // All attempts exhausted: status is `failed_upload`, bundle preserved.
    throw new EvidenceUploadError(
      `Walrus upload failed after ${MAX_UPLOAD_ATTEMPTS} attempts: ${errMessage(lastError)}`,
      recordId,
      evidenceHash,
      MAX_UPLOAD_ATTEMPTS,
      lastError,
    );
  }

  /**
   * Link an uploaded blob to its on-chain ActionLog: record the evidence hash
   * on-chain, then persist the association and move the record to
   * `linked_on_chain`. (Req 10.4)
   *
   * IF recording the hash on-chain fails, the stored blob id is retained, the
   * record is moved to `failed_upload`, and an {@link EvidenceLinkError} is
   * thrown — the link did not complete. (Req 10.5)
   *
   * Before linking, the stored bundle payload is re-checked so no secret can be
   * promoted into a `linked_on_chain` (non-private) record. (Req 10.8)
   *
   * @throws if no on-chain recorder was configured.
   * @throws {EvidenceImmutableError} if the record is already `linked_on_chain`.
   * @throws {EvidenceLinkError} if on-chain recording fails.
   * @throws if no tracking record exists for `blobId`.
   */
  async link(blobId: string, actionLogId: string, evidenceHash: string): Promise<void> {
    if (this.recordOnChain === undefined) {
      throw new Error('EvidenceUploader was constructed without an on-chain recorder; cannot link');
    }

    const existing = await this.store.getById(blobId);
    if (existing === null) {
      throw new Error(`Cannot link unknown evidence record "${blobId}"`);
    }
    // Re-linking immutable evidence is a modification and is rejected. (Req 10.10)
    if (existing.status === 'linked_on_chain') {
      throw new EvidenceImmutableError(blobId);
    }
    // Defense in depth: the payload must carry no secret before it becomes a
    // non-private linked record. (Req 10.8)
    if (existing.payload !== null && existing.payload !== undefined) {
      assertNoSecrets(existing.payload);
    }

    try {
      await this.recordOnChain({ blobId, actionLogId, evidenceHash });
    } catch (err) {
      // On-chain linking failed: retain the blob id, mark failed_upload, error.
      await this.store.updateStatus(blobId, 'failed_upload');
      throw new EvidenceLinkError(blobId, err);
    }

    const linked = await this.store.linkToAction(blobId, actionLogId, evidenceHash);
    if (linked === null) {
      throw new Error(`Failed to persist link for evidence record "${blobId}"`);
    }
  }

  /**
   * Assert that the evidence record for `blobId` may be modified or deleted.
   * Records in `linked_on_chain` are immutable: this throws
   * {@link EvidenceImmutableError} for them, leaving the stored bundle and
   * recorded hash untouched. Records in any other status (or unknown records)
   * are mutable and the call returns normally. (Req 10.10)
   */
  async assertMutable(blobId: string): Promise<void> {
    const row = await this.store.getById(blobId);
    if (row !== null && row.status === 'linked_on_chain') {
      throw new EvidenceImmutableError(blobId);
    }
  }

  /**
   * Return the current lifecycle status for a tracking record, or `null` if no
   * such record exists. Always exactly one of {@link EVIDENCE_STATUSES}.
   */
  async getStatus(recordId: string): Promise<EvidenceStatus | null> {
    const row = await this.store.getById(recordId);
    if (row === null) {
      return null;
    }
    if (!isEvidenceStatus(row.status)) {
      // The DB CHECK constraint makes this unreachable; guard defensively.
      throw new Error(`Persisted evidence status is not a valid status: ${String(row.status)}`);
    }
    return row.status;
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
