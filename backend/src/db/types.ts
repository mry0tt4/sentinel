/**
 * Typed domain models for the seven Sentinel PostgreSQL tables.
 *
 * Each interface mirrors the columns defined in
 * `backend/migrations/0001_initial_schema.sql` (and the design's "PostgreSQL
 * Schema"). Fields that are `NOT NULL` are required; nullable columns are
 * typed with `| null`. `DEFAULT`ed columns (ids, timestamps, counters) are
 * optional on the *insert* input types defined below so callers can omit them
 * and let Postgres fill them in. (Requirement 15.3)
 *
 * Postgres `BIGINT` columns are returned by the `pg` driver as strings to avoid
 * precision loss; we model those fields as `string` and let higher layers
 * convert to `bigint`/`number` where needed.
 */

// ---------------------------------------------------------------------------
// Enumerated column domains (mirror the SQL CHECK constraints).
// ---------------------------------------------------------------------------

export type MarketType = 'lending' | 'perps' | 'stablecoin' | 'demo';
export type MarketStatus = 'Normal' | 'Warning' | 'Guarded' | 'Paused' | 'Revoked';
export type DataSource = 'live' | 'simulated';
export type ActorType = 'agent' | 'dao' | 'admin';
export type WalrusStatus =
  | 'pending_upload'
  | 'uploaded'
  | 'linked_on_chain'
  | 'failed_upload'
  | 'retrying'
  | 'private_encrypted';
export type EnvCheckType =
  | 'rpc_chain_id'
  | 'submission_target'
  | 'digest_origin'
  | 'wallet_network';
export type EnvCheckOutcome = 'pass' | 'fail';

/** JSON value type used for `JSONB` columns. */
export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json }
  | Json[];

// ---------------------------------------------------------------------------
// Row types — shapes returned from SELECT * for each table.
// ---------------------------------------------------------------------------

/** `markets` row. */
export interface MarketRow {
  id: string;
  on_chain_id: string;
  market_type: MarketType;
  name: string;
  status: MarketStatus;
  freshness_threshold_ms: string; // BIGINT
  created_at: Date;
}

/** `policies` row. */
export interface PolicyRow {
  id: string;
  market_id: string;
  on_chain_policy_id: string;
  guardian_cap_id: string | null;
  override_cap_id: string | null;
  owner_address: string;
  dao_address: string;
  allowed_actions: string[];
  max_ltv_delta_bps: number;
  max_margin_delta_bps: number;
  pause_duration_limit_ms: string; // BIGINT
  cooldown_ms: string; // BIGINT
  risk_thresholds: Json;
  is_revoked: boolean;
  is_paused: boolean;
  version: number;
  walrus_config_blob_id: string | null;
  created_at: Date;
}

/** `risk_snapshots` row. */
export interface RiskSnapshotRow {
  id: string;
  market_id: string;
  risk_score: number;
  band: string;
  classes: string[];
  confidence: number;
  feature_vector: Json;
  rule_outputs: Json;
  recommended_action: string | null;
  refusal_reason: string | null;
  model_version: string;
  prompt_config_version: string;
  explanation: string | null;
  is_simulated: boolean;
  data_source: DataSource;
  created_at: Date;
}

/** `incidents` row. */
export interface IncidentRow {
  id: string;
  market_id: string;
  started_at: Date;
  ended_at: Date | null;
  scenario_id: string | null;
  is_simulated: boolean;
  summary: string | null;
}

/** `actions` row. */
export interface ActionRow {
  id: string;
  policy_id: string;
  market_id: string;
  incident_id: string | null;
  actor: string;
  actor_type: ActorType;
  risk_score: number | null;
  action_type: string;
  old_value: string | null;
  new_value: string | null;
  walrus_evidence_blob_id: string | null;
  evidence_hash: string | null;
  tx_digest: string | null;
  is_reversed: boolean;
  reversed_by: string | null;
  reversal_tx_digest: string | null;
  override_reason: string | null;
  timestamp_ms: string; // BIGINT
  created_at: Date;
}

/** `walrus_blobs` row. */
export interface WalrusBlobRow {
  blob_id: string;
  action_id: string | null;
  market_id: string | null;
  status: WalrusStatus;
  evidence_hash: string | null;
  attempt_count: number;
  last_attempt_at: Date | null;
  payload: Json | null;
  created_at: Date;
}

/** `environment_checks` row. */
export interface EnvironmentCheckRow {
  id: string;
  check_type: EnvCheckType;
  outcome: EnvCheckOutcome;
  detail: string | null;
  checked_at: Date;
}

// ---------------------------------------------------------------------------
// Insert input types — what callers provide to create a row. DB-defaulted
// columns (id, created_at, counters, boolean defaults) are optional.
// ---------------------------------------------------------------------------

export interface MarketInsert {
  id?: string;
  on_chain_id: string;
  market_type: MarketType;
  name: string;
  status: MarketStatus;
  freshness_threshold_ms: number | string;
}

export interface PolicyInsert {
  id?: string;
  market_id: string;
  on_chain_policy_id: string;
  guardian_cap_id?: string | null;
  override_cap_id?: string | null;
  owner_address: string;
  dao_address: string;
  allowed_actions: string[];
  max_ltv_delta_bps: number;
  max_margin_delta_bps: number;
  pause_duration_limit_ms: number | string;
  cooldown_ms: number | string;
  risk_thresholds: Json;
  is_revoked?: boolean;
  is_paused?: boolean;
  version?: number;
  walrus_config_blob_id?: string | null;
}

export interface RiskSnapshotInsert {
  id?: string;
  market_id: string;
  risk_score: number;
  band: string;
  classes: string[];
  confidence: number;
  feature_vector: Json;
  rule_outputs: Json;
  recommended_action?: string | null;
  refusal_reason?: string | null;
  model_version: string;
  prompt_config_version: string;
  explanation?: string | null;
  is_simulated?: boolean;
  data_source: DataSource;
}

export interface IncidentInsert {
  id?: string;
  market_id: string;
  started_at: Date | string;
  ended_at?: Date | string | null;
  scenario_id?: string | null;
  is_simulated?: boolean;
  summary?: string | null;
}

export interface ActionInsert {
  id?: string;
  policy_id: string;
  market_id: string;
  incident_id?: string | null;
  actor: string;
  actor_type: ActorType;
  risk_score?: number | null;
  action_type: string;
  old_value?: string | null;
  new_value?: string | null;
  walrus_evidence_blob_id?: string | null;
  evidence_hash?: string | null;
  tx_digest?: string | null;
  is_reversed?: boolean;
  reversed_by?: string | null;
  reversal_tx_digest?: string | null;
  override_reason?: string | null;
  timestamp_ms: number | string;
}

export interface WalrusBlobInsert {
  blob_id: string;
  action_id?: string | null;
  market_id?: string | null;
  status: WalrusStatus;
  evidence_hash?: string | null;
  attempt_count?: number;
  last_attempt_at?: Date | string | null;
  payload?: Json | null;
}

export interface EnvironmentCheckInsert {
  id?: string;
  check_type: EnvCheckType;
  outcome: EnvCheckOutcome;
  detail?: string | null;
}
