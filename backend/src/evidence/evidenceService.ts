/**
 * Evidence Service — bundle generation + canonical serialization.
 *
 * This is the construction half of the design's `EvidenceService`:
 *
 *   interface EvidenceService {
 *     generate(evaluation, actionContext): EvidenceBundle;
 *     upload(bundle): Promise<{ blobId; evidenceHash }>;   // task 9.3
 *     link(blobId, actionLogId, evidenceHash): Promise<void>; // task 9.6
 *     getStatus(blobId): EvidenceStatus;                   // task 9.3
 *     assertMutable(blobId): void;                         // task 9.6
 *   }
 *
 * Only {@link EvidenceService.generate} and {@link EvidenceService.serialize}
 * are implemented here. The Walrus upload / status lifecycle (task 9.3) and
 * linking / immutability / encryption (task 9.6) layer on top of this class
 * later without changing bundle construction.
 *
 * `generate` is pure and deterministic: the same evaluation + context always
 * yields an identical bundle, including its `rawDataHash`. That hash is a
 * SHA-256 over the canonical serialization of the bundle's data fields (every
 * field except the hash itself), making it a verifiable content fingerprint of
 * the raw inputs. (Req 10.1)
 *
 * Security: the bundle carries the agent's *public* `agentSigner` address and
 * never a private key or other secret. A defensive assertion verifies no
 * secret-looking field leaked into the serialized output before it is hashed.
 * (Req 10.8)
 */

import { createHash } from 'node:crypto';

import type { RiskEvaluation } from '../risk/types.js';
import { canonicalJsonStringify } from './canonicalJson.js';
import { assertNoSecrets } from './secretGuard.js';
import {
  encryptSensitiveFields,
  type EncryptedSensitiveResult,
  type FieldEncryptFn,
} from './sensitiveFields.js';
import {
  EvidenceUploader,
  type EvidenceStatus,
  type EvidenceUploadDeps,
  type UploadResult,
} from './uploadManager.js';
import {
  EVIDENCE_SCHEMA_VERSION,
  type ActionContext,
  type EvidenceBundle,
  type EvidenceExposureSnapshot,
  type EvidenceLiquidity,
  type EvidencePrices,
} from './types.js';

export class EvidenceService {
  /**
   * Optional upload lifecycle manager. Present only when the service is
   * constructed with Walrus upload dependencies; {@link EvidenceService.generate}
   * and {@link EvidenceService.serialize} stay usable without it.
   */
  private readonly uploader?: EvidenceUploader;

  /**
   * @param uploadDeps Optional Walrus upload dependencies (client, store,
   *   clock, delay). When omitted the service supports only bundle generation
   *   and serialization; {@link EvidenceService.upload} then throws.
   */
  constructor(uploadDeps?: EvidenceUploadDeps) {
    this.uploader = uploadDeps ? new EvidenceUploader(uploadDeps) : undefined;
  }

  /**
   * Upload a bundle to Walrus with bounded (≤5), ≥5s-spaced retries, tracking
   * the status lifecycle and preserving the bundle on exhaustion. Returns the
   * Walrus blob id + evidence hash on success. (Req 10.2, 10.6, 10.7, 17.4)
   *
   * @throws if the service was constructed without upload dependencies.
   * @throws {import('./uploadManager.js').EvidenceUploadError} after 5 failures.
   */
  async upload(bundle: EvidenceBundle): Promise<UploadResult> {
    return this.requireUploader().upload(bundle);
  }

  /**
   * Current lifecycle status for a tracking record (always exactly one of the
   * allowed set), or `null` if unknown. (Req 10.3)
   *
   * @throws if the service was constructed without upload dependencies.
   */
  async getStatus(recordId: string): Promise<EvidenceStatus | null> {
    return this.requireUploader().getStatus(recordId);
  }

  private requireUploader(): EvidenceUploader {
    if (this.uploader === undefined) {
      throw new Error(
        'EvidenceService was constructed without upload dependencies; cannot upload/getStatus',
      );
    }
    return this.uploader;
  }

  /**
   * Link an uploaded blob to its on-chain ActionLog: record the evidence hash
   * on-chain and move the record to `linked_on_chain`. On on-chain failure the
   * blob id is retained, the record becomes `failed_upload`, and an error is
   * thrown. (Req 10.4, 10.5)
   *
   * @throws if the service was constructed without upload dependencies, or
   *   without an on-chain recorder.
   * @throws {import('./uploadManager.js').EvidenceLinkError} on link failure.
   * @throws {import('./uploadManager.js').EvidenceImmutableError} if already linked.
   */
  async link(blobId: string, actionLogId: string, evidenceHash: string): Promise<void> {
    return this.requireUploader().link(blobId, actionLogId, evidenceHash);
  }

  /**
   * Assert that the evidence record for `blobId` may be modified or deleted.
   * Throws for `linked_on_chain` records (immutable), returns for all others.
   * (Req 10.10)
   *
   * @throws if the service was constructed without upload dependencies.
   * @throws {import('./uploadManager.js').EvidenceImmutableError} if linked.
   */
  async assertMutable(blobId: string): Promise<void> {
    return this.requireUploader().assertMutable(blobId);
  }

  /**
   * Encrypt the policy-designated sensitive fields of a bundle, returning the
   * encrypted bundle (with `sensitiveFieldsEncrypted` populated) and its target
   * `private_encrypted` status. Pure; does not require upload dependencies.
   * Uses an injectable encryptor (deterministic stub by default). (Req 10.9)
   */
  encryptSensitiveFields(
    bundle: EvidenceBundle,
    sensitiveFieldNames: readonly string[],
    encryptFn?: FieldEncryptFn,
  ): EncryptedSensitiveResult {
    return encryptSensitiveFields(bundle, sensitiveFieldNames, encryptFn);
  }

  /**
   * Build a complete {@link EvidenceBundle} from a deterministic risk
   * evaluation plus its action context. Snapshot fields (prices/liquidity/
   * exposure) are taken from the context when provided, otherwise derived from
   * the evaluation's feature vector. The `rawDataHash` is computed last over
   * the canonical serialization of every other field. (Req 10.1)
   */
  generate(evaluation: RiskEvaluation, actionContext: ActionContext): EvidenceBundle {
    const fv = evaluation.featureVector;

    const timestampMs = actionContext.timestampMs ?? fv.nowMs;

    const prices: EvidencePrices = actionContext.prices
      ? {
          price: numToStr(actionContext.prices.price),
          confidence: numToStr(actionContext.prices.confidence),
          oracleTimestampMs: actionContext.prices.oracleTimestampMs,
          freshnessMs:
            actionContext.prices.freshnessMs ??
            timestampMs - actionContext.prices.oracleTimestampMs,
        }
      : {
          price: numToStr(fv.oraclePrice),
          confidence: numToStr(fv.oracleConfidence),
          oracleTimestampMs: fv.oracleTimestampMs,
          freshnessMs: timestampMs - fv.oracleTimestampMs,
        };

    const liquidity: EvidenceLiquidity = actionContext.liquidity
      ? {
          depth: numToStr(actionContext.liquidity.depth),
          spread: numToStr(actionContext.liquidity.spread),
          imbalance: numToStr(actionContext.liquidity.imbalance),
        }
      : {
          depth: numToStr(fv.liquidityDepth),
          spread: numToStr(fv.spreadBps),
          imbalance: numToStr(fv.imbalance),
        };

    const exposureSnapshot: EvidenceExposureSnapshot = actionContext.exposureSnapshot
      ? {
          utilization: numToStr(actionContext.exposureSnapshot.utilization),
          exposure: numToStr(actionContext.exposureSnapshot.exposure),
        }
      : {
          utilization: numToStr(fv.utilization),
          exposure: numToStr(fv.exposure),
        };

    // Every field except rawDataHash. The hash is computed over this.
    const bundleData: Omit<EvidenceBundle, 'rawDataHash'> = {
      schemaVersion: EVIDENCE_SCHEMA_VERSION,
      marketId: actionContext.marketId ?? evaluation.marketId,
      policyId: actionContext.policyId,
      timestampMs,
      dataSource: actionContext.dataSource,
      scenarioId: actionContext.scenarioId ?? null,
      prices,
      liquidity,
      exposureSnapshot,
      riskModelVersion: evaluation.modelVersion,
      promptConfigVersion: evaluation.promptConfigVersion,
      featureVector: fv,
      riskScore: evaluation.riskScore,
      riskClasses: evaluation.classes,
      recommendedAction: evaluation.recommendedAction ?? null,
      executedAction: actionContext.executedAction ?? null,
      aiExplanation: evaluation.explanation,
      deterministicRuleOutputs: evaluation.ruleOutputs,
      agentSigner: actionContext.agentSigner,
      txDigest: actionContext.txDigest ?? null,
      overrideReason: actionContext.overrideReason ?? null,
      priorActionIds: actionContext.priorActionIds ?? [],
    };

    // Defensive: refuse to emit evidence that contains a secret-looking key.
    assertNoSecrets(bundleData);

    const rawDataHash = hashCanonical(bundleData);

    return { ...bundleData, rawDataHash };
  }

  /**
   * Serialize a bundle to its canonical, stable-key-ordered JSON string. This
   * is the exact byte representation uploaded to Walrus (task 9.3) and the
   * basis for the on-chain evidence hash (task 9.6).
   */
  serialize(bundle: EvidenceBundle): string {
    return canonicalJsonStringify(bundle as unknown);
  }
}

/**
 * SHA-256 (hex) over the canonical serialization of `data`. Deterministic for
 * structurally equal inputs regardless of property insertion order.
 */
function hashCanonical(data: unknown): string {
  const canonical = canonicalJsonStringify(data);
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/** Format a finite number for string storage; rejects non-finite values. */
function numToStr(n: number): string {
  if (!Number.isFinite(n)) {
    throw new Error(`Cannot serialize non-finite numeric into evidence: ${String(n)}`);
  }
  return String(n);
}
