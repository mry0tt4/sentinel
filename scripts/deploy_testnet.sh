#!/usr/bin/env bash
#
# deploy_testnet.sh — repeatable deploy of the three Sentinel Move packages to
# Sui Testnet, recording the resulting package IDs into backend/frontend config.
# (Task 3.12 — Requirements 1.1 testnet-only, 8.5 policy package id wiring)
#
# What it does:
#   1. Verifies / switches the active sui client environment to Sui Testnet and
#      FAILS CLOSED if the active env is not testnet. (Req 1.1 — testnet only)
#   2. Verifies there is an active address with gas; otherwise prints the exact
#      faucet step and exits without faking a deployment.
#   3. Publishes the dependency graph in ONE transaction from the
#      sentinel_policy package using --with-unpublished-dependencies, which
#      also publishes sentinel_demo_market and sentinel_adapters.
#   4. Parses the JSON publish output and writes:
#        - deployments/testnet.json  (canonical, committed, package IDs are public)
#        - .env                       (backend SENTINEL_*_PACKAGE_ID, gitignored)
#        - frontend/.env              (frontend PUBLIC_SENTINEL_*_PACKAGE_ID, gitignored)
#
# Idempotent: re-running re-publishes fresh packages and overwrites the recorded
# IDs in place (existing unrelated env lines are preserved).
#
# Usage:
#   ./scripts/deploy_testnet.sh
#   GAS_BUDGET=500000000 ./scripts/deploy_testnet.sh
#
set -euo pipefail

# --- Resolve paths ----------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
POLICY_DIR="${REPO_ROOT}/move/sentinel_policy"

TESTNET_ENV_ALIAS="${TESTNET_ENV_ALIAS:-testnet}"
TESTNET_RPC_URL="${TESTNET_RPC_URL:-https://fullnode.testnet.sui.io:443}"
GAS_BUDGET="${GAS_BUDGET:-500000000}"

log()  { printf '\033[0;36m[deploy]\033[0m %s\n' "$*"; }
ok()   { printf '\033[0;32m[deploy]\033[0m %s\n' "$*"; }
err()  { printf '\033[0;31m[deploy] ERROR:\033[0m %s\n' "$*" >&2; }
die()  { err "$*"; exit 1; }

# --- 0. Preconditions -------------------------------------------------------
command -v sui >/dev/null 2>&1 || die "sui CLI not found on PATH. Install from https://docs.sui.io/guides/developer/getting-started/sui-install"
command -v node >/dev/null 2>&1 || die "node not found on PATH (required to record package IDs)."

# --- 1. Ensure the active env is Sui Testnet (Req 1.1) ----------------------
# Create the testnet env if it does not exist, then switch to it. We FAIL CLOSED
# if, after this, the active env is not testnet — Sentinel is testnet-only.
# NOTE: capture the env list into a variable first; piping directly into
# `grep -q` makes grep close the pipe early, which (under `set -o pipefail`)
# aborts the `sui` process with SIGPIPE and corrupts the exit status.
ENVS_JSON="$(sui client envs --json 2>/dev/null || true)"
if ! printf '%s' "${ENVS_JSON}" | grep -q "\"alias\": \"${TESTNET_ENV_ALIAS}\""; then
  log "No '${TESTNET_ENV_ALIAS}' env found; creating it -> ${TESTNET_RPC_URL}"
  sui client new-env --alias "${TESTNET_ENV_ALIAS}" --rpc "${TESTNET_RPC_URL}" >/dev/null
fi

ACTIVE_ENV="$(sui client active-env 2>/dev/null || true)"
if [ "${ACTIVE_ENV}" != "${TESTNET_ENV_ALIAS}" ]; then
  log "Active env is '${ACTIVE_ENV:-<none>}'; switching to '${TESTNET_ENV_ALIAS}'"
  sui client switch --env "${TESTNET_ENV_ALIAS}" >/dev/null
  ACTIVE_ENV="$(sui client active-env 2>/dev/null || true)"
fi

if [ "${ACTIVE_ENV}" != "${TESTNET_ENV_ALIAS}" ]; then
  die "Refusing to deploy: active sui env is '${ACTIVE_ENV:-<none>}', not '${TESTNET_ENV_ALIAS}'. Sentinel deploys to Sui Testnet ONLY (Req 1.1)."
fi

# Defense-in-depth: confirm the active env's RPC URL actually points at testnet.
ACTIVE_RPC="$(printf '%s' "${ENVS_JSON}" \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);const envs=Array.isArray(j)?(Array.isArray(j[0])?j[0]:j):[];const a=envs.find(e=>e&&e.alias===process.argv[1]);process.stdout.write(a&&a.rpc?a.rpc:"")}catch(e){process.stdout.write("")}})' "${TESTNET_ENV_ALIAS}" || true)"
if [ -n "${ACTIVE_RPC}" ] && ! printf '%s' "${ACTIVE_RPC}" | grep -qi 'testnet'; then
  die "Refusing to deploy: env '${TESTNET_ENV_ALIAS}' RPC '${ACTIVE_RPC}' does not look like Sui Testnet (Req 1.1)."
fi
ok "Active sui env verified as Sui Testnet (${ACTIVE_ENV})."

# --- 2. Ensure an active address with gas -----------------------------------
ACTIVE_ADDR="$(sui client active-address 2>/dev/null || true)"
if [ -z "${ACTIVE_ADDR}" ] || [ "${ACTIVE_ADDR}" = "None" ]; then
  die "No active sui address. Create/import one with 'sui client new-address ed25519' then re-run."
fi
log "Active address: ${ACTIVE_ADDR}"

GAS_COUNT="$(sui client gas --json 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);process.stdout.write(String(Array.isArray(j)?j.length:0))}catch(e){process.stdout.write("0")}})' || echo 0)"
if [ "${GAS_COUNT}" = "0" ]; then
  err "Active address has NO gas coins on Sui Testnet, so publishing cannot proceed."
  err "Fund it, then re-run this script:"
  err "  Web faucet:  https://faucet.sui.io/?address=${ACTIVE_ADDR}"
  err "  HTTP faucet: curl --location --request POST 'https://faucet.testnet.sui.io/v1/gas' \\"
  err "                 --header 'Content-Type: application/json' \\"
  err "                 --data-raw '{\"FixedAmountRequest\":{\"recipient\":\"${ACTIVE_ADDR}\"}}'"
  err "Publishing all three packages needs roughly 0.1-0.5 SUI of testnet gas."
  exit 2
fi
ok "Active address has ${GAS_COUNT} gas coin(s)."

# --- 3. Publish the dependency graph in one transaction ---------------------
PUBLISH_JSON="$(mktemp -t sentinel-publish.XXXXXX.json)"
trap 'rm -f "${PUBLISH_JSON}"' EXIT

log "Publishing sentinel_policy (+ sentinel_demo_market, sentinel_adapters) to Sui Testnet..."
log "  gas budget: ${GAS_BUDGET}"
if ! sui client publish \
      --json \
      --gas-budget "${GAS_BUDGET}" \
      --with-unpublished-dependencies \
      --skip-dependency-verification \
      "${POLICY_DIR}" > "${PUBLISH_JSON}" 2>"${PUBLISH_JSON}.err"; then
  err "sui client publish failed:"
  cat "${PUBLISH_JSON}.err" >&2 || true
  cat "${PUBLISH_JSON}" >&2 || true
  rm -f "${PUBLISH_JSON}.err"
  exit 1
fi
rm -f "${PUBLISH_JSON}.err"
ok "Publish transaction submitted."

# --- 4. Record package IDs into backend/frontend config ---------------------
node "${SCRIPT_DIR}/record_deployment.mjs" "${PUBLISH_JSON}" --network "${TESTNET_ENV_ALIAS}"

ok "Deploy complete. Package IDs recorded in deployments/${TESTNET_ENV_ALIAS}.json, .env, and frontend/.env."
