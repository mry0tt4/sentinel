// Feature: sentinel-risk-guardian, Property 12: Successful action records and emits atomically
//
// Property 12 (Successful action records and emits atomically): a successful
// `execute_guardian_action` performs, within a SINGLE transaction, all of:
//   - sets `policy.last_action_timestamp_ms` to the action time (the cooldown
//     clock), so the next action is gated by `cooldown_ms` from this moment;
//   - creates and shares an immutable `ActionLog` carrying the supplied Walrus
//     evidence blob id, evidence hash, and tx digest (plus action type and
//     before/after values);
//   - emits exactly one `RiskActionExecuted` event.
// Because these three effects share `execute_guardian_action`'s single
// transaction, either all commit together or (on any failed check) none do.
//
// Validates: Requirements 8.14, 9.4, 16.8
//
// The test stands up a real demo `MarketState`, a `RiskPolicy`, and the agent's
// `GuardianCap` (agent = tx sender, market in `allowed_markets`, action in
// `allowed_actions`, zero cooldown, cap unexpired/un-revoked) so a within-bounds
// reduce-ltv at mock clock time NOW succeeds. The atomicity claim is checked two
// ways:
//   1. The event is asserted via the test framework: `next_tx` returns the
//      effects of the action transaction, and `test_scenario::num_user_events`
//      confirms exactly one user event (the `RiskActionExecuted` emit) was
//      produced by that same transaction.
//   2. In the NEXT transaction we re-open the shared `RiskPolicy` and the shared
//      `ActionLog` and assert the recorded timestamp, evidence references, and
//      before/after values — proving the timestamp write and the audit record
//      were committed by the action transaction.
#[test_only]
module sentinel_policy::successful_action_tests;

use sentinel_adapters::adapters;
use sentinel_demo_market::market::{Self, MarketState};
use sentinel_policy::policy::{Self, RiskPolicy, GuardianCap, ActionLog};
use sui::clock;
use sui::test_scenario::{Self, Scenario};

// === Test fixtures ===

/// The agent address: holds the `GuardianCap` and is the tx sender for the
/// guardian action (so the `ENotAuthorizedAgent` check passes).
const AGENT: address = @0xA1;
/// The DAO / governor address (holds the `OverrideCap`; unused by this test).
const DAO: address = @0xDA0;

// Initial demo-market configuration.
const INIT_COLLATERAL: u64 = 1_000_000;
const INIT_BORROW: u64 = 500_000;
const INIT_MAX_LTV_BPS: u64 = 8_000;
const INIT_MARGIN_BPS: u64 = 500;

// A fixed mock clock time. Must be < the guardian cap expiry below and, with a
// zero cooldown and `last_action_timestamp_ms = 0`, always satisfies cooldown.
const NOW_MS: u64 = 100;
const GUARDIAN_EXPIRES_AT_MS: u64 = 1_000_000;

// The evidence references supplied to the action and expected on the ActionLog.
const EVIDENCE_BLOB_ID: vector<u8> = b"walrus-evidence-blob-id";
const EVIDENCE_HASH: vector<u8> = b"evidence-sha256-hash";
const TX_DIGEST: vector<u8> = b"sui-tx-digest";
const RISK_SCORE: u8 = 90;

// reduce-ltv from 8000 -> 7500 (a 500 bps reduction, within the 1000 cap).
const NEW_MAX_LTV_BPS: u64 = 7_500;

/// Initialize a demo market and create a `RiskPolicy` (+ caps) scoped to it,
/// with the agent authorized for reduce-ltv on this market and a zero cooldown
/// so the only relevant checks are the in-bounds delta and the success path.
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

        let allowed_actions = vector[adapters::action_reduce_ltv()];

        policy::create_policy(
            market_id,
            adapters::market_type_demo(),
            AGENT,
            DAO,
            allowed_actions,
            vector[market_id],
            1_000, // max_ltv_delta_bps: allows the 500 bps reduction below
            200, // max_margin_delta_bps
            10_000, // pause_duration_limit_ms
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

// === Property 12: successful action records + emits atomically ===

#[test]
fun successful_action_records_and_emits_atomically() {
    let mut scenario = test_scenario::begin(AGENT);
    setup_market_and_policy(&mut scenario);

    // tx 2 (sender = AGENT): perform the successful guardian action. The
    // returned effects describe exactly this transaction.
    let effects = test_scenario::next_tx(&mut scenario, AGENT);
    {
        let mut risk_policy = test_scenario::take_shared<RiskPolicy>(&scenario);
        let guardian_cap = test_scenario::take_from_sender<GuardianCap>(&scenario);
        let mut market_obj = test_scenario::take_shared<MarketState>(&scenario);

        // Pre-condition: no prior action recorded.
        assert!(policy::policy_last_action_timestamp_ms(&risk_policy) == 0, 0);

        let mut action_clock = clock::create_for_testing(scenario.ctx());
        clock::set_for_testing(&mut action_clock, NOW_MS);

        // Within-bounds reduce-ltv 8000 -> 7500 at mock time NOW. On success
        // this sets the cooldown clock, writes+shares the ActionLog, and emits
        // RiskActionExecuted — all in this single transaction.
        policy::execute_guardian_action(
            &mut risk_policy,
            &guardian_cap,
            &mut market_obj,
            adapters::action_reduce_ltv(),
            NEW_MAX_LTV_BPS,
            0, // pause_duration_ms (unused for reduce-ltv)
            RISK_SCORE,
            EVIDENCE_BLOB_ID,
            EVIDENCE_HASH,
            TX_DIGEST,
            &action_clock,
            scenario.ctx(),
        );

        clock::destroy_for_testing(action_clock);
        test_scenario::return_shared(risk_policy);
        test_scenario::return_shared(market_obj);
        test_scenario::return_to_sender(&scenario, guardian_cap);
    };

    // (1) The emit is asserted via the framework: the action transaction
    // (whose effects are returned by the `next_tx` above) produced exactly one
    // user event — the `RiskActionExecuted` emit. This proves the event was
    // emitted in the SAME transaction as the state changes asserted below.
    assert!(test_scenario::num_user_events(&effects) == 1, 1);

    // tx 3 (sender = AGENT): re-open the shared policy and the shared ActionLog
    // to assert the action transaction committed both the timestamp write and
    // the audit record.
    test_scenario::next_tx(&mut scenario, AGENT);
    {
        let risk_policy = test_scenario::take_shared<RiskPolicy>(&scenario);
        let action_log = test_scenario::take_shared<ActionLog>(&scenario);
        let market_obj = test_scenario::take_shared<MarketState>(&scenario);

        // (2a) The cooldown clock (last action timestamp) was recorded as NOW.
        assert!(policy::policy_last_action_timestamp_ms(&risk_policy) == NOW_MS, 2);

        // (2b) The ActionLog exists as a shared object and carries the exact
        // Walrus evidence blob id, evidence hash, and tx digest passed in.
        assert!(policy::action_log_blob_id(&action_log) == EVIDENCE_BLOB_ID, 3);
        assert!(policy::action_log_evidence_hash(&action_log) == EVIDENCE_HASH, 4);
        assert!(policy::action_log_tx_digest(&action_log) == TX_DIGEST, 5);

        // (2c) The ActionLog records the action type, before/after values, risk
        // score, and the same timestamp as the policy cooldown clock.
        assert!(policy::action_log_action_type(&action_log) == adapters::action_reduce_ltv(), 6);
        assert!(policy::action_log_old_value(&action_log) == INIT_MAX_LTV_BPS, 7);
        assert!(policy::action_log_new_value(&action_log) == NEW_MAX_LTV_BPS, 8);
        assert!(policy::action_log_risk_score(&action_log) == RISK_SCORE, 9);
        assert!(policy::action_log_timestamp_ms(&action_log) == NOW_MS, 10);

        // The bounded reduction was also applied to the market in that same tx.
        assert!(market::max_ltv_bps(&market::get_state(&market_obj)) == NEW_MAX_LTV_BPS, 11);

        test_scenario::return_shared(risk_policy);
        test_scenario::return_shared(action_log);
        test_scenario::return_shared(market_obj);
    };

    test_scenario::end(scenario);
}
