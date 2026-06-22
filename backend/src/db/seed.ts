/**
 * Demo seed script.
 *
 * Populates the database with one Demo_Market, its Risk_Policy, a realistic
 * history of risk snapshots (computed by the REAL deterministic Risk Engine —
 * not placeholder numbers), and one incident with two actions. This is what
 * makes the dashboard, market detail, and incident replay show real content
 * immediately, before/independent of any live loop.
 *
 * Idempotent: re-running deletes the demo rows and re-inserts them.
 *
 * Run with: `npm run seed` (loads ../.env via tsx --env-file-if-exists).
 */

import { getPool } from './pool.js';
import { assessRisk, DEFAULT_SCORING_CONFIG } from '../risk/scoringEngine.js';
import type { FeatureVector } from '../risk/types.js';
import {
  DEMO_DAO_ADDRESS,
  DEMO_FRESHNESS_THRESHOLD_MS,
  DEMO_MARKET_BASELINE,
  DEMO_MARKET_ID,
  DEMO_MARKET_NAME,
  DEMO_ON_CHAIN_MARKET_ID,
  DEMO_OWNER_ADDRESS,
  DEMO_POLICY_ID,
} from '../demo/demoMarket.js';

const INCIDENT_ID = '33333333-3333-4333-8333-333333333333';

/** Build a plausible feature vector for snapshot index `i` of `total`. */
function featureAt(i: number, total: number, nowMs: number): FeatureVector {
  // A calm → volatility-spike → recovery arc so the trend has shape and the
  // climax crosses an action threshold.
  const t = i / (total - 1);
  const spike = Math.exp(-Math.pow((t - 0.72) / 0.08, 2)); // bell peak near 72%
  const vol = 4 + spike * 46; // 4% calm → ~50% at peak
  const drop1m = -spike * 14; // up to -14% 1m move at peak
  const drop5m = -spike * 22;
  const price = 3.5 * (1 - spike * 0.18); // SUI ~ $3.50, dips on the spike
  const ts = nowMs - (total - 1 - i) * 60_000; // one point per minute

  return {
    oraclePrice: price,
    oracleConfidence: price * (0.002 + spike * 0.03),
    oracleTimestampMs: ts,
    nowMs: ts,
    freshnessThresholdMs: DEMO_FRESHNESS_THRESHOLD_MS,
    referencePrice: 3.5,
    priceChange1mPct: drop1m,
    priceChange5mPct: drop5m,
    priceChange15mPct: drop5m * 1.1,
    realizedVolatilityPct: vol,
    liquidityDepth: DEMO_MARKET_BASELINE.liquidityDepth * (1 - spike * 0.55),
    spreadBps: DEMO_MARKET_BASELINE.spreadBps + spike * 90,
    imbalance: spike * 0.5,
    utilization: DEMO_MARKET_BASELINE.utilization + spike * 0.25,
    exposure: DEMO_MARKET_BASELINE.exposure,
    currentMaxLtvBps: DEMO_MARKET_BASELINE.currentMaxLtvBps,
    borrowPaused: false,
    guardedMode: false,
    policyActive: true,
    guardianRevoked: false,
    priorActionsCount: 0,
    priorOverridesCount: 0,
    historicalEvidenceRefs: [],
  };
}

async function seed(): Promise<void> {
  const pool = getPool();
  const now = Date.now();
  const SNAPSHOTS = 45;

  // --- Clean any prior demo rows (FK-safe order) --------------------------
  await pool.query('DELETE FROM actions WHERE market_id = $1', [DEMO_MARKET_ID]);
  await pool.query('DELETE FROM incidents WHERE market_id = $1', [DEMO_MARKET_ID]);
  await pool.query('DELETE FROM risk_snapshots WHERE market_id = $1', [DEMO_MARKET_ID]);
  await pool.query('DELETE FROM walrus_blobs WHERE market_id = $1', [DEMO_MARKET_ID]);
  await pool.query('DELETE FROM policies WHERE id = $1', [DEMO_POLICY_ID]);
  await pool.query('DELETE FROM markets WHERE id = $1', [DEMO_MARKET_ID]);

  // --- Market -------------------------------------------------------------
  // Use the REAL provisioned on-chain MarketState object id when available so
  // the Override Console can target the live object; fall back to the symbolic
  // id for a non-provisioned environment.
  const onChainMarketId = process.env.DEMO_MARKET_STATE_ID ?? DEMO_ON_CHAIN_MARKET_ID;
  await pool.query(
    `INSERT INTO markets (id, on_chain_id, market_type, name, status, freshness_threshold_ms)
     VALUES ($1, $2, 'demo', $3, 'Normal', $4)`,
    [DEMO_MARKET_ID, onChainMarketId, DEMO_MARKET_NAME, DEMO_FRESHNESS_THRESHOLD_MS],
  );

  // --- Policy -------------------------------------------------------------
  // Prefer the REAL provisioned RiskPolicy / GuardianCap / OverrideCap object
  // ids so the Override Console submits against the live objects.
  const onChainPolicyId = process.env.DEMO_POLICY_OBJECT_ID ?? 'demo-policy::sui-lending';
  const guardianCapId = process.env.DEMO_GUARDIAN_CAP_ID ?? 'demo-guardian-cap';
  const overrideCapId = process.env.DEMO_OVERRIDE_CAP_ID ?? 'demo-override-cap';
  await pool.query(
    `INSERT INTO policies
       (id, market_id, on_chain_policy_id, guardian_cap_id, override_cap_id, owner_address,
        dao_address, allowed_actions, max_ltv_delta_bps, max_margin_delta_bps,
        pause_duration_limit_ms, cooldown_ms, risk_thresholds, version)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 1)`,
    [
      DEMO_POLICY_ID,
      DEMO_MARKET_ID,
      onChainPolicyId,
      guardianCapId,
      overrideCapId,
      DEMO_OWNER_ADDRESS,
      DEMO_DAO_ADDRESS,
      ['pause_new_borrows', 'reduce_max_ltv', 'enter_guarded_mode', 'increase_maintenance_margin'],
      2000,
      2000,
      String(7 * 24 * 60 * 60 * 1000),
      String(60_000),
      JSON.stringify({ warning: 40, guarded: 60, paramAdjust: 75, emergency: 90 }),
    ],
  );

  // --- Risk snapshots (real engine output, backdated) ---------------------
  let climaxIndex = -1;
  for (let i = 0; i < SNAPSHOTS; i += 1) {
    const fv = featureAt(i, SNAPSHOTS, now);
    const a = assessRisk(fv, DEFAULT_SCORING_CONFIG);
    if (climaxIndex === -1 && a.recommendedAction !== null) climaxIndex = i;
    const explanation =
      `Risk score ${a.riskScore}/100 (${a.band}). ` +
      (a.classes.length ? `Detected: ${a.classes.join(', ')}. ` : '') +
      `${a.recommendedAction ? `Recommended action: ${a.recommendedAction}.` : 'No action required.'}`;
    await pool.query(
      `INSERT INTO risk_snapshots
         (id, market_id, risk_score, band, classes, confidence, feature_vector, rule_outputs,
          recommended_action, model_version, prompt_config_version, explanation, is_simulated,
          data_source, created_at)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, false, 'live', $12)`,
      [
        DEMO_MARKET_ID,
        a.riskScore,
        a.band,
        a.classes,
        a.confidence,
        JSON.stringify(fv),
        JSON.stringify(a.ruleOutputs),
        a.recommendedAction,
        DEFAULT_SCORING_CONFIG.modelVersion,
        DEFAULT_SCORING_CONFIG.promptConfigVersion,
        explanation,
        new Date(fv.nowMs).toISOString(),
      ],
    );
  }

  // --- Incident + actions around the climax -------------------------------
  const climaxMs = now - (SNAPSHOTS - 1 - (climaxIndex < 0 ? 32 : climaxIndex)) * 60_000;
  await pool.query(
    `INSERT INTO incidents (id, market_id, started_at, ended_at, scenario_id, is_simulated, summary)
     VALUES ($1, $2, $3, $4, NULL, false, $5)`,
    [
      INCIDENT_ID,
      DEMO_MARKET_ID,
      new Date(climaxMs - 120_000).toISOString(),
      new Date(climaxMs + 300_000).toISOString(),
      'SUI volatility spike — autonomous pause-new-borrows executed, then DAO-reversed on recovery.',
    ],
  );

  await pool.query(
    `INSERT INTO actions
       (id, policy_id, market_id, incident_id, actor, actor_type, risk_score, action_type,
        old_value, new_value, walrus_evidence_blob_id, evidence_hash, tx_digest, timestamp_ms)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, 'agent', 92, 'pause_new_borrows',
             'borrows=open', 'borrows=paused', $5, $6, $7, $8)`,
    [
      DEMO_POLICY_ID,
      DEMO_MARKET_ID,
      INCIDENT_ID,
      DEMO_OWNER_ADDRESS,
      'demo-blob-pause-001',
      '0x' + 'ab'.repeat(16),
      'DEMOpause' + 'x'.repeat(35),
      String(climaxMs),
    ],
  );
  await pool.query(
    `INSERT INTO actions
       (id, policy_id, market_id, incident_id, actor, actor_type, risk_score, action_type,
        old_value, new_value, tx_digest, override_reason, timestamp_ms)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, 'dao', 38, 'unpause_market',
             'borrows=paused', 'borrows=open', $5, $6, $7)`,
    [
      DEMO_POLICY_ID,
      DEMO_MARKET_ID,
      INCIDENT_ID,
      DEMO_DAO_ADDRESS,
      'DEMOunpause' + 'y'.repeat(33),
      'Volatility recovered below threshold; DAO restored borrowing.',
      String(climaxMs + 300_000),
    ],
  );

  // eslint-disable-next-line no-console
  console.log(
    `[seed] Demo market seeded: ${SNAPSHOTS} risk snapshots, 1 incident, 2 actions ` +
      `(climax at snapshot ${climaxIndex < 0 ? 'n/a' : climaxIndex}).`,
  );
}

seed()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    // eslint-disable-next-line no-console
    console.error('[seed] failed:', err);
    process.exit(1);
  });
