-- =============================================================================
-- Migration 0001: Initial Sentinel schema
-- =============================================================================
-- Creates the seven core tables and their constraints exactly as defined in
-- the design document (.kiro/specs/sentinel-risk-guardian/design.md,
-- "PostgreSQL Schema"). (Requirement 15.3)
--
-- Tables are created in foreign-key dependency order:
--   markets -> policies -> risk_snapshots -> incidents -> actions
--           -> walrus_blobs -> environment_checks
-- =============================================================================

-- markets: monitored market registry
CREATE TABLE IF NOT EXISTS markets (
  id              UUID PRIMARY KEY,
  on_chain_id     TEXT NOT NULL,            -- Sui object id of demo market
  market_type     TEXT NOT NULL CHECK (market_type IN ('lending','perps','stablecoin','demo')),
  name            TEXT NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('Normal','Warning','Guarded','Paused','Revoked')),
  freshness_threshold_ms BIGINT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- policies: off-chain mirror of on-chain RiskPolicy config
CREATE TABLE IF NOT EXISTS policies (
  id                    UUID PRIMARY KEY,
  market_id             UUID NOT NULL REFERENCES markets(id),
  on_chain_policy_id    TEXT NOT NULL,
  guardian_cap_id       TEXT,
  override_cap_id       TEXT,
  owner_address         TEXT NOT NULL,
  dao_address           TEXT NOT NULL,
  allowed_actions       TEXT[] NOT NULL,
  max_ltv_delta_bps     INTEGER NOT NULL CHECK (max_ltv_delta_bps >= 0),
  max_margin_delta_bps  INTEGER NOT NULL CHECK (max_margin_delta_bps >= 0),
  pause_duration_limit_ms BIGINT NOT NULL CHECK (pause_duration_limit_ms >= 0),
  cooldown_ms           BIGINT NOT NULL CHECK (cooldown_ms >= 0),
  risk_thresholds       JSONB NOT NULL,
  is_revoked            BOOLEAN NOT NULL DEFAULT false,
  is_paused             BOOLEAN NOT NULL DEFAULT false,
  version               INTEGER NOT NULL DEFAULT 1,
  walrus_config_blob_id TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- risk_snapshots: time-series of evaluations
CREATE TABLE IF NOT EXISTS risk_snapshots (
  id              UUID PRIMARY KEY,
  market_id       UUID NOT NULL REFERENCES markets(id),
  risk_score      INTEGER NOT NULL CHECK (risk_score BETWEEN 0 AND 100),
  band            TEXT NOT NULL,
  classes         TEXT[] NOT NULL,
  confidence      INTEGER NOT NULL CHECK (confidence BETWEEN 0 AND 100),
  feature_vector  JSONB NOT NULL,
  rule_outputs    JSONB NOT NULL,
  recommended_action TEXT,
  refusal_reason  TEXT,
  model_version   TEXT NOT NULL,
  prompt_config_version TEXT NOT NULL,
  explanation     TEXT,                      -- <=1000 chars
  is_simulated    BOOLEAN NOT NULL DEFAULT false,
  data_source     TEXT NOT NULL CHECK (data_source IN ('live','simulated')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- incidents: grouped timelines
CREATE TABLE IF NOT EXISTS incidents (
  id              UUID PRIMARY KEY,
  market_id       UUID NOT NULL REFERENCES markets(id),
  started_at      TIMESTAMPTZ NOT NULL,
  ended_at        TIMESTAMPTZ,
  scenario_id     TEXT,                      -- set if simulated
  is_simulated    BOOLEAN NOT NULL DEFAULT false,
  summary         TEXT
);

-- actions: executed/reversed actions (mirror of on-chain ActionLog)
CREATE TABLE IF NOT EXISTS actions (
  id                  UUID PRIMARY KEY,
  policy_id           UUID NOT NULL REFERENCES policies(id),
  market_id           UUID NOT NULL REFERENCES markets(id),
  incident_id         UUID REFERENCES incidents(id),
  actor               TEXT NOT NULL,
  actor_type          TEXT NOT NULL CHECK (actor_type IN ('agent','dao','admin')),
  risk_score          INTEGER CHECK (risk_score BETWEEN 0 AND 100),
  action_type         TEXT NOT NULL,
  old_value           TEXT,
  new_value           TEXT,
  walrus_evidence_blob_id TEXT,
  evidence_hash       TEXT,
  tx_digest           TEXT,
  is_reversed         BOOLEAN NOT NULL DEFAULT false,
  reversed_by         TEXT,
  reversal_tx_digest  TEXT,
  override_reason     TEXT,
  timestamp_ms        BIGINT NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- walrus_blobs: evidence lifecycle tracking
CREATE TABLE IF NOT EXISTS walrus_blobs (
  blob_id         TEXT PRIMARY KEY,
  action_id       UUID REFERENCES actions(id),
  market_id       UUID REFERENCES markets(id),
  status          TEXT NOT NULL CHECK (status IN
                    ('pending_upload','uploaded','linked_on_chain',
                     'failed_upload','retrying','private_encrypted')),
  evidence_hash   TEXT,
  attempt_count   INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count <= 5),
  last_attempt_at TIMESTAMPTZ,
  payload         JSONB,                     -- retained for reprocessing if not yet linked
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- environment_checks: network enforcement audit trail
CREATE TABLE IF NOT EXISTS environment_checks (
  id              UUID PRIMARY KEY,
  check_type      TEXT NOT NULL CHECK (check_type IN
                    ('rpc_chain_id','submission_target','digest_origin','wallet_network')),
  outcome         TEXT NOT NULL CHECK (outcome IN ('pass','fail')),
  detail          TEXT,
  checked_at      TIMESTAMPTZ NOT NULL DEFAULT now()   -- ISO 8601 UTC
);

-- -----------------------------------------------------------------------------
-- Supporting indexes for common access patterns (foreign keys + time-series).
-- -----------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_policies_market_id          ON policies (market_id);
CREATE INDEX IF NOT EXISTS idx_risk_snapshots_market_time  ON risk_snapshots (market_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_incidents_market_id         ON incidents (market_id);
CREATE INDEX IF NOT EXISTS idx_actions_policy_id           ON actions (policy_id);
CREATE INDEX IF NOT EXISTS idx_actions_market_id           ON actions (market_id);
CREATE INDEX IF NOT EXISTS idx_actions_incident_id         ON actions (incident_id);
CREATE INDEX IF NOT EXISTS idx_walrus_blobs_action_id      ON walrus_blobs (action_id);
CREATE INDEX IF NOT EXISTS idx_walrus_blobs_status         ON walrus_blobs (status);
CREATE INDEX IF NOT EXISTS idx_environment_checks_type_time ON environment_checks (check_type, checked_at DESC);
