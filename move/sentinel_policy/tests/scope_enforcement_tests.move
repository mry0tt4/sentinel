// Feature: sentinel-risk-guardian, Property 10: On-chain scope enforcement
//
// Property 10 (On-chain scope enforcement): an autonomous guardian action whose
// target market is NOT in the cap's `allowed_markets`, or whose `action_type`
// is NOT in the cap's `allowed_actions`, is rejected by
// `execute_guardian_action` with the matching scope error and — because the
// scope checks run before any market mutation and the enforcement + mutation
// share a single transaction — no market state change is committed.
//
// The two on-chain scope dimensions (Req 8.10 enforcement order) are:
//   - market-scope : target market ∉ `allowed_markets` -> EMarketNotAllowed (6)
//                                                                       (Req 7.3)
//   - action-scope : `action_type` ∉ `allowed_actions` -> EActionNotAllowed (7)
//                                                                       (Req 7.4)
//
// Enforcement order matters: market-scope (check 3) runs BEFORE action-scope
// (check 4). To isolate EActionNotAllowed the harness keeps the market IN scope
// (so check 3 passes) and only the action out of scope; to isolate
// EMarketNotAllowed the harness drops the market from `allowed_markets` while
// keeping the attempted action a valid, in-scope action so the market check is
// the failing one.
//
// Validates: Requirements 7.3, 7.4
//
// Each negative test stands up a real demo `MarketState`, a `RiskPolicy`, and
// the agent's `GuardianCap` configured so that the ONLY check that can fail is
// the scope check under test (agent = tx sender, cap un-revoked/unexpired,
// cooldown satisfied, deltas within bounds). A positive control confirms the
// harness is valid: with the market AND action in scope, the action succeeds
// and mutates the market — proving the negative tests abort on the scope check
// and not on harness misconfiguration.
#[test_only]
module sentinel_policy::scope_enforcement_tests;

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

// Generous per-action bounds + zero cooldown so the scope check is always the
// only thing that can fail (or, in the positive control, nothing fails).
const MAX_LTV_DELTA_BPS: u64 = 1_000;
const MAX_MARGIN_DELTA_BPS: u64 = 200;
const PAUSE_DURATION_LIMIT_MS: u64 = 10_000;

// A fixed mock clock time. < the guardian cap expiry below and, with a zero
// cooldown and `last_action_timestamp_ms = 0`, always satisfies cooldown.
const NOW_MS: u64 = 100;
const GUARDIAN_EXPIRES_AT_MS: u64 = 1_000_000;

/// Initialize a demo market and create a `RiskPolicy` (+ caps) scoped to it.
/// `include_market_in_scope` controls whether the real market id is placed in
/// the cap's `allowed_markets` (true) or left out so the market is out of scope
/// (false). `allowed_actions` is parameterized so a test can withhold the
/// action it then attempts. A zero cooldown and generous bounds keep every
/// other check passing.
#[test_only]
fun setup_market_and_policy(
    scenario: &mut Scenario,
    include_market_in_scope: bool,
    allowed_actions: vector<u8>,
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

        // The cap's market scope: the real market when in scope, else empty so
        // the market is provably absent from `allowed_markets`.
        let allowed_markets = if (include_market_in_scope) {
            vector[market_id]
        } else {
            vector<ID>[]
        };

        policy::create_policy(
            market_id,
            adapters::market_type_demo(),
            AGENT,
            DAO,
            allowed_actions,
            allowed_markets,
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

/// Drive an in-bounds reduce-ltv (8000 -> `new_ltv`) at mock time `NOW_MS`.
/// Helper shared by the positive control and the market-scope test (both use a
/// reduce-ltv action so only the market-scope dimension differs).
#[test_only]
fun do_reduce_ltv(scenario: &mut Scenario, new_ltv: u64) {
    let mut risk_policy = test_scenario::take_shared<RiskPolicy>(scenario);
    let guardian_cap = test_scenario::take_from_sender<GuardianCap>(scenario);
    let mut market_obj = test_scenario::take_shared<MarketState>(scenario);

    let mut clock = clock::create_for_testing(scenario.ctx());
    clock::set_for_testing(&mut clock, NOW_MS);

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

// === Positive control: in-scope market + action succeeds and mutates ===

/// With the market in `allowed_markets` and reduce-ltv in `allowed_actions`,
/// the action is applied and the market is mutated — proving the negative tests
/// abort on the scope check and not on harness misconfiguration.
#[test]
fun in_scope_action_succeeds() {
    let mut scenario = test_scenario::begin(AGENT);
    setup_market_and_policy(&mut scenario, true, vector[adapters::action_reduce_ltv()]);

    test_scenario::next_tx(&mut scenario, AGENT);
    {
        // 8000 -> 7500 (delta 500 <= 1000): within bounds and in scope.
        do_reduce_ltv(&mut scenario, 7_500);
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

// === Market-scope: target market ∉ allowed_markets aborts with
//     EMarketNotAllowed (6), no state change ===

/// The cap's `allowed_markets` is empty, so the target market is out of scope.
/// reduce-ltv is in `allowed_actions` (so the action-scope check would pass),
/// which isolates the market-scope check (check 3) as the failing one: the call
/// aborts with EMarketNotAllowed (6) before any market mutation. (Req 7.3)
#[test]
#[expected_failure(abort_code = 6, location = sentinel_policy::policy)]
fun market_not_in_scope_aborts() {
    let mut scenario = test_scenario::begin(AGENT);
    // Market NOT in scope; action (reduce-ltv) IS allowed.
    setup_market_and_policy(&mut scenario, false, vector[adapters::action_reduce_ltv()]);

    test_scenario::next_tx(&mut scenario, AGENT);
    {
        // 8000 -> 7500 is within bounds; the only failing check is market-scope.
        do_reduce_ltv(&mut scenario, 7_500);
    };
    test_scenario::end(scenario);
}

// === Action-scope: action_type ∉ allowed_actions aborts with
//     EActionNotAllowed (7), no state change ===

/// The market IS in scope (so the market-scope check 3 passes) but the attempted
/// action (pause-borrows) is NOT in `allowed_actions` (which only grants
/// reduce-ltv). Because market-scope is verified before action-scope, this
/// isolates the action-scope check (check 4): the call aborts with
/// EActionNotAllowed (7) before any market mutation. (Req 7.4)
#[test]
#[expected_failure(abort_code = 7, location = sentinel_policy::policy)]
fun action_not_in_scope_aborts() {
    let mut scenario = test_scenario::begin(AGENT);
    // Market IN scope; only reduce-ltv allowed (pause-borrows withheld).
    setup_market_and_policy(&mut scenario, true, vector[adapters::action_reduce_ltv()]);

    test_scenario::next_tx(&mut scenario, AGENT);
    {
        let mut risk_policy = test_scenario::take_shared<RiskPolicy>(&scenario);
        let guardian_cap = test_scenario::take_from_sender<GuardianCap>(&scenario);
        let mut market_obj = test_scenario::take_shared<MarketState>(&scenario);

        let mut clock = clock::create_for_testing(scenario.ctx());
        clock::set_for_testing(&mut clock, NOW_MS);

        // pause-borrows is a valid, in-bounds action, but it is NOT in
        // `allowed_actions`, so the action-scope check rejects it.
        policy::execute_guardian_action(
            &mut risk_policy,
            &guardian_cap,
            &mut market_obj,
            adapters::action_pause_borrows(),
            0, // new_param_value (unused for pause-borrows)
            1_000, // pause_duration_ms within the 10_000 ms limit
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
