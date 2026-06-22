// Feature: sentinel-risk-guardian, Property 8: On-chain bound enforcement
//
// Property 8 (On-chain bound enforcement): an autonomous guardian action whose
// requested change exceeds a configured policy bound is rejected by
// `execute_guardian_action` with the matching bound error, and — because the
// bounds check runs before any market mutation and the enforcement + mutation
// share a single transaction — no market state change is committed.
//
// Validates: Requirements 7.5, 7.6, 7.9, 8.12
//
// These tests stand up a real demo `MarketState`, a `RiskPolicy`, and the
// agent's `GuardianCap` (agent = tx sender, market in `allowed_markets`, action
// in `allowed_actions`, cooldown satisfied, cap unexpired/un-revoked) so that
// the ONLY check that can fail is the per-action delta bound. Each over-cap
// action is expected to abort with the specific bound error:
//   - reduce-ltv over `max_ltv_delta_bps`        -> ELtvDeltaExceeded   (9)
//   - pause-borrows over `pause_duration_limit_ms` -> EPauseDurationExceeded (11)
//   - increase-margin over `max_margin_delta_bps` -> EMarginDeltaExceeded (10)
//
// For the margin case, `execute_guardian_action`'s increase-margin branch
// checks the margin delta bound (EMarginDeltaExceeded) BEFORE its terminal
// `abort EUnsupportedAction`; an over-cap delta therefore reaches the bound
// error first, which is what this test asserts.
//
// A positive control (an in-bounds reduce-ltv) confirms the harness is valid:
// when the change is within bounds the action succeeds and the market is
// mutated, proving the failing tests abort on the bound and not on harness
// misconfiguration.
#[test_only]
module sentinel_policy::bound_enforcement_tests;

use sentinel_adapters::adapters;
use sentinel_demo_market::market::{Self, MarketState};
use sentinel_policy::policy::{Self, RiskPolicy, GuardianCap};
use sui::clock;
use sui::test_scenario::{Self, Scenario};

// === Test fixtures ===

/// The agent address: holds the `GuardianCap` and is the tx sender for the
/// guardian action (so the `ENotAuthorizedAgent` check passes).
const AGENT: address = @0xA1;
/// The DAO / governor address (holds the `OverrideCap`; unused by these tests).
const DAO: address = @0xDA0;

// Initial demo-market configuration shared by every test.
const INIT_COLLATERAL: u64 = 1_000_000;
const INIT_BORROW: u64 = 500_000;
const INIT_MAX_LTV_BPS: u64 = 8_000;
const INIT_MARGIN_BPS: u64 = 500;

// A fixed mock clock time. Must be < the guardian cap expiry below and, with a
// zero cooldown and `last_action_timestamp_ms = 0`, always satisfies cooldown.
const NOW_MS: u64 = 100;
const GUARDIAN_EXPIRES_AT_MS: u64 = 1_000_000;

/// Initialize a demo market and create a `RiskPolicy` (+ caps) scoped to it,
/// with the agent authorized for pause-borrows / reduce-ltv / increase-margin
/// on this market and a zero cooldown. The per-action bound limits are
/// parameterized so each test can drive a single bound over its cap.
#[test_only]
fun setup_market_and_policy(
    scenario: &mut Scenario,
    max_ltv_delta_bps: u64,
    max_margin_delta_bps: u64,
    pause_duration_limit_ms: u64,
) {
    // tx 0 (the `begin` tx, sender = AGENT): create + share the demo market.
    market::init_market(
        INIT_COLLATERAL,
        INIT_BORROW,
        INIT_MAX_LTV_BPS,
        INIT_MARGIN_BPS,
        scenario.ctx(),
    );

    // tx 1 (sender = AGENT): read the shared market id and create the policy.
    test_scenario::next_tx(scenario, AGENT);
    {
        let market_obj = test_scenario::take_shared<MarketState>(scenario);
        let market_id = object::id(&market_obj);

        let mut clock = clock::create_for_testing(scenario.ctx());
        clock::set_for_testing(&mut clock, NOW_MS);

        let allowed_actions = vector[
            adapters::action_pause_borrows(),
            adapters::action_reduce_ltv(),
            adapters::action_increase_margin(),
        ];

        policy::create_policy(
            market_id,
            adapters::market_type_demo(),
            AGENT,
            DAO,
            allowed_actions,
            vector[market_id],
            max_ltv_delta_bps,
            max_margin_delta_bps,
            pause_duration_limit_ms,
            vector[80u64],
            0, // cooldown_ms: zero so the cooldown check always passes
            GUARDIAN_EXPIRES_AT_MS,
            b"policy-config-blob",
            &clock,
            scenario.ctx(),
        );

        clock::destroy_for_testing(clock);
        test_scenario::return_shared(market_obj);
    };
}

// === Positive control: in-bounds reduce-ltv succeeds and mutates the market ===

#[test]
fun in_bounds_reduce_ltv_succeeds() {
    let mut scenario = test_scenario::begin(AGENT);
    // max_ltv_delta_bps = 1000 allows a 500 bps reduction.
    setup_market_and_policy(&mut scenario, 1_000, 200, 10_000);

    test_scenario::next_tx(&mut scenario, AGENT);
    {
        let mut risk_policy = test_scenario::take_shared<RiskPolicy>(&scenario);
        let guardian_cap = test_scenario::take_from_sender<GuardianCap>(&scenario);
        let mut market_obj = test_scenario::take_shared<MarketState>(&scenario);

        let mut clock = clock::create_for_testing(scenario.ctx());
        clock::set_for_testing(&mut clock, NOW_MS);

        // Reduce max LTV 8000 -> 7500 (delta 500 <= 1000): within bounds.
        policy::execute_guardian_action(
            &mut risk_policy,
            &guardian_cap,
            &mut market_obj,
            adapters::action_reduce_ltv(),
            7_500, // new_param_value (new max LTV)
            0, // pause_duration_ms (unused for reduce-ltv)
            90, // risk_score
            b"evidence-blob",
            b"evidence-hash",
            b"tx-digest",
            &clock,
            scenario.ctx(),
        );

        // The bounded reduction was applied to the market.
        assert!(market::max_ltv_bps(&market::get_state(&market_obj)) == 7_500, 0);

        clock::destroy_for_testing(clock);
        test_scenario::return_shared(risk_policy);
        test_scenario::return_shared(market_obj);
        test_scenario::return_to_sender(&scenario, guardian_cap);
    };
    test_scenario::end(scenario);
}

// === Bound violations: each aborts with its specific bound error ===

/// reduce-ltv whose reduction exceeds `max_ltv_delta_bps` aborts with
/// ELtvDeltaExceeded (9) and commits no market change. (Req 7.5, 8.12)
#[test]
#[expected_failure(abort_code = 9, location = sentinel_policy::policy)]
fun reduce_ltv_over_cap_aborts() {
    let mut scenario = test_scenario::begin(AGENT);
    // max_ltv_delta_bps = 500; the action below requests a 1000 bps reduction.
    setup_market_and_policy(&mut scenario, 500, 200, 10_000);

    test_scenario::next_tx(&mut scenario, AGENT);
    {
        let mut risk_policy = test_scenario::take_shared<RiskPolicy>(&scenario);
        let guardian_cap = test_scenario::take_from_sender<GuardianCap>(&scenario);
        let mut market_obj = test_scenario::take_shared<MarketState>(&scenario);

        let mut clock = clock::create_for_testing(scenario.ctx());
        clock::set_for_testing(&mut clock, NOW_MS);

        // 8000 -> 7000 is a 1000 bps reduction, over the 500 bps cap: aborts.
        policy::execute_guardian_action(
            &mut risk_policy,
            &guardian_cap,
            &mut market_obj,
            adapters::action_reduce_ltv(),
            7_000,
            0,
            90,
            b"evidence-blob",
            b"evidence-hash",
            b"tx-digest",
            &clock,
            scenario.ctx(),
        );

        // Unreachable: the call above aborts. Cleanup exists only so the
        // success path type-checks; the abort discards the whole transaction,
        // guaranteeing no market state change.
        clock::destroy_for_testing(clock);
        test_scenario::return_shared(risk_policy);
        test_scenario::return_shared(market_obj);
        test_scenario::return_to_sender(&scenario, guardian_cap);
    };
    test_scenario::end(scenario);
}

/// pause-borrows whose duration exceeds `pause_duration_limit_ms` aborts with
/// EPauseDurationExceeded (11) and commits no market change. (Req 7.6, 8.12)
#[test]
#[expected_failure(abort_code = 11, location = sentinel_policy::policy)]
fun pause_borrows_over_cap_aborts() {
    let mut scenario = test_scenario::begin(AGENT);
    // pause_duration_limit_ms = 1000; the action below requests 5000 ms.
    setup_market_and_policy(&mut scenario, 1_000, 200, 1_000);

    test_scenario::next_tx(&mut scenario, AGENT);
    {
        let mut risk_policy = test_scenario::take_shared<RiskPolicy>(&scenario);
        let guardian_cap = test_scenario::take_from_sender<GuardianCap>(&scenario);
        let mut market_obj = test_scenario::take_shared<MarketState>(&scenario);

        let mut clock = clock::create_for_testing(scenario.ctx());
        clock::set_for_testing(&mut clock, NOW_MS);

        // 5000 ms pause exceeds the 1000 ms limit: aborts.
        policy::execute_guardian_action(
            &mut risk_policy,
            &guardian_cap,
            &mut market_obj,
            adapters::action_pause_borrows(),
            0, // new_param_value (unused for pause-borrows)
            5_000, // pause_duration_ms over the cap
            90,
            b"evidence-blob",
            b"evidence-hash",
            b"tx-digest",
            &clock,
            scenario.ctx(),
        );

        clock::destroy_for_testing(clock);
        test_scenario::return_shared(risk_policy);
        test_scenario::return_shared(market_obj);
        test_scenario::return_to_sender(&scenario, guardian_cap);
    };
    test_scenario::end(scenario);
}

/// increase-margin whose increase exceeds `max_margin_delta_bps` aborts with
/// EMarginDeltaExceeded (10). The bound check runs before the branch's terminal
/// `abort EUnsupportedAction`, so an over-cap delta is rejected on the bound.
/// (Req 7.9, 8.12)
#[test]
#[expected_failure(abort_code = 10, location = sentinel_policy::policy)]
fun increase_margin_over_cap_aborts() {
    let mut scenario = test_scenario::begin(AGENT);
    // max_margin_delta_bps = 200; the action below requests a 500 bps increase.
    setup_market_and_policy(&mut scenario, 1_000, 200, 10_000);

    test_scenario::next_tx(&mut scenario, AGENT);
    {
        let mut risk_policy = test_scenario::take_shared<RiskPolicy>(&scenario);
        let guardian_cap = test_scenario::take_from_sender<GuardianCap>(&scenario);
        let mut market_obj = test_scenario::take_shared<MarketState>(&scenario);

        let mut clock = clock::create_for_testing(scenario.ctx());
        clock::set_for_testing(&mut clock, NOW_MS);

        // current margin 500 -> 1000 is a 500 bps increase, over the 200 cap.
        // new_param_value (1000) >= current (500) so the EUnsupportedAction
        // direction guard passes, and the delta bound is the failing check.
        policy::execute_guardian_action(
            &mut risk_policy,
            &guardian_cap,
            &mut market_obj,
            adapters::action_increase_margin(),
            1_000, // new_param_value (new maintenance margin)
            0,
            90,
            b"evidence-blob",
            b"evidence-hash",
            b"tx-digest",
            &clock,
            scenario.ctx(),
        );

        clock::destroy_for_testing(clock);
        test_scenario::return_shared(risk_policy);
        test_scenario::return_shared(market_obj);
        test_scenario::return_to_sender(&scenario, guardian_cap);
    };
    test_scenario::end(scenario);
}
