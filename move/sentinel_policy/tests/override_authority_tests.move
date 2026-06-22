// Feature: sentinel-risk-guardian, Property 13: Override operations require a valid OverrideCap
//
// Property 13 (Override operations require a valid OverrideCap): for any call to
// `override_action`, `reverse_action`, `revoke_guardian`, `update_thresholds`, or
// `unpause_market` made *without* a valid `OverrideCap` for the target
// `RiskPolicy` (or with the relevant capability flag false), the policy package
// SHALL abort and leave state unchanged. Because each override operation runs
// `assert_override_for_policy` (and any required flag check) before any mutation,
// and enforcement + mutation share a single transaction, a failed authority
// check rolls back everything.
//
// The override-authority dimensions covered here (Req 8.13, 12.5) are:
//   - wrong caller : `update_thresholds` invoked by a sender that is NOT the
//                    cap's `dao_address` -> ENotAuthorizedDao (14)
//   - flag false   : `unpause_market` with `can_unpause_market == false`
//                    -> ECannotUnpauseMarket (19); `revoke_guardian` with
//                    `can_revoke_agent == false` -> ECannotRevokeAgent (17)
//   - wrong policy : an `OverrideCap` scoped to a DIFFERENT policy id
//                    -> EOverrideCapNotForPolicy (15)
//
// Validates: Requirements 8.13, 12.5
//
// Each negative test stands up a real demo `MarketState`, a `RiskPolicy`, and an
// `OverrideCap` configured so that the ONLY check that can fail is the
// override-authority check under test. A positive control confirms the harness
// is valid: with a fully-flagged DAO `OverrideCap` presented by the DAO,
// `update_thresholds` succeeds and bumps the policy `version`.
#[test_only]
module sentinel_policy::override_authority_tests;

use sentinel_adapters::adapters;
use sentinel_demo_market::market::{Self, MarketState};
use sentinel_policy::policy::{Self, RiskPolicy, GuardianCap, OverrideCap};
use sui::clock;
use sui::test_scenario::{Self, Scenario};

// === Test fixtures ===

/// The agent address: holds the `GuardianCap`.
const AGENT: address = @0xA1;
/// The DAO / governor address: holds the `OverrideCap` minted by `create_policy`.
const DAO: address = @0xDA0;
/// An unauthorized stranger: not the DAO, used to drive the `ENotAuthorizedDao`
/// path.
const STRANGER: address = @0xBAD;

// Initial demo-market configuration shared by every test.
const INIT_COLLATERAL: u64 = 1_000_000;
const INIT_BORROW: u64 = 500_000;
const INIT_MAX_LTV_BPS: u64 = 8_000;
const INIT_MARGIN_BPS: u64 = 500;

// Per-action bounds (irrelevant to the override-authority checks, but required
// by `create_policy`).
const MAX_LTV_DELTA_BPS: u64 = 1_000;
const MAX_MARGIN_DELTA_BPS: u64 = 200;
const PAUSE_DURATION_LIMIT_MS: u64 = 10_000;

// Mock-clock anchors.
const CREATE_NOW_MS: u64 = 100;
const GUARDIAN_EXPIRES_AT_MS: u64 = 1_000_000;

// New threshold values used by `update_thresholds` calls.
const NEW_MAX_LTV_DELTA_BPS: u64 = 2_000;
const NEW_MAX_MARGIN_DELTA_BPS: u64 = 400;
const NEW_PAUSE_DURATION_LIMIT_MS: u64 = 20_000;
const NEW_COOLDOWN_MS: u64 = 5_000;

/// Initialize a demo market and create a `RiskPolicy` (+ caps) scoped to it. The
/// DAO is granted the full set of override flags by `create_policy`; the agent
/// is authorized for reduce-ltv / pause-borrows on this market.
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
            0,
            GUARDIAN_EXPIRES_AT_MS,
            b"policy-config-blob",
            &clock,
            scenario.ctx(),
        );

        clock::destroy_for_testing(clock);
        test_scenario::return_shared(market_obj);
    };
}

// === Positive control: a fully-flagged DAO cap can update thresholds ===

/// With the DAO's full `OverrideCap` presented by the DAO itself,
/// `update_thresholds` succeeds: the policy `version` advances from 1 to 2 and
/// the new bounds are recorded. This proves the harness is valid, so the
/// negative tests abort on the authority check and not on misconfiguration.
#[test]
fun full_cap_dao_updates_thresholds() {
    let mut scenario = test_scenario::begin(AGENT);
    setup_market_and_policy(&mut scenario);

    // Sanity: a freshly created policy starts at version 1.
    test_scenario::next_tx(&mut scenario, DAO);
    {
        let risk_policy = test_scenario::take_shared<RiskPolicy>(&scenario);
        assert!(policy::policy_version(&risk_policy) == 1, 0);
        test_scenario::return_shared(risk_policy);
    };

    // tx (sender = DAO): update thresholds with the full override cap.
    test_scenario::next_tx(&mut scenario, DAO);
    {
        let mut risk_policy = test_scenario::take_shared<RiskPolicy>(&scenario);
        let override_cap = test_scenario::take_from_sender<OverrideCap>(&scenario);

        let mut clock = clock::create_for_testing(scenario.ctx());
        clock::set_for_testing(&mut clock, CREATE_NOW_MS);

        policy::update_thresholds(
            &mut risk_policy,
            &override_cap,
            NEW_MAX_LTV_DELTA_BPS,
            NEW_MAX_MARGIN_DELTA_BPS,
            NEW_PAUSE_DURATION_LIMIT_MS,
            NEW_COOLDOWN_MS,
            vector[70u64, 85u64],
            &clock,
            scenario.ctx(),
        );

        clock::destroy_for_testing(clock);
        test_scenario::return_shared(risk_policy);
        test_scenario::return_to_sender(&scenario, override_cap);
    };

    // Confirm the update committed: version bumped and bounds changed.
    test_scenario::next_tx(&mut scenario, DAO);
    {
        let risk_policy = test_scenario::take_shared<RiskPolicy>(&scenario);
        assert!(policy::policy_version(&risk_policy) == 2, 1);
        assert!(policy::max_ltv_delta_bps(&risk_policy) == NEW_MAX_LTV_DELTA_BPS, 2);
        assert!(policy::max_margin_delta_bps(&risk_policy) == NEW_MAX_MARGIN_DELTA_BPS, 3);
        test_scenario::return_shared(risk_policy);
    };
    test_scenario::end(scenario);
}

// === Wrong caller: update_thresholds by a non-DAO sender aborts (14) ===

/// `update_thresholds` presented by a sender that is NOT the cap's `dao_address`
/// aborts with ENotAuthorizedDao (14) before any mutation, so the policy
/// `version` and bounds are unchanged (the aborting transaction rolls back).
/// (Req 8.13, 12.5)
#[test]
#[expected_failure(abort_code = 14, location = sentinel_policy::policy)]
fun update_thresholds_by_non_dao_aborts() {
    let mut scenario = test_scenario::begin(AGENT);
    setup_market_and_policy(&mut scenario);

    // tx (sender = STRANGER): borrow the DAO's override cap but present it as a
    // non-DAO sender -> ENotAuthorizedDao.
    test_scenario::next_tx(&mut scenario, STRANGER);
    {
        let mut risk_policy = test_scenario::take_shared<RiskPolicy>(&scenario);
        let override_cap = test_scenario::take_from_address<OverrideCap>(&scenario, DAO);

        let mut clock = clock::create_for_testing(scenario.ctx());
        clock::set_for_testing(&mut clock, CREATE_NOW_MS);

        policy::update_thresholds(
            &mut risk_policy,
            &override_cap,
            NEW_MAX_LTV_DELTA_BPS,
            NEW_MAX_MARGIN_DELTA_BPS,
            NEW_PAUSE_DURATION_LIMIT_MS,
            NEW_COOLDOWN_MS,
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

// === Flag false: unpause_market without can_unpause_market aborts (19) ===

/// A valid, correctly-scoped `OverrideCap` presented by the DAO but with
/// `can_unpause_market == false` aborts `unpause_market` with
/// ECannotUnpauseMarket (19) before any market mutation. The cap is constructed
/// directly via `create_override_cap` (scoped to this policy, DAO sender) with
/// only the unpause flag false. (Req 8.13)
#[test]
#[expected_failure(abort_code = 19, location = sentinel_policy::policy)]
fun unpause_without_flag_aborts() {
    let mut scenario = test_scenario::begin(AGENT);
    setup_market_and_policy(&mut scenario);

    // tx (sender = DAO): build a cap with can_unpause_market = false and call
    // unpause_market -> ECannotUnpauseMarket.
    test_scenario::next_tx(&mut scenario, DAO);
    {
        let mut risk_policy = test_scenario::take_shared<RiskPolicy>(&scenario);
        let mut market_obj = test_scenario::take_shared<MarketState>(&scenario);
        let policy_id = object::id(&risk_policy);

        let no_unpause_cap = policy::create_override_cap(
            policy_id,
            DAO,
            true, // can_reverse_action
            true, // can_revoke_agent
            true, // can_update_thresholds
            false, // can_unpause_market  <-- the flag under test
            scenario.ctx(),
        );

        policy::unpause_market(
            &mut risk_policy,
            &no_unpause_cap,
            &mut market_obj,
            scenario.ctx(),
        );

        // Unreachable: the call above aborts. Present only so the freshly minted
        // cap is consumed on the (never-taken) success path for the type checker.
        transfer::public_transfer(no_unpause_cap, DAO);
        test_scenario::return_shared(risk_policy);
        test_scenario::return_shared(market_obj);
    };
    test_scenario::end(scenario);
}

// === Flag false: revoke_guardian without can_revoke_agent aborts (17) ===

/// A valid, correctly-scoped `OverrideCap` presented by the DAO but with
/// `can_revoke_agent == false` aborts `revoke_guardian` with ECannotRevokeAgent
/// (17) before the `GuardianCap` is touched, so the cap stays un-revoked (the
/// aborting transaction rolls back). (Req 12.5)
#[test]
#[expected_failure(abort_code = 17, location = sentinel_policy::policy)]
fun revoke_without_flag_aborts() {
    let mut scenario = test_scenario::begin(AGENT);
    setup_market_and_policy(&mut scenario);

    // tx (sender = DAO): build a cap with can_revoke_agent = false and call
    // revoke_guardian -> ECannotRevokeAgent.
    test_scenario::next_tx(&mut scenario, DAO);
    {
        let mut risk_policy = test_scenario::take_shared<RiskPolicy>(&scenario);
        let mut guardian_cap = test_scenario::take_from_address<GuardianCap>(&scenario, AGENT);
        let policy_id = object::id(&risk_policy);

        let no_revoke_cap = policy::create_override_cap(
            policy_id,
            DAO,
            true, // can_reverse_action
            false, // can_revoke_agent  <-- the flag under test
            true, // can_update_thresholds
            true, // can_unpause_market
            scenario.ctx(),
        );

        let mut clock = clock::create_for_testing(scenario.ctx());
        clock::set_for_testing(&mut clock, CREATE_NOW_MS);

        policy::revoke_guardian(
            &mut risk_policy,
            &no_revoke_cap,
            &mut guardian_cap,
            &clock,
            scenario.ctx(),
        );

        // Unreachable: the call above aborts. Present only to satisfy the type
        // checker on the (never-taken) success path.
        clock::destroy_for_testing(clock);
        transfer::public_transfer(no_revoke_cap, DAO);
        test_scenario::return_shared(risk_policy);
        test_scenario::return_to_address(AGENT, guardian_cap);
    };
    test_scenario::end(scenario);
}

// === Wrong policy: a cap scoped to a different policy aborts (15) ===

/// An `OverrideCap` whose `policy_id` does NOT match the target `RiskPolicy`
/// aborts `update_thresholds` with EOverrideCapNotForPolicy (15) — the scope
/// check runs first in `assert_override_for_policy`, before the sender check and
/// before any mutation. The mismatched cap is built against a bogus policy id.
/// (Req 8.13, 12.5)
#[test]
#[expected_failure(abort_code = 15, location = sentinel_policy::policy)]
fun cap_for_other_policy_aborts() {
    let mut scenario = test_scenario::begin(AGENT);
    setup_market_and_policy(&mut scenario);

    // tx (sender = DAO): build a cap scoped to a DIFFERENT policy id and call
    // update_thresholds -> EOverrideCapNotForPolicy.
    test_scenario::next_tx(&mut scenario, DAO);
    {
        let mut risk_policy = test_scenario::take_shared<RiskPolicy>(&scenario);

        // A policy id that is not this policy's id.
        let other_policy_id = object::id_from_address(@0xC0FFEE);
        let wrong_policy_cap = policy::create_override_cap(
            other_policy_id,
            DAO,
            true,
            true,
            true,
            true,
            scenario.ctx(),
        );

        let mut clock = clock::create_for_testing(scenario.ctx());
        clock::set_for_testing(&mut clock, CREATE_NOW_MS);

        policy::update_thresholds(
            &mut risk_policy,
            &wrong_policy_cap,
            NEW_MAX_LTV_DELTA_BPS,
            NEW_MAX_MARGIN_DELTA_BPS,
            NEW_PAUSE_DURATION_LIMIT_MS,
            NEW_COOLDOWN_MS,
            vector[70u64],
            &clock,
            scenario.ctx(),
        );

        // Unreachable: the call above aborts. Present only to satisfy the type
        // checker on the (never-taken) success path.
        clock::destroy_for_testing(clock);
        transfer::public_transfer(wrong_policy_cap, DAO);
        test_scenario::return_shared(risk_policy);
    };
    test_scenario::end(scenario);
}
