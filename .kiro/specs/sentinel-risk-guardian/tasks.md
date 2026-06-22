# Implementation Plan: Sentinel Risk Guardian

## Overview

This plan converts the Sentinel design into incremental, test-driven coding tasks across four layers: on-chain Sui Move packages (`sentinel_policy`, `sentinel_demo_market`, `sentinel_adapters`), the Node.js + Express + TypeScript backend, the Astro + TypeScript frontend, and the cross-cutting testnet-only network enforcement / fail-closed reliability concerns.

Tasks are sequenced so the P0 judge-facing end-to-end demo path is achievable as early as possible: testnet wallet connection → network enforcement → demo market → Move policy/guardian/override objects → AI risk score → live dashboard → oracle adapter → simulation lab → autonomous testnet action → on-chain ActionLog/event → Walrus evidence → incident replay → human override → guardian revocation.

Property-based tests (fast-check for TypeScript, the Move test scenario framework for on-chain) implement the 32 correctness properties from the design. Each property maps to exactly one test sub-task, tagged `// Feature: sentinel-risk-guardian, Property {number}: ...`, with a minimum of 100 iterations for fast-check properties. Test sub-tasks are marked optional with `*`.

## Tasks

- [x] 1. Set up monorepo, toolchain, and package skeletons
  - [x] 1.1 Create monorepo workspace structure and shared tooling
    - Create top-level directories `move/`, `backend/`, `frontend/`, plus shared `tsconfig.base.json`, linting/formatting config, and a root README describing the four layers
    - Add an `.env.example` documenting Sui Testnet RPC, Walrus Testnet endpoint, agent signer key var, DB/Redis URLs (no real secrets committed)
    - _Requirements: 16.3_

  - [x] 1.2 Initialize the backend project (Express + TypeScript)
    - Scaffold `backend/` with Express, TypeScript, `@mysten/sui` SDK, env config loader, and the test runner (vitest/jest) with `fast-check` installed
    - Add npm scripts for build, lint, and `test --run` (single-run, no watch)
    - _Requirements: 15.1, 15.2, 16.3_

  - [x] 1.3 Initialize the frontend project (Astro + TypeScript)
    - Scaffold `frontend/` with Astro, TypeScript, Sui dApp Kit dependencies, a charting library, and a component test runner
    - _Requirements: 2.1, 3.1_

  - [x] 1.4 Initialize the Sui Move workspace with three package skeletons
    - Create `move/sentinel_policy`, `move/sentinel_demo_market`, `move/sentinel_adapters` each with a `Move.toml` targeting Sui Testnet dependencies and empty module files
    - _Requirements: 8.1, 5.1, 4.2_

- [x] 2. Implement the on-chain demo market (`sentinel_demo_market`)
  - [x] 2.1 Implement market state, initialization, getters, and admin reset
    - Implement `init_market` creating `MarketState` with collateral/borrow config, max LTV, maintenance margin, borrow pause flag, guarded mode flag, and stored admin/owner address
    - Implement read-only getters `get_state`, `get_utilization`, `get_exposure`, and admin-gated `reset_market`
    - _Requirements: 5.1, 5.2, 5.5, 5.6_

  - [x] 2.2 Implement policy-controlled mutators with authorization witness
    - Implement pause/unpause borrows, reduce/restore max LTV, enter/exit guarded mode, each requiring a proof-of-policy-authorization witness (hot-potato) passed from the policy package, rejecting unauthorized callers
    - _Requirements: 5.3, 5.4_

  - [x] 2.3 Write Move tests for demo market authorization and reset
    - **Property 17: Demo market authorization gating** — unauthorized state change rejected, no state change
    - **Property 16: Demo market reset round-trip and admin gating** — admin reset restores init values; non-admin reset rejected
    - **Validates: Requirements 5.3, 5.4, 5.5, 5.6**

- [x] 3. Implement the on-chain policy package and adapters (`sentinel_policy`, `sentinel_adapters`)
  - [x] 3.1 Define policy structs, events, and the adapter interface
    - Define `RiskPolicy`, `GuardianCap`, `OverrideCap`, `ActionLog` structs with all specified fields, and the events `RiskActionExecuted`, `RiskActionOverridden`, `GuardianRevoked`, `PolicyUpdated`
    - Define the `sentinel_adapters` market-type abstraction (`lending`, `perps`, `stablecoin`, `demo`) that `execute_guardian_action` targets uniformly
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.6, 8.7, 8.8, 8.9, 4.2_

  - [x] 3.2 Implement policy and capability creation functions
    - Implement `create_policy`, `create_guardian_cap`, `create_override_cap` wiring `policy_id`, bounds, cooldown, allowed markets/actions, expiry, and DAO/agent addresses
    - _Requirements: 8.1, 8.2, 8.3, 8.5_

  - [x] 3.3 Implement `execute_guardian_action` with ordered enforcement, logging, and event
    - Verify in order (aborting on first failure with no state change): not revoked, not expired, market in `allowed_markets`, action in `allowed_actions`, cooldown elapsed, deltas within `max_ltv_delta_bps`/`max_margin_delta_bps`/`pause_duration_limit_ms`
    - On success apply the bounded mutation via the adapter, set `last_action_timestamp_ms`, create an `ActionLog` (with blob id, evidence hash, tx digest), and emit `RiskActionExecuted`
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 7.8, 7.9, 8.10, 8.11, 8.12, 8.14, 9.4_

  - [x] 3.4 Implement override, reversal, revocation, threshold, and market-control functions
    - Implement `revoke_guardian`, `update_thresholds`, `override_action`, `confirm_action`, `reverse_action`, `pause_market`, `unpause_market`, `adjust_ltv`, `restore_ltv`, `enter_guarded_mode`, `exit_guarded_mode`, `log_action`, each verifying a valid `OverrideCap` (and relevant capability flag) where required and emitting the corresponding event; forbid agent fund transfer, admin change, OverrideCap removal, and self-policy edits
    - Make `revoke_guardian` idempotent (no duplicate `GuardianRevoked` when already revoked)
    - _Requirements: 7.7, 8.5, 8.6, 8.7, 8.8, 8.9, 8.13, 11.4, 11.8, 12.1, 12.3, 12.5, 12.6, 16.7, 16.8_

  - [x] 3.5 Write Move test for on-chain bound enforcement
    - **Property 8: On-chain bound enforcement** — LTV/margin/pause-duration over cap aborts, no state change
    - **Validates: Requirements 7.5, 7.6, 7.9, 8.12**

  - [x] 3.6 Write Move test for capability-state rejection
    - **Property 9: On-chain capability-state rejection** — revoked/expired/within-cooldown/non-testnet aborts, no state change (mocked `Clock` for expiry/cooldown boundaries)
    - **Validates: Requirements 7.8, 8.10, 8.11, 12.3, 17.8**

  - [x] 3.7 Write Move test for scope enforcement
    - **Property 10: On-chain scope enforcement** — market not in `allowed_markets` or action not in `allowed_actions` aborts, no state change
    - **Validates: Requirements 7.3, 7.4**

  - [x] 3.8 Write Move test for forbidden agent operations
    - **Property 11: Forbidden agent operations always rejected** — transfer funds / change admin / remove OverrideCap / edit policy all abort
    - **Validates: Requirements 7.7, 16.7**

  - [x] 3.9 Write Move test for successful action atomic record + emit
    - **Property 12: Successful action records and emits atomically** — `last_action_timestamp_ms` set, ActionLog with blob id/hash/digest recorded, `RiskActionExecuted` emitted in one tx
    - **Validates: Requirements 8.14, 9.4, 16.8**

  - [x] 3.10 Write Move test for override authority requirement
    - **Property 13: Override operations require a valid OverrideCap** — override/reverse/revoke/update/unpause without valid cap (or flag false) aborts, state unchanged
    - **Validates: Requirements 8.13, 12.5**

  - [x] 3.11 Write Move test for guardian revocation atomicity and idempotence
    - **Property 14: Guardian revocation is atomic and idempotent** — valid revoke flips `revoked` + emits event in same tx; repeat revoke keeps true with no duplicate event
    - **Validates: Requirements 12.1, 12.6**

  - [x] 3.12 Deploy the three Move packages to Sui Testnet
    - Publish `sentinel_demo_market`, `sentinel_adapters`, `sentinel_policy` to Sui Testnet via a repeatable deploy script and record the resulting package IDs into backend/frontend config
    - _Requirements: 1.1, 8.5_

- [x] 4. Checkpoint - on-chain layer complete
  - Ensure all Move tests pass, ask the user if questions arise.

- [x] 5. Implement backend foundation and data persistence
  - [x] 5.1 Create PostgreSQL schema and migrations
    - Implement migrations for `markets`, `policies`, `risk_snapshots`, `incidents`, `actions`, `walrus_blobs`, and `environment_checks` with all constraints from the design
    - _Requirements: 15.3_

  - [x] 5.2 Implement the data access layer and Redis cache/queue
    - Implement typed repositories for all seven tables and a Redis client for hot snapshots and the job queue
    - _Requirements: 15.3_

  - [x] 5.3 Implement config and secret loading
    - Load Sui Testnet RPC, Walrus endpoint, agent signer key, and DB/Redis URLs from environment variables only; never expose the agent key to any client-facing surface
    - _Requirements: 16.1, 16.2, 16.3_

- [x] 6. Implement the Network Guard (testnet-only enforcement)
  - [x] 6.1 Implement Network Guard verification and audit recording
    - Implement `verifyRpcChainIdAtStartup` (refuse startup with no partial init if mismatched or unverifiable within 10s), `verifySubmissionTarget` (package id + chain), `verifyDigestOrigin`, and `recordCheck` writing every result to `environment_checks` with ISO 8601 UTC timestamp, type, and pass/fail outcome
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.6, 1.7, 1.8, 1.9, 1.10_

  - [x] 6.2 Write property test for network verification recording
    - **Property 24: Network verification is always recorded** — every verification creates an `environment_checks` record; failed submission-target/digest-origin verification blocks the action/display
    - **Validates: Requirements 1.6, 1.7, 1.8, 1.9, 1.10**

  - [x] 6.3 Write smoke test for startup refusal on network mismatch
    - **Property 25: Backend refuses startup on network mismatch** — wrong/unverifiable RPC chain id prevents startup with no partial initialization and returns a mismatch/unverifiable error
    - **Validates: Requirements 1.3, 1.4**

- [x] 7. Implement the Risk Engine and AI Explanation Service
  - [x] 7.1 Implement the deterministic scoring engine
    - Implement the `FeatureVector` type, the weighted five-group subscore aggregation clamped to `[0,100]`, band assignment, risk classification, and recommended-action selection using deterministic rules + anomaly detection (no LLM in the gating path); record model version, prompt/config version, and feature vector per evaluation
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.11, 6.12, 6.13_

  - [x] 7.2 Write property test for risk score range
    - **Property 1: Risk score is always within range** — score and confidence are integers in `[0,100]` for any feature vector (extreme/missing/adversarial)
    - **Validates: Requirements 6.2, 6.5, 3.3, 14.2**

  - [x] 7.3 Write property test for band partition
    - **Property 2: Band assignment partitions the score range** — every score maps to exactly one band per the mapping
    - **Validates: Requirements 6.3**

  - [x] 7.4 Write property test for risk classification subset
    - **Property 3: Risk classification is a non-empty subset of the allowed set**
    - **Validates: Requirements 6.4**

  - [x] 7.5 Implement the AI Explanation Service
    - Wrap the LLM to produce a ≤1000-char plain-language explanation from score/band/classes/rule outputs, with no authority to change the score or trigger actions
    - _Requirements: 6.5, 6.13_

  - [x] 7.6 Write property test for explanation independence
    - **Property 4: Explanation never gates decisions (deterministic independence)** — score/band/classes/recommended action are identical regardless of explanation output; explanation ≤1000 chars
    - **Validates: Requirements 6.5, 6.11, 6.13**

  - [x] 7.7 Implement fail-closed refusal and stale-data emergency logic
    - Refuse a recommendation and record a reason when oracle price/confidence/timestamp is absent/unparseable, network is not Sui Testnet, the GuardianCap is revoked, or the recommended action would exceed policy bounds; when oracle age exceeds freshness and policy permits, recommend an emergency pause with a recorded stale-data justification
    - _Requirements: 6.6, 6.7, 6.8, 6.9, 6.10, 6.14, 17.1, 17.2_

  - [x] 7.8 Write property test for fail-closed refusal
    - **Property 5: Fail-closed — no action recommended under uncertainty** — null recommendation + recorded refusal reason under missing oracle data / non-testnet / revoked cap / out-of-bounds
    - **Validates: Requirements 6.7, 6.8, 6.9, 6.10, 17.1, 17.2**

  - [x] 7.9 Write property test for stale-data emergency recommendation
    - **Property 6: Stale-data emergency recommendation** — oracle age over freshness + policy permits → emergency pause + recorded justification
    - **Validates: Requirements 6.14**

  - [x] 7.10 Implement the model/prompt version registry with admin approval gate
    - Persist risk model and prompt/config versions and block use of any version that has not received admin approval
    - _Requirements: 16.10_

  - [x] 7.11 Write property test for version approval gating
    - **Property 31: Model/prompt version requires approval before use** — unapproved version is blocked until approved
    - **Validates: Requirements 16.10**

- [x] 8. Implement oracle ingestion and liquidity workers
  - [x] 8.1 Implement the Oracle Adapter and Oracle Ingestion Worker
    - Implement the configurable `OracleAdapter.readFeed` (Pyth on testnet) returning price, confidence, and timestamp, and the worker that polls and writes snapshots to Redis + Postgres
    - _Requirements: 6.1_

  - [x] 8.2 Implement the Liquidity Worker
    - Read liquidity depth, spread, and imbalance (DeepBook optional, else demo-market simulated values) and write snapshots
    - _Requirements: 6.1_

  - [x] 8.3 Write integration test for oracle adapter read on testnet
    - Read a live testnet feed (1–2 examples) and assert price/confidence/timestamp are parsed
    - _Requirements: 6.1_

- [x] 9. Implement the Evidence Service (Walrus Testnet)
  - [x] 9.1 Implement evidence bundle generation
    - Serialize an `EvidenceBundle` containing all required fields (market/policy ids, timestamp, prices, oracle confidence/freshness, liquidity/exposure, model versions, feature vector, score, classes, recommended/executed action, explanation, rule outputs, agent signer, tx digest, prior action ids, scenario id, raw data hash)
    - _Requirements: 10.1_

  - [x] 9.2 Write property test for evidence bundle completeness
    - **Property 18: Evidence bundle completeness** — serialized JSON contains all required fields
    - **Validates: Requirements 10.1**

  - [x] 9.3 Implement Walrus upload with status lifecycle and bounded retry
    - Upload bundles as JSON to Walrus Testnet, track status transitions across `{pending_upload, uploaded, linked_on_chain, failed_upload, retrying, private_encrypted}`, and retry failed uploads up to 5 attempts ≥5s apart before marking `failed_upload` and preserving the bundle
    - _Requirements: 10.2, 10.3, 10.6, 10.7, 17.4_

  - [x] 9.4 Write property test for evidence status validity
    - **Property 19: Evidence has exactly one valid status** — status is always exactly one of the allowed set
    - **Validates: Requirements 10.3**

  - [x] 9.5 Write property test for bounded upload retry
    - **Property 21: Upload retry is bounded** — at most 5 attempts ≥5s apart; after the 5th failure status is `failed_upload` with bundle preserved
    - **Validates: Requirements 10.6, 10.7, 17.4**

  - [x] 9.6 Implement linking, immutability, secret exclusion, and sensitive-field encryption
    - Implement `link` (store blob id, record hash on-chain, set `linked_on_chain`; on link failure retain blob id, set `failed_upload`, return error), `assertMutable` (reject modify/delete of linked evidence), exclusion of secrets/keys from non-private bundles, and encryption of policy-designated sensitive fields setting status `private_encrypted`
    - _Requirements: 10.4, 10.5, 10.8, 10.9, 10.10_

  - [x] 9.7 Write property test for linked-evidence immutability
    - **Property 20: Linked evidence is immutable** — modify/delete of `linked_on_chain` rejected, bundle and hash unchanged
    - **Validates: Requirements 10.10**

  - [x] 9.8 Write property test for secret exclusion in non-private evidence
    - **Property 22: Secrets are never present in non-private evidence** — no secrets/keys in `uploaded`/`linked_on_chain`/`pending_upload`; designated sensitive fields encrypted with status `private_encrypted`
    - **Validates: Requirements 10.8, 10.9, 16.1**

  - [x] 9.9 Write integration test for Walrus upload round-trip timing
    - Upload a bundle and confirm a Blob_ID + hash are returned within 30s (1–2 examples)
    - _Requirements: 10.2_

- [x] 10. Checkpoint - core backend services complete
  - Ensure all tests pass, ask the user if questions arise.

- [x] 11. Implement the Action Executor (PTB build / simulate / submit)
  - [x] 11.1 Implement server-defined PTB templates and simulation
    - Implement `buildActionPtb` from fixed server-defined templates only (rejecting arbitrary PTB structure from user input), composing the optional price-feed update and the `execute_guardian_action` call, plus `simulate` (dry-run)
    - _Requirements: 9.2, 9.3, 16.4, 16.5_

  - [x] 11.2 Write property test for server-defined PTB templates
    - **Property 27: Server-defined PTB templates only** — PTB always built from a template; arbitrary user-supplied PTB structure rejected
    - **Validates: Requirements 16.4**

  - [x] 11.3 Write property test for simulate-before-submit
    - **Property 28: Simulate-before-submit** — simulation precedes submission; failed simulation prevents submission
    - **Validates: Requirements 16.5, 17.3**

  - [x] 11.4 Implement the full network-gated execution flow with evidence-before-PTB ordering
    - Orchestrate `execute`: verify network, generate + upload evidence first (no action PTB built/submitted if upload fails; mark pending/retrying), build/simulate/submit the PTB, then link evidence to the ActionLog; surface failed transactions and record no successful action on policy-validation failure
    - _Requirements: 9.1, 9.2, 9.5, 9.6, 9.7, 16.5, 16.6, 17.1, 17.2, 17.3_

  - [x] 11.5 Write property test for evidence-before-PTB ordering
    - **Property 7: Evidence-before-PTB ordering** — evidence uploaded (blob id + hash) before PTB build; on upload failure no PTB built/submitted and evidence marked pending/retrying
    - **Validates: Requirements 9.1, 9.2, 9.6**

  - [x] 11.6 Implement action priority ordering
    - When multiple actions are recommended for a market, select the highest-priority first with pause-new-borrows as priority zero, then reduce max LTV, enter guarded mode, increase maintenance margin
    - _Requirements: 7.1, 7.2, 7.10_

  - [x] 11.7 Write property test for action priority ordering
    - **Property 15: Action priority ordering** — highest-priority action selected first, pause-new-borrows priority zero
    - **Validates: Requirements 7.10, 7.1, 7.2**

- [x] 12. Implement the Protocol State Indexer
  - [x] 12.1 Implement event subscription, persistence, and restart recovery
    - Subscribe to `sentinel_policy`/`sentinel_demo_market` events, persist ActionLogs/events, flip linked evidence status, and recover indexing from on-chain transaction digests after restart from the last persisted checkpoint
    - _Requirements: 3.7, 17.6, 17.7, 17.8_

  - [x] 12.2 Write integration test for indexer reconciliation after restart
    - **Property 29: Indexer reconciles to chain state after restart** — persisted action records match the on-chain ActionLog set (small fixed seeded action set)
    - **Validates: Requirements 17.6**

- [x] 13. Implement the API Gateway, REST endpoints, WebSocket server, and Incident Service
  - [x] 13.1 Implement REST read endpoints
    - Implement `GET /api/markets`, `/api/markets/:id`, `/api/markets/:id/risk`, `/api/incidents/:id`, `/api/actions/:id` with role resolution
    - _Requirements: 15.1, 3.2, 3.3, 3.5, 3.6_

  - [x] 13.2 Implement REST action endpoints with validation and rate limiting
    - Implement `POST /api/policies/draft`, `/api/policies/simulate`, `/api/actions/recommend`, `/api/actions/execute`, `/api/evidence/upload`, `/api/simulator/start`, `/api/simulator/reset` with input validation (descriptive errors), range-validation of policy bounds, and a configurable rate limiter
    - _Requirements: 15.2, 15.4, 15.5, 4.9_

  - [x] 13.3 Write property test for input validation and rate limiting
    - **Property 30: Invalid API input is rejected; rate limit enforced** — invalid input rejected with descriptive error; excess requests over the configured limit rejected
    - **Validates: Requirements 15.4, 15.5**

  - [x] 13.4 Implement the WebSocket server and message types
    - Implement subscribe/unsubscribe and push of `risk_update`, `action_executed`, `guardian_revoked`, `override_applied`, `stale_data`, and `env_check_failed` messages to subscribed dashboards
    - _Requirements: 3.7, 12.2, 17.5_

  - [x] 13.5 Implement the Incident Service
    - Assemble incident timelines from `risk_snapshots`, `actions`, and events for replay, including before/after parameters and simulation markers
    - _Requirements: 13.1, 13.2, 13.3, 13.4, 13.5, 13.6_

- [x] 14. Checkpoint - backend API surface complete
  - Ensure all tests pass, ask the user if questions arise.

- [x] 15. Implement frontend wallet connection and network enforcement
  - [x] 15.1 Implement the Sui dApp Kit wallet connection and `useSuiWallet` hook
    - Implement the wallet adapter connection flow exposing `{ address, network, connected, signAndExecute }`; display connected address and detected network; clear address and disable signing on disconnect
    - _Requirements: 2.1, 2.2, 2.5_

  - [x] 15.2 Implement the network badge and wrong-network gating
    - Show a Sui Testnet status indicator when connected to testnet; on a non-testnet wallet, block signing and display "Sentinel is running on Sui Testnet for the hackathon demo. Please switch your wallet to Sui Testnet." and disable signing controls; block display of any tx digest not verified as testnet
    - _Requirements: 1.5, 1.9, 2.3, 2.4_

  - [x] 15.3 Write interaction tests for wallet and network gating
    - Assert connect/disconnect states and that wrong-network gating disables signing controls
    - _Requirements: 2.4, 2.5, 1.5_

- [x] 16. Implement the Risk Operations Dashboard
  - [x] 16.1 Implement the dashboard page and live WebSocket client
    - Render the testnet badge, market list with status set {Normal, Warning, Guarded, Paused, Revoked}, risk score gauge, risk trend + oracle price charts, indicator panel (freshness/confidence/volatility/liquidity/exposure), the "Why did this happen?" panel (AI explanation + deterministic rule outputs), and a stale badge; subscribe over WebSocket for live updates
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.7, 3.8, 3.9_

  - [x] 16.2 Implement the single-market detail page
    - Render market header, parameters card, last action card (tx digest, blob id, override status), and risk trend chart
    - _Requirements: 3.3, 3.4, 3.5, 3.6_

  - [x] 16.3 Write component tests for the dashboard and stale badge
    - Assert market status rendering, indicator panel, why-panel content, and stale-state display
    - _Requirements: 3.2, 3.8, 3.9_

- [x] 17. Implement the onboarding and policy configuration wizard
  - [x] 17.1 Implement the wizard steps, validation, review, and sign-to-deploy
    - Implement market-type selection, demo-market select/create, feed mapping, thresholds/bounds (max LTV delta bps, margin delta bps, pause duration, cooldown), DAO override address, a review step, and signing that submits the policy-deployment PTB; require a connected testnet wallet and block submission while identifying any missing or out-of-range value; persist the policy record and display the resulting tx digest on success
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7, 4.8, 4.9, 4.10_

  - [x] 17.2 Write property/interaction test for wizard validation
    - **Property 26: Wizard rejects invalid configuration** — missing required value or out-of-range value blocks submission and identifies the invalid value
    - **Validates: Requirements 4.9**

- [x] 18. Implement the Simulation Lab
  - [x] 18.1 Implement the backend simulation scenarios and endpoints
    - Register exactly nine scenarios (SUI flash crash, stablecoin depeg, oracle staleness, oracle divergence, liquidity collapse, liquidation cascade, high utilization spike, false-positive recovery, guardian revoked); feed scenario inputs to the Risk Engine; trigger a real testnet action + Walrus evidence when a threshold is crossed and a valid non-revoked/non-expired GuardianCap authorizes it; block the action when the guardian is revoked/expired; reset the demo market + inputs; retain scenario state and report no success on action/evidence failure
    - _Requirements: 14.1, 14.2, 14.3, 14.4, 14.5, 14.8, 14.9_

  - [x] 18.2 Implement the simulator frontend with data-source labeling
    - Render the scenario picker, runner, and override controls; label each data element with exactly one of {live oracle data, simulated scenario data, real testnet transaction, Walrus evidence}; update score within 2 seconds of each input step
    - _Requirements: 14.2, 14.4, 14.6, 14.7_

  - [x] 18.3 Write component test for simulation data labeling
    - **Property 23: Simulated data is never labeled as live** — each element carries exactly one label; simulated data never labeled live oracle data
    - **Validates: Requirements 14.6, 14.7**

  - [x] 18.4 Write smoke test for scenario registration
    - Assert exactly nine simulator scenarios are registered
    - _Requirements: 14.1_

- [x] 19. Implement the Override Console and guardian revocation
  - [x] 19.1 Implement override/reverse/revoke backend wiring with override reason in evidence
    - Wire `/api/actions/execute` override paths to `override_action`/`reverse_action`/`revoke_guardian`/`update_thresholds`/`unpause_market`, require an override reason, include it in the evidence and ActionLog, and record a new ActionLog marking the original action reversed
    - _Requirements: 11.4, 11.5, 11.6, 12.1_

  - [x] 19.2 Write property test for override reason recording
    - **Property 32: Override reason is required and recorded in evidence** — override requires a reason that appears in the resulting evidence and ActionLog
    - **Validates: Requirements 11.6, 11.4**

  - [x] 19.3 Implement the Override Console UI
    - Render active actions, paused markets, relevant policy, risk score at action time, linked Walrus evidence, and the OverrideCap holder address; preview reversal changes before signing; provide confirm/revoke/update-thresholds/unpause/restore controls; display the resulting tx digest
    - _Requirements: 11.1, 11.2, 11.3, 11.5, 11.7_

  - [x] 19.4 Implement guardian revocation end-to-end wiring
    - On revocation confirmation, update the dashboard market guardian status to Revoked within 5 seconds via WebSocket, block future autonomous actions, and display "Guardian capability has been revoked." when an action is rejected due to revocation
    - _Requirements: 11.8, 12.2, 12.3, 12.4_

- [x] 20. Implement the Incident Replay page
  - [x] 20.1 Implement the incident timeline UI
    - Render the condition/score-movement timeline, per-step AI explanations, action points with tx digest + Walrus blob id, override and revocation events, before/after parameters, and a simulation marker where applicable
    - _Requirements: 13.1, 13.2, 13.3, 13.4, 13.5, 13.6_

  - [x] 20.2 Write component tests for incident replay
    - Assert timeline assembly, action-point digest/blob rendering, before/after params, and simulation marker
    - _Requirements: 13.1, 13.3, 13.5, 13.6_

- [x] 21. Final integration and end-to-end wiring
  - [x] 21.1 Wire the full risk-control loop end-to-end across services
    - Connect workers → Risk Engine → Action Executor → Evidence Service → on-chain policy → indexer → WebSocket → frontend so a threshold crossing produces an autonomous testnet action, on-chain ActionLog/event, Walrus evidence, and a live dashboard update with no orphaned components
    - _Requirements: 3.7, 9.4, 9.5, 17.7, 17.8_

  - [x] 21.2 Write the end-to-end demo rehearsal test
    - Scripted testnet rehearsal: deploy policy via wizard → run a scenario → observe autonomous pause-new-borrows PTB → verify on-chain ActionLog + `RiskActionExecuted` event + Walrus Blob_ID + tx digest → perform a DAO reverse → revoke the guardian and confirm a subsequent action is rejected on-chain
    - _Requirements: 1.6, 7.1, 9.4, 12.3, 14.3_

- [x] 22. Final checkpoint - end-to-end demo path verified
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional test sub-tasks and can be skipped for a faster MVP; core implementation tasks are never optional.
- Each correctness property from the design maps to exactly one property-based test sub-task, tagged `// Feature: sentinel-risk-guardian, Property {number}: ...`. fast-check property tests run a minimum of 100 iterations; on-chain properties use the Move test scenario framework with a mocked `Clock`.
- Tasks reference specific requirement sub-clauses for traceability; checkpoints provide incremental validation at layer boundaries.
- The sequence front-loads the P0 demo path: on-chain objects and network enforcement first, then the risk/evidence/action loop, then the frontend surfaces, then end-to-end wiring.
- Do NOT implement PBT generators from scratch — use fast-check arbitraries (`FeatureVector`, `PolicyConfig`/`ActionRequest`, `CapabilityState`, `EvidenceBundle`, `ActionSet`) and the Move test scenario framework.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2", "1.3", "1.4"] },
    { "id": 2, "tasks": ["2.1", "3.1", "5.1", "5.3"] },
    { "id": 3, "tasks": ["2.2", "3.2", "5.2"] },
    { "id": 4, "tasks": ["3.3", "6.1"] },
    { "id": 5, "tasks": ["3.4", "6.2", "6.3", "7.1", "8.1", "8.2"] },
    { "id": 6, "tasks": ["2.3", "3.5", "3.6", "3.7", "3.8", "3.9", "3.10", "3.11", "7.2", "7.3", "7.4", "7.5", "7.7", "7.10", "8.3", "9.1"] },
    { "id": 7, "tasks": ["3.12", "7.6", "7.8", "7.9", "7.11", "9.2", "9.3"] },
    { "id": 8, "tasks": ["9.4", "9.5", "9.6", "11.1", "12.1"] },
    { "id": 9, "tasks": ["9.7", "9.8", "9.9", "11.2", "11.3", "11.4", "11.6", "12.2"] },
    { "id": 10, "tasks": ["11.5", "11.7", "13.1", "13.2", "13.5"] },
    { "id": 11, "tasks": ["13.3", "13.4", "15.1"] },
    { "id": 12, "tasks": ["15.2", "16.1", "17.1", "18.1", "19.1"] },
    { "id": 13, "tasks": ["15.3", "16.2", "17.2", "18.2", "19.2", "19.3", "20.1"] },
    { "id": 14, "tasks": ["16.3", "18.3", "18.4", "19.4", "20.2", "21.1"] },
    { "id": 15, "tasks": ["21.2"] }
  ]
}
```
