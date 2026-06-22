/// # sentinel_adapters
///
/// Adapter traits / market-type abstraction deployed to **Sui Testnet only**.
///
/// This module provides the *uniform interface* that
/// `sentinel_policy::execute_guardian_action` targets, so new market types can
/// be added without changing the policy enforcement logic. The policy package
/// validates a bounded action (capability state, scope, cooldown, bounds) and
/// then mints an `ActionTicket` describing the approved mutation. A concrete
/// adapter (e.g. `sentinel_demo_market`) consumes that ticket to apply the
/// change.
///
/// ## Authorization model
///
/// `ActionTicket` is a **hot potato**: it has no `key`, `store`, `copy`, or
/// `drop` abilities. Once minted it cannot be stored, copied, or dropped — it
/// MUST be consumed by an adapter mutator within the *same* transaction. This
/// binds every market mutation to a single, policy-validated action and makes
/// it impossible to apply a change without an accompanying ticket.
///
/// The authorization *decision* (who may mint a ticket and under what bounds)
/// lives in `sentinel_policy::execute_guardian_action`, which is the only
/// intended minter and performs all capability/scope/cooldown/bounds checks
/// before calling `new_action_ticket`. `sentinel_adapters` intentionally does
/// not depend on `sentinel_policy` (that would create a dependency cycle); the
/// hot-potato discipline is what this layer guarantees.
///
/// Supported market types: `lending`, `perps`, `stablecoin`, `demo`.
///
/// Requirements: 4.2 (market-type selection / future extensibility)
module sentinel_adapters::adapters;

// === Errors ===

/// The supplied market-type code is not one of the supported types.
const EInvalidMarketType: u64 = 0;
/// The supplied action-type code is not one of the supported actions.
const EInvalidActionType: u64 = 1;

// === Market type codes ===
//
// A `RiskPolicy` records its market type as a `u8`. These codes are the
// canonical mapping for the policy package, the backend, and the onboarding
// wizard's market-type selection (Req 4.2).

/// Lending market (collateral / borrow / max-LTV / maintenance margin).
const MARKET_TYPE_LENDING: u8 = 0;
/// Perpetual-futures market.
const MARKET_TYPE_PERPS: u8 = 1;
/// Stablecoin market (peg-sensitive).
const MARKET_TYPE_STABLECOIN: u8 = 2;
/// Controllable simulated demo market (`sentinel_demo_market`).
const MARKET_TYPE_DEMO: u8 = 3;

// === Action type codes ===
//
// The bounded safety actions an agent may be authorized to execute. Ordered so
// that `pause-new-borrows` is the priority-zero action (Req 7.1, 7.10). These
// codes are the canonical mapping shared by the policy package's
// `allowed_actions` vector, the `ActionLog.action_type` field, and the
// `RiskActionExecuted` event.

/// Pause new borrows (priority-zero emergency action).
const ACTION_PAUSE_BORROWS: u8 = 0;
/// Unpause borrows (restore borrowing).
const ACTION_UNPAUSE_BORROWS: u8 = 1;
/// Reduce the market's max LTV (bounded by `max_ltv_delta_bps`).
const ACTION_REDUCE_LTV: u8 = 2;
/// Restore a previously reduced max LTV.
const ACTION_RESTORE_LTV: u8 = 3;
/// Enter guarded mode.
const ACTION_ENTER_GUARDED: u8 = 4;
/// Exit guarded mode.
const ACTION_EXIT_GUARDED: u8 = 5;
/// Increase the maintenance margin (bounded by `max_margin_delta_bps`).
const ACTION_INCREASE_MARGIN: u8 = 6;

// === Uniform authorization interface (hot potato) ===

/// A single, policy-validated, bounded market mutation.
///
/// Minted by `sentinel_policy::execute_guardian_action` *after* all enforcement
/// checks pass, and consumed by a concrete adapter mutator. It carries no
/// abilities, so it cannot escape the transaction in which it was created.
public struct ActionTicket {
    /// On-chain id of the target market object.
    market_id: ID,
    /// Market-type code (see `MARKET_TYPE_*`).
    market_type: u8,
    /// Action-type code (see `ACTION_*`).
    action_type: u8,
    /// Prior value of the mutated parameter (for the `ActionLog` record).
    old_value: u64,
    /// New value of the mutated parameter (already bounds-checked by the policy).
    new_value: u64,
}

/// Mint an `ActionTicket` for an approved, bounded action.
///
/// INTENDED CALLER: `sentinel_policy::execute_guardian_action`, only after its
/// capability/scope/cooldown/bounds checks have passed. Aborts if the supplied
/// market-type or action-type code is not recognized.
public fun new_action_ticket(
    market_id: ID,
    market_type: u8,
    action_type: u8,
    old_value: u64,
    new_value: u64,
): ActionTicket {
    assert!(is_valid_market_type(market_type), EInvalidMarketType);
    assert!(is_valid_action(action_type), EInvalidActionType);
    ActionTicket { market_id, market_type, action_type, old_value, new_value }
}

/// Consume an `ActionTicket`, returning its fields. Called by the concrete
/// adapter after it has applied the mutation, discharging the hot potato.
public fun consume(ticket: ActionTicket): (ID, u8, u8, u64, u64) {
    let ActionTicket { market_id, market_type, action_type, old_value, new_value } = ticket;
    (market_id, market_type, action_type, old_value, new_value)
}

// === ActionTicket accessors ===

public fun ticket_market_id(ticket: &ActionTicket): ID { ticket.market_id }

public fun ticket_market_type(ticket: &ActionTicket): u8 { ticket.market_type }

public fun ticket_action_type(ticket: &ActionTicket): u8 { ticket.action_type }

public fun ticket_old_value(ticket: &ActionTicket): u64 { ticket.old_value }

public fun ticket_new_value(ticket: &ActionTicket): u64 { ticket.new_value }

// === Validation / classification helpers ===

/// True when `market_type` is one of the supported `MARKET_TYPE_*` codes.
public fun is_valid_market_type(market_type: u8): bool {
    market_type == MARKET_TYPE_LENDING
        || market_type == MARKET_TYPE_PERPS
        || market_type == MARKET_TYPE_STABLECOIN
        || market_type == MARKET_TYPE_DEMO
}

/// True when `action_type` is one of the supported `ACTION_*` codes.
public fun is_valid_action(action_type: u8): bool {
    action_type == ACTION_PAUSE_BORROWS
        || action_type == ACTION_UNPAUSE_BORROWS
        || action_type == ACTION_REDUCE_LTV
        || action_type == ACTION_RESTORE_LTV
        || action_type == ACTION_ENTER_GUARDED
        || action_type == ACTION_EXIT_GUARDED
        || action_type == ACTION_INCREASE_MARGIN
}

// === Public constant accessors ===
//
// Move `const`s are module-private; these expose the canonical codes to the
// policy package, tests, and any future adapter without duplicating literals.

public fun market_type_lending(): u8 { MARKET_TYPE_LENDING }

public fun market_type_perps(): u8 { MARKET_TYPE_PERPS }

public fun market_type_stablecoin(): u8 { MARKET_TYPE_STABLECOIN }

public fun market_type_demo(): u8 { MARKET_TYPE_DEMO }

public fun action_pause_borrows(): u8 { ACTION_PAUSE_BORROWS }

public fun action_unpause_borrows(): u8 { ACTION_UNPAUSE_BORROWS }

public fun action_reduce_ltv(): u8 { ACTION_REDUCE_LTV }

public fun action_restore_ltv(): u8 { ACTION_RESTORE_LTV }

public fun action_enter_guarded(): u8 { ACTION_ENTER_GUARDED }

public fun action_exit_guarded(): u8 { ACTION_EXIT_GUARDED }

public fun action_increase_margin(): u8 { ACTION_INCREASE_MARGIN }
