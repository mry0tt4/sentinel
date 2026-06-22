/**
 * Evidence module public surface.
 *
 * Bundle generation + canonical serialization (task 9.1). The Walrus upload /
 * status lifecycle (task 9.3) and linking / immutability / encryption
 * (task 9.6) will extend {@link EvidenceService} and re-export here.
 */

export { EvidenceService } from './evidenceService.js';
export { canonicalJsonStringify, type JsonValue } from './canonicalJson.js';
export {
  EvidenceUploader,
  EvidenceUploadError,
  EvidenceImmutableError,
  EvidenceLinkError,
  EVIDENCE_STATUSES,
  MAX_UPLOAD_ATTEMPTS,
  MIN_RETRY_INTERVAL_MS,
  isEvidenceStatus,
  type Clock,
  type DelayFn,
  type EvidenceBlobStore,
  type EvidenceStatus,
  type EvidenceUploadDeps,
  type OnChainHashRecorder,
  type OnChainLinkContext,
  type UploadResult,
} from './uploadManager.js';
export {
  assertNoSecrets,
  containsSecretKey,
  findSecretKey,
  FORBIDDEN_KEY_SUBSTRINGS,
} from './secretGuard.js';
export {
  encryptSensitiveFields,
  defaultDeterministicEncrypt,
  type EncryptedSensitiveResult,
  type FieldEncryptFn,
} from './sensitiveFields.js';
export {
  HttpWalrusClient,
  WalrusStoreError,
  type FetchLike,
  type HttpWalrusClientOptions,
  type WalrusClient,
  type WalrusStoreResult,
} from './walrusClient.js';
export {
  EVIDENCE_SCHEMA_VERSION,
  type ActionContext,
  type EvidenceBundle,
  type EvidenceDataSource,
  type EvidenceExposureSnapshot,
  type EvidenceLiquidity,
  type EvidencePrices,
  type ExposureSnapshotInput,
  type LiquiditySnapshotInput,
  type PriceSnapshotInput,
} from './types.js';
