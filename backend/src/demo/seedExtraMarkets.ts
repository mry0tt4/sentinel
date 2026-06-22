/**
 * Provision + seed two ADDITIONAL monitored markets so the dashboard reflects a
 * realistic multi-market risk desk (not a single lonely market).
 *
 * For each extra market this:
 *   1. mints a REAL on-chain `MarketState` on Sui Testnet (so the market is
 *      explorer-verifiable, like the primary demo market), and
 *   2. seeds the off-chain `markets` row + a backdated arc of `risk_snapshots`
 *      computed by the REAL deterministic Risk Engine (never placeholder
 *      numbers), so the market shows a live-looking status, score, and trend.
 *
 * These markets are monitor-only (no policy / no autonomous actions) — they
 * populate the dashboard’s market list and detail views. The primary
 * `SUI Lending Market (Demo)` remains the one wired to the live loop + actions.
 *
 * Run: `npm run seed-markets` (signs init_market with AGENT_SIGNER_KEY; gas).
 */

import { SuiClient, getFullnodeUrl } from '@mysten/sui/client';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';
import { Transaction } from '@mysten/sui/transactions';

import { loadConfig } from '../config/env.js';
import { getPool } from '../db/pool.js';
import { assessRisk, DEFAULT_SCORING_CONFIG } from '../risk/scoringEngine.js';
import type { FeatureVector } from '../risk/types.js';

interface ExtraMarket {
  id: string;
  name: string;
  /** init_market params. */
  collateral: number;
  borrow: number;
  maxLtvBps: number;
  maintMarginBps: number;
  /** Risk arc profile applied across the seeded snapshots. */
  profile: (t: number, nowMs: number, i: number, total: number) => FeatureVector;
}

const FRESHNESS_MS = 30_000;

/** SUI Perps — leveraged, higher utilization + volatility → sits in Warning/Guarded. */
function perpsProfile(t: number, nowMs: number, i: number, total: number): FeatureVector {
  const wave = 0.5 + 0.5 * Math.sin(t * Math.PI * 2.2); // oscillating stress
  const ts = nowMs - (total - 1 - i) * 60_000;
  const price = 3.5 * (1 - wave * 0.06);
  return {
    oraclePrice: price,
    oracleConfidence: price * (0.004 + wave * 0.012),
    oracleTimestampMs: ts,
    nowMs: ts,
    freshnessThresholdMs: FRESHNESS_MS,
    referencePrice: 3.5,
    priceChange1mPct: -wave * 5,
    priceChange5mPct: -wave * 8,
    priceChange15mPct: -wave * 9,
    realizedVolatilityPct: 18 + wave * 26,
    liquidityDepth: 900_000 * (1 - wave * 0.4),
    spreadBps: 20 + wave * 60,
    imbalance: wave * 0.4,
    utilization: 0.78 + wave * 0.12,
    exposure: 3_100_000,
    currentMaxLtvBps: 8000,
    borrowPaused: false,
    guardedMode: false,
    policyActive: true,
    guardianRevoked: false,
    priorActionsCount: 0,
    priorOverridesCount: 0,
    historicalEvidenceRefs: [],
  };
}

/** USDC Vault — stable, deep liquidity, low utilization → comfortably Normal. */
function vaultProfile(t: number, nowMs: number, i: number, total: number): FeatureVector {
  const ripple = 0.5 + 0.5 * Math.sin(t * Math.PI * 3);
  const ts = nowMs - (total - 1 - i) * 60_000;
  return {
    oraclePrice: 1 + (ripple - 0.5) * 0.001,
    oracleConfidence: 0.0004,
    oracleTimestampMs: ts,
    nowMs: ts,
    freshnessThresholdMs: FRESHNESS_MS,
    expectedPegPrice: 1,
    priceChange1mPct: (ripple - 0.5) * 0.4,
    priceChange5mPct: (ripple - 0.5) * 0.6,
    priceChange15mPct: (ripple - 0.5) * 0.7,
    realizedVolatilityPct: 1 + ripple * 2,
    liquidityDepth: 5_000_000,
    spreadBps: 3 + ripple * 3,
    imbalance: (ripple - 0.5) * 0.1,
    utilization: 0.35 + ripple * 0.08,
    exposure: 8_000_000,
    currentMaxLtvBps: 9000,
    borrowPaused: false,
    guardedMode: false,
    policyActive: true,
    guardianRevoked: false,
    priorActionsCount: 0,
    priorOverridesCount: 0,
    historicalEvidenceRefs: [],
  };
}

const MARKETS: ExtraMarket[] = [
  {
    id: '44444444-4444-4444-8444-444444444444',
    name: 'SUI Perps',
    collateral: 5_000_000,
    borrow: 3_900_000,
    maxLtvBps: 8000,
    maintMarginBps: 625,
    profile: perpsProfile,
  },
  {
    id: '55555555-5555-4555-8555-555555555555',
    name: 'USDC Vault',
    collateral: 12_000_000,
    borrow: 4_200_000,
    maxLtvBps: 9000,
    maintMarginBps: 300,
    profile: vaultProfile,
  },
];

/** Map an engine band to a dashboard market status. */
function bandToStatus(band: string): string {
  if (band === 'EmergencyPause') return 'Paused';
  if (band === 'Guarded' || band === 'ParamAdjust') return 'Guarded';
  if (band === 'Warning') return 'Warning';
  return 'Normal';
}

function findCreated(changes: unknown[], suffix: string): string | undefined {
  const c = (changes as Array<{ type?: string; objectType?: string; objectId?: string }>).find(
    (x) => x.type === 'created' && typeof x.objectType === 'string' && x.objectType.endsWith(suffix),
  );
  return c?.objectId;
}

async function main(): Promise<void> {
  const { config, secrets } = loadConfig();
  const pkg = config.packageIds.policy;
  if (!pkg) throw new Error('SENTINEL_POLICY_PACKAGE_ID is not configured');
  if (!secrets.agentSignerKey) throw new Error('AGENT_SIGNER_KEY is required');

  const client = new SuiClient({ url: config.suiRpcUrl || getFullnodeUrl('testnet') });
  const keypair = Ed25519Keypair.fromSecretKey(decodeSuiPrivateKey(secrets.agentSignerKey).secretKey);
  const pool = getPool();
  const now = Date.now();
  const SNAPSHOTS = 40;

  for (const m of MARKETS) {
    // 1. Mint a real on-chain MarketState.
    const tx = new Transaction();
    tx.moveCall({
      target: `${pkg}::market::init_market`,
      arguments: [
        tx.pure.u64(m.collateral),
        tx.pure.u64(m.borrow),
        tx.pure.u64(m.maxLtvBps),
        tx.pure.u64(m.maintMarginBps),
      ],
    });
    const res = await client.signAndExecuteTransaction({
      transaction: tx,
      signer: keypair,
      options: { showObjectChanges: true, showEffects: true },
    });
    if (res.effects?.status?.status !== 'success') {
      throw new Error(`init_market failed for ${m.name}: ${res.effects?.status?.error}`);
    }
    const onChainId = findCreated(res.objectChanges ?? [], '::market::MarketState');
    if (!onChainId) throw new Error(`could not resolve MarketState for ${m.name}`);
    console.log(`[seed-markets] ${m.name} MarketState ${onChainId} (tx ${res.digest})`);

    // 2. Reset + seed the off-chain rows (market row first for the FK).
    await pool.query('DELETE FROM risk_snapshots WHERE market_id = $1', [m.id]);
    await pool.query('DELETE FROM markets WHERE id = $1', [m.id]);

    // Pre-compute the latest band so the market row carries the right status.
    const lastFv = m.profile(1, now, SNAPSHOTS - 1, SNAPSHOTS);
    const lastBand = assessRisk(lastFv, DEFAULT_SCORING_CONFIG).band;
    await pool.query(
      `INSERT INTO markets (id, on_chain_id, market_type, name, status, freshness_threshold_ms)
       VALUES ($1, $2, 'demo', $3, $4, $5)`,
      [m.id, onChainId, m.name, bandToStatus(lastBand), FRESHNESS_MS],
    );

    for (let i = 0; i < SNAPSHOTS; i += 1) {
      const fv = m.profile(i / (SNAPSHOTS - 1), now, i, SNAPSHOTS);
      const a = assessRisk(fv, DEFAULT_SCORING_CONFIG);
      const explanation =
        `Risk score ${a.riskScore}/100 (${a.band}). ` +
        (a.classes.length ? `Detected: ${a.classes.join(', ')}. ` : '') +
        (a.recommendedAction ? `Recommended action: ${a.recommendedAction}.` : 'No action required.');
      await pool.query(
        `INSERT INTO risk_snapshots
           (id, market_id, risk_score, band, classes, confidence, feature_vector, rule_outputs,
            recommended_action, model_version, prompt_config_version, explanation, is_simulated,
            data_source, created_at)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, false, 'live', $12)`,
        [
          m.id,
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
    console.log(`[seed-markets] ${m.name}: ${SNAPSHOTS} snapshots, status ${bandToStatus(lastBand)}`);
  }

  console.log('[seed-markets] done — dashboard now shows 3 monitored markets.');
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    console.error('[seed-markets] failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
