// Feature: sentinel-risk-guardian, Property 14: Guardian revocation is atomic and idempotence
//
// Property 14 (Guardian revocation is atomic and idempotent): a valid
// `revoke_guardian` call flips the `GuardianCap.revoked` flag to `true`,
// reflects the revocation at the policy level (`policy.is_revoked == true`), and
// emits exactly one `GuardianRevoked` event — all within the SAME transaction.
// A subsequent (repeat) `revoke_guardian` call on the already-revoked cap is a
// no-op: the cap stays revoked and NO duplicate `GuardianRevoked` event is
// emitted (the transition + emit are guarded by `if (!guardian_cap.revoked)`).
//
// How the two halves are verified:
//   - ATOMICITY: the revoke runs in one transaction. `next_tx` returns the
//     `TransactionEffects` of that just-ended transaction, and
//     `test_scenario::num_user_events == 1` confirms exactly one user event (the
//     `GuardianRevoked` emit) was produced by the SAME transaction that flipped
//     the flags. A following transaction re-opens the shared policy and the
//     guardian cap and asserts `guardian_cap_revoked == true` and
//     `policy_is_revoked == true` committed.
//   - IDEMPOTENCE: a second revoke on the already-revoked cap runs in its own
//     transaction; its effects report `num_user_events == 0` (no duplicate
//     event), and the cap remains revoked.
//
// Validates: Requirements 12.1, 12.6
#[test_only]
module sentinel_policy::guardian_revocation_tests;

use sentinel_adapters::adapters;
use sentinel_demo_market::market::{Self, MarketState};
use sentinel_policy::policy::{Self, RiskPolicy, GuardianCap, OverrideCap};
use sui::clock;
use sui::test_scenario::{Self, Scenario};

// === Test fixtures ===

/// The agent address: holds the `GuardianCap` minted by `create_policy`.
const AGENT: address = @0xA1;
/// The DAO / governor address: holds the full-flagged `OverrideCap`.
const DAO: address = @0xDA0;

// Initial demo-market configuration.
const INIT_COLLATERAL: u64 = 1_000_000;
const INIT_BORROW: u64 = 500_000;
const INIT_MAX_LTV_BPS: u64 = 8_000;
const INIT_MARGIN_BPS: u64 = 500;

// Per-action bounds (irrelevant to revocation, but required by `create_policy`).
const MAX_LTV_DELTA_BPS: u64 = 1_000;
const MAX_MARGIN_DELTA_BPS: u64 = 200;
const PAUSE_DURATION_LIMIT_MS: u64 = 10_000;

// Mock-clock anchors.
const CREATE_NOW_MS: u64 = 100;
const REVOKE_NOW_MS: u64 = 500;
const GUARDIAN_EXPIRES_AT_MS: u64 = 1_000_000;

/// Initialize a demo market and create a `RiskPolicy` (+ caps) scoped to it. The
/// DAO is granted the full set of override flags by `create_policy` (so
/// `can_revoke_agent == true`); the `GuardianCap` is transferred to AGENT.
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

// === Property 14: revocation is atomic and idempotent ===

/// A valid DAO `revoke_guardian` flips the cap + policy revocation flags and
/// emits exactly one `GuardianRevoked` event in the SAME transaction; a repeat
/// revoke is a no-op with zero events and the cap stays revoked.
#[test]
fun guardian_revocation_is_atomic_and_idempotent() {
    let mut scenario = test_scenario::begin(AGENT);
    setup_market_and_policy(&mut scenario);

    // Pre-condition: the freshly created cap and policy are NOT revoked.
    test_scenario::next_tx(&mut scenario, DAO);
    {
        let risk_policy = test_scenario::take_shared<RiskPolicy>(&scenario);
        let guardian_cap = test_scenario::take_from_address<GuardianCap>(&scenario, AGENT);
        assert!(!policy::guardian_cap_revoked(&guardian_cap), 0);
        assert!(!policy::policy_is_revoked(&risk_policy), 1);
        test_scenario::return_shared(risk_policy);
        test_scenario::return_to_address(AGENT, guardian_cap);
    };

    // === ATOMICITY ===
    // tx (sender = DAO): the FIRST, valid revoke. This single transaction flips
    // `guardian_cap.revoked` and `policy.is_revoked` to true AND emits
    // `GuardianRevoked`.
    test_scenario::next_tx(&mut scenario, DAO);
    {
        let mut risk_policy = test_scenario::take_shared<RiskPolicy>(&scenario);
        let override_cap = test_scenario::take_from_sender<OverrideCap>(&scenario);
        // The `&mut GuardianCap` argument is taken from the AGENT's address.
        let mut guardian_cap = test_scenario::take_from_address<GuardianCap>(&scenario, AGENT);

        let mut clock = clock::create_for_testing(scenario.ctx());
        clock::set_for_testing(&mut clock, REVOKE_NOW_MS);

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

    // `next_tx` returns the effects of the transaction that just ended (the
    // revoke above). Exactly one user event proves the `GuardianRevoked` emit
    // and the flag flips happened in the SAME transaction.
    let effects = test_scenario::next_tx(&mut scenario, DAO);
    assert!(test_scenario::num_user_events(&effects) == 1, 2);

    // The revoke transaction committed both flags: the cap is revoked and the
    // policy reflects the revocation.
    {
        let risk_policy = test_scenario::take_shared<RiskPolicy>(&scenario);
        let guardian_cap = test_scenario::take_from_address<GuardianCap>(&scenario, AGENT);
        assert!(policy::guardian_cap_revoked(&guardian_cap), 3);
        assert!(policy::policy_is_revoked(&risk_policy), 4);
        test_scenario::return_shared(risk_policy);
        test_scenario::return_to_address(AGENT, guardian_cap);
    };

    // === IDEMPOTENCE ===
    // tx (sender = DAO): a SECOND revoke on the already-revoked cap. The
    // idempotence guard skips the transition + emit, so this transaction does
    // nothing observable.
    test_scenario::next_tx(&mut scenario, DAO);
    {
        let mut risk_policy = test_scenario::take_shared<RiskPolicy>(&scenario);
        let override_cap = test_scenario::take_from_sender<OverrideCap>(&scenario);
        let mut guardian_cap = test_scenario::take_from_address<GuardianCap>(&scenario, AGENT);

        let mut clock = clock::create_for_testing(scenario.ctx());
        clock::set_for_testing(&mut clock, REVOKE_NOW_MS);

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

    // The repeat revoke produced ZERO user events: no duplicate `GuardianRevoked`.
    let effects2 = test_scenario::next_tx(&mut scenario, DAO);
    assert!(test_scenario::num_user_events(&effects2) == 0, 5);

    // The cap remains revoked (revocation is monotonic) after the no-op repeat.
    {
        let risk_policy = test_scenario::take_shared<RiskPolicy>(&scenario);
        let guardian_cap = test_scenario::take_from_address<GuardianCap>(&scenario, AGENT);
        assert!(policy::guardian_cap_revoked(&guardian_cap), 6);
        assert!(policy::policy_is_revoked(&risk_policy), 7);
        test_scenario::return_shared(risk_policy);
        test_scenario::return_to_address(AGENT, guardian_cap);
    };

    test_scenario::end(scenario);
}
