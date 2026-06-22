/// # sentinel_policy
///
/// The on-chain trust root, deployed to **Sui Testnet only**. The AI agent
/// never controls the protocol directly — this package is the sole authority
/// that grants and bounds agent permissions.
///
/// This module currently delivers the **object and event definitions** for the
/// policy package (task 3.1):
///   - structs: `RiskPolicy`, `GuardianCap`, `OverrideCap`, `ActionLog`.
///   - events: `RiskActionExecuted`, `RiskActionOverridden`, `GuardianRevoked`,
///     `PolicyUpdated`.
///   - actor-type code constants for `ActionLog.actor_type`.
///
/// The behavioral functions (`create_policy`, `create_guardian_cap`,
/// `create_override_cap`, `revoke_guardian`, `update_thresholds`,
/// `execute_guardian_action`, the market-control mutators, `log_action`,
/// `override_action`, `confirm_action`, `reverse_action`) are delivered in
/// tasks 3.2–3.4 and intentionally NOT implemented here.
///
/// Depends locally on `sentinel_demo_market` (market state mutated via an
/// authorization witness) and `sentinel_adapters` (the uniform `ActionTicket`
/// interface targeted by `execute_guardian_action`).
///
/// Requirements: 8.1, 8.2, 8.3, 8.4, 8.6, 8.7, 8.8, 8.9
module sentinel_policy::policy;

use sentinel_adapters::adapters;
use sentinel_demo_market::market::{Self, MarketState};
use sui::clock::Clock;
use sui::event;

// === Errors ===

/// Raised when `create_policy` is given a market-type code that is not one of
/// the supported `sentinel_adapters` `MARKET_TYPE_*` codes.
const EInvalidMarketType: u64 = 0;
/// Raised when an `allowed_actions` vector contains an action-type code that is
/// not one of the supported `sentinel_adapters` `ACTION_*` codes.
const EInvalidActionType: u64 = 1;
/// `execute_guardian_action` was called by an address other than the
/// `GuardianCap`'s `agent_address`. (Req 7.8)
const ENotAuthorizedAgent: u64 = 2;
/// The presented `GuardianCap` is scoped to a different `RiskPolicy`. (Req 8.2)
const ECapNotForPolicy: u64 = 3;
/// The `GuardianCap` (or its policy) has been revoked. (Req 7.8, 8.11, 12.3)
const ERevoked: u64 = 4;
/// The `GuardianCap` has expired (`expires_at_ms <= tx_timestamp_ms`). (Req 7.8, 8.11)
const EExpired: u64 = 5;
/// The target market is not present in the cap's `allowed_markets`. (Req 7.3)
const EMarketNotAllowed: u64 = 6;
/// The action type is not present in the cap's `allowed_actions`. (Req 7.4)
const EActionNotAllowed: u64 = 7;
/// Less than `cooldown_ms` has elapsed since `last_action_timestamp_ms`.
/// (Req 7.8, 8.11)
const ECooldownNotElapsed: u64 = 8;
/// A max-LTV reduction would exceed `max_ltv_delta_bps`. (Req 7.5, 8.12)
const ELtvDeltaExceeded: u64 = 9;
/// A maintenance-margin increase would exceed `max_margin_delta_bps`.
/// (Req 7.9, 8.12)
const EMarginDeltaExceeded: u64 = 10;
/// A pause duration would exceed `pause_duration_limit_ms`. (Req 7.6, 8.12)
const EPauseDurationExceeded: u64 = 11;
/// The requested action type is not supported by this adapter / market.
const EUnsupportedAction: u64 = 12;
/// A `reduce-ltv` action supplied a new value that is not a reduction
/// (`new_value > current max_ltv_bps`). (Req 7.5)
const EInvalidLtvReduction: u64 = 13;

// --- DAO / governor override errors (task 3.4) ---

/// The caller is not the `OverrideCap`'s `dao_address`. (Req 8.13, 12.5)
const ENotAuthorizedDao: u64 = 14;
/// The presented `OverrideCap` is scoped to a different `RiskPolicy`.
/// (Req 8.13, 12.5)
const EOverrideCapNotForPolicy: u64 = 15;
/// The `OverrideCap` lacks `can_reverse_action`. (Req 8.13)
const ECannotReverseAction: u64 = 16;
/// The `OverrideCap` lacks `can_revoke_agent`. (Req 12.5)
const ECannotRevokeAgent: u64 = 17;
/// The `OverrideCap` lacks `can_update_thresholds`. (Req 8.13)
const ECannotUpdateThresholds: u64 = 18;
/// The `OverrideCap` lacks `can_unpause_market`. (Req 8.13)
const ECannotUnpauseMarket: u64 = 19;
/// The presented `GuardianCap` is scoped to a different `RiskPolicy`. (Req 12.5)
const EGuardianCapNotForPolicy: u64 = 20;
/// The presented `ActionLog` is scoped to a different `RiskPolicy`. (Req 11.4)
const EActionLogNotForPolicy: u64 = 21;
/// The target `ActionLog` has already been reversed. (Req 11.4)
const EAlreadyReversed: u64 = 22;
/// The presented market does not match the policy's / action log's market.
/// (Req 11.4)
const EMarketMismatch: u64 = 23;
/// The original action has no inverse market mutation, so it cannot be
/// reversed on-chain. (Req 11.4)
const ENoInverseAction: u64 = 24;

// === Actor type codes ===
//
// Recorded in `ActionLog.actor_type` to identify who performed an action.

/// The autonomous agent acting under a `GuardianCap`.
const ACTOR_TYPE_AGENT: u8 = 0;
/// A DAO / governor acting under an `OverrideCap`.
const ACTOR_TYPE_DAO: u8 = 1;
/// The protocol admin / policy owner.
const ACTOR_TYPE_ADMIN: u8 = 2;

// === Objects ===

/// The policy object: the sole on-chain authority that grants and bounds agent
/// permissions for a single market. Stores the bounds, cooldown,
/// revocation/pause state, and references to the capability objects.
///
/// Req 8.1.
public struct RiskPolicy has key {
    id: UID,
    /// On-chain id of the market this policy governs.
    market_id: ID,
    /// Market-type code (see `sentinel_adapters::adapters` `MARKET_TYPE_*`).
    market_type: u8,
    /// The policy owner / protocol admin address.
    owner: address,
    /// Id of the `OverrideCap` granted to the DAO.
    dao_override_cap_id: ID,
    /// Id of the `GuardianCap` granted to the agent.
    guardian_cap_id: ID,
    /// Action-type codes the agent is permitted to execute.
    allowed_actions: vector<u8>,
    /// Maximum permitted max-LTV reduction, in basis points.
    max_ltv_delta_bps: u64,
    /// Maximum permitted maintenance-margin increase, in basis points.
    max_margin_delta_bps: u64,
    /// Maximum permitted pause duration, in milliseconds.
    pause_duration_limit_ms: u64,
    /// Configured risk thresholds used by the off-chain risk engine.
    risk_thresholds: vector<u64>,
    /// Minimum elapsed time between agent actions, in milliseconds.
    cooldown_ms: u64,
    /// Timestamp (ms) of the last successful agent action; 0 if none.
    last_action_timestamp_ms: u64,
    /// True once the policy has been revoked.
    is_revoked: bool,
    /// True while the market is paused under this policy.
    is_paused: bool,
    /// Monotonically increasing config version (bumped on update).
    version: u64,
    /// Walrus blob id of the durable policy-configuration evidence.
    walrus_config_blob_id: vector<u8>,
    /// Creation timestamp, in milliseconds.
    created_at_ms: u64,
}

/// Capability granting a specific agent address bounded authority to act on
/// specific markets and action types until expiry or revocation.
///
/// Req 8.2.
public struct GuardianCap has key, store {
    id: UID,
    /// Id of the `RiskPolicy` this capability is scoped to.
    policy_id: ID,
    /// The agent address authorized to present this capability.
    agent_address: address,
    /// Expiry timestamp, in milliseconds.
    expires_at_ms: u64,
    /// Market ids the agent may act on.
    allowed_markets: vector<ID>,
    /// Action-type codes the agent may execute.
    allowed_actions: vector<u8>,
    /// True once the DAO has revoked this capability.
    revoked: bool,
}

/// Capability granting a DAO / governor address authority to reverse actions,
/// revoke the agent, update thresholds, and unpause markets.
///
/// Req 8.3.
public struct OverrideCap has key, store {
    id: UID,
    /// Id of the `RiskPolicy` this capability is scoped to.
    policy_id: ID,
    /// The DAO / governor address authorized to present this capability.
    dao_address: address,
    /// May reverse an executed action.
    can_reverse_action: bool,
    /// May revoke the agent's `GuardianCap`.
    can_revoke_agent: bool,
    /// May update the policy thresholds / configuration.
    can_update_thresholds: bool,
    /// May unpause a paused market.
    can_unpause_market: bool,
}

/// Immutable record of a single executed or reversed action, including the risk
/// score, before/after values, Walrus evidence references, and reversal
/// metadata.
///
/// Req 8.4.
public struct ActionLog has key, store {
    id: UID,
    /// Id of the governing `RiskPolicy`.
    policy_id: ID,
    /// Id of the affected market.
    market_id: ID,
    /// Address that performed the action.
    actor: address,
    /// Actor-type code (see `ACTOR_TYPE_*`).
    actor_type: u8,
    /// Risk score (0–100) at the time of the action.
    risk_score: u8,
    /// Action-type code (see `sentinel_adapters::adapters` `ACTION_*`).
    action_type: u8,
    /// Prior value of the mutated parameter.
    old_value: u64,
    /// New value of the mutated parameter.
    new_value: u64,
    /// Walrus blob id of the linked evidence bundle.
    walrus_evidence_blob_id: vector<u8>,
    /// Hash of the linked evidence bundle.
    evidence_hash: vector<u8>,
    /// Sui transaction digest of the action.
    tx_digest: vector<u8>,
    /// Timestamp of the action, in milliseconds.
    timestamp_ms: u64,
    /// DAO address that reversed this action, if any.
    reversed_by: Option<address>,
    /// Transaction digest of the reversal, if any.
    reversal_tx_digest: vector<u8>,
    /// True once this action has been reversed.
    is_reversed: bool,
}

// === Events ===

/// Emitted when an autonomous bounded action is executed. Req 8.6.
public struct RiskActionExecuted has copy, drop {
    policy_id: ID,
    market_id: ID,
    action_type: u8,
    risk_score: u8,
    old_value: u64,
    new_value: u64,
    evidence_blob_id: vector<u8>,
    evidence_hash: vector<u8>,
    timestamp_ms: u64,
}

/// Emitted when a DAO overrides / reverses a prior action. Req 8.7.
public struct RiskActionOverridden has copy, drop {
    policy_id: ID,
    original_action_id: ID,
    dao_address: address,
    reason: vector<u8>,
    timestamp_ms: u64,
}

/// Emitted when a guardian capability is revoked. Req 8.8.
public struct GuardianRevoked has copy, drop {
    policy_id: ID,
    guardian_cap_id: ID,
    dao_address: address,
    timestamp_ms: u64,
}

/// Emitted when policy thresholds or configuration are updated. Req 8.9.
public struct PolicyUpdated has copy, drop {
    policy_id: ID,
    version: u64,
    timestamp_ms: u64,
}

// === Event emit helpers ===
//
// Thin wrappers so the behavioral functions (tasks 3.3–3.4) emit events via a
// single, named entry point. Constructing and emitting the events here also
// keeps every event field "read", which the compiler verifies.

public(package) fun emit_risk_action_executed(
    policy_id: ID,
    market_id: ID,
    action_type: u8,
    risk_score: u8,
    old_value: u64,
    new_value: u64,
    evidence_blob_id: vector<u8>,
    evidence_hash: vector<u8>,
    timestamp_ms: u64,
) {
    event::emit(RiskActionExecuted {
        policy_id,
        market_id,
        action_type,
        risk_score,
        old_value,
        new_value,
        evidence_blob_id,
        evidence_hash,
        timestamp_ms,
    });
}

public(package) fun emit_risk_action_overridden(
    policy_id: ID,
    original_action_id: ID,
    dao_address: address,
    reason: vector<u8>,
    timestamp_ms: u64,
) {
    event::emit(RiskActionOverridden {
        policy_id,
        original_action_id,
        dao_address,
        reason,
        timestamp_ms,
    });
}

public(package) fun emit_guardian_revoked(
    policy_id: ID,
    guardian_cap_id: ID,
    dao_address: address,
    timestamp_ms: u64,
) {
    event::emit(GuardianRevoked { policy_id, guardian_cap_id, dao_address, timestamp_ms });
}

public(package) fun emit_policy_updated(policy_id: ID, version: u64, timestamp_ms: u64) {
    event::emit(PolicyUpdated { policy_id, version, timestamp_ms });
}

// === Actor-type constant accessors ===

public fun actor_type_agent(): u8 { ACTOR_TYPE_AGENT }

public fun actor_type_dao(): u8 { ACTOR_TYPE_DAO }

public fun actor_type_admin(): u8 { ACTOR_TYPE_ADMIN }

// === Policy read-only accessors ===
//
// Harmless getters that expose policy invariants for verification (Req 7.7,
// 16.7). They confer NO authority: there is no corresponding setter reachable
// by a `GuardianCap`, so reading `owner` / `max_ltv_delta_bps` / `version`
// cannot be turned into a mutation. They let callers (and tests) assert that an
// agent action via `execute_guardian_action` leaves the policy owner/admin and
// bounds untouched.

/// The policy owner / protocol admin address. Set once in `create_policy` and
/// never mutated (no setter exists). (Req 7.7, 16.7)
public fun policy_owner(policy: &RiskPolicy): address { policy.owner }

/// The maximum permitted max-LTV reduction bound, in basis points. Only
/// `update_thresholds` (OverrideCap-gated) can change it. (Req 7.7, 16.7)
public fun max_ltv_delta_bps(policy: &RiskPolicy): u64 { policy.max_ltv_delta_bps }

/// The maximum permitted maintenance-margin increase bound, in basis points.
/// Only `update_thresholds` (OverrideCap-gated) can change it. (Req 7.7, 16.7)
public fun max_margin_delta_bps(policy: &RiskPolicy): u64 { policy.max_margin_delta_bps }

/// The monotonically increasing config version, bumped only by
/// `update_thresholds` (OverrideCap-gated). (Req 7.7, 16.7)
public fun policy_version(policy: &RiskPolicy): u64 { policy.version }

/// Timestamp (ms) of the last successful agent action; 0 if none. Set only by
/// `execute_guardian_action` on success (the cooldown clock). Read-only getter
/// so callers/tests can assert the action timestamp was recorded atomically
/// with the `ActionLog` write and `RiskActionExecuted` emit. (Req 8.14, 16.8)
public fun policy_last_action_timestamp_ms(policy: &RiskPolicy): u64 {
    policy.last_action_timestamp_ms
}

/// True once the policy has been revoked. Set only by `revoke_guardian`
/// (OverrideCap-gated) on the not-revoked -> revoked transition; never cleared.
/// Read-only getter so callers/tests can assert the agent's revocation was
/// reflected at the policy level atomically with the `GuardianCap` flip and the
/// `GuardianRevoked` emit. (Req 12.1, 12.6)
public fun policy_is_revoked(policy: &RiskPolicy): bool { policy.is_revoked }

// === GuardianCap read-only accessors ===

/// True once the DAO has revoked this capability. Set only by `revoke_guardian`
/// (OverrideCap-gated) and never cleared, so revocation is monotonic. Read-only
/// getter so callers/tests can assert the cap was flipped to revoked atomically
/// with the `GuardianRevoked` emit, and stays revoked across repeat (idempotent)
/// revoke calls. (Req 12.1, 12.6)
public fun guardian_cap_revoked(cap: &GuardianCap): bool { cap.revoked }

// === ActionLog read-only accessors ===
//
// Harmless getters exposing the immutable audit-record fields so callers/tests
// can verify that a successful `execute_guardian_action` recorded the action
// with the supplied Walrus evidence references, digest, and before/after
// values. They confer no authority and have no setters. (Req 9.4, 16.8)

/// Walrus blob id of the linked evidence bundle recorded on the action. (Req 9.4)
public fun action_log_blob_id(log: &ActionLog): vector<u8> { log.walrus_evidence_blob_id }

/// Hash of the linked evidence bundle recorded on the action. (Req 9.4)
public fun action_log_evidence_hash(log: &ActionLog): vector<u8> { log.evidence_hash }

/// Sui transaction digest recorded on the action. (Req 9.4)
public fun action_log_tx_digest(log: &ActionLog): vector<u8> { log.tx_digest }

/// Action-type code recorded on the action. (Req 8.14)
public fun action_log_action_type(log: &ActionLog): u8 { log.action_type }

/// Prior value of the mutated parameter recorded on the action. (Req 8.14)
public fun action_log_old_value(log: &ActionLog): u64 { log.old_value }

/// New value of the mutated parameter recorded on the action. (Req 8.14)
public fun action_log_new_value(log: &ActionLog): u64 { log.new_value }

/// Timestamp (ms) recorded on the action. (Req 8.14)
public fun action_log_timestamp_ms(log: &ActionLog): u64 { log.timestamp_ms }

/// Risk score recorded on the action. (Req 8.14)
public fun action_log_risk_score(log: &ActionLog): u8 { log.risk_score }

// === Creation (task 3.2) ===
//
// ## Resolving the policy <-> capability cross-reference
//
// `RiskPolicy` stores `guardian_cap_id` and `dao_override_cap_id`, while each
// capability stores `policy_id`. That is a circular reference: neither side's
// id exists until its object is created. We resolve it by minting the
// policy's `UID` *first* (so its `ID` is known) and then creating the two
// capabilities against that id, before finally assembling the `RiskPolicy`
// with the capabilities' ids. Because `ID` has `copy`, reading the policy id
// up front does not consume the still-unowned `UID`, which is moved into the
// `RiskPolicy` at the end. This keeps the wiring single-transaction, atomic,
// and free of post-creation setters.
//
// `create_guardian_cap` / `create_override_cap` are also exposed as standalone
// constructors (Req 8.5) that return the capability object; `create_policy`
// composes them. Standalone callers must supply the governing `policy_id`.

/// Construct a `GuardianCap` scoped to `policy_id`, granting `agent_address`
/// bounded authority over `allowed_markets` / `allowed_actions` until
/// `expires_at_ms`. Starts un-revoked. Aborts if any action code is invalid.
///
/// The caller owns the returned capability and is responsible for transferring
/// it to the agent (see `create_policy`). Req 8.2.
public fun create_guardian_cap(
    policy_id: ID,
    agent_address: address,
    expires_at_ms: u64,
    allowed_markets: vector<ID>,
    allowed_actions: vector<u8>,
    ctx: &mut TxContext,
): GuardianCap {
    assert_valid_actions(&allowed_actions);
    GuardianCap {
        id: object::new(ctx),
        policy_id,
        agent_address,
        expires_at_ms,
        allowed_markets,
        allowed_actions,
        revoked: false,
    }
}

/// Construct an `OverrideCap` scoped to `policy_id`, granting `dao_address` the
/// supplied privileged capability flags.
///
/// The caller owns the returned capability and is responsible for transferring
/// it to the DAO (see `create_policy`). Req 8.3.
public fun create_override_cap(
    policy_id: ID,
    dao_address: address,
    can_reverse_action: bool,
    can_revoke_agent: bool,
    can_update_thresholds: bool,
    can_unpause_market: bool,
    ctx: &mut TxContext,
): OverrideCap {
    OverrideCap {
        id: object::new(ctx),
        policy_id,
        dao_address,
        can_reverse_action,
        can_revoke_agent,
        can_update_thresholds,
        can_unpause_market,
    }
}

/// Create a `RiskPolicy` together with its `GuardianCap` (for the agent) and
/// `OverrideCap` (for the DAO), wiring the cross-referencing ids in a single
/// atomic transaction.
///
/// The DAO is granted the full set of override flags. The guardian capability
/// is scoped to `allowed_markets` / `allowed_actions` and expires at
/// `guardian_expires_at_ms`. The transaction sender becomes the policy
/// `owner`. The policy starts at `version = 1`, not revoked, not paused, with
/// `last_action_timestamp_ms = 0`.
///
/// Effects: the `RiskPolicy` is shared (so the agent, DAO, and admin can all
/// reference and mutate it under capability checks), the `GuardianCap` is
/// transferred to `agent_address`, and the `OverrideCap` is transferred to
/// `dao_address`. Emits `PolicyUpdated` for the new policy.
///
/// Aborts if `market_type` or any entry of `allowed_actions` is invalid, with
/// no objects created. Req 8.1, 8.2, 8.3, 8.5.
public fun create_policy(
    market_id: ID,
    market_type: u8,
    agent_address: address,
    dao_address: address,
    allowed_actions: vector<u8>,
    allowed_markets: vector<ID>,
    max_ltv_delta_bps: u64,
    max_margin_delta_bps: u64,
    pause_duration_limit_ms: u64,
    risk_thresholds: vector<u64>,
    cooldown_ms: u64,
    guardian_expires_at_ms: u64,
    walrus_config_blob_id: vector<u8>,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    assert!(adapters::is_valid_market_type(market_type), EInvalidMarketType);
    assert_valid_actions(&allowed_actions);

    let owner = ctx.sender();
    let now_ms = clock.timestamp_ms();

    // Mint the policy id first so the capabilities can reference it.
    let policy_uid = object::new(ctx);
    let policy_id = object::uid_to_inner(&policy_uid);

    // Create the capabilities against the (now known) policy id.
    let guardian_cap = create_guardian_cap(
        policy_id,
        agent_address,
        guardian_expires_at_ms,
        allowed_markets,
        allowed_actions,
        ctx,
    );
    let override_cap = create_override_cap(
        policy_id,
        dao_address,
        true,
        true,
        true,
        true,
        ctx,
    );

    // Read the capability ids to close the cross-reference.
    let guardian_cap_id = object::id(&guardian_cap);
    let dao_override_cap_id = object::id(&override_cap);

    let policy = RiskPolicy {
        id: policy_uid,
        market_id,
        market_type,
        owner,
        dao_override_cap_id,
        guardian_cap_id,
        allowed_actions,
        max_ltv_delta_bps,
        max_margin_delta_bps,
        pause_duration_limit_ms,
        risk_thresholds,
        cooldown_ms,
        last_action_timestamp_ms: 0,
        is_revoked: false,
        is_paused: false,
        version: 1,
        walrus_config_blob_id,
        created_at_ms: now_ms,
    };

    emit_policy_updated(policy_id, policy.version, now_ms);

    // The policy is shared; the capabilities go to their respective holders.
    transfer::share_object(policy);
    transfer::public_transfer(guardian_cap, agent_address);
    transfer::public_transfer(override_cap, dao_address);
}

/// Assert every action code in `actions` is a supported `sentinel_adapters`
/// `ACTION_*` code. Aborts with `EInvalidActionType` on the first invalid code.
fun assert_valid_actions(actions: &vector<u8>) {
    let n = vector::length(actions);
    let mut i = 0;
    while (i < n) {
        assert!(adapters::is_valid_action(*vector::borrow(actions, i)), EInvalidActionType);
        i = i + 1;
    };
}

// === Autonomous action execution (task 3.3) ===

/// Execute a single bounded autonomous safety action against a demo market.
///
/// This is the critical enforcement path. It validates the agent's authority
/// in a fixed order and aborts on the FIRST failed check **with no state
/// mutation** (every check runs before any mutation is applied), then — only
/// on success — applies the bounded change through the `sentinel_adapters`
/// `ActionTicket` interface, records the cooldown clock, writes an immutable
/// `ActionLog`, and emits `RiskActionExecuted`. Because validation and the
/// mutation share one transaction, a failed check rolls back everything.
///
/// Enforcement order (Req 8.10):
///   0. caller is the cap's `agent_address`, and the cap is scoped to `policy`
///   1. `cap.revoked == false` (and the policy itself is not revoked) — Req 7.8, 12.3
///   2. `cap.expires_at_ms > tx_timestamp_ms` — Req 7.8
///   3. target market ∈ `cap.allowed_markets` — Req 7.3
///   4. `action_type` ∈ `cap.allowed_actions` — Req 7.4
///   5. `tx_timestamp_ms - last_action_timestamp_ms >= cooldown_ms` — Req 7.8
///   6. action delta within bounds (`max_ltv_delta_bps` / `max_margin_delta_bps`
///      / `pause_duration_limit_ms`) — Req 7.5, 7.6, 7.9, 8.12
///
/// `new_param_value` carries the bounds-checked new parameter for value-setting
/// actions (the new max-LTV for `reduce-ltv` / `restore-ltv`); `pause_duration_ms`
/// carries the requested pause duration for `pause-borrows`. Both are ignored by
/// actions that do not use them. `walrus_evidence_blob_id`, `evidence_hash`, and
/// `tx_digest` are recorded verbatim in the `ActionLog` (Req 9.4).
///
/// Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 7.8, 7.9, 8.10, 8.11, 8.12, 8.14, 9.4
public fun execute_guardian_action(
    policy: &mut RiskPolicy,
    guardian_cap: &GuardianCap,
    market: &mut MarketState,
    action_type: u8,
    new_param_value: u64,
    pause_duration_ms: u64,
    risk_score: u8,
    walrus_evidence_blob_id: vector<u8>,
    evidence_hash: vector<u8>,
    tx_digest: vector<u8>,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    let policy_id = object::id(policy);
    let market_id = object::id(market);
    let now_ms = clock.timestamp_ms();

    // --- Check 0: caller authority & capability scope (no state change). ---
    // The agent that holds the cap must be the transaction sender, and the cap
    // must govern *this* policy.
    assert!(ctx.sender() == guardian_cap.agent_address, ENotAuthorizedAgent);
    assert!(guardian_cap.policy_id == policy_id, ECapNotForPolicy);

    // --- Check 1: not revoked (cap or policy). Req 7.8, 12.3 ---
    assert!(!guardian_cap.revoked, ERevoked);
    assert!(!policy.is_revoked, ERevoked);

    // --- Check 2: not expired. Req 7.8 ---
    assert!(guardian_cap.expires_at_ms > now_ms, EExpired);

    // --- Check 3: target market is in scope. Req 7.3 ---
    assert!(vector::contains(&guardian_cap.allowed_markets, &market_id), EMarketNotAllowed);

    // --- Check 4: action type is in scope. Req 7.4 ---
    assert!(vector::contains(&guardian_cap.allowed_actions, &action_type), EActionNotAllowed);

    // --- Check 5: cooldown elapsed. Req 7.8 ---
    // `last_action_timestamp_ms` is only ever set from a prior `now_ms`, so the
    // subtraction cannot underflow.
    assert!(now_ms - policy.last_action_timestamp_ms >= policy.cooldown_ms, ECooldownNotElapsed);

    // --- Check 6 + apply: bounds enforcement then the bounded mutation. ---
    // Each branch verifies the per-action delta bound (Req 7.5/7.6/7.9/8.12),
    // mints an `ActionTicket` describing the approved change, and consumes it via
    // the matching demo-market mutator. `old_value`/`new_value` are captured for
    // the `ActionLog` and event.
    let market_type = policy.market_type;
    let old_value;
    let new_value;

    if (action_type == adapters::action_pause_borrows()) {
        // Bound: requested pause duration must not exceed the policy limit.
        assert!(pause_duration_ms <= policy.pause_duration_limit_ms, EPauseDurationExceeded);
        old_value = 0;
        new_value = pause_duration_ms;
        let ticket = adapters::new_action_ticket(market_id, market_type, action_type, old_value, new_value);
        market::pause_borrows(market, ticket);
        policy.is_paused = true;
    } else if (action_type == adapters::action_unpause_borrows()) {
        old_value = 1;
        new_value = 0;
        let ticket = adapters::new_action_ticket(market_id, market_type, action_type, old_value, new_value);
        market::unpause_borrows(market, ticket);
        policy.is_paused = false;
    } else if (action_type == adapters::action_reduce_ltv()) {
        // Bound: the reduction (current - new) must not exceed `max_ltv_delta_bps`,
        // and the new value must actually be a reduction.
        let current_ltv = market::max_ltv_bps(&market::get_state(market));
        assert!(new_param_value <= current_ltv, EInvalidLtvReduction);
        assert!(current_ltv - new_param_value <= policy.max_ltv_delta_bps, ELtvDeltaExceeded);
        old_value = current_ltv;
        new_value = new_param_value;
        let ticket = adapters::new_action_ticket(market_id, market_type, action_type, old_value, new_value);
        market::reduce_ltv(market, ticket);
    } else if (action_type == adapters::action_restore_ltv()) {
        let current_ltv = market::max_ltv_bps(&market::get_state(market));
        old_value = current_ltv;
        new_value = new_param_value;
        let ticket = adapters::new_action_ticket(market_id, market_type, action_type, old_value, new_value);
        market::restore_ltv(market, ticket);
    } else if (action_type == adapters::action_enter_guarded()) {
        old_value = 0;
        new_value = 1;
        let ticket = adapters::new_action_ticket(market_id, market_type, action_type, old_value, new_value);
        market::enter_guarded_mode(market, ticket);
    } else if (action_type == adapters::action_exit_guarded()) {
        old_value = 1;
        new_value = 0;
        let ticket = adapters::new_action_ticket(market_id, market_type, action_type, old_value, new_value);
        market::exit_guarded_mode(market, ticket);
    } else if (action_type == adapters::action_increase_margin()) {
        // The maintenance-margin bound is enforced here (Req 7.9/8.12) for any
        // margin-capable adapter, but the simulated demo market exposes no
        // margin mutator, so the action cannot be applied to it.
        let current_margin = market::maintenance_margin_bps(&market::get_state(market));
        assert!(new_param_value >= current_margin, EUnsupportedAction);
        assert!(new_param_value - current_margin <= policy.max_margin_delta_bps, EMarginDeltaExceeded);
        abort EUnsupportedAction
    } else {
        abort EUnsupportedAction
    };

    // --- On success: record cooldown clock, write the ActionLog, emit event. ---
    // (Req 8.14, 9.4) All within this same transaction.
    policy.last_action_timestamp_ms = now_ms;

    let action_log = ActionLog {
        id: object::new(ctx),
        policy_id,
        market_id,
        actor: ctx.sender(),
        actor_type: ACTOR_TYPE_AGENT,
        risk_score,
        action_type,
        old_value,
        new_value,
        walrus_evidence_blob_id,
        evidence_hash,
        tx_digest,
        timestamp_ms: now_ms,
        reversed_by: option::none(),
        reversal_tx_digest: b"",
        is_reversed: false,
    };

    // `vector<u8>` has `copy`, so the evidence references are copied into the
    // event while the originals remain owned by the `ActionLog`.
    emit_risk_action_executed(
        policy_id,
        market_id,
        action_type,
        risk_score,
        old_value,
        new_value,
        walrus_evidence_blob_id,
        evidence_hash,
        now_ms,
    );

    // Share the immutable audit record so the DAO can later reference it (and
    // reverse it via `override_action` / `reverse_action` in task 3.4).
    transfer::share_object(action_log);
}

// === DAO / governor override operations (task 3.4) ===
//
// Every function in this section is authorized by an `OverrideCap` rather than
// a `GuardianCap`: the DAO/governor is the higher authority that can reverse,
// confirm, revoke, retune, and directly steer the market. Each verifies, with
// NO state change on failure (Req 8.13, 12.5):
//   - the presented `OverrideCap` is scoped to *this* `RiskPolicy`
//     (`override_cap.policy_id == object::id(policy)`),
//   - the caller is the cap's `dao_address`,
//   - the relevant capability flag is true *where required*.
//
// ## Forbidden operations (Req 7.7, 16.7)
//
// There is intentionally NO public function anywhere in this package that lets
// the *agent* (or anyone) transfer funds, change the policy `owner`/admin,
// delete/remove an `OverrideCap`, or edit the policy's own bounds via the
// `GuardianCap` path. These are structurally impossible:
//   - `RiskPolicy` holds no coin/balance fields, so no fund transfer exists.
//   - `owner` is set once in `create_policy` and never mutated.
//   - `OverrideCap` is only ever created (`create_override_cap`) and
//     transferred to the DAO; no function unpacks/deletes it, and it is not
//     consumed by any path here.
//   - The only mutators of policy bounds/thresholds (`update_thresholds`) and
//     of market state (`*_market`, `adjust_ltv`, `restore_ltv`,
//     `*_guarded_mode`, `reverse_action`/`override_action`) require an
//     `OverrideCap`; the `GuardianCap` path (`execute_guardian_action`) cannot
//     mutate the policy configuration.

/// Verify the `OverrideCap` governs `policy` and the caller is its DAO address.
/// Aborts (no state change) otherwise. Shared precondition for every override
/// operation. (Req 8.13, 12.5)
fun assert_override_for_policy(
    policy: &RiskPolicy,
    override_cap: &OverrideCap,
    ctx: &TxContext,
) {
    assert!(override_cap.policy_id == object::id(policy), EOverrideCapNotForPolicy);
    assert!(ctx.sender() == override_cap.dao_address, ENotAuthorizedDao);
}

/// Revoke the agent's `GuardianCap`, immediately and verifiably preventing
/// future autonomous actions (Req 12.1, 12.3, 11.8).
///
/// Authorization: a valid `OverrideCap` scoped to `policy`, presented by its
/// `dao_address`, with `can_revoke_agent == true` (Req 12.5). The
/// `guardian_cap` must also be scoped to the same policy.
///
/// IDEMPOTENT (Req 12.6): if the cap is already revoked, the function leaves
/// `revoked == true` and does NOT emit a duplicate `GuardianRevoked` event. The
/// event (and the `policy.is_revoked` reflection) only fire on the transition
/// from not-revoked to revoked, all within the same transaction.
public fun revoke_guardian(
    policy: &mut RiskPolicy,
    override_cap: &OverrideCap,
    guardian_cap: &mut GuardianCap,
    clock: &Clock,
    ctx: &TxContext,
) {
    assert_override_for_policy(policy, override_cap, ctx);
    assert!(override_cap.can_revoke_agent, ECannotRevokeAgent);
    assert!(guardian_cap.policy_id == object::id(policy), EGuardianCapNotForPolicy);

    // Idempotence guard: only transition + emit when currently not revoked.
    if (!guardian_cap.revoked) {
        guardian_cap.revoked = true;
        // Reflect the agent's revocation at the policy level so the autonomous
        // path (`execute_guardian_action`) also fails closed.
        policy.is_revoked = true;
        emit_guardian_revoked(
            object::id(policy),
            object::id(guardian_cap),
            override_cap.dao_address,
            clock.timestamp_ms(),
        );
    };
}

/// Retune the policy's bounds and risk thresholds, bump the config version, and
/// emit `PolicyUpdated` (Req 8.9, 12.5).
///
/// Authorization: a valid `OverrideCap` scoped to `policy`, presented by its
/// `dao_address`, with `can_update_thresholds == true` (Req 8.13).
public fun update_thresholds(
    policy: &mut RiskPolicy,
    override_cap: &OverrideCap,
    new_max_ltv_delta_bps: u64,
    new_max_margin_delta_bps: u64,
    new_pause_duration_limit_ms: u64,
    new_cooldown_ms: u64,
    new_risk_thresholds: vector<u64>,
    clock: &Clock,
    ctx: &TxContext,
) {
    assert_override_for_policy(policy, override_cap, ctx);
    assert!(override_cap.can_update_thresholds, ECannotUpdateThresholds);

    policy.max_ltv_delta_bps = new_max_ltv_delta_bps;
    policy.max_margin_delta_bps = new_max_margin_delta_bps;
    policy.pause_duration_limit_ms = new_pause_duration_limit_ms;
    policy.cooldown_ms = new_cooldown_ms;
    policy.risk_thresholds = new_risk_thresholds;
    policy.version = policy.version + 1;

    emit_policy_updated(object::id(policy), policy.version, clock.timestamp_ms());
}

/// Apply the inverse market mutation for a previously executed action, mint the
/// inverse `ActionTicket`, consume it via the matching demo-market mutator, and
/// return the `(inverse_action_type, inverse_new_value)` recorded on the
/// reversal `ActionLog`. Updates `policy.is_paused` for pause/unpause inverses.
///
/// Aborts with `ENoInverseAction` for action types that have no on-chain
/// inverse (e.g. `increase-margin`, which the demo market cannot apply).
fun apply_inverse(
    policy: &mut RiskPolicy,
    market: &mut MarketState,
    original_action_type: u8,
    original_old_value: u64,
): (u8, u64) {
    let market_id = object::id(market);
    let market_type = policy.market_type;

    if (original_action_type == adapters::action_pause_borrows()) {
        let ticket = adapters::new_action_ticket(
            market_id, market_type, adapters::action_unpause_borrows(), 1, 0,
        );
        market::unpause_borrows(market, ticket);
        policy.is_paused = false;
        (adapters::action_unpause_borrows(), 0)
    } else if (original_action_type == adapters::action_unpause_borrows()) {
        let ticket = adapters::new_action_ticket(
            market_id, market_type, adapters::action_pause_borrows(), 0, 1,
        );
        market::pause_borrows(market, ticket);
        policy.is_paused = true;
        (adapters::action_pause_borrows(), 1)
    } else if (original_action_type == adapters::action_reduce_ltv()) {
        // Restore the max-LTV to its pre-action value.
        let current = market::max_ltv_bps(&market::get_state(market));
        let ticket = adapters::new_action_ticket(
            market_id, market_type, adapters::action_restore_ltv(), current, original_old_value,
        );
        market::restore_ltv(market, ticket);
        (adapters::action_restore_ltv(), original_old_value)
    } else if (original_action_type == adapters::action_restore_ltv()) {
        // Reduce the max-LTV back to its pre-restore value.
        let current = market::max_ltv_bps(&market::get_state(market));
        let ticket = adapters::new_action_ticket(
            market_id, market_type, adapters::action_reduce_ltv(), current, original_old_value,
        );
        market::reduce_ltv(market, ticket);
        (adapters::action_reduce_ltv(), original_old_value)
    } else if (original_action_type == adapters::action_enter_guarded()) {
        let ticket = adapters::new_action_ticket(
            market_id, market_type, adapters::action_exit_guarded(), 1, 0,
        );
        market::exit_guarded_mode(market, ticket);
        (adapters::action_exit_guarded(), 0)
    } else if (original_action_type == adapters::action_exit_guarded()) {
        let ticket = adapters::new_action_ticket(
            market_id, market_type, adapters::action_enter_guarded(), 0, 1,
        );
        market::enter_guarded_mode(market, ticket);
        (adapters::action_enter_guarded(), 1)
    } else {
        // e.g. increase-margin: no inverse mutator on the demo market.
        abort ENoInverseAction
    }
}

/// Shared implementation of `override_action` / `reverse_action`. Validates the
/// override authority and target, marks the original `ActionLog` reversed,
/// applies the inverse market mutation, records a new reversal `ActionLog`, and
/// emits `RiskActionOverridden` — all in the same transaction (Req 11.4, 8.7).
fun reverse_internal(
    policy: &mut RiskPolicy,
    override_cap: &OverrideCap,
    action_log: &mut ActionLog,
    market: &mut MarketState,
    reason: vector<u8>,
    reversal_tx_digest: vector<u8>,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    assert_override_for_policy(policy, override_cap, ctx);
    assert!(override_cap.can_reverse_action, ECannotReverseAction);

    let policy_id = object::id(policy);
    // The action log and market must belong to this policy / each other.
    assert!(action_log.policy_id == policy_id, EActionLogNotForPolicy);
    assert!(action_log.market_id == object::id(market), EMarketMismatch);
    // An action can only be reversed once (Req 11.4).
    assert!(!action_log.is_reversed, EAlreadyReversed);

    let now_ms = clock.timestamp_ms();
    let dao = override_cap.dao_address;
    let original_action_id = object::id(action_log);
    let original_action_type = action_log.action_type;
    let original_old_value = action_log.old_value;
    let original_new_value = action_log.new_value;
    let original_risk_score = action_log.risk_score;
    let original_market_id = action_log.market_id;

    // Apply the inverse market change (aborts here with no state change if the
    // action has no on-chain inverse).
    let (inverse_action_type, inverse_new_value) =
        apply_inverse(policy, market, original_action_type, original_old_value);

    // Mark the original action reversed (Req 11.4).
    action_log.is_reversed = true;
    action_log.reversed_by = option::some(dao);
    action_log.reversal_tx_digest = reversal_tx_digest;

    // Record a new ActionLog capturing the reversal itself (Req 11.4).
    let reversal_log = ActionLog {
        id: object::new(ctx),
        policy_id,
        market_id: original_market_id,
        actor: dao,
        actor_type: ACTOR_TYPE_DAO,
        risk_score: original_risk_score,
        action_type: inverse_action_type,
        old_value: original_new_value,
        new_value: inverse_new_value,
        walrus_evidence_blob_id: b"",
        evidence_hash: b"",
        tx_digest: reversal_tx_digest,
        timestamp_ms: now_ms,
        reversed_by: option::none(),
        reversal_tx_digest: b"",
        is_reversed: false,
    };
    transfer::share_object(reversal_log);

    emit_risk_action_overridden(policy_id, original_action_id, dao, reason, now_ms);
}

/// Override a prior autonomous action: reverse its market effect, mark its
/// `ActionLog` reversed, record a reversal log, and emit `RiskActionOverridden`
/// with the governor's `reason` (Req 8.7, 11.4). Equivalent entry point to
/// `reverse_action`; both require `can_reverse_action`.
public fun override_action(
    policy: &mut RiskPolicy,
    override_cap: &OverrideCap,
    action_log: &mut ActionLog,
    market: &mut MarketState,
    reason: vector<u8>,
    reversal_tx_digest: vector<u8>,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    reverse_internal(
        policy, override_cap, action_log, market, reason, reversal_tx_digest, clock, ctx,
    );
}

/// Reverse a prior autonomous action (see `reverse_internal`). Equivalent entry
/// point to `override_action`; both require `can_reverse_action` (Req 11.4).
public fun reverse_action(
    policy: &mut RiskPolicy,
    override_cap: &OverrideCap,
    action_log: &mut ActionLog,
    market: &mut MarketState,
    reason: vector<u8>,
    reversal_tx_digest: vector<u8>,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    reverse_internal(
        policy, override_cap, action_log, market, reason, reversal_tx_digest, clock, ctx,
    );
}

/// Confirm a prior autonomous action as correct — the DAO reviewed it and is
/// NOT reversing it (Req 11.5). Verifies override authority and that the action
/// belongs to this policy and has not already been reversed; applies no market
/// or policy state change (the action stands as recorded).
public fun confirm_action(
    policy: &RiskPolicy,
    override_cap: &OverrideCap,
    action_log: &ActionLog,
    ctx: &TxContext,
) {
    assert_override_for_policy(policy, override_cap, ctx);
    assert!(override_cap.can_reverse_action, ECannotReverseAction);
    assert!(action_log.policy_id == object::id(policy), EActionLogNotForPolicy);
    // Confirming an already-reversed action is meaningless.
    assert!(!action_log.is_reversed, EAlreadyReversed);
}

// === DAO-driven market controls (task 3.4) ===
//
// Unlike `execute_guardian_action` (agent-authorized, bounds-checked), these
// are manual interventions by the DAO/governor. Each requires a valid
// `OverrideCap` scoped to `policy`, presented by its `dao_address`, mints an
// `ActionTicket`, and consumes it via the matching demo-market mutator. The
// target market must be the policy's governed market. `unpause_market`
// additionally requires `can_unpause_market` (Req 8.13).

/// DAO directly pauses new borrows on the policy's market.
public fun pause_market(
    policy: &mut RiskPolicy,
    override_cap: &OverrideCap,
    market: &mut MarketState,
    ctx: &TxContext,
) {
    assert_override_for_policy(policy, override_cap, ctx);
    assert!(object::id(market) == policy.market_id, EMarketMismatch);
    let ticket = adapters::new_action_ticket(
        object::id(market), policy.market_type, adapters::action_pause_borrows(), 0, 1,
    );
    market::pause_borrows(market, ticket);
    policy.is_paused = true;
}

/// DAO unpauses borrows on the policy's market. Requires `can_unpause_market`
/// (Req 8.13).
public fun unpause_market(
    policy: &mut RiskPolicy,
    override_cap: &OverrideCap,
    market: &mut MarketState,
    ctx: &TxContext,
) {
    assert_override_for_policy(policy, override_cap, ctx);
    assert!(override_cap.can_unpause_market, ECannotUnpauseMarket);
    assert!(object::id(market) == policy.market_id, EMarketMismatch);
    let ticket = adapters::new_action_ticket(
        object::id(market), policy.market_type, adapters::action_unpause_borrows(), 1, 0,
    );
    market::unpause_borrows(market, ticket);
    policy.is_paused = false;
}

/// DAO directly sets the market's max-LTV to `new_ltv_bps`. As the higher
/// authority, the DAO is not bound by `max_ltv_delta_bps`.
public fun adjust_ltv(
    policy: &mut RiskPolicy,
    override_cap: &OverrideCap,
    market: &mut MarketState,
    new_ltv_bps: u64,
    ctx: &TxContext,
) {
    assert_override_for_policy(policy, override_cap, ctx);
    assert!(object::id(market) == policy.market_id, EMarketMismatch);
    let current = market::max_ltv_bps(&market::get_state(market));
    let ticket = adapters::new_action_ticket(
        object::id(market), policy.market_type, adapters::action_reduce_ltv(), current, new_ltv_bps,
    );
    market::reduce_ltv(market, ticket);
}

/// DAO restores the market's max-LTV to `new_ltv_bps`.
public fun restore_ltv(
    policy: &mut RiskPolicy,
    override_cap: &OverrideCap,
    market: &mut MarketState,
    new_ltv_bps: u64,
    ctx: &TxContext,
) {
    assert_override_for_policy(policy, override_cap, ctx);
    assert!(object::id(market) == policy.market_id, EMarketMismatch);
    let current = market::max_ltv_bps(&market::get_state(market));
    let ticket = adapters::new_action_ticket(
        object::id(market), policy.market_type, adapters::action_restore_ltv(), current, new_ltv_bps,
    );
    market::restore_ltv(market, ticket);
}

/// DAO directly enters guarded mode on the policy's market.
public fun enter_guarded_mode(
    policy: &RiskPolicy,
    override_cap: &OverrideCap,
    market: &mut MarketState,
    ctx: &TxContext,
) {
    assert_override_for_policy(policy, override_cap, ctx);
    assert!(object::id(market) == policy.market_id, EMarketMismatch);
    let ticket = adapters::new_action_ticket(
        object::id(market), policy.market_type, adapters::action_enter_guarded(), 0, 1,
    );
    market::enter_guarded_mode(market, ticket);
}

/// DAO directly exits guarded mode on the policy's market.
public fun exit_guarded_mode(
    policy: &RiskPolicy,
    override_cap: &OverrideCap,
    market: &mut MarketState,
    ctx: &TxContext,
) {
    assert_override_for_policy(policy, override_cap, ctx);
    assert!(object::id(market) == policy.market_id, EMarketMismatch);
    let ticket = adapters::new_action_ticket(
        object::id(market), policy.market_type, adapters::action_exit_guarded(), 1, 0,
    );
    market::exit_guarded_mode(market, ticket);
}

// === Audit log helper (task 3.4) ===

/// Create and share an immutable `ActionLog` audit record for `policy`.
///
/// This is a pure record-keeping helper: it writes an audit row and confers NO
/// authority over markets or policy configuration. It is used to log
/// DAO/admin interventions (e.g. the market-control functions above) that do
/// not themselves emit a dedicated event. The `actor_type` should be one of the
/// `ACTOR_TYPE_*` codes.
public fun log_action(
    policy: &RiskPolicy,
    market_id: ID,
    actor: address,
    actor_type: u8,
    risk_score: u8,
    action_type: u8,
    old_value: u64,
    new_value: u64,
    walrus_evidence_blob_id: vector<u8>,
    evidence_hash: vector<u8>,
    tx_digest: vector<u8>,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    let action_log = ActionLog {
        id: object::new(ctx),
        policy_id: object::id(policy),
        market_id,
        actor,
        actor_type,
        risk_score,
        action_type,
        old_value,
        new_value,
        walrus_evidence_blob_id,
        evidence_hash,
        tx_digest,
        timestamp_ms: clock.timestamp_ms(),
        reversed_by: option::none(),
        reversal_tx_digest: b"",
        is_reversed: false,
    };
    transfer::share_object(action_log);
}
