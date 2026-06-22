# Sentinel — an autonomous circuit breaker for Sui lending markets

**Sentinel is an autonomous circuit breaker for Sui DeFi.** It watches a lending market in real
time, scores its risk 0–100 with a deterministic engine, and — when a threshold is crossed —
executes a **bounded** safety action on-chain in seconds (reduce max-LTV, pause new borrows, enter
guarded mode), with every decision provable on Walrus and reversible by a DAO.

> **Who uses it:** Sui lending protocols and DAO risk committees run Sentinel to **automatically
> pause borrows or reduce LTV during oracle/liquidity shocks** — the moments when a human multisig
> is too slow and an unbounded bot is too dangerous.

**Why it’s safe — the core idea:** the AI never controls the protocol. An on-chain Move
`RiskPolicy` object is the sole authority. The agent holds only a `GuardianCap` (bounded to specific
markets, specific actions, capped deltas, a cooldown, and an expiry); the DAO holds an `OverrideCap`
to reverse, retune, unpause, or revoke. The agent **cannot** move funds, change the admin, or edit
its own limits — those paths abort unconditionally in Move.

> ⚠️ Sui Overflow 2026 submission: all execution targets **Sui Testnet only**; all evidence is
> stored on **Walrus Testnet only**. Mainnet is disabled and enforced at four layers.

> 📜 **Judges:** see [`SUBMISSION.md`](./SUBMISSION.md) for one-click, verifiable proof —
> the exact autonomous-action tx digest, Walrus evidence blob id, DAO override digest, and
> "run these commands" reproduction steps.

---

## 60-second judging path

The fastest way to see the whole thesis end to end:

1. **Dashboard** (`/dashboard`) — a live market with **real protected value anchored to Suilend’s
   on-chain reserves** ($150M+ TVL), live Pyth price, DeepBook liquidity, and a risk gauge updating
   over a WebSocket.
2. **Real-event replay** (on the dashboard) — replays the **real Oct 2025 SUI crash (−22.8% in a
   day)** through the _same_ deterministic engine; the score spikes to 79 and Sentinel would have
   reduced LTV. Proof it catches real events, not just synthetic drills.
3. **Simulation Lab** (`/simulator`) — pick a scenario (e.g. _SUI flash crash_); watch the risk
   score climb on a live chart with a plain-English “why this score” breakdown, then watch Sentinel
   execute a **real Sui Testnet PTB**, store a **Walrus** evidence blob, and emit an on-chain
   `ActionLog`. The tx digest is shown only after the Network Guard verifies it as testnet.
4. **Override Console** (in the Simulation Lab and at `/admin`) — as the DAO, unpause the market or
   retune thresholds; it executes a real `OverrideCap`-gated Move call and emits `PolicyUpdated`.

### Live on-chain objects (Sui Testnet)

Package `0xacc43943d51e0bdf43f8a0ea471fd1bb8c4ecaab6df1b9c3a5cab5bbcbea82e7` (modules
`policy`, `market`, `adapters`):

| Object                     | Id                                                                   |
| -------------------------- | -------------------------------------------------------------------- |
| `MarketState` (demo)       | `0x95120424738ae3f9f159bfeafea4e6a11e462463b2b831255d1284e5c3606d12` |
| `MarketState` (SUI Perps)  | `0x3cb057f7748fdffe2c92a817497b363cb6b9f1b660f844459779a3569c402e1e` |
| `MarketState` (USDC Vault) | `0x3dcf15e5a6ebde9c93bec1b411c044d763dbef6d52aea06b4b36aa366ceb1caf` |
| `RiskPolicy`               | `0x81591e148e9a257bd175b696339eba97008fa0762b9132b6320dc1876dba8387` |
| `GuardianCap` (agent)      | `0x21e7bf5b5989422f9a37c766735619a6c389cfbed879a795cc9ba91617ab4706` |
| `OverrideCap` (DAO)        | `0x72b45229d9481a87f5e82049b2a789b52dda4fcbb6cc4396e99cfb715cc2bf39` |

Recent verifiable transactions: autonomous `execute_guardian_action` calls (e.g.
`GypsZ8GjXHvLtTmjCSN2HpuXBJPJSMkvCsUDGrkfYuVU`, emits `RiskActionExecuted`) and a DAO
`update_thresholds` override (`Dm1oXPms782vKSmR9MiDhWMi67bE7ZNdeeufwAmjGtta`, emits `PolicyUpdated`)
— all viewable on [suiscan.xyz/testnet](https://suiscan.xyz/testnet).

**Judges:** run `npm run verify` to confirm the package, all six objects, every cited transaction,
and the live Walrus evidence blobs against the public testnet RPC in one command (no local services
or secrets needed). See [`SUBMISSION.md`](./SUBMISSION.md) for the full proof sheet, and the
**Agent pipeline** panel on the dashboard for the live observe → score → decide → evidence → submit →
govern trace.

---

## Sponsor tech — load-bearing, not decorative

- **Sui Move** is the trust root. The capability pattern (`GuardianCap` / `OverrideCap`) is what
  makes bounded autonomy _structurally_ safe — the whole product is impossible without Move objects.
- **Walrus** stores every decision’s evidence bundle (feature vector, score, rule outputs, reason),
  linked by hash to the on-chain `ActionLog`. Remove Walrus and the “provable / accountable” claim
  collapses — it’s the audit layer.
- **Pyth** is the live price oracle feeding the engine (real SUI/USD feed); staleness and confidence
  width are first-class risk signals.
- **DeepBook** supplies live order-book depth, spread, and imbalance — the liquidity dimension of
  the risk score.
- **DeepSeek** authors the human-readable “why” — strictly advisory, never touching the score.

## Real-world anchoring & the adapter path

- **Real TVL today:** the dashboard’s protected-value / exposure figures are read live from a real
  Sui lending protocol (**Suilend**, via its on-chain reserves) so the “value protected” is genuine
  capital, not a placeholder. (`backend/src/protocol/protocolReserve.ts`)
- **Adapter path for real markets:** `sentinel_adapters` defines a market-type abstraction
  (`lending`, `perps`, `stablecoin`, `demo`) and a uniform `ActionTicket` interface that
  `execute_guardian_action` targets. Onboarding a **Scallop / NAVI-style** lending market means
  writing one adapter that maps its pause/LTV mutators to `ActionTicket` — the policy, capabilities,
  scoring, evidence, and override flow are unchanged. Execution stays on the demo market for the
  hackathon; the seam to a production protocol is already in place.

### Real vs simulated — at a glance

| Real (live)                                                                 | Simulated / configured                                      |
| --------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Pyth oracle prices (SUI/USD, USDC/USD), DeepBook SUI/USDC liquidity         | USDC Vault liquidity depth (testnet stable book is empty)   |
| Suilend reserves anchoring the demo market's "value protected"              | Lending exposure on the demo `MarketState` (we minted it)   |
| On-chain `MarketState` / `RiskPolicy` / caps, all signed actions + evidence | Guarded **execution target** = the testnet demo market only |

Three monitored markets (SUI Lending demo, SUI Perps, USDC Vault) each carry their **own** live Pyth
feed, liquidity venue, and on-chain `MarketState` — the dashboard's Live Data Sources strip reflects
the true source per market. Full breakdown in [`SUBMISSION.md` §6](./SUBMISSION.md).

---

## Architecture — four layers

| Layer        | Directory                 | Stack                     | Responsibility                                                                                                                                                                                                                                                                      |
| ------------ | ------------------------- | ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **On-chain** | [`move/`](./move)         | Sui Move                  | `sentinel_policy` (RiskPolicy, GuardianCap, OverrideCap, ActionLog — trust root + enforcement), `sentinel_demo_market` (controllable lending market), `sentinel_adapters` (market-type abstraction). Testnet only.                                                                  |
| **Backend**  | [`backend/`](./backend)   | Node + Express + TS       | API gateway, WebSocket server, Risk Engine, AI Explanation Service, Action Executor (PTB build/simulate/submit), Evidence Service (Walrus), Oracle/Liquidity workers, Protocol Indexer, Network Guard, real-protocol reserve reader, historical replay. Holds the agent signer key. |
| **Frontend** | [`frontend/`](./frontend) | Astro + React islands     | Landing, dashboard, policy wizard, override console, incident replay, simulation lab. Sui dApp Kit for wallet.                                                                                                                                                                      |
| **Storage**  | (backend-managed)         | PostgreSQL, Redis, Walrus | Relational config + time-series snapshots, cache/queue, immutable evidence.                                                                                                                                                                                                         |

Two cross-cutting guarantees: **network enforcement** (testnet verified at wallet, RPC chain-id,
package-id, and tx-digest-display layers; backend refuses to start on mismatch) and **fail-closed
reliability** (missing oracle data, failed simulation, failed evidence upload, stale data, or a
revoked guardian → block execution, never act).

---

## Run it in 5 minutes

Requires Node.js 20+, Docker (Postgres + Redis), and a funded Sui Testnet key for on-chain actions.

```bash
# 1. Install
npm install
cp .env.example .env        # fill SUI_RPC_URL, AGENT_SIGNER_KEY, WALRUS_*, DATABASE_URL, REDIS_URL, LLM_API_KEY

# 2. Datastores (Postgres on 5434, Redis)
docker compose up -d        # or your local Postgres/Redis

# 3. Migrate + seed the demo market/policy/incident
cd backend && npm run migrate && npm run seed

# 4. (one-time) provision real on-chain objects, or reuse the ids above
npm run provision           # writes object ids to .env + deployments/demo-objects.json

# 5. Start the backend (REST :4000 + WebSocket) and the frontend (Astro)
npm run dev                 # backend
cd ../frontend && npm run dev   # http://localhost:4321
```

Production build (now adapter-backed, so it actually builds):

```bash
cd frontend && npm run build   # static pages prerendered; dynamic routes via @astrojs/node
```

### Common scripts

```bash
npm run lint           # lint all sources
npm run build          # build all workspaces
npm test               # run all suites (backend ~480 tests incl. property-based; frontend 140)
npm run verify         # verify on-chain proof (package, objects, txs, Walrus blobs) vs live testnet
```

Backend demo utilities: `npm run provision` (mint on-chain objects), `npm run reset-cooldown`
(set the demo policy cooldown to 0 so the lab can fire repeatedly).

---

## Testing & correctness

Sentinel is built with formal correctness in mind: the deterministic risk engine, the bounded-action
enforcement, the fail-closed paths, and the data-source labeling invariant are all covered by
**property-based tests** alongside example tests and route smoke tests. The on-chain enforcement
(capability checks, cooldown, delta bounds, override authority) is the gating path and is tested in
Move.

## License

MIT
