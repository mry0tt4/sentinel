# Requirements Document

## Introduction

Sentinel is a full-stack web application that monitors risk for Sui DeFi markets in real time, computes an AI-assisted risk score (0-100), and autonomously executes bounded on-chain safety actions through a Sui Move policy object. The system implements a closed risk-control loop: an AI risk engine detects and explains risk, a Sui Move policy object defines and enforces what the AI agent is permitted to do, Programmable Transaction Blocks (PTBs) execute approved actions as real Sui Testnet transactions, on-chain capability objects enforce limits, expiry, revocation, cooldowns, and DAO override, Walrus Testnet stores durable evidence bundles, and human governors can reverse, confirm, or revoke autonomous control.

The guiding thesis is: AI makes risk monitoring faster; Sui makes autonomous AI safer; Walrus makes the AI accountable. The AI never directly controls the protocol — the Move policy object is the sole authority that grants and bounds agent permissions.

This document specifies requirements for the P0 (must-have) feature set and supporting modules required for the Sui Overflow 2026 hackathon submission. All judge-facing execution targets Sui Testnet only, and all evidence is stored on Walrus Testnet only. Mainnet is disabled for the submission.

## Glossary

- **Sentinel**: The complete full-stack application comprising the frontend, backend services, AI risk engine, and on-chain Move packages.
- **Frontend**: The Astro-based web client that renders the dashboard, onboarding wizard, override console, incident replay, and simulation lab.
- **Backend**: The Node.js + Express + TypeScript service layer, including HTTP APIs, background workers, and the WebSocket server.
- **Risk_Engine**: The AI subsystem that ingests market data, computes a risk score, classifies risk, recommends an action, estimates confidence, and produces a plain-language explanation.
- **Action_Engine**: The backend subsystem that builds and submits PTBs to execute bounded on-chain safety actions.
- **Network_Guard**: The component that enforces Sui Testnet-only operation across wallet, RPC, package, and transaction layers.
- **Risk_Policy**: The on-chain Move object (RiskPolicy) that stores policy configuration and enforces agent permission, scope, bounds, cooldown, expiry, and revocation.
- **Guardian_Cap**: The on-chain Move capability object (GuardianCap) granting a specific agent address bounded authority to act on specific markets and action types until expiry or revocation.
- **Override_Cap**: The on-chain Move capability object (OverrideCap) granting a DAO/governor address authority to reverse actions, revoke the agent, update thresholds, and unpause markets.
- **Action_Log**: The on-chain Move object (ActionLog) recording each executed or reversed action with risk score, values, evidence blob ID, evidence hash, transaction digest, and reversal metadata.
- **Demo_Market**: The on-chain Move package (sentinel_demo_market) providing a controllable simulated lending market with collateral/borrow config, max LTV, maintenance margin, pause flag, and guarded-mode flag.
- **Policy_Package**: The on-chain Move package (sentinel_policy) defining Risk_Policy, Guardian_Cap, Override_Cap, Action_Log, their functions, and events.
- **Evidence_Vault**: The Walrus Testnet storage subsystem that stores evidence bundles and tracks their upload/link status.
- **Evidence_Bundle**: The structured JSON record capturing the inputs, model versions, feature vector, score, classification, recommended/executed action, explanation, signer, and transaction digest for a single risk evaluation or action.
- **Oracle_Adapter**: The component that reads testnet price feeds (Pyth or a configurable adapter) including price, confidence, and timestamp.
- **Simulation_Lab**: The subsystem that runs predefined risk scenarios against the Demo_Market and clearly distinguishes live, simulated, and on-chain data.
- **Override_Console**: The frontend and backend subsystem enabling human governors to reverse, confirm, revoke, update thresholds, and unpause.
- **Dashboard**: The Risk Operations Dashboard frontend view presenting market health, risk scores, parameters, last action, and evidence references.
- **DAO_Governor**: A user role representing DAO governors or multisig signers holding an Override_Cap.
- **Protocol_Admin**: A user role representing protocol risk teams who create and configure policies.
- **Risk_Score**: An integer from 0 to 100 produced by the Risk_Engine, partitioned into bands: 0-39 Normal, 40-59 Warning, 60-74 Guarded recommended, 75-89 parameter adjustment recommended, 90-100 emergency pause recommended.
- **PTB**: A Sui Programmable Transaction Block used to compose and execute on-chain actions.
- **Tx_Digest**: The Sui transaction digest returned after a transaction is executed on Sui Testnet.
- **Blob_ID**: The Walrus identifier for a stored evidence bundle.
- **Bps**: Basis points (1 bp = 0.01%), used to express max LTV and margin deltas.
- **Fail_Closed**: The reliability principle that the system blocks execution rather than acting under uncertainty or failure.

## Requirements

### Requirement 1: Environment and Network Enforcement

**User Story:** As a Protocol_Admin, I want Sentinel to operate exclusively on Sui Testnet and Walrus Testnet, so that no real funds are at risk and all judge-facing execution is verifiable on testnet.

#### Acceptance Criteria

1. THE Network_Guard SHALL configure all Sui RPC connections to a Sui Testnet endpoint.
2. THE Network_Guard SHALL configure all evidence storage connections to a Walrus Testnet endpoint.
3. IF a configured Sui RPC endpoint reports a chain identifier that does not match the known Sui Testnet chain identifier, THEN THE Network_Guard SHALL reject the configuration, prevent Backend startup with no partial initialization, and return a startup error indicating a network mismatch.
4. IF a configured Sui RPC endpoint is unreachable or its chain identifier cannot be verified within 10 seconds, THEN THE Network_Guard SHALL prevent Backend startup with no partial initialization and return a startup error indicating the endpoint could not be verified.
5. IF a connected wallet reports a network other than Sui Testnet, THEN THE Frontend SHALL block transaction signing and display the message "Sentinel is running on Sui Testnet for the hackathon demo. Please switch your wallet to Sui Testnet."
6. WHEN the Action_Engine prepares to submit a transaction, THE Network_Guard SHALL verify that the target package ID and RPC chain identifier match Sui Testnet before submission.
7. IF a transaction target does not match Sui Testnet, THEN THE Action_Engine SHALL refuse to submit the transaction with no partial submission and record an environment check failure.
8. WHEN a Tx_Digest is retrieved for display, THE Network_Guard SHALL verify the transaction originates from Sui Testnet before the Frontend displays it.
9. IF a Tx_Digest cannot be verified as originating from Sui Testnet, THEN THE Frontend SHALL block display of the transaction and return a verification error.
10. THE Network_Guard SHALL record each environment verification result in the environment_checks store with an ISO 8601 UTC timestamp, the verification type, and a pass or fail outcome.

### Requirement 2: Sui Testnet Wallet Connection

**User Story:** As a DeFi User, I want to connect a Sui Testnet wallet, so that I can interact with Sentinel and authorize transactions.

#### Acceptance Criteria

1. WHEN a user initiates wallet connection, THE Frontend SHALL present a Sui dApp Kit wallet adapter connection flow.
2. WHEN a wallet connects successfully, THE Frontend SHALL display the connected wallet address and the detected wallet network.
3. WHILE a wallet is connected to Sui Testnet, THE Frontend SHALL display a Sui Testnet status indicator.
4. IF a wallet is connected to a network other than Sui Testnet, THEN THE Frontend SHALL display a wrong-network warning and disable signing controls.
5. WHEN a user disconnects the wallet, THE Frontend SHALL clear the displayed wallet address and disable signing controls.

### Requirement 3: Risk Operations Dashboard

**User Story:** As a Protocol_Admin, I want a real-time risk operations dashboard, so that I can monitor market health, risk scores, parameters, and recent autonomous actions.

#### Acceptance Criteria

1. THE Dashboard SHALL display a Sui Testnet badge and the connected wallet network status.
2. THE Dashboard SHALL display a list of monitored markets with each market's current status from the set {Normal, Warning, Guarded, Paused, Revoked}.
3. WHEN a market is selected, THE Dashboard SHALL display the market's current Risk_Score as an integer from 0 to 100.
4. WHEN a market is selected, THE Dashboard SHALL display a Risk_Score trend chart and an oracle price chart for that market.
5. WHEN a market is selected, THE Dashboard SHALL display oracle freshness, oracle confidence, volatility, liquidity, and exposure indicators for that market.
6. WHEN a market is selected, THE Dashboard SHALL display the market's current parameters, last executed action, last Tx_Digest, last Walrus Blob_ID, and DAO override status.
7. WHEN new risk data is computed for a displayed market, THE Backend SHALL push the updated data to the Frontend over the WebSocket server.
8. WHEN a user opens the "Why did this happen?" panel for a market, THE Dashboard SHALL display the most recent AI explanation and the deterministic rule outputs for that market.
9. IF the most recent risk data for a market is older than its configured freshness threshold, THEN THE Dashboard SHALL display the data as stale.

### Requirement 4: Protocol Onboarding and Policy Configuration Wizard

**User Story:** As a Protocol_Admin, I want a guided onboarding wizard, so that I can configure and deploy a Risk_Policy with bounded agent permissions for a market.

#### Acceptance Criteria

1. WHEN a Protocol_Admin starts onboarding, THE Frontend SHALL require a connected Sui Testnet wallet and confirm the wallet network before proceeding.
2. THE Frontend SHALL allow the Protocol_Admin to choose a market type from the set {lending, perps, stablecoin, demo}.
3. THE Frontend SHALL allow the Protocol_Admin to select an existing Demo_Market or create a new Demo_Market.
4. THE Frontend SHALL allow the Protocol_Admin to map market assets to Sui Testnet price feeds.
5. THE Frontend SHALL allow the Protocol_Admin to configure risk thresholds, select allowed action types, and set action bounds including max LTV delta in Bps, max margin delta in Bps, pause duration limit, and cooldown.
6. THE Frontend SHALL allow the Protocol_Admin to set a DAO override address.
7. WHEN the Protocol_Admin reaches the review step, THE Frontend SHALL display all configured values for confirmation before signing.
8. WHEN the Protocol_Admin signs the deployment transaction, THE Action_Engine SHALL submit a PTB to create or update the Risk_Policy on Sui Testnet.
9. IF any required configuration value is missing or outside its allowed range, THEN THE Frontend SHALL block submission and identify the invalid value.
10. WHEN policy deployment succeeds, THE Backend SHALL persist the policy record and display the resulting Tx_Digest.

### Requirement 5: Sui Testnet Demo Market

**User Story:** As a Sui Builder, I want a controllable on-chain demo market, so that I can exercise risk scenarios and autonomous actions on Sui Testnet.

#### Acceptance Criteria

1. THE Demo_Market SHALL provide an initialization function that creates market state with collateral configuration, borrow configuration, max LTV, maintenance margin, a borrow pause flag, and a guarded mode flag.
2. THE Demo_Market SHALL expose read-only functions returning current market state including simulated utilization and exposure.
3. WHEN a policy-controlled update for an approved action is invoked, THE Demo_Market SHALL apply the corresponding state change to pause borrows, unpause borrows, reduce max LTV, restore max LTV, enter guarded mode, or exit guarded mode.
4. IF a state-changing call is not authorized by the Risk_Policy or by the admin, THEN THE Demo_Market SHALL reject the call.
5. WHEN the admin invokes the reset function, THE Demo_Market SHALL restore market state to its initialized values.
6. IF a reset is requested by an actor other than the admin, THEN THE Demo_Market SHALL reject the reset.

### Requirement 6: AI Risk Engine

**User Story:** As a Protocol_Admin, I want an AI risk engine that scores, classifies, and explains risk, so that I receive a faster and accountable risk assessment for each market.

#### Acceptance Criteria

1. THE Risk_Engine SHALL accept as inputs oracle price, oracle confidence, oracle timestamp, 1-minute, 5-minute, and 15-minute price changes, realized volatility, liquidity depth, spread, imbalance, utilization, exposure, current max LTV, borrow status, guarded status, policy state, guardian revocation state, prior actions, prior overrides, and historical Walrus evidence references.
2. WHEN the Risk_Engine evaluates a market, THE Risk_Engine SHALL compute a Risk_Score as an integer from 0 to 100 within 5 seconds of receiving complete input data.
3. WHEN the Risk_Engine computes a Risk_Score, THE Risk_Engine SHALL assign exactly one status band where 0-39 maps to Normal, 40-59 maps to Warning, 60-74 maps to Guarded recommended, 75-89 maps to parameter adjustment recommended, and 90-100 maps to emergency pause recommended.
4. WHEN the Risk_Engine evaluates a market, THE Risk_Engine SHALL classify the risk into one or more classes from the set {flash crash, oracle staleness, oracle divergence, stablecoin depeg, liquidity collapse, liquidation cascade, high utilization, governance override, guardian revocation, data integrity}.
5. WHEN the Risk_Engine completes an evaluation, THE Risk_Engine SHALL produce a recommended action, a confidence estimate as an integer from 0 to 100, and a plain-language explanation of at most 1000 characters.
6. WHEN the Risk_Engine completes an evaluation, THE Risk_Engine SHALL generate an Evidence_Bundle and request its storage on the Evidence_Vault.
7. IF oracle price, oracle confidence, or oracle timestamp is absent or unparseable, THEN THE Risk_Engine SHALL refuse to recommend an action and record the refusal reason.
8. IF the active network is not Sui Testnet, THEN THE Risk_Engine SHALL refuse to recommend an action and record the refusal reason.
9. IF the Guardian_Cap for the market is revoked, THEN THE Risk_Engine SHALL refuse to recommend an autonomous action and record the refusal reason.
10. IF a recommended action would exceed the Risk_Policy bounds, THEN THE Risk_Engine SHALL refuse to recommend that action and record the refusal reason.
11. THE Risk_Engine SHALL evaluate critical risk thresholds using deterministic rules rather than the language model.
12. THE Risk_Engine SHALL record the risk model version, the prompt and configuration version, and the feature vector for each evaluation.
13. WHERE the language model is used, THE Risk_Engine SHALL limit the language model to producing explanations and SHALL NOT allow the language model to execute actions.
14. IF the oracle timestamp age exceeds the market's configured oracle freshness threshold and an emergency stale-data pause is permitted by policy, THEN THE Risk_Engine SHALL recommend an emergency pause and record the stale-data justification.

### Requirement 7: Autonomous On-Chain Action Engine

**User Story:** As a DAO_Governor, I want autonomous actions to be strictly bounded by the on-chain policy, so that the agent can mitigate risk without exceeding granted authority.

#### Acceptance Criteria

1. THE Action_Engine SHALL support an autonomous pause-new-borrows action as the priority-zero action.
2. THE Action_Engine SHALL support reduce max LTV, enter guarded mode, and increase maintenance margin as additional autonomous actions.
3. WHEN the Action_Engine executes an action, THE Action_Engine SHALL submit the action only against markets approved in the Risk_Policy.
4. WHEN the Action_Engine executes an action, THE Action_Engine SHALL submit only action types approved in the Risk_Policy.
5. IF a max LTV reduction exceeds the policy max_ltv_delta_bps cap, THEN THE Risk_Policy SHALL reject the action, apply no market state change, and surface the failed transaction.
6. IF a pause duration exceeds the policy pause_duration_limit_ms, THEN THE Risk_Policy SHALL reject the action, apply no market state change, and surface the failed transaction.
7. IF the agent attempts to transfer funds, change the admin, remove the Override_Cap, or update the Risk_Policy itself, THEN THE Risk_Policy SHALL reject the action and apply no state change.
8. IF the Guardian_Cap is expired, revoked, the elapsed time since last_action_timestamp_ms is less than cooldown_ms, or the network is not Sui Testnet, THEN THE Risk_Policy SHALL reject the action and apply no market state change.
9. IF a maintenance margin increase exceeds the policy max_margin_delta_bps cap, THEN THE Risk_Policy SHALL reject the action, apply no market state change, and surface the failed transaction.
10. WHEN multiple autonomous actions are recommended for the same market, THE Action_Engine SHALL execute the highest-priority action first, with pause-new-borrows as priority zero.

### Requirement 8: Move Policy Object and Capabilities

**User Story:** As a Sui Builder, I want on-chain policy and capability objects that enforce permissions, so that autonomous authority is granted, bounded, logged, and revocable on-chain.

#### Acceptance Criteria

1. THE Policy_Package SHALL define a Risk_Policy object containing id, market_id, market_type, owner, dao_override_cap_id, guardian_cap_id, allowed_actions, max_ltv_delta_bps, max_margin_delta_bps, pause_duration_limit_ms, risk_thresholds, cooldown_ms, last_action_timestamp_ms, is_revoked, is_paused, version, walrus_config_blob_id, and created_at_ms.
2. THE Policy_Package SHALL define a Guardian_Cap object containing id, policy_id, agent_address, expires_at_ms, allowed_markets, allowed_actions, and revoked.
3. THE Policy_Package SHALL define an Override_Cap object containing id, policy_id, dao_address, can_reverse_action, can_revoke_agent, can_update_thresholds, and can_unpause_market.
4. THE Policy_Package SHALL define an Action_Log object containing id, policy_id, market_id, actor, actor_type, risk_score, action_type, old_value, new_value, walrus_evidence_blob_id, evidence_hash, tx_digest, timestamp_ms, reversed_by, reversal_tx_digest, and is_reversed.
5. THE Policy_Package SHALL provide the functions create_policy, create_guardian_cap, create_override_cap, revoke_guardian, update_thresholds, execute_guardian_action, pause_market, unpause_market, adjust_ltv, restore_ltv, enter_guarded_mode, exit_guarded_mode, log_action, override_action, confirm_action, and reverse_action.
6. WHEN an autonomous action is executed, THE Policy_Package SHALL emit a RiskActionExecuted event.
7. WHEN an action is overridden, THE Policy_Package SHALL emit a RiskActionOverridden event.
8. WHEN a guardian is revoked, THE Policy_Package SHALL emit a GuardianRevoked event.
9. WHEN policy thresholds or configuration are updated, THE Policy_Package SHALL emit a PolicyUpdated event.
10. WHEN execute_guardian_action is called, THE Policy_Package SHALL verify the Guardian_Cap has revoked equal to false, expires_at_ms greater than the transaction timestamp, the target market present in allowed_markets, the action type present in allowed_actions, and the elapsed time since last_action_timestamp_ms at least cooldown_ms, before applying any change.
11. IF execute_guardian_action is called with a Guardian_Cap that is revoked, expired, or within cooldown, THEN THE Policy_Package SHALL abort the transaction, apply no state change, and surface the abort.
12. IF an action would exceed max_ltv_delta_bps, max_margin_delta_bps, or pause_duration_limit_ms, THEN THE Policy_Package SHALL abort the transaction and apply no state change.
13. WHEN override_action, reverse_action, revoke_guardian, update_thresholds, or unpause_market is called, THE Policy_Package SHALL verify the caller holds a valid Override_Cap for the Risk_Policy before applying any change, and SHALL abort with no state change otherwise.
14. WHEN execute_guardian_action succeeds, THE Policy_Package SHALL set last_action_timestamp_ms to the transaction timestamp and record an Action_Log entry.

### Requirement 9: PTB Execution Flow

**User Story:** As a Protocol_Admin, I want each autonomous action executed through a validated PTB, so that data, evidence, and on-chain enforcement are bound into a single auditable transaction flow.

#### Acceptance Criteria

1. WHEN a risk evaluation crosses an action threshold, THE Action_Engine SHALL generate an Evidence_Bundle and upload it to the Evidence_Vault before building the action PTB.
2. WHEN the Evidence_Vault returns a Blob_ID and evidence hash, THE Action_Engine SHALL build a PTB that includes the policy validation call and the bounded action call.
3. WHERE the oracle price feed requires an update, THE Action_Engine SHALL include the price feed update in the PTB.
4. WHEN the PTB executes successfully, THE Policy_Package SHALL emit the corresponding action event and record an Action_Log entry with the Blob_ID, evidence hash, and Tx_Digest.
5. WHEN the PTB execution completes, THE Backend SHALL receive the Tx_Digest and update the Dashboard.
6. IF evidence upload fails, THEN THE Action_Engine SHALL not build or submit the action PTB and SHALL mark the evidence as pending for retry.
7. IF policy validation within the PTB fails, THEN THE Action_Engine SHALL surface the failed transaction and SHALL NOT record a successful action.

### Requirement 10: Walrus Testnet Evidence Vault

**User Story:** As a DAO_Governor, I want durable, linkable evidence for every action, so that autonomous decisions are accountable and auditable.

#### Acceptance Criteria

1. WHEN the Risk_Engine generates an Evidence_Bundle, THE Evidence_Bundle SHALL include market and policy identifiers, timestamp, prices, oracle confidence and freshness, liquidity and exposure snapshots, risk model version, prompt and configuration version, feature vector, risk score and class, recommended and executed action, AI explanation, deterministic rule outputs, agent signer, transaction digest, prior action identifiers, simulation scenario identifier, and a raw data hash.
2. WHEN an Evidence_Bundle is ready for storage, THE Evidence_Vault SHALL upload it to Walrus Testnet as a JSON document within 30 seconds of the upload being initiated.
3. WHEN an Evidence_Bundle is uploaded, THE Evidence_Vault SHALL assign it exactly one status from the set {pending_upload, uploaded, linked_on_chain, failed_upload, retrying, private_encrypted}.
4. WHEN an Evidence_Bundle is linked to an Action_Log, THE Evidence_Vault SHALL store the Blob_ID in the database, record the evidence hash on-chain, and set the status to linked_on_chain.
5. IF recording the evidence hash on-chain fails during linking, THEN THE Evidence_Vault SHALL retain the stored Blob_ID, set the status to failed_upload, and return an error indication that on-chain linking did not complete.
6. IF an evidence upload fails, THEN THE Evidence_Vault SHALL set the status to retrying and retry the upload up to a maximum of 5 attempts, with an interval of at least 5 seconds between attempts.
7. IF all 5 upload retry attempts fail, THEN THE Evidence_Vault SHALL set the status to failed_upload, preserve the unuploaded Evidence_Bundle for later reprocessing, and return an error indication that the upload was not completed.
8. THE Evidence_Vault SHALL exclude secrets and private keys from any Evidence_Bundle with status uploaded, linked_on_chain, or pending_upload.
9. WHERE an Evidence_Bundle field is designated as sensitive configuration by the policy configuration, THE Evidence_Vault SHALL encrypt that field before storage and set the status to private_encrypted.
10. IF a request attempts to modify or delete an Evidence_Bundle whose status is linked_on_chain, THEN THE Evidence_Vault SHALL reject the request, leave the stored Evidence_Bundle and recorded evidence hash unchanged, and return an error indication that linked evidence is immutable.

### Requirement 11: Human Override Console

**User Story:** As a DAO_Governor, I want a console to reverse, confirm, and adjust autonomous actions, so that humans retain authority over the agent.

#### Acceptance Criteria

1. THE Override_Console SHALL display active actions, paused markets, the relevant policy, the Risk_Score at the time of each action, and the linked Walrus evidence.
2. THE Override_Console SHALL display which wallet address holds the Override_Cap authority.
3. WHEN a DAO_Governor selects an action to reverse, THE Override_Console SHALL preview the resulting changes before signing.
4. WHEN a DAO_Governor signs a reversal, THE Action_Engine SHALL submit an override transaction and THE Policy_Package SHALL record a new Action_Log entry marking the original action reversed.
5. THE Override_Console SHALL allow a DAO_Governor to confirm an action, revoke the guardian, update thresholds, unpause a market, and restore a parameter.
6. WHEN a DAO_Governor performs an override operation, THE Override_Console SHALL require an override reason and include it in the evidence.
7. WHEN an override transaction completes, THE Override_Console SHALL display the resulting Tx_Digest.
8. WHEN a guardian is revoked through the Override_Console, THE Policy_Package SHALL immediately block future autonomous actions for that guardian.

### Requirement 12: Guardian Revocation

**User Story:** As a DAO_Governor, I want to revoke the agent's guardian capability on-chain, so that the agent is immediately and verifiably prevented from acting.

#### Acceptance Criteria

1. WHEN a DAO_Governor invokes revoke_guardian with an Override_Cap associated with the target Risk_Policy and having can_revoke_agent equal to true, THE Policy_Package SHALL set the Guardian_Cap revoked state to true and emit a GuardianRevoked event within the same transaction.
2. WHEN a guardian revocation transaction is confirmed, THE Dashboard SHALL display the market guardian status as Revoked within 5 seconds of confirmation.
3. IF the agent attempts execute_guardian_action after revocation, THEN THE Policy_Package SHALL reject the action, apply no market state change, and return a rejection error indication.
4. WHEN an autonomous action is rejected due to revocation, THE Frontend SHALL display the message "Guardian capability has been revoked."
5. IF revoke_guardian is invoked with an Override_Cap that is not associated with the target Risk_Policy or has can_revoke_agent equal to false, THEN THE Policy_Package SHALL abort the transaction and leave the Guardian_Cap revoked state unchanged.
6. IF revoke_guardian is invoked on a Guardian_Cap whose revoked state is already true, THEN THE Policy_Package SHALL leave the revoked state true and SHALL NOT emit a duplicate GuardianRevoked event.

### Requirement 13: Incident Replay

**User Story:** As a DeFi User, I want to replay an incident timeline, so that I can understand how risk evolved and what actions were taken.

#### Acceptance Criteria

1. WHEN a user opens an incident, THE Frontend SHALL display a timeline of market conditions and Risk_Score movement across the incident.
2. THE Frontend SHALL display the AI explanation for each step in the incident timeline.
3. THE Frontend SHALL display each action point with its Tx_Digest and linked Walrus Blob_ID.
4. WHERE an override or revocation occurred during the incident, THE Frontend SHALL display the override event and the revocation event on the timeline.
5. THE Frontend SHALL display before-and-after parameters for each action in the incident.
6. WHERE incident data originates from a simulation, THE Frontend SHALL display a simulation marker on the incident.

### Requirement 14: Simulation Lab

**User Story:** As a Sui Builder, I want a simulation lab with predefined risk scenarios, so that I can demonstrate autonomous risk responses on Sui Testnet.

#### Acceptance Criteria

1. THE Simulation_Lab SHALL provide exactly nine scenarios: SUI flash crash, stablecoin depeg, oracle staleness, oracle divergence, liquidity collapse, liquidation cascade, high utilization spike, false-positive recovery, and guardian revoked.
2. WHEN a user starts a scenario, THE Simulation_Lab SHALL feed scenario inputs to the Risk_Engine and display the resulting Risk_Score as an integer from 0 to 100, updating within 2 seconds of each input step.
3. WHEN a scenario crosses an action threshold and a valid, non-revoked, non-expired Guardian_Cap authorizes the action, THE Simulation_Lab SHALL trigger a real Sui Testnet action and store the resulting evidence on Walrus Testnet.
4. THE Simulation_Lab SHALL allow a human override and a guardian revocation on Sui Testnet during a scenario.
5. WHEN a user resets a scenario, THE Simulation_Lab SHALL restore the Demo_Market and scenario inputs to their initial state.
6. THE Simulation_Lab SHALL label each displayed data element with exactly one of live oracle data, simulated scenario data, real testnet transaction, or Walrus evidence.
7. THE Simulation_Lab SHALL NOT present simulated data as live oracle data.
8. IF a scenario crosses an action threshold while the Guardian_Cap is revoked or expired, THEN THE Simulation_Lab SHALL block the action and display an indication that the guardian is not authorized.
9. IF a real testnet action or Walrus evidence storage fails during a scenario, THEN THE Simulation_Lab SHALL not report a successful action and SHALL retain the scenario state.

### Requirement 15: Backend APIs and Data Persistence

**User Story:** As a Sui Builder, I want documented APIs and persistent records, so that the frontend, workers, and audit trail share consistent data.

#### Acceptance Criteria

1. THE Backend SHALL expose the read endpoints GET /api/markets, GET /api/markets/:id, GET /api/markets/:id/risk, GET /api/incidents/:id, and GET /api/actions/:id.
2. THE Backend SHALL expose the action endpoints POST /api/policies/draft, POST /api/policies/simulate, POST /api/actions/recommend, POST /api/actions/execute, POST /api/evidence/upload, POST /api/simulator/start, and POST /api/simulator/reset.
3. THE Backend SHALL persist relational records in the tables markets, policies, risk_snapshots, incidents, actions, walrus_blobs, and environment_checks.
4. WHEN the Backend receives a request with invalid input, THE Backend SHALL reject the request and return a descriptive error.
5. WHEN the Backend receives requests above its configured rate limit, THE Backend SHALL reject the excess requests.

### Requirement 16: Security and Agent Authority

**User Story:** As a Protocol_Admin, I want defense-in-depth security controls, so that autonomous authority cannot be misused or escalated.

#### Acceptance Criteria

1. THE Backend SHALL store agent signing keys outside the Frontend and SHALL NOT expose agent keys to the Frontend.
2. THE Backend SHALL operate the agent signer with least-privilege authority limited to approved actions.
3. THE Backend SHALL store secrets in environment variables and SHALL NOT store secrets in source code or public evidence.
4. THE Backend SHALL construct PTBs from server-defined templates and SHALL reject arbitrary PTB construction from user input.
5. WHEN an action is requested, THE Action_Engine SHALL simulate the transaction before submission.
6. IF a transaction fails, THEN THE Frontend SHALL display the failed transaction.
7. THE Policy_Package SHALL prevent the agent from removing the Override_Cap.
8. WHEN any action, reversal, or revocation occurs on-chain, THE Policy_Package SHALL emit a corresponding event.
9. THE Policy_Package SHALL include Move unit tests that verify permission boundaries including revocation, expiry, bounds, and cooldown.
10. WHERE a risk model or prompt version changes, THE Backend SHALL require admin approval before the new version is used.

### Requirement 17: Reliability and Fail-Closed Behavior

**User Story:** As a DAO_Governor, I want the system to fail closed under uncertainty, so that the agent never acts on bad data or during failures.

#### Acceptance Criteria

1. IF the connected wallet is not on Sui Testnet, THEN THE Action_Engine SHALL block execution.
2. IF the Risk_Engine fails to complete an evaluation, THEN THE Action_Engine SHALL NOT execute an action.
3. IF transaction simulation fails, THEN THE Action_Engine SHALL NOT submit the transaction.
4. IF a Walrus upload fails, THEN THE Evidence_Vault SHALL mark the evidence pending and retry.
5. WHILE risk data for a market is stale, THE Dashboard SHALL display the stale state to the user.
6. WHEN the Backend restarts after an outage, THE Backend SHALL recover event indexing from the on-chain transaction digests.
7. WHILE the Backend is unavailable, THE Policy_Package SHALL remain the authoritative source of policy and market state.
8. IF a Guardian_Cap is revoked, THEN THE Policy_Package SHALL fail the autonomous action on-chain regardless of Backend state.
