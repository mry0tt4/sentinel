/**
 * Evidence_Bundle domain types.
 *
 * An Evidence_Bundle is the structured, immutable JSON record produced for a
 * single risk evaluation / action. It captures every input, model version,
 * feature, score, classification, recommended/executed action, explanation,
 * signer, and transaction digest needed to audit an autonomous decision. The
 * shape here mirrors the "Evidence_Bundle JSON Schema" in the design exactly.
 * (Req 10.1)
 *
 * Two security invariants shape these types:
 *  - The bundle MUST NOT contain secrets or private keys for any non-private
 *    status. `agentSigner` is the agent's *public* address, never its key.
 *    (Req 10.8)
 *  - Sensitive fields designated by policy config are encrypted before storage
 *    and recorded by name in `sensitiveFieldsEncrypted`; that lifecycle lands
 *    in a later task (9.6) — this module only models the field. (Req 10.9)
 *
 * This file defines only the data contracts. Bundle construction lives in
 * {@link ./evidenceService.ts}; the Walrus upload / status lifecycle (task 9.3)
 * and linking/immutability/encryption (task 9.6) slot in on top later.
 */

import type {
  ActionType,
  DeterministicRuleOutput,
  FeatureVector,
  RiskClass,
} from '../risk/types.js';

/** Current Evidence_Bundle schema version. Bumped on breaking shape changes. */
export const EVIDENCE_SCHEMA_VERSION = '1.0';

/**
 * Whether the underlying data came from a live testnet feed or a simulated
 * scenario. The dashboard and replay views surface this distinction. (Req 14)
 */
export type EvidenceDataSource = 'live' | 'simulated';

/**
 * Price snapshot as serialized into the bundle. Numeric magnitudes are stored
 * as strings to preserve exact precision across JSON round-trips and to keep
 * the rawDataHash stable regardless of float formatting. `freshnessMs` is the
 * oracle age (now - oracleTimestampMs) at evaluation time.
 */
export interface EvidencePrices {
  price: string;
  confidence: string;
  oracleTimestampMs: number;
  freshnessMs: number;
}

/** Liquidity snapshot as serialized into the bundle (string magnitudes). */
export interface EvidenceLiquidity {
  depth: string;
  spread: string;
  imbalance: string;
}

/** Protocol exposure snapshot as serialized into the bundle (string magnitudes). */
export interface EvidenceExposureSnapshot {
  utilization: string;
  exposure: string;
}

/**
 * The complete Evidence_Bundle. Field-for-field this matches the design JSON
 * schema; every Req 10.1 element is represented.
 */
export interface EvidenceBundle {
  /** Schema version, e.g. "1.0". */
  schemaVersion: string;
  /** Market identifier the evaluation targeted. */
  marketId: string;
  /** Governing Risk_Policy identifier. */
  policyId: string;
  /** Bundle/evaluation timestamp, ms since epoch. */
  timestampMs: number;
  /** Whether inputs were live or simulated. */
  dataSource: EvidenceDataSource;
  /** Simulation scenario id when `dataSource === 'simulated'`, else null. */
  scenarioId: string | null;
  /** Oracle price snapshot. */
  prices: EvidencePrices;
  /** Liquidity snapshot. */
  liquidity: EvidenceLiquidity;
  /** Protocol exposure snapshot. */
  exposureSnapshot: EvidenceExposureSnapshot;
  /** Risk model version (reproducibility). (Req 6.12) */
  riskModelVersion: string;
  /** Prompt/config version (reproducibility). (Req 6.12) */
  promptConfigVersion: string;
  /** The exact feature vector evaluated (numeric features). */
  featureVector: FeatureVector;
  /** Integer risk score in [0, 100]. */
  riskScore: number;
  /** Non-empty subset of risk classes assigned. */
  riskClasses: RiskClass[];
  /** Deterministic recommended action, or null when none/refused. */
  recommendedAction: string | null;
  /** Action actually executed on-chain, or null if none executed. */
  executedAction: string | null;
  /** Plain-language AI explanation (<=1000 chars). */
  aiExplanation: string;
  /** All deterministic rule outputs for this evaluation. */
  deterministicRuleOutputs: DeterministicRuleOutput[];
  /** Public address of the agent signer (NEVER a private key). (Req 10.8) */
  agentSigner: string;
  /** Sui transaction digest once executed, else null. */
  txDigest: string | null;
  /**
   * Human override reason recorded when this bundle backs a DAO override
   * operation (reverse / revoke / update-thresholds / unpause), else null. A
   * non-empty reason is required for every Override_Console operation and is
   * carried here so the evidence audit trail captures *why* a human intervened.
   * (Req 11.6, 11.4)
   */
  overrideReason: string | null;
  /** Identifiers of prior actions on this market for context. */
  priorActionIds: string[];
  /** SHA-256 hash over the canonical serialized bundle inputs. */
  rawDataHash: string;
  /** Names of fields encrypted under `private_encrypted` status (task 9.6). */
  sensitiveFieldsEncrypted?: string[];
}

/** Numeric price snapshot input supplied by the action context. */
export interface PriceSnapshotInput {
  price: number;
  confidence: number;
  oracleTimestampMs: number;
  /** Oracle freshness/age in ms. Defaults to (now - oracleTimestampMs). */
  freshnessMs?: number;
}

/** Numeric liquidity snapshot input supplied by the action context. */
export interface LiquiditySnapshotInput {
  depth: number;
  spread: number;
  imbalance: number;
}

/** Numeric exposure snapshot input supplied by the action context. */
export interface ExposureSnapshotInput {
  utilization: number;
  exposure: number;
}

/**
 * The action-flow context carried alongside a {@link RiskEvaluation} into
 * {@link EvidenceService.generate}. It supplies the identity, signing, and
 * action-lifecycle data that the pure risk evaluation does not own, plus
 * optional snapshot overrides. When `prices`, `liquidity`, or `exposureSnapshot`
 * are omitted they are derived deterministically from the evaluation's feature
 * vector, so the context need only override them when an authoritative
 * out-of-band reading exists.
 */
export interface ActionContext {
  /** Governing policy id. */
  policyId: string;
  /** Public address of the agent signer (NEVER a key). (Req 10.8) */
  agentSigner: string;
  /** Live vs simulated data source. */
  dataSource: EvidenceDataSource;
  /** Scenario id for simulated runs; null/omitted for live. */
  scenarioId?: string | null;
  /** Sui tx digest once the action executed; null/omitted otherwise. */
  txDigest?: string | null;
  /** Prior action identifiers for this market. Defaults to []. */
  priorActionIds?: string[];
  /** Action actually executed on-chain; null/omitted if none. */
  executedAction?: ActionType | string | null;
  /**
   * Human override reason for a DAO override operation (reverse / revoke /
   * update-thresholds / unpause). Carried through into the generated
   * Evidence_Bundle's `overrideReason`. Required (non-empty) for override
   * operations; null/omitted for ordinary autonomous actions. (Req 11.6, 11.4)
   */
  overrideReason?: string | null;
  /**
   * Bundle timestamp, ms since epoch. Defaults to the evaluation's reference
   * time (`featureVector.nowMs`) to keep the bundle — and its hash —
   * deterministic for a given evaluation.
   */
  timestampMs?: number;
  /** Overrides the market id (defaults to the evaluation's market id). */
  marketId?: string;
  /** Authoritative price snapshot; derived from the feature vector if omitted. */
  prices?: PriceSnapshotInput;
  /** Authoritative liquidity snapshot; derived from the feature vector if omitted. */
  liquidity?: LiquiditySnapshotInput;
  /** Authoritative exposure snapshot; derived from the feature vector if omitted. */
  exposureSnapshot?: ExposureSnapshotInput;
}
