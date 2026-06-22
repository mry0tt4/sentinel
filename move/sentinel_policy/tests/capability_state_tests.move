// Feature: sentinel-risk-guardian, Property 9: On-chain capability-state rejection
//
// Property 9 (On-chain capability-state rejection): an autonomous guardian
// action presented under a capability whose *state* forbids it is rejected by
// `execute_guardian_action` with the matching capability-state error and — because
// every capability check runs before any market mutation and the enforcement +
// mutation share a single transaction — no state change is committed.
//
// The on-chain capability-state dimensions covered here (Req 8.10 enforcement
// order, Req 8.11) are:
//   - revoked  : the `GuardianCap` (and, by reflection, the policy) is revoked
//                via `revoke_guardian` -> ERevoked (4)            (Req 7.8, 12.3)
//   - expired  : the mocked `Clock` is advanced to/after the cap's
//                `expires_at_ms` -> EExpired (5)                  (Req 7.8, 8.11)
//   - cooldown : a successful action sets `last_action_timestamp_ms`, and a
//                second action within `cooldown_ms` -> ECooldownNotElapsed (8)
//                                                                 (Req 7.8, 8.11)
//
// NOTE on the "non-testnet" dimension (Req 17.8): rejecting non-testnet
// environments is enforced OFF-CHAIN by the Network Guard (covered by the 6.x
// backend/frontend tests), not by this Move module — the policy package is only
// ever deployed to Sui Testnet and has no notion of "network". On-chain, the
// capability-state rejection therefore covers revoked / expired / cooldown.
//
// Validates: Requirements 7.8, 8.10, 8.11, 12.3, 17.8
//
// Each negative test stands up a real demo `MarketState`, a `RiskPolicy`, and
// the agent's `GuardianCap` configured so that the ONLY check that can fail is
// the capability-state check under test (agent = tx sender, market/action in
// scope, deltas within bounds). The mocked `Clock` (sui::clock::create_for_testing
// / set_for_testing) drives the expiry and cooldown boundaries. A positive
// control confirms the harness is valid: with the cap live, unexpired, and the
// cooldown elapsed, the action succeeds and mutates the market.
#[test_only]
module sentinel_policy::capability_state_tests;

use sentinel_adapters::adapters;
use sentinel_demo_market::market::{Self, MarketState};
use sentinel_policy::policy::{Self, RiskPolicy, GuardianCap, OverrideCap};
use sui::clock;
use sui::test_scenario::{Self, Scenario};

// === Test fixtures ===

/// The agent address: holds the `GuardianCap` and is the tx sender for the
/// guardian action (so the `ENotAuthorizedAgent` check passes).
const AGENT: address = @0xA1;
/// The DAO / governor address: holds the `OverrideCap` and performs revocation.
const DAO: address = @0xDA0;

// Initial demo-market configuration shared by every test.
const INIT_COLLATERAL: u64 = 1_000_000;
const INIT_BORROW: u64 = 500_000;
const INIT_MAX_LTV_BPS: u64 = 8_000;
const INIT_MARGIN_BPS: u64 = 500;

// Generous per-action bounds so the capability-state check is always the only
// thing that can fail (or, in the positive control, nothing fails).
const MAX_LTV_DELTA_BPS: u64 = 1_000;
const MAX_MARGIN_DELTA_BPS: u64 = 200;
const PAUSE_DURATION_LIMIT_MS: u64 = 10_000;

// Mock-clock anchors.
const CREATE_NOW_MS: u64 = 100;
const GUARDIAN_EXPIRES_AT_MS: u64 = 1_000_000;

/// Initialize a demo market and create a `RiskPolicy` (+ caps) scoped to it,
/// with the agent authorized for reduce-ltv / pause-borrows on this market.
/// `cooldown_ms` is parameterized so the cooldown test can require spacing
/// while the other tests use a zero cooldown.
#[test_only]
fun setup_market_and_policy(scenario: &mut Scenario, cooldown_ms: u64) {
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
        clock::set_for_testing(&mut clock, CREATE_NOW_MS);

        let allowed_actions = vector[
            adapters::action_reduce_ltv(),
            adapters::action_pause_borrows(),
        ];

        policy::create_policy(
            market_id,
            adapters::market_type_demo(),
            AGENT,
            DAO,
            allowed_actions,
            vector[market_id],
            MAX_LTV_DELTA_BPS,
            MAX_MARGIN_DELTA_BPS,
            PAUSE_DURATION_LIMIT_MS,
            vector[80u64],
            cooldown_ms,
            GUARDIAN_EXPIRES_AT_MS,
            b"policy-config-blob",
            &clock,
            scenario.ctx(),
        );

        clock::destroy_for_testing(clock);
        test_scenario::return_shared(market_obj);
    };
}

/// Drive an in-bounds reduce-ltv (8000 -> `new_ltv`) at mock time `now_ms`.
/// Helper used by the success path and the positive control so the call shape
/// is identical to the negative tests.
#[test_only]
fun do_reduce_ltv(scenario: &mut Scenario, new_ltv: u64, now_ms: u64) {
    let mut risk_policy = test_scenario::take_shared<RiskPolicy>(scenario);
    let guardian_cap = test_scenario::take_from_sender<GuardianCap>(scenario);
    let mut market_obj = test_scenario::take_shared<MarketState>(scenario);

    let mut clock = clock::create_for_testing(scenario.ctx());
    clock::set_for_testing(&mut clock, now_ms);

    policy::execute_guardian_action(
        &mut risk_policy,
        &guardian_cap,
        &mut market_obj,
        adapters::action_reduce_ltv(),
        new_ltv,
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
    test_scenario::return_to_sender(scenario, guardian_cap);
}

// === Positive control: a live, unexpired, cooled-down cap succeeds ===

/// With the cap un-revoked, unexpired, and the (zero) cooldown satisfied, the
/// action is applied and the market is mutated — proving the negative tests
/// abort on the capability-state check and not on harness misconfiguration.
#[test]
fun live_cap_action_succeeds() {
    let mut scenario = test_scenario::begin(AGENT);
    setup_market_and_policy(&mut scenario, 0);

    test_scenario::next_tx(&mut scenario, AGENT);
    {
        // 8000 -> 7500 (delta 500 <= 1000) within bounds, before expiry.
        do_reduce_ltv(&mut scenario, 7_500, CREATE_NOW_MS);
    };

    // Confirm the mutation committed.
    test_scenario::next_tx(&mut scenario, AGENT);
    {
        let market_obj = test_scenario::take_shared<MarketState>(&scenario);
        assert!(market::max_ltv_bps(&market::get_state(&market_obj)) == 7_500, 0);
        test_scenario::return_shared(market_obj);
    };
    test_scenario::end(scenario);
}

// === Revoked: a revoked cap aborts with ERevoked (4), no state change ===

/// After the DAO revokes the `GuardianCap` (via `revoke_guardian`), an agent
/// action aborts with ERevoked (4) before any market mutation. (Req 7.8, 12.3)
#[test]
#[expected_failure(abort_code = 4, location = sentinel_policy::policy)]
fun revoked_cap_action_aborts() {
    let mut scenario = test_scenario::begin(AGENT);
    setup_market_and_policy(&mut scenario, 0);

    // tx (sender = DAO): revoke the agent's GuardianCap using the OverrideCap.
    // The cap is owned by AGENT but can be taken by address for the &mut arg.
    test_scenario::next_tx(&mut scenario, DAO);
    {
        let mut risk_policy = test_scenario::take_shared<RiskPolicy>(&scenario);
        let override_cap = test_scenario::take_from_sender<OverrideCap>(&scenario);
        let mut guardian_cap = test_scenario::take_from_address<GuardianCap>(&scenario, AGENT);

        let mut clock = clock::create_for_testing(scenario.ctx());
        clock::set_for_testing(&mut clock, CREATE_NOW_MS);

        policy::revoke_guardian(
            &mut risk_policy,
            &override_cap,
            &mut guardian_cap,
            &clock,
            scenario.ctx(),
        );

        clock::destroy_for_testing(clock);
        test_scenario::return_shared(risk_policy);
        test_scenario::return_to_sender(&scenario, override_cap);
        test_scenario::return_to_address(AGENT, guardian_cap);
    };

    // tx (sender = AGENT): the revoked cap cannot act -> ERevoked.
    test_scenario::next_tx(&mut scenario, AGENT);
    {
        do_reduce_ltv(&mut scenario, 7_500, CREATE_NOW_MS);
    };
    test_scenario::end(scenario);
}

// === Expired: a cap past its expiry aborts with EExpired (5), no state change ===

/// Advancing the mock clock to the cap's `expires_at_ms` makes the cap expired
/// (the check is strict `expires_at_ms > now_ms`), so the action aborts with
/// EExpired (5) before any market mutation. This exercises the expiry boundary.
/// (Req 7.8, 8.11)
#[test]
#[expected_failure(abort_code = 5, location = sentinel_policy::policy)]
fun expired_cap_action_aborts() {
    let mut scenario = test_scenario::begin(AGENT);
    setup_market_and_policy(&mut scenario, 0);

    test_scenario::next_tx(&mut scenario, AGENT);
    {
        // now_ms == expires_at_ms: not strictly before expiry -> expired.
        do_reduce_ltv(&mut scenario, 7_500, GUARDIAN_EXPIRES_AT_MS);
    };
    test_scenario::end(scenario);
}

// === Cooldown: a second action within cooldown aborts with
//     ECooldownNotElapsed (8), no state change ===

/// With a 1000 ms cooldown, a first action at t=2000 succeeds and records
/// `last_action_timestamp_ms = 2000`; a second action at t=2500 (only 500 ms
/// later, < cooldown) aborts with ECooldownNotElapsed (8) before any market
/// mutation. The mock clock drives both the satisfied first window
/// (2000 - 0 >= 1000) and the violated second window (2500 - 2000 < 1000).
/// (Req 7.8, 8.11)
#[test]
#[expected_failure(abort_code = 8, location = sentinel_policy::policy)]
fun action_within_cooldown_aborts() {
    let mut scenario = test_scenario::begin(AGENT);
    setup_market_and_policy(&mut scenario, 1_000);

    // First action at t=2000: 2000 - 0 >= 1000, succeeds (8000 -> 7800).
    test_scenario::next_tx(&mut scenario, AGENT);
    {
        do_reduce_ltv(&mut scenario, 7_800, 2_000);
    };

    // Second action at t=2500: 2500 - 2000 = 500 < 1000 cooldown -> aborts.
    test_scenario::next_tx(&mut scenario, AGENT);
    {
        do_reduce_ltv(&mut scenario, 7_700, 2_500);
    };
    test_scenario::end(scenario);
}
