#!/usr/bin/env node
/**
 * record_deployment.mjs — parse the JSON output of `sui client publish --json`
 * and record the resulting package IDs into the canonical deployment artifact
 * and the backend/frontend env configuration. (Task 3.12 — Req 1.1, 8.5)
 *
 * This is invoked by scripts/deploy_testnet.sh after a successful publish, but
 * is intentionally standalone and idempotent so it can be re-run against a
 * saved publish-output JSON file to (re)write config without re-deploying.
 *
 * Usage:
 *   node scripts/record_deployment.mjs <publish-output.json> [--network testnet]
 *
 * The three Sentinel Move packages are published in a single transaction via
 * `--with-unpublished-dependencies`, so the publish output contains three
 * `published` objectChanges. Each is mapped to a package by the module name it
 * exposes:
 *   - sentinel_adapters     -> module "sentinel_adapters"
 *   - sentinel_demo_market  -> module "sentinel_demo_market"
 *   - sentinel_policy       -> module "sentinel_policy"
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

/**
 * Module name -> logical package key used throughout the config surfaces.
 *
 * On-chain a published package exposes its modules by their *bare* module name
 * (the part after `::`), so the three Sentinel modules surface as `policy`,
 * `market`, and `adapters` — not the package directory names. When published
 * with `--with-unpublished-dependencies`, the modern Sui toolchain may combine
 * all three into a SINGLE published package; in that case the one `published`
 * objectChange lists all three modules and every logical key resolves to the
 * same package id (which is correct — all modules live at that address).
 */
const PACKAGE_BY_MODULE = {
  policy: 'policy',
  market: 'demoMarket',
  adapters: 'adapters',
};

/** Logical key -> backend env var name (read by backend/src/config/env.ts). */
const BACKEND_ENV_KEYS = {
  policy: 'SENTINEL_POLICY_PACKAGE_ID',
  demoMarket: 'SENTINEL_DEMO_MARKET_PACKAGE_ID',
  adapters: 'SENTINEL_ADAPTERS_PACKAGE_ID',
};

/** Logical key -> frontend (Astro PUBLIC_*) env var name. */
const FRONTEND_ENV_KEYS = {
  policy: 'PUBLIC_SENTINEL_POLICY_PACKAGE_ID',
  demoMarket: 'PUBLIC_SENTINEL_DEMO_MARKET_PACKAGE_ID',
  adapters: 'PUBLIC_SENTINEL_ADAPTERS_PACKAGE_ID',
};

function fail(message) {
  console.error(`[record_deployment] ERROR: ${message}`);
  process.exit(1);
}

/**
 * Set (or replace) a `KEY=value` line in a dotenv-style file, preserving all
 * other lines and comments. Creates the file from .env.example when missing so
 * re-running the deploy never clobbers unrelated config.
 */
function setEnvVar(filePath, key, value) {
  let lines = [];
  if (existsSync(filePath)) {
    lines = readFileSync(filePath, 'utf8').split('\n');
  }
  const assignment = `${key}=${value}`;
  const idx = lines.findIndex((line) => line.replace(/^\s*/, '').startsWith(`${key}=`));
  if (idx >= 0) {
    lines[idx] = assignment;
  } else {
    if (lines.length > 0 && lines[lines.length - 1] === '') {
      lines.splice(lines.length - 1, 0, assignment);
    } else {
      lines.push(assignment);
    }
  }
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, lines.join('\n'));
}

function main() {
  const args = process.argv.slice(2);
  const jsonPathArg = args.find((a) => !a.startsWith('--'));
  const networkIdx = args.indexOf('--network');
  const network = networkIdx >= 0 ? args[networkIdx + 1] : 'testnet';

  if (!jsonPathArg) {
    fail('missing path to publish-output JSON file');
  }
  const jsonPath = resolve(jsonPathArg);
  if (!existsSync(jsonPath)) {
    fail(`publish-output JSON not found: ${jsonPath}`);
  }

  let publish;
  try {
    publish = JSON.parse(readFileSync(jsonPath, 'utf8'));
  } catch (err) {
    fail(`could not parse publish-output JSON: ${err.message}`);
  }

  // The `effects.status` must be success; bail loudly otherwise.
  const status = publish?.effects?.status?.status;
  if (status && status !== 'success') {
    fail(`publish transaction did not succeed (status="${status}")`);
  }

  const objectChanges = publish?.objectChanges ?? [];
  if (!Array.isArray(objectChanges) || objectChanges.length === 0) {
    fail('publish output contained no objectChanges to parse');
  }

  const digest = publish?.digest ?? null;
  const packageIds = { policy: '', demoMarket: '', adapters: '' };

  // Map each published package to a logical key via its module list.
  for (const change of objectChanges) {
    if (change.type !== 'published') continue;
    const modules = change.modules ?? [];
    for (const moduleName of modules) {
      const key = PACKAGE_BY_MODULE[moduleName];
      if (key) {
        packageIds[key] = change.packageId;
      }
    }
  }

  const missing = Object.entries(packageIds)
    .filter(([, id]) => !id)
    .map(([k]) => k);
  if (missing.length > 0) {
    fail(
      `could not resolve package id(s) for: ${missing.join(', ')}. ` +
        'Ensure the publish used --with-unpublished-dependencies so all three packages are published.',
    );
  }

  // Capture created shared objects and the UpgradeCap(s) for completeness.
  const created = objectChanges
    .filter((c) => c.type === 'created')
    .map((c) => ({
      objectId: c.objectId,
      objectType: c.objectType,
      owner: c.owner,
    }));
  const upgradeCaps = created.filter((c) =>
    typeof c.objectType === 'string' && c.objectType.includes('::package::UpgradeCap'),
  );

  // ---- Write the canonical deployment artifact -----------------------------
  const artifact = {
    network,
    deployedAt: new Date().toISOString(),
    txDigest: digest,
    packageIds,
    upgradeCaps: upgradeCaps.map((c) => ({ objectId: c.objectId, owner: c.owner })),
    createdObjects: created,
  };
  const artifactPath = join(REPO_ROOT, 'deployments', `${network}.json`);
  mkdirSync(dirname(artifactPath), { recursive: true });
  writeFileSync(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`);

  // ---- Update backend env (root .env) --------------------------------------
  const rootEnv = join(REPO_ROOT, '.env');
  const rootEnvExample = join(REPO_ROOT, '.env.example');
  if (!existsSync(rootEnv) && existsSync(rootEnvExample)) {
    writeFileSync(rootEnv, readFileSync(rootEnvExample, 'utf8'));
  }
  for (const [key, envKey] of Object.entries(BACKEND_ENV_KEYS)) {
    setEnvVar(rootEnv, envKey, packageIds[key]);
  }

  // ---- Update frontend env (frontend/.env, PUBLIC_* vars) ------------------
  const frontendEnv = join(REPO_ROOT, 'frontend', '.env');
  for (const [key, envKey] of Object.entries(FRONTEND_ENV_KEYS)) {
    setEnvVar(frontendEnv, envKey, packageIds[key]);
  }

  // ---- Report --------------------------------------------------------------
  console.log('[record_deployment] Recorded package IDs:');
  console.log(`  sentinel_policy       = ${packageIds.policy}`);
  console.log(`  sentinel_demo_market  = ${packageIds.demoMarket}`);
  console.log(`  sentinel_adapters     = ${packageIds.adapters}`);
  console.log(`[record_deployment] tx digest: ${digest}`);
  console.log(`[record_deployment] wrote: ${artifactPath}`);
  console.log(`[record_deployment] updated: ${rootEnv} (backend SENTINEL_*_PACKAGE_ID)`);
  console.log(`[record_deployment] updated: ${frontendEnv} (frontend PUBLIC_SENTINEL_*_PACKAGE_ID)`);
}

main();
