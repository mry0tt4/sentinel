// Feature: sentinel-risk-guardian, Property 11: Forbidden agent operations always rejected
//
// Property 11 (Forbidden agent operations always rejected): for ANY attempt by
// the agent (the `GuardianCap` holder) to transfer funds, change the policy
// owner/admin, remove/delete the `OverrideCap`, or edit the `RiskPolicy`'s own
// bounds/config, the policy package SHALL abort and apply no state change.
//
// Validates: Requirements 7.7, 16.7
//
// ## How this property is demonstrated
//
// Most of the forbidden operations are NOT representable in the package — they
// are structurally (compile-time) impossible, so there is no callable function
// to drive a runtime test against:
//
//   - "transfer funds"        : `RiskPolicy` holds no coin/balance fields, and
//                               no function in `sentinel_policy::policy` moves
//                               value, so there is no fund-transfer surface at
//                               all. (compile-time impossibility)
//   - "change admin"          : `owner` is set once in `create_policy` and has
//                               NO setter anywhere in the module. The agent
//                               path (`execute_guardian_action`) never writes
//                               it. (compile-time impossibility)
//   - "remove OverrideCap"    : `OverrideCap` is only ever *created* and
//                               *transferred* to the DAO; no function unpacks,
//                               deletes, or consumes it. (compile-time
//                               impossibility)
//
// What CAN be exercised at runtime is the reachable surface, and these tests
// enforce it on two fronts:
//
//   1. Positive proof that the guarded path is the ONLY agent mutation path and
//      that it cannot edit the policy: a successful `execute_guardian_action`
//      mutates the *market* but leaves the policy `owner`, the policy bounds
//      (`max_ltv_delta_bps` / `max_margin_delta_bps`), and the config `version`
//      untouched. The agent has no way to edit the policy's own configuration.
//
//   2. Config mutation REQUIRES an `OverrideCap` presented by its DAO: an agent
//      who is not the DAO, even if handed the DAO's `OverrideCap`, fails the
//      `dao_address` authority check (`ENotAuthorizedDao` = 14) when calling
//      `update_thresholds`, and no policy state changes. The agent cannot
//      obtain the authority to edit the policy.
#[test_only]
module sentinel_policy::forbidden_agent_ops_tests;

use sentinel_adapters::adapters;
use sentinel_demo_market::market::{Self, MarketState};
use sentinel_policy::policy::{Self, RiskPolicy, GuardianCap, OverrideCap};
use sui::clock;
use sui::test_scenario::{Self, Scenario};

// === Test fixtures ===

/// The agent address: holds the `GuardianCap`, is the policy `owner`, and is
/// the tx sender for the guardian action (so the agent-authority check passes).
const AGENT: address = @0xA1;
/// The DAO / governor address: holds the `OverrideCap`. The agent is NOT this
/// address, which is what makes the `update_thresholds` attempt unauthorized.
const DAO: address = @0xDA0;

// Initial demo-market configuration.
const INIT_COLLATERAL: u64 = 1_000_000;
const INIT_BORROW: u64 = 500_000;
const INIT_MAX_LTV_BPS: u64 = 8_000;
const INIT_MARGIN_BPS: u64 = 500;

// Generous per-action bounds + zero cooldown so the guarded reduce-ltv action
// in the positive control always succeeds (isolating the invariant assertions).
const MAX_LTV_DELTA_BPS: u64 = 1_000;
const MAX_MARGIN_DELTA_BPS: u64 = 200;
const PAUSE_DURATION_LIMIT_MS: u64 = 10_000;

// A fixed mock clock time, before the guardian cap expiry, with a zero cooldown.
const NOW_MS: u64 = 100;
const GUARDIAN_EXPIRES_AT_MS: u64 = 1_000_000;

/// Initialize a demo market and create a `RiskPolicy` (+ caps) scoped to it,
/// allowing reduce-ltv so the positive control's guarded action can succeed.
/// The policy `owner` is the create_policy sender (AGENT), the `OverrideCap`
/// goes to DAO, and the `GuardianCap` goes to AGENT.
#[test_only]
fun setup_market_and_policy(scenario: &mut Scenario) {
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

        policy::create_policy(
            market_id,
            adapters::market_type_demo(),
            AGENT,
            DAO,
            vector[adapters::action_reduce_ltv()],
            vector[market_id],
            MAX_LTV_DELTA_BPS,
            MAX_MARGIN_DELTA_BPS,
            PAUSE_DURATION_LIMIT_MS,
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

// === Positive proof: the guarded path mutates the MARKET but never the POLICY ===

/// A successful `execute_guardian_action` is the only mutation path available to
/// the agent. It applies the bounded market change (reduce-ltv 8000 -> 7500) but
/// leaves the policy `owner`, bounds (`max_ltv_delta_bps`,
/// `max_margin_delta_bps`), and `version` exactly as created. This proves the
/// agent cannot change the admin or edit the policy's own configuration through
/// its only reachable mutation path. (Req 7.7, 16.7)
#[test]
fun guardian_action_leaves_policy_owner_and_bounds_untouched() {
    let mut scenario = test_scenario::begin(AGENT);
    setup_market_and_policy(&mut scenario);

    // Capture the policy invariants as created (owner = AGENT, bounds, version).
    test_scenario::next_tx(&mut scenario, AGENT);
    {
        let risk_policy = test_scenario::take_shared<RiskPolicy>(&scenario);
        assert!(policy::policy_owner(&risk_policy) == AGENT, 0);
        assert!(policy::max_ltv_delta_bps(&risk_policy) == MAX_LTV_DELTA_BPS, 1);
        assert!(policy::max_margin_delta_bps(&risk_policy) == MAX_MARGIN_DELTA_BPS, 2);
        assert!(policy::policy_version(&risk_policy) == 1, 3);
        test_scenario::return_shared(risk_policy);
    };

    // The agent performs its only mutation: a bounded guarded action.
    test_scenario::next_tx(&mut scenario, AGENT);
    {
        let mut risk_policy = test_scenario::take_shared<RiskPolicy>(&scenario);
        let guardian_cap = test_scenario::take_from_sender<GuardianCap>(&scenario);
        let mut market_obj = test_scenario::take_shared<MarketState>(&scenario);

        let mut clock = clock::create_for_testing(scenario.ctx());
        clock::set_for_testing(&mut clock, NOW_MS);

        // 8000 -> 7500 (delta 500 <= 1000): in-scope, in-bounds, succeeds.
        policy::execute_guardian_action(
            &mut risk_policy,
            &guardian_cap,
            &mut market_obj,
            adapters::action_reduce_ltv(),
            7_500,
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

    // The market mutated, but every policy invariant is unchanged: the agent
    // could not change the admin/owner, the bounds, or the config version.
    test_scenario::next_tx(&mut scenario, AGENT);
    {
        let risk_policy = test_scenario::take_shared<RiskPolicy>(&scenario);
        let market_obj = test_scenario::take_shared<MarketState>(&scenario);

        // The guarded action committed on the market.
        assert!(market::max_ltv_bps(&market::get_state(&market_obj)) == 7_500, 4);

        // ...but the policy owner/admin is untouched.
        assert!(policy::policy_owner(&risk_policy) == AGENT, 5);
        // ...and the policy's own bounds are untouched.
        assert!(policy::max_ltv_delta_bps(&risk_policy) == MAX_LTV_DELTA_BPS, 6);
        assert!(policy::max_margin_delta_bps(&risk_policy) == MAX_MARGIN_DELTA_BPS, 7);
        // ...and the config version did not bump (no policy edit occurred).
        assert!(policy::policy_version(&risk_policy) == 1, 8);

        test_scenario::return_shared(risk_policy);
        test_scenario::return_shared(market_obj);
    };

    test_scenario::end(scenario);
}

// === Editing the policy REQUIRES an OverrideCap presented by its DAO ===

/// The agent attempts to edit the policy via `update_thresholds`. Even when
/// handed the DAO's real `OverrideCap` (so the cap-scope check passes), the
/// agent is NOT the cap's `dao_address`, so `assert_override_for_policy` aborts
/// with `ENotAuthorizedDao` (14) before any field is written. This proves the
/// agent cannot obtain the authority to edit the policy's bounds/config.
/// (Req 7.7, 16.7)
#[test]
#[expected_failure(abort_code = 14, location = sentinel_policy::policy)]
fun agent_cannot_update_thresholds_without_dao_authority() {
    let mut scenario = test_scenario::begin(AGENT);
    setup_market_and_policy(&mut scenario);

    // Sender = AGENT, presenting the DAO's OverrideCap: fails the dao_address
    // authority check.
    test_scenario::next_tx(&mut scenario, AGENT);
    {
        let mut risk_policy = test_scenario::take_shared<RiskPolicy>(&scenario);
        // The OverrideCap lives with the DAO; the agent borrows it but lacks the
        // authority to use it (sender != dao_address).
        let override_cap = test_scenario::take_from_address<OverrideCap>(&scenario, DAO);

        let mut clock = clock::create_for_testing(scenario.ctx());
        clock::set_for_testing(&mut clock, NOW_MS);

        policy::update_thresholds(
            &mut risk_policy,
            &override_cap,
            500,   // new_max_ltv_delta_bps
            100,   // new_max_margin_delta_bps
            5_000, // new_pause_duration_limit_ms
            10,    // new_cooldown_ms
            vector[70u64],
            &clock,
            scenario.ctx(),
        );

        clock::destroy_for_testing(clock);
        test_scenario::return_shared(risk_policy);
        test_scenario::return_to_address(DAO, override_cap);
    };

    test_scenario::end(scenario);
}
