/**
 * Reset the demo `RiskPolicy` cooldown to 0 on Sui Testnet.
 *
 * The provisioned demo policy was created with a 60s `cooldown_ms`, which makes
 * back-to-back Simulation Lab runs abort on-chain with `ECooldownNotElapsed`
 * (abort code 8 in `policy::execute_guardian_action`). For the demo we want the
 * agent to be able to fire actions repeatedly, so this calls the
 * OverrideCap-gated `update_thresholds` to set `cooldown_ms = 0` while
 * preserving every other bound (read from the live object first).
 *
 * Run: `npm run reset-cooldown` (signs with AGENT_SIGNER_KEY, which doubles as
 * the demo DAO address; spends testnet gas).
 */

import { SuiClient, getFullnodeUrl } from '@mysten/sui/client';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';
import { Transaction } from '@mysten/sui/transactions';
import { SUI_CLOCK_OBJECT_ID } from '@mysten/sui/utils';

import { loadConfig } from '../config/env.js';

async function main(): Promise<void> {
  const { config, secrets } = loadConfig();
  const pkg = config.packageIds.policy;
  const policyId = process.env.DEMO_POLICY_OBJECT_ID;
  const overrideCapId = process.env.DEMO_OVERRIDE_CAP_ID;

  if (!pkg || pkg.trim() === '') throw new Error('SENTINEL_POLICY_PACKAGE_ID is not configured');
  if (!policyId) throw new Error('DEMO_POLICY_OBJECT_ID is not configured');
  if (!overrideCapId) throw new Error('DEMO_OVERRIDE_CAP_ID is not configured');
  if (!secrets.agentSignerKey || secrets.agentSignerKey.trim() === '') {
    throw new Error('AGENT_SIGNER_KEY is required to sign the update');
  }

  const client = new SuiClient({ url: config.suiRpcUrl || getFullnodeUrl('testnet') });
  const keypair = Ed25519Keypair.fromSecretKey(
    decodeSuiPrivateKey(secrets.agentSignerKey).secretKey,
  );

  // Read the current bounds so only the cooldown changes.
  const obj = await client.getObject({ id: policyId, options: { showContent: true } });
  const content = obj.data?.content;
  if (!content || content.dataType !== 'moveObject') {
    throw new Error('could not read RiskPolicy object content');
  }
  const f = (content as unknown as { fields: Record<string, unknown> }).fields;
  const maxLtvDelta = Number(f.max_ltv_delta_bps);
  const maxMarginDelta = Number(f.max_margin_delta_bps);
  const pauseLimitMs = Number(f.pause_duration_limit_ms);
  const thresholds = (f.risk_thresholds as string[]).map((x) => Number(x));
  const currentCooldown = Number(f.cooldown_ms);
  console.log(
    `[reset-cooldown] current cooldown=${currentCooldown}ms → setting to 0 (bounds preserved)`,
  );

  const tx = new Transaction();
  tx.moveCall({
    target: `${pkg}::policy::update_thresholds`,
    arguments: [
      tx.object(policyId),
      tx.object(overrideCapId),
      tx.pure.u64(maxLtvDelta),
      tx.pure.u64(maxMarginDelta),
      tx.pure.u64(pauseLimitMs),
      tx.pure.u64(0), // new_cooldown_ms — fire repeatedly for the demo
      tx.pure.vector('u64', thresholds),
      tx.object(SUI_CLOCK_OBJECT_ID),
    ],
  });

  const res = await client.signAndExecuteTransaction({
    transaction: tx,
    signer: keypair,
    options: { showEffects: true },
  });
  if (res.effects?.status?.status !== 'success') {
    throw new Error(`update_thresholds failed: ${res.effects?.status?.error}`);
  }
  console.log(`[reset-cooldown] cooldown set to 0 (tx ${res.digest})`);
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    console.error('[reset-cooldown] failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
