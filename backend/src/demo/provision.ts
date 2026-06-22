/**
 * Provision the Sentinel demo on Sui Testnet.
 *
 * Creates the REAL on-chain objects the live loop needs:
 *   1. `sentinel_demo_market::market::init_market` → a shared `MarketState`
 *      (real collateral/borrow/LTV — the source of real exposure & utilization).
 *   2. `sentinel_policy::policy::create_policy` → a shared `RiskPolicy`, a
 *      `GuardianCap` (transferred to the agent), and an `OverrideCap` (to DAO).
 *
 * Records the resulting object ids into `deployments/demo-objects.json` and
 * upserts them into the root `.env` (DEMO_MARKET_STATE_ID, DEMO_POLICY_OBJECT_ID,
 * DEMO_GUARDIAN_CAP_ID, DEMO_OVERRIDE_CAP_ID) so the backend wires real
 * autonomous actions + reads real on-chain market state.
 *
 * Run: `npm run provision` (signs with AGENT_SIGNER_KEY; spends testnet gas).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SuiClient, getFullnodeUrl } from '@mysten/sui/client';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';
import { Transaction } from '@mysten/sui/transactions';
import { SUI_CLOCK_OBJECT_ID } from '@mysten/sui/utils';

import { loadConfig } from '../config/env.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..', '..');

interface ObjectChange {
  type?: string;
  objectType?: string;
  objectId?: string;
}

function findCreated(changes: ObjectChange[], suffix: string): string | undefined {
  const c = changes.find(
    (x) =>
      x.type === 'created' && typeof x.objectType === 'string' && x.objectType.endsWith(suffix),
  );
  return c?.objectId;
}

function setEnvVar(file: string, key: string, value: string): void {
  const lines: string[] = existsSync(file) ? readFileSync(file, 'utf8').split('\n') : [];
  const idx = lines.findIndex((l) => l.replace(/^\s*/, '').startsWith(`${key}=`));
  if (idx >= 0) lines[idx] = `${key}=${value}`;
  else lines.push(`${key}=${value}`);
  writeFileSync(file, lines.join('\n'));
}

async function main(): Promise<void> {
  const { config, secrets } = loadConfig();
  const pkg = config.packageIds.policy;
  if (!pkg || pkg.trim() === '') {
    throw new Error('SENTINEL_POLICY_PACKAGE_ID is not configured');
  }
  if (!secrets.agentSignerKey || secrets.agentSignerKey.trim() === '') {
    throw new Error('AGENT_SIGNER_KEY is required to sign provisioning transactions');
  }

  const client = new SuiClient({ url: config.suiRpcUrl || getFullnodeUrl('testnet') });
  const keypair = Ed25519Keypair.fromSecretKey(
    decodeSuiPrivateKey(secrets.agentSignerKey).secretKey,
  );
  const agent = keypair.toSuiAddress();
  console.log(`[provision] agent address: ${agent}`);

  // --- 1. init_market: real collateral/borrow → real utilization/exposure ---
  const COLLATERAL = 10_000_000;
  const BORROW = 6_200_000; // utilization 62%
  const MAX_LTV_BPS = 7_500;
  const MAINT_MARGIN_BPS = 500;

  const initTx = new Transaction();
  initTx.moveCall({
    target: `${pkg}::market::init_market`,
    arguments: [
      initTx.pure.u64(COLLATERAL),
      initTx.pure.u64(BORROW),
      initTx.pure.u64(MAX_LTV_BPS),
      initTx.pure.u64(MAINT_MARGIN_BPS),
    ],
  });
  const initRes = await client.signAndExecuteTransaction({
    transaction: initTx,
    signer: keypair,
    options: { showObjectChanges: true, showEffects: true },
  });
  if (initRes.effects?.status?.status !== 'success') {
    throw new Error(`init_market failed: ${initRes.effects?.status?.error}`);
  }
  const marketStateId = findCreated(initRes.objectChanges ?? [], '::market::MarketState');
  if (!marketStateId) throw new Error('could not find created MarketState object');
  console.log(`[provision] MarketState: ${marketStateId} (tx ${initRes.digest})`);

  // --- 2. create_policy: RiskPolicy + GuardianCap(agent) + OverrideCap(dao) ---
  const oneYearMs = Date.now() + 365 * 24 * 60 * 60 * 1000;
  const polTx = new Transaction();
  polTx.moveCall({
    target: `${pkg}::policy::create_policy`,
    arguments: [
      polTx.pure.address(marketStateId), // market_id: ID
      polTx.pure.u8(3), // market_type: demo
      polTx.pure.address(agent), // agent_address
      polTx.pure.address(agent), // dao_address (agent doubles as DAO for the demo)
      polTx.pure.vector('u8', [0, 2, 4, 6]), // allowed_actions: pause, reduce_ltv, enter_guarded, increase_margin
      polTx.pure.vector('address', [marketStateId]), // allowed_markets: vector<ID>
      polTx.pure.u64(2_000), // max_ltv_delta_bps
      polTx.pure.u64(2_000), // max_margin_delta_bps
      polTx.pure.u64(7 * 24 * 60 * 60 * 1000), // pause_duration_limit_ms
      polTx.pure.vector('u64', [40, 60, 75, 90]), // risk_thresholds
      polTx.pure.u64(0), // cooldown_ms (0 so the demo can fire repeatedly)
      polTx.pure.u64(oneYearMs), // guardian_expires_at_ms
      polTx.pure.vector('u8', []), // walrus_config_blob_id
      polTx.object(SUI_CLOCK_OBJECT_ID),
    ],
  });
  const polRes = await client.signAndExecuteTransaction({
    transaction: polTx,
    signer: keypair,
    options: { showObjectChanges: true, showEffects: true },
  });
  if (polRes.effects?.status?.status !== 'success') {
    throw new Error(`create_policy failed: ${polRes.effects?.status?.error}`);
  }
  const changes = polRes.objectChanges ?? [];
  const policyId = findCreated(changes, '::policy::RiskPolicy');
  const guardianCapId = findCreated(changes, '::policy::GuardianCap');
  const overrideCapId = findCreated(changes, '::policy::OverrideCap');
  if (!policyId || !guardianCapId || !overrideCapId) {
    throw new Error(
      `could not resolve policy objects: policy=${policyId} guardian=${guardianCapId} override=${overrideCapId}`,
    );
  }
  console.log(`[provision] RiskPolicy: ${policyId}`);
  console.log(`[provision] GuardianCap: ${guardianCapId}`);
  console.log(`[provision] OverrideCap: ${overrideCapId} (tx ${polRes.digest})`);

  // --- Record ---
  const artifact = {
    network: 'testnet',
    provisionedAt: new Date().toISOString(),
    agent,
    marketStateId,
    policyId,
    guardianCapId,
    overrideCapId,
    initMarketTx: initRes.digest,
    createPolicyTx: polRes.digest,
  };
  const outPath = join(REPO_ROOT, 'deployments', 'demo-objects.json');
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(artifact, null, 2)}\n`);

  const envFile = join(REPO_ROOT, '.env');
  setEnvVar(envFile, 'DEMO_MARKET_STATE_ID', marketStateId);
  setEnvVar(envFile, 'DEMO_POLICY_OBJECT_ID', policyId);
  setEnvVar(envFile, 'DEMO_GUARDIAN_CAP_ID', guardianCapId);
  setEnvVar(envFile, 'DEMO_OVERRIDE_CAP_ID', overrideCapId);

  console.log(`[provision] wrote ${outPath} and updated .env`);
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    console.error('[provision] failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
