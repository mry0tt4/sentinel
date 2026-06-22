# Deployments

Canonical record of the Sentinel Move packages published to Sui Testnet.

> Sentinel is **Sui Testnet only** for the hackathon demo (Req 1.1). Mainnet is
> disabled. The deploy script fails closed if the active sui env is not testnet.

## Files

- `testnet.json` — generated artifact with the published package IDs, the
  publish tx digest, and the created `UpgradeCap`(s). Package IDs are public, so
  this file is committed. Until a real deploy runs it holds clearly-marked
  `NOT_DEPLOYED` placeholder values.

## How to deploy (repeatable)

The three packages form a local dependency graph
(`sentinel_policy` → `sentinel_demo_market` → `sentinel_adapters`), so a single
publish of `sentinel_policy` with `--with-unpublished-dependencies` publishes
all three in one transaction.

```bash
# 1. Ensure you have a testnet address with gas:
sui client active-address
# Fund it via the web faucet (CLI/HTTP faucet is IP rate-limited):
#   https://faucet.sui.io/?address=<YOUR_ADDRESS>
# Publishing all three packages needs roughly 0.1–0.5 SUI of testnet gas.

# 2. Run the repeatable deploy script from the repo root:
./scripts/deploy_testnet.sh
```

The script:

1. Verifies / switches the active `sui` client env to **testnet** and aborts if
   it is anything else (Req 1.1).
2. Verifies an active address with gas exists (prints the faucet command and
   exits cleanly if not — it never fakes a deployment).
3. Publishes the dependency graph in one transaction
   (`--with-unpublished-dependencies`).
4. Records the resulting package IDs into:
   - `deployments/testnet.json` (this directory)
   - `.env` (backend: `SENTINEL_POLICY_PACKAGE_ID`,
     `SENTINEL_DEMO_MARKET_PACKAGE_ID`, `SENTINEL_ADAPTERS_PACKAGE_ID`)
   - `frontend/.env` (frontend: `PUBLIC_SENTINEL_*_PACKAGE_ID`)

Re-running the script re-publishes and overwrites the recorded IDs in place;
unrelated env lines are preserved.

### Recording IDs from a saved publish output

If you publish manually, save the JSON and record config without re-deploying:

```bash
sui client publish --json --with-unpublished-dependencies \
  --skip-dependency-verification move/sentinel_policy > publish-output.json
node scripts/record_deployment.mjs publish-output.json --network testnet
```
