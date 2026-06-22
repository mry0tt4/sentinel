# Sentinel — Sui Overflow 2026 Submission Proof

**Sentinel is an autonomous, bounded circuit breaker for Sui lending markets.** Sui
lending protocols and DAO risk committees use it to automatically pause borrows,
reduce LTV, or raise margin during oracle/liquidity shocks — with every decision
constrained by an on-chain policy and backed by immutable Walrus evidence.

This file is the one-page, judge-verifiable proof. Every value below is a **real
Sui Testnet artifact** you can click and confirm — no mocks, no placeholders.

- **Network:** Sui Testnet (`chain-id 4c78adac`)
- **Move package:** [`0xacc43943d51e0bdf43f8a0ea471fd1bb8c4ecaab6df1b9c3a5cab5bbcbea82e7`](https://suiscan.xyz/testnet/object/0xacc43943d51e0bdf43f8a0ea471fd1bb8c4ecaab6df1b9c3a5cab5bbcbea82e7) (modules `policy`, `market`, `adapters`)
- **Agent / DAO address:** [`0xa054daa9e6db27e623f377f17b0702222f2b54b9ef76d16ca02cf3dec189d4b4`](https://suiscan.xyz/testnet/account/0xa054daa9e6db27e623f377f17b0702222f2b54b9ef76d16ca02cf3dec189d4b4)

---

## 0. Judge mode — one-click verification

Verify every claim in this file against the **public Sui Testnet RPC + Walrus
aggregator** in one command — no local services, no secrets, no wallet:

```bash
npm install        # only needs Node 20+ (uses built-in fetch)
npm run verify
```

`scripts/verify-submission.mjs` reads [`deployments/proof.json`](./deployments/proof.json)
(the single source of truth this doc also cites) and checks, live:

1. the Move package is published on testnet,
2. all six on-chain objects exist (demo + 2 extra MarketStates, RiskPolicy, both caps),
3. every cited transaction executed with `success`,
4. each autonomous action emitted `policy::RiskActionExecuted` and each override `policy::PolicyUpdated`,
5. each non-expired Walrus evidence blob is retrievable.

Latest run: **20/20 checks passed.** (Walrus testnet blobs expire by storage
epoch; an expired blob is reported but is not a failure — the on-chain ActionLog
permanently records its blob id + evidence hash.)

---

## 1. Live on-chain objects

| Object                      | ID                                                                                                                                                                            |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Demo `MarketState` (shared) | [`0x95120424738ae3f9f159bfeafea4e6a11e462463b2b831255d1284e5c3606d12`](https://suiscan.xyz/testnet/object/0x95120424738ae3f9f159bfeafea4e6a11e462463b2b831255d1284e5c3606d12) |
| `RiskPolicy` (shared)       | [`0x81591e148e9a257bd175b696339eba97008fa0762b9132b6320dc1876dba8387`](https://suiscan.xyz/testnet/object/0x81591e148e9a257bd175b696339eba97008fa0762b9132b6320dc1876dba8387) |
| `GuardianCap` (agent-held)  | [`0x21e7bf5b5989422f9a37c766735619a6c389cfbed879a795cc9ba91617ab4706`](https://suiscan.xyz/testnet/object/0x21e7bf5b5989422f9a37c766735619a6c389cfbed879a795cc9ba91617ab4706) |
| `OverrideCap` (DAO-held)    | [`0x72b45229d9481a87f5e82049b2a789b52dda4fcbb6cc4396e99cfb715cc2bf39`](https://suiscan.xyz/testnet/object/0x72b45229d9481a87f5e82049b2a789b52dda4fcbb6cc4396e99cfb715cc2bf39) |

Provisioning transactions:
[`init_market`](https://suiscan.xyz/testnet/tx/Htm3pspJu2CaReVZoFaUowkG1VwQYAkm95JXwNPi6w1h) ·
[`create_policy`](https://suiscan.xyz/testnet/tx/Cead6Wreo29hh4HRY3yB6gokfoUf81pMjYE7wGXeUvQS)

---

## 2. Autonomous agent action (the core proof)

The agent detected elevated risk, built and simulated a Programmable Transaction
Block, pinned evidence to Walrus, then signed `execute_guardian_action` with its
`GuardianCap` — all without a human in the loop.

- **Transaction digest:** [`GypsZ8GjXHvLtTmjCSN2HpuXBJPJSMkvCsUDGrkfYuVU`](https://suiscan.xyz/testnet/tx/GypsZ8GjXHvLtTmjCSN2HpuXBJPJSMkvCsUDGrkfYuVU)
- **On-chain event emitted:** `policy::RiskActionExecuted`
- **Action:** reduce max LTV → **6500 bps (65%)** at **risk score 87**
- **Actor:** agent (`GuardianCap`), bounded by `RiskPolicy` limits
- **Walrus evidence blob:** [`2PMM51awFAYran58Z--VEYgVlh3DqzqFmvioZUO_1fE`](https://aggregator.walrus-testnet.walrus.space/v1/blobs/2PMM51awFAYran58Z--VEYgVlh3DqzqFmvioZUO_1fE) (retrievable, HTTP 200)
- **Checkpoint:** 351198978

> The PTB inputs (verifiable on the explorer) include the `RiskPolicy`, the
> `GuardianCap`, the `MarketState`, the action type, the new LTV value, the risk
> score, and the Walrus blob id + evidence hash — proving the action and its
> evidence are bound together on-chain.

There are **36 real autonomous agent actions** and **15 distinct Walrus evidence
blobs** recorded against this policy. Four representative actions, each with a
**live** Walrus evidence blob, all `success` on testnet (run `npm run verify` to
re-confirm):

| Action              | Risk score | Tx digest                                                                                     | Walrus evidence blob (live)                                                                                           |
| ------------------- | ---------- | --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `reduce_max_ltv`    | 87         | [`GypsZ8…YuVU`](https://suiscan.xyz/testnet/tx/GypsZ8GjXHvLtTmjCSN2HpuXBJPJSMkvCsUDGrkfYuVU)  | [`2PMM51…O_1fE`](https://aggregator.walrus-testnet.walrus.space/v1/blobs/2PMM51awFAYran58Z--VEYgVlh3DqzqFmvioZUO_1fE) |
| `reduce_max_ltv`    | 83         | [`DtjRMR…1uBt`](https://suiscan.xyz/testnet/tx/DtjRMRURXmb2Vn8zFJZamPUVDqfKbr8PdbTsZW7h1uBt)  | [`-WcIzS…rWEs`](https://aggregator.walrus-testnet.walrus.space/v1/blobs/-WcIzS47ICdk6xCq25FfXgZDPTWBbH2m_Cl02sqrWEs)  |
| `reduce_max_ltv`    | 79         | [`DpUem5…ExpM`](https://suiscan.xyz/testnet/tx/DpUem5sZujhbc9D5WUu3XgYHcv8sEAw54Psr9jieExpM)  | [`OGYjx6…AzwQ`](https://aggregator.walrus-testnet.walrus.space/v1/blobs/OGYjx6rc8VikSIhOEzZbYPJbiqBs7MUT5aNYoQQAzwQ)  |
| `pause_new_borrows` | 35         | [`7CnUGM…x2ndC`](https://suiscan.xyz/testnet/tx/7CnUGMYX1YtBfPzEZH3qKaQ6P24aMsrmuy4tniix2ndC) | [`5Tw0tB…DqL_8`](https://aggregator.walrus-testnet.walrus.space/v1/blobs/5Tw0tB3XnMAYL5Ugx7fFcC3TWDrU3J1auJ6FGkDqL_8) |

---

## 3. DAO override (human-in-the-loop reversal)

The DAO risk committee retuned the policy bounds during a live stress test using
its `OverrideCap` — demonstrating that human governance can always override the
agent.

- **Transaction digest:** [`Dm1oXPms782vKSmR9MiDhWMi67bE7ZNdeeufwAmjGtta`](https://suiscan.xyz/testnet/tx/Dm1oXPms782vKSmR9MiDhWMi67bE7ZNdeeufwAmjGtta)
- **On-chain event emitted:** `policy::PolicyUpdated`
- **Operation:** `update_thresholds` (OverrideCap)
- **Reason (recorded):** "DAO retunes limits during simulated stress (live test)"
- **Walrus evidence blob:** [`ARr5i5KyydW8O7B02pHzvEYIn0Aff3FWIkBbgfLphg8`](https://aggregator.walrus-testnet.walrus.space/v1/blobs/ARr5i5KyydW8O7B02pHzvEYIn0Aff3FWIkBbgfLphg8) (retrievable, HTTP 200)
- **Checkpoint:** 351195565

Additional DAO override digest:
[`Ep9Rk5Zc4bEQhQJ4qv1hoK5HsDHdgynck8dREYrsbkMw`](https://suiscan.xyz/testnet/tx/Ep9Rk5Zc4bEQhQJ4qv1hoK5HsDHdgynck8dREYrsbkMw).

---

## 4. Sponsor integrations (load-bearing, not decorative)

- **Walrus** — every agent action and DAO override writes a canonical-JSON
  evidence blob to Walrus Testnet _before_ the PTB is submitted; the blob id is
  recorded in the on-chain action. The blobs in §2 and §3 are live and fetchable.
- **DeepBook / Pyth** — the Risk Engine reads SUI/USD from a Pyth feed and
  SUI/USDC liquidity from a DeepBook pool to compute oracle freshness,
  volatility, and liquidity-depth features (see `sources` in `GET /api/markets/:id/risk`).
- **Real Sui lending TVL** — the impact figures are anchored to live Suilend
  reserves so "value protected" reflects genuine on-chain capital.

---

## 5. The agent pipeline (what runs on every tick)

Sentinel's autonomous loop is visible in the dashboard's **Agent pipeline** panel
and is the same flow the live loop and Simulation Lab execute:

1. **Observe** — live Pyth oracle + DeepBook liquidity + on-chain `MarketState`.
2. **Score** — deterministic risk engine produces a 0–100 score + band (no LLM in the decision path).
3. **Decide** — fail-closed policy gate maps the band to a single **bounded** action (or none).
4. **Evidence** — a canonical-JSON evidence bundle is written to **Walrus first**, before any transaction.
5. **Build PTB** — from a fixed, **server-defined template** (`execute_guardian_action`); arbitrary transaction structure is rejected by construction.
6. **Simulate** — dry-run the PTB; refuse to submit if it fails.
7. **Submit** — network-gated submission to **Sui Testnet** (digest shown only after the Network Guard confirms testnet origin).
8. **Record + Govern** — the on-chain `ActionLog` is mirrored off-chain; the DAO's `OverrideCap` can reverse or retune at any time.

The AI never holds funds or keys and cannot change its own limits — those paths
abort unconditionally in Move. The agent's only authority is a `GuardianCap`
bounded to specific markets, actions, deltas, a cooldown, and an expiry.

---

## 6. Real vs simulated — exactly what's what

Being precise so judges can trust every claim:

| Element                                       | Status                                                                                       |
| --------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Oracle prices (SUI/USD, USDC/USD)             | **Real** — live Pyth Hermes feeds                                                            |
| Liquidity (SUI markets)                       | **Real** — live DeepBook `SUI_DBUSDC` order book                                             |
| Liquidity (USDC Vault)                        | **Modeled** — the DeepBook testnet stable book is empty, so depth is a labelled baseline     |
| "Value protected" anchoring                   | **Real** — live Suilend reserves (read-only, via DefiLlama), only for the SUI lending market |
| `MarketState` / `RiskPolicy` / caps           | **Real** — on-chain Sui Testnet objects (explorer-verifiable)                                |
| Autonomous actions + DAO overrides            | **Real** — signed Sui Testnet transactions with Walrus evidence (§2, §3)                     |
| Guarded **execution target**                  | **Testnet demo market** — Sentinel's own `MarketState`, not a third-party mainnet protocol   |
| Lending protocol exposure (collateral/borrow) | **Configured** on the demo `MarketState` (we minted it), then monitored with real feeds      |

In short: the **data feeds, evidence, transactions, and on-chain objects are
real**; the **market Sentinel guards is a testnet demo market** (Overflow rules
keep all execution on testnet). Wiring the same `GuardianCap` flow to a
production lending market (Scallop / NAVI / Suilend) is a config change to the
adapter target, not new architecture.

---

## 7. Reproduce it yourself

```bash
# 0. Prereqs: Node 20+, Docker, a funded Sui Testnet key
npm install
cp .env.example .env            # fill SUI_RPC_URL, AGENT_SIGNER_KEY, WALRUS_*, LLM_API_KEY

# 1. Datastores (Postgres on 5434, Redis on 6379)
docker compose up -d

# 2. Migrate + seed the demo market / policy / incident
npm run migrate --workspace=backend
npm run seed    --workspace=backend

# 3. Quality gates (all green)
npm run lint                    # 0 errors / 0 warnings
npm run build                   # backend + frontend (no chunk warnings)
npm test                        # 619 passing (backend 479 + frontend 140), 5 live tests opt-in (skipped)

# 4. Move contract tests
#    (from move/sentinel_policy)  -> 25/25 passing
sui move test

# 5. One-click on-chain proof check (no local services needed)
npm run verify                  # 20/20 checks against live testnet + Walrus
```

### Optional: live on-chain + Walrus + Pyth integration tests

The normal `npm test` run keeps network-touching tests opt-in so CI stays
deterministic. To exercise the real testnet/Walrus/Pyth paths:

```bash
RUN_INTEGRATION=1 npm test --workspace=backend
```

### Verify the digests above without cloning

```bash
# Confirm the autonomous action succeeded on Sui Testnet
curl -s https://fullnode.testnet.sui.io:443 -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"sui_getTransactionBlock","params":["GypsZ8GjXHvLtTmjCSN2HpuXBJPJSMkvCsUDGrkfYuVU",{"showEvents":true}]}'

# Fetch the Walrus evidence blob it pinned
curl -s https://aggregator.walrus-testnet.walrus.space/v1/blobs/2PMM51awFAYran58Z--VEYgVlh3DqzqFmvioZUO_1fE
```

---

## 8. Demo video

Watch the walkthrough (scenario start → score crosses threshold → Walrus blob →
testnet PTB → on-chain action log → DAO override):

**▶ https://www.youtube.com/watch?v=wjW0sVAG4bQ**
