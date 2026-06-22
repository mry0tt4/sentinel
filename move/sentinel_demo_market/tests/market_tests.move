/// Move unit tests for `sentinel_demo_market::market`.
///
/// Feature: sentinel-risk-guardian
///
/// Covers:
///   - Property 16: Demo market reset round-trip and admin gating
///     (Requirements 5.5, 5.6)
///   - Property 17: Demo market authorization gating
///     (Requirements 5.3, 5.4)
///
/// These exercise the authorization-witness discipline: the demo market only
/// applies a mutation when presented an `ActionTicket` whose market id, market
/// type, and action type authorize *this* market and *this* mutator, and the
/// admin-gated `reset_market` round-trip.
#[test_only]
module sentinel_demo_market::market_tests;

use sui::test_scenario as ts;
use sentinel_demo_market::market::{Self, MarketState};
use sentinel_adapters::adapters;

// Test actors.
const ADMIN: address = @0xAD;
const NOT_ADMIN: address = @0xB0B;

// Initial market parameters captured at `init_market` time. `reset_market`
// must restore exactly these.
const INIT_COLLATERAL: u64 = 1_000_000;
const INIT_BORROW: u64 = 500_000;
const INIT_MAX_LTV_BPS: u64 = 8_000;
const INIT_MAINT_MARGIN_BPS: u64 = 500;

// Mirror of the private abort codes in `sentinel_demo_market::market`, used by
// `expected_failure` annotations together with `location`.
const ENotAdmin: u64 = 1;
const EWrongMarket: u64 = 2;
const EWrongMarketType: u64 = 3;
const EWrongAction: u64 = 4;

/// Initialize a market owned by `ADMIN` and return the started scenario,
/// positioned in a fresh transaction sent by `ADMIN`.
fun start_with_market(): ts::Scenario {
    let mut scenario = ts::begin(ADMIN);
    {
        market::init_market(
            INIT_COLLATERAL,
            INIT_BORROW,
            INIT_MAX_LTV_BPS,
            INIT_MAINT_MARGIN_BPS,
            ts::ctx(&mut scenario),
        );
    };
    ts::next_tx(&mut scenario, ADMIN);
    scenario
}

// === Property 16: Demo market reset round-trip and admin gating ===

// Feature: sentinel-risk-guardian, Property 16: Demo market reset round-trip
// and admin gating. After a sequence of authorized mutations, an admin reset
// restores the market to its initialized values. (Requirements 5.5, 5.6)
#[test]
fun reset_market_restores_initial_values_round_trip() {
    let mut scenario = start_with_market();
    let mut state = ts::take_shared<MarketState>(&scenario);
    let market_id = object::id(&state);

    // Mutate via a valid `reduce-ltv` ticket authorizing THIS market.
    let reduce_ticket = adapters::new_action_ticket(
        market_id,
        adapters::market_type_demo(),
        adapters::action_reduce_ltv(),
        INIT_MAX_LTV_BPS,
        6_000,
    );
    market::reduce_ltv(&mut state, reduce_ticket);

    // Mutate via a valid `enter-guarded` ticket authorizing THIS market.
    let guard_ticket = adapters::new_action_ticket(
        market_id,
        adapters::market_type_demo(),
        adapters::action_enter_guarded(),
        0,
        0,
    );
    market::enter_guarded_mode(&mut state, guard_ticket);

    // Confirm the market actually changed before resetting.
    let mutated = market::get_state(&state);
    assert!(market::max_ltv_bps(&mutated) == 6_000, 100);
    assert!(market::is_guarded_mode(&mutated), 101);

    // Admin reset restores every initialized value (round-trip).
    market::reset_market(&mut state, ts::ctx(&mut scenario));
    let restored = market::get_state(&state);
    assert!(market::collateral_amount(&restored) == INIT_COLLATERAL, 102);
    assert!(market::borrow_amount(&restored) == INIT_BORROW, 103);
    assert!(market::max_ltv_bps(&restored) == INIT_MAX_LTV_BPS, 104);
    assert!(market::maintenance_margin_bps(&restored) == INIT_MAINT_MARGIN_BPS, 105);
    assert!(!market::is_borrow_paused(&restored), 106);
    assert!(!market::is_guarded_mode(&restored), 107);

    ts::return_shared(state);
    ts::end(scenario);
}

// Feature: sentinel-risk-guardian, Property 16: a reset invoked by a non-admin
// actor is rejected with `ENotAdmin` and applies no state change.
// (Requirement 5.6)
#[test]
#[expected_failure(abort_code = ENotAdmin, location = sentinel_demo_market::market)]
fun reset_market_rejects_non_admin() {
    let mut scenario = start_with_market();

    // Switch the sender to a non-admin actor.
    ts::next_tx(&mut scenario, NOT_ADMIN);
    let mut state = ts::take_shared<MarketState>(&scenario);

    // Aborts with ENotAdmin; no state change is applied.
    market::reset_market(&mut state, ts::ctx(&mut scenario));

    ts::return_shared(state);
    ts::end(scenario);
}

// === Property 17: Demo market authorization gating ===

// Feature: sentinel-risk-guardian, Property 17: a ticket targeting a DIFFERENT
// market id does not authorize this market; the mutator aborts with
// `EWrongMarket` and no state change occurs. (Requirements 5.3, 5.4)
#[test]
#[expected_failure(abort_code = EWrongMarket, location = sentinel_demo_market::market)]
fun mutator_rejects_ticket_for_wrong_market() {
    let scenario = start_with_market();
    let mut state = ts::take_shared<MarketState>(&scenario);

    // A ticket whose market id is some other object — not this market.
    let wrong_market_ticket = adapters::new_action_ticket(
        object::id_from_address(@0xCAFE),
        adapters::market_type_demo(),
        adapters::action_enter_guarded(),
        0,
        0,
    );
    market::enter_guarded_mode(&mut state, wrong_market_ticket);

    ts::return_shared(state);
    ts::end(scenario);
}

// Feature: sentinel-risk-guardian, Property 17: a ticket for a non-demo market
// type does not authorize this market; the mutator aborts with
// `EWrongMarketType` and no state change occurs. (Requirements 5.3, 5.4)
#[test]
#[expected_failure(abort_code = EWrongMarketType, location = sentinel_demo_market::market)]
fun mutator_rejects_ticket_for_wrong_market_type() {
    let scenario = start_with_market();
    let mut state = ts::take_shared<MarketState>(&scenario);
    let market_id = object::id(&state);

    // Correct market id and action, but a lending (non-demo) market type.
    let wrong_type_ticket = adapters::new_action_ticket(
        market_id,
        adapters::market_type_lending(),
        adapters::action_enter_guarded(),
        0,
        0,
    );
    market::enter_guarded_mode(&mut state, wrong_type_ticket);

    ts::return_shared(state);
    ts::end(scenario);
}

// Feature: sentinel-risk-guardian, Property 17: a ticket authorizing a
// DIFFERENT action does not authorize this mutator; the call aborts with
// `EWrongAction` and no state change occurs. (Requirements 5.3, 5.4)
#[test]
#[expected_failure(abort_code = EWrongAction, location = sentinel_demo_market::market)]
fun mutator_rejects_ticket_for_wrong_action() {
    let scenario = start_with_market();
    let mut state = ts::take_shared<MarketState>(&scenario);
    let market_id = object::id(&state);

    // Correct market id and demo type, but a pause-borrows ticket handed to the
    // enter-guarded mutator.
    let wrong_action_ticket = adapters::new_action_ticket(
        market_id,
        adapters::market_type_demo(),
        adapters::action_pause_borrows(),
        0,
        0,
    );
    market::enter_guarded_mode(&mut state, wrong_action_ticket);

    ts::return_shared(state);
    ts::end(scenario);
}
