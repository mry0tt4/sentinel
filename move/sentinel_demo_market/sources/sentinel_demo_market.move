/// # sentinel_demo_market
///
/// Controllable, simulated on-chain lending market used to exercise risk
/// scenarios and autonomous safety actions on **Sui Testnet only**.
///
/// Task 2.1 delivers:
///   - `init_market` creating and sharing a `MarketState` (collateral/borrow
///     config, max LTV, maintenance margin, borrow pause flag, guarded mode
///     flag, and the stored admin/owner address).
///   - read-only getters: `get_state`, `get_utilization`, `get_exposure`
///     (plus field accessors on the returned config snapshot).
///   - admin-gated `reset_market` that restores the market to its initialized
///     values and rejects any non-admin caller.
///
/// Task 2.2 adds the policy-controlled mutators (pause/unpause borrows,
/// reduce/restore max LTV, enter/exit guarded mode). Each mutator requires a
/// proof-of-policy-authorization witness — an `ActionTicket` hot potato minted
/// by `sentinel_policy::execute_guardian_action` after it has validated the
/// bounded action. The demo market never grants itself authority: it only
/// applies a change when presented a ticket whose `market_id`, `market_type`,
/// and `action_type` authorize *this* market and *this* mutator, and aborts
/// (with no state change) otherwise. Because `ActionTicket` carries no
/// abilities, it cannot be forged, stored, copied, or dropped — only minted by
/// the policy package and consumed here in the same transaction.
///
/// Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6
module sentinel_demo_market::market;

use sentinel_adapters::adapters::{Self, ActionTicket};

// === Errors ===

/// Raised when an actor other than the stored admin attempts an admin-only
/// operation such as `reset_market`. (Requirement 5.6)
const ENotAdmin: u64 = 1;
/// Raised when a presented `ActionTicket` targets a different market than the
/// `MarketState` it is applied to. (Requirement 5.4)
const EWrongMarket: u64 = 2;
/// Raised when a presented `ActionTicket` is for a non-demo market type.
/// (Requirement 5.4)
const EWrongMarketType: u64 = 3;
/// Raised when a presented `ActionTicket` authorizes a different action than
/// the mutator it is passed to. (Requirement 5.4)
const EWrongAction: u64 = 4;

// === Structs ===

/// The mutable, resettable configuration of a simulated market.
///
/// Values are expressed as follows:
///   - `collateral_amount` / `borrow_amount`: abstract simulated units used to
///     derive utilization and exposure.
///   - `max_ltv_bps` / `maintenance_margin_bps`: basis points (1 bp = 0.01%).
///   - `borrow_paused`: when true, new borrows are paused.
///   - `guarded_mode`: when true, the market is in a defensive guarded state.
public struct MarketConfig has store, copy, drop {
    collateral_amount: u64,
    borrow_amount: u64,
    max_ltv_bps: u64,
    maintenance_margin_bps: u64,
    borrow_paused: bool,
    guarded_mode: bool,
}

/// A shared, controllable simulated lending market.
///
/// `config` holds the current state; `initial_config` is the immutable
/// snapshot captured at initialization so `reset_market` can restore it.
/// `admin` is the owner address authorized to reset the market.
public struct MarketState has key {
    id: UID,
    admin: address,
    config: MarketConfig,
    initial_config: MarketConfig,
}

// === Initialization ===

/// Create a new `MarketState` with the supplied collateral/borrow
/// configuration, max LTV, and maintenance margin, and share it so the policy
/// package and admin can operate on it. The transaction sender becomes the
/// stored admin/owner. Borrows start unpaused and guarded mode starts off.
///
/// Requirement 5.1
public fun init_market(
    collateral_amount: u64,
    borrow_amount: u64,
    max_ltv_bps: u64,
    maintenance_margin_bps: u64,
    ctx: &mut TxContext,
) {
    let config = MarketConfig {
        collateral_amount,
        borrow_amount,
        max_ltv_bps,
        maintenance_margin_bps,
        borrow_paused: false,
        guarded_mode: false,
    };

    let state = MarketState {
        id: object::new(ctx),
        admin: ctx.sender(),
        // Capture the initialized values so `reset_market` can restore them.
        config,
        initial_config: config,
    };

    transfer::share_object(state);
}

// === Read-only getters ===

/// Return a copy of the market's current configuration snapshot.
///
/// Requirement 5.2
public fun get_state(state: &MarketState): MarketConfig {
    state.config
}

/// Return the simulated utilization expressed in basis points
/// (`borrow_amount / collateral_amount`). Returns 0 when there is no
/// collateral to avoid division by zero.
///
/// Requirement 5.2
public fun get_utilization(state: &MarketState): u64 {
    let collateral = state.config.collateral_amount;
    if (collateral == 0) {
        0
    } else {
        // bps = borrow * 10_000 / collateral
        ((state.config.borrow_amount as u128) * 10_000 / (collateral as u128)) as u64
    }
}

/// Return the simulated exposure of the market (the outstanding borrowed
/// amount).
///
/// Requirement 5.2
public fun get_exposure(state: &MarketState): u64 {
    state.config.borrow_amount
}

/// Return the stored admin/owner address of the market.
public fun admin(state: &MarketState): address {
    state.admin
}

// === MarketConfig field accessors ===

public fun collateral_amount(config: &MarketConfig): u64 {
    config.collateral_amount
}

public fun borrow_amount(config: &MarketConfig): u64 {
    config.borrow_amount
}

public fun max_ltv_bps(config: &MarketConfig): u64 {
    config.max_ltv_bps
}

public fun maintenance_margin_bps(config: &MarketConfig): u64 {
    config.maintenance_margin_bps
}

public fun is_borrow_paused(config: &MarketConfig): bool {
    config.borrow_paused
}

public fun is_guarded_mode(config: &MarketConfig): bool {
    config.guarded_mode
}

// === Policy-controlled mutators (authorization-witness gated) ===
//
// Each mutator consumes an `ActionTicket` — the proof-of-policy-authorization
// witness minted by `sentinel_policy::execute_guardian_action` after it has
// validated the bounded action (capability state, scope, cooldown, bounds).
// The demo market re-verifies that the ticket authorizes *this* market and
// *this* action before applying the change, and aborts (reverting the whole
// transaction, including the ticket mint) otherwise. There is no other way to
// mutate market state, so an unauthorized caller — one without a valid ticket
// — cannot change the market. (Requirements 5.3, 5.4)

/// Assert that `ticket` authorizes `expected_action` on this exact market.
/// Verifies the ticket's target market id matches this `MarketState`, the
/// market type is `demo`, and the action type matches the calling mutator.
/// Aborts with no state change when any check fails. (Requirement 5.4)
fun assert_authorizes(
    state: &MarketState,
    ticket: &ActionTicket,
    expected_action: u8,
) {
    assert!(adapters::ticket_market_id(ticket) == object::id(state), EWrongMarket);
    assert!(adapters::ticket_market_type(ticket) == adapters::market_type_demo(), EWrongMarketType);
    assert!(adapters::ticket_action_type(ticket) == expected_action, EWrongAction);
}

/// Pause new borrows. Requires a ticket authorizing `pause-borrows` on this
/// market. (Requirement 5.3)
public fun pause_borrows(state: &mut MarketState, ticket: ActionTicket) {
    assert_authorizes(state, &ticket, adapters::action_pause_borrows());
    let (_id, _mt, _at, _old, _new) = adapters::consume(ticket);
    state.config.borrow_paused = true;
}

/// Unpause borrows. Requires a ticket authorizing `unpause-borrows` on this
/// market. (Requirement 5.3)
public fun unpause_borrows(state: &mut MarketState, ticket: ActionTicket) {
    assert_authorizes(state, &ticket, adapters::action_unpause_borrows());
    let (_id, _mt, _at, _old, _new) = adapters::consume(ticket);
    state.config.borrow_paused = false;
}

/// Reduce the market's max LTV to the bounds-checked value carried by the
/// ticket. The policy package has already verified the delta is within
/// `max_ltv_delta_bps`; the demo market applies `new_value` directly. Requires
/// a ticket authorizing `reduce-ltv` on this market. (Requirement 5.3)
public fun reduce_ltv(state: &mut MarketState, ticket: ActionTicket) {
    assert_authorizes(state, &ticket, adapters::action_reduce_ltv());
    let (_id, _mt, _at, _old, new_value) = adapters::consume(ticket);
    state.config.max_ltv_bps = new_value;
}

/// Restore the market's max LTV to the value carried by the ticket. Requires a
/// ticket authorizing `restore-ltv` on this market. (Requirement 5.3)
public fun restore_ltv(state: &mut MarketState, ticket: ActionTicket) {
    assert_authorizes(state, &ticket, adapters::action_restore_ltv());
    let (_id, _mt, _at, _old, new_value) = adapters::consume(ticket);
    state.config.max_ltv_bps = new_value;
}

/// Enter guarded mode. Requires a ticket authorizing `enter-guarded` on this
/// market. (Requirement 5.3)
public fun enter_guarded_mode(state: &mut MarketState, ticket: ActionTicket) {
    assert_authorizes(state, &ticket, adapters::action_enter_guarded());
    let (_id, _mt, _at, _old, _new) = adapters::consume(ticket);
    state.config.guarded_mode = true;
}

/// Exit guarded mode. Requires a ticket authorizing `exit-guarded` on this
/// market. (Requirement 5.3)
public fun exit_guarded_mode(state: &mut MarketState, ticket: ActionTicket) {
    assert_authorizes(state, &ticket, adapters::action_exit_guarded());
    let (_id, _mt, _at, _old, _new) = adapters::consume(ticket);
    state.config.guarded_mode = false;
}

// === Admin operations ===

/// Restore the market to its initialized values. Only the stored admin/owner
/// may invoke this; any other caller aborts with `ENotAdmin` and no state
/// change is applied.
///
/// Requirements 5.5, 5.6
public fun reset_market(state: &mut MarketState, ctx: &TxContext) {
    assert!(ctx.sender() == state.admin, ENotAdmin);
    state.config = state.initial_config;
}
