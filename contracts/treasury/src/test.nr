// TXE tests for Treasury.
// Run with: pnpm test:noir
//
// TXE limitation: env.deploy("@token/Token") resolves to the CURRENT crate's
// target/ folder, so Treasury TXE tests cannot deploy a real Token. We test
// only the assertion paths that fire BEFORE any Token call (only_orderbook,
// only_deployer, pay_aggregator zero-amount no-op). Full happy-path coverage
// (T1 full pay, T2 silent partial with real Token, T4 deposit) is deferred to
// the Task 18 e2e where deploy-tokens.ts wires real Token + Treasury together.

use crate::Treasury;
use aztec::{
    protocol::{address::{AztecAddress, EthAddress}, traits::FromField},
    test::helpers::test_environment::TestEnvironment,
};

// Deploy Treasury with sentinel bond_token + a STAND-IN aggregator_registry.
// TXE env.deploy only resolves the current crate's artifact, so a real
// AggregatorRegistry cannot be deployed here (same limitation that blocks a real
// Token). The R3 bonded-gate on consume_relayer_claim cross-calls the registry,
// so its success/revert behaviour is exercised in the integration e2e, NOT in
// TXE -- mirroring how the Orderbook's identical _assert_aggregator_registered
// gate is covered. TXE here covers the non-cross-contract asserts (queue fee cap).
unconstrained fn deploy_treasury(
    env: &mut TestEnvironment,
    deployer: AztecAddress,
    orderbook_addr: AztecAddress,
) -> AztecAddress {
    let token_sentinel = AztecAddress::from_field(0xCA1);
    let registry_standin = AztecAddress::from_field(0xA6E7); // not exercised unless consume is called
    let treasury_init =
        Treasury::interface().constructor(token_sentinel, orderbook_addr, registry_standin, deployer);
    env.deploy("Treasury").with_public_initializer(deployer, treasury_init)
}

#[test]
unconstrained fn constructor_sets_immutables_and_zero_balance() {
    let mut env = TestEnvironment::new();
    let deployer = env.create_light_account();
    let orderbook = env.create_light_account();

    let treasury = deploy_treasury(&mut env, deployer, orderbook);

    let stored_orderbook: AztecAddress =
        env.execute_utility(Treasury::at(treasury).get_orderbook_addr());
    assert(stored_orderbook == orderbook, "orderbook_addr mismatch");

    let tracked: u128 =
        env.execute_utility(Treasury::at(treasury).get_tracked_balance());
    assert(tracked == 0 as u128, "fresh treasury must report tracked_balance=0");
}

#[test(should_fail_with = "only orderbook")]
unconstrained fn t3_pay_aggregator_rejects_non_orderbook_caller() {
    let mut env = TestEnvironment::new();
    let deployer = env.create_light_account();
    let orderbook = env.create_light_account();
    let stranger = env.create_light_account();
    let winner = env.create_light_account();

    let treasury = deploy_treasury(&mut env, deployer, orderbook);

    env.call_public(stranger, Treasury::at(treasury).pay_aggregator(winner, 500_000));
}

#[test]
unconstrained fn t1b_pay_aggregator_zero_amount_is_noop() {
    // Edge case: if aggregator_fee is configured as 0, pay_aggregator must
    // succeed without making any Token call (the inner `if pay > 0` guard
    // skips the Token cross-contract call entirely). Token is not deployed
    // in this TXE test; the path under test never touches it.
    let mut env = TestEnvironment::new();
    let deployer = env.create_light_account();
    let orderbook = env.create_light_account();
    let winner = env.create_light_account();

    let treasury = deploy_treasury(&mut env, deployer, orderbook);

    env.call_public(orderbook, Treasury::at(treasury).pay_aggregator(winner, 0 as u128));

    let tracked_after: u128 =
        env.execute_utility(Treasury::at(treasury).get_tracked_balance());
    assert(tracked_after == 0, "tracked_balance unchanged on zero pay");
}

#[test(should_fail_with = "only deployer")]
unconstrained fn t4_seed_public_rejects_non_deployer() {
    let mut env = TestEnvironment::new();
    let deployer = env.create_light_account();
    let orderbook = env.create_light_account();
    let stranger = env.create_light_account();

    let treasury = deploy_treasury(&mut env, deployer, orderbook);

    env.call_public(stranger, Treasury::at(treasury).seed_public(100));
}

#[test]
unconstrained fn seed_public_increments_tracked_balance_for_deployer() {
    let mut env = TestEnvironment::new();
    let deployer = env.create_light_account();
    let orderbook = env.create_light_account();

    let treasury = deploy_treasury(&mut env, deployer, orderbook);

    env.call_public(deployer, Treasury::at(treasury).seed_public(123_456));
    let tracked: u128 =
        env.execute_utility(Treasury::at(treasury).get_tracked_balance());
    assert(tracked == 123_456, "seed_public must increment tracked_balance");

    // Second seed adds.
    env.call_public(deployer, Treasury::at(treasury).seed_public(1_000));
    let tracked2: u128 =
        env.execute_utility(Treasury::at(treasury).get_tracked_balance());
    assert(tracked2 == 124_456, "tracked_balance accumulates across seeds");
}

// -- Sub-5c D1: relayer claim queue tests --------------------------------------

#[test]
unconstrained fn sub5c_queue_relayer_claim_appends() {
    let mut env = TestEnvironment::new();
    let deployer = env.create_light_account();
    let orderbook = env.create_light_account();

    let treasury = deploy_treasury(&mut env, deployer, orderbook);

    let maker = env.create_light_account();
    let l1_recipient = EthAddress::from_field(0xabcdef);

    let claim_id: u64 = env.call_public(
        maker,
        Treasury::at(treasury).queue_relayer_claim(
            0xfeed as Field,
            0xbeef as Field,
            l1_recipient,
            1_000_000 as u128,
            5_000 as u128,
        ),
    );
    assert(claim_id == 0, "first claim id must be 0");

    let count: u32 =
        env.execute_utility(Treasury::at(treasury).get_pending_relayer_claims_count());
    assert(count == 1, "count must be 1 after one queue");
}

// L18: a single sender may hold at most MAX_PENDING_PER_SENDER (4) of the
// shared 32-slot queue. This test queues 4 from one sender (all OK), then
// verifies the 5th is rejected before the global-cap check is even reached.
#[test(should_fail_with = "per-sender claim cap")]
unconstrained fn sub5c_queue_relayer_claim_rejects_per_sender_cap() {
    let mut env = TestEnvironment::new();
    let deployer = env.create_light_account();
    let orderbook = env.create_light_account();

    let treasury = deploy_treasury(&mut env, deployer, orderbook);

    let maker = env.create_light_account();
    let l1_recipient = EthAddress::from_field(0xabcdef);

    // Queue MAX_PENDING_PER_SENDER (4) claims -- all must succeed.
    for i in 0..4 {
        env.call_public(
            maker,
            Treasury::at(treasury).queue_relayer_claim(
                i as Field,
                (0xdead + i) as Field,
                l1_recipient,
                1_000 as u128,
                1 as u128,
            ),
        );
    }
    // 5th claim from the same sender must revert "per-sender claim cap".
    env.call_public(
        maker,
        Treasury::at(treasury).queue_relayer_claim(
            99 as Field,
            99 as Field,
            l1_recipient,
            1_000 as u128,
            1 as u128,
        ),
    );
}

// Global queue-full cap: 8 distinct senders x 4 claims each = 32 slots filled
// (MAX_PENDING_RELAYER_CLAIMS). A 9th sender's first claim must then revert
// "queue full" because the global count check fires before the per-sender check.
#[test(should_fail_with = "queue full")]
unconstrained fn sub5c_queue_relayer_claim_rejects_overflow() {
    let mut env = TestEnvironment::new();
    let deployer = env.create_light_account();
    let orderbook = env.create_light_account();

    let treasury = deploy_treasury(&mut env, deployer, orderbook);

    let l1_recipient = EthAddress::from_field(0xabcdef);

    // Create 8 distinct senders (each will hold exactly 4 claims).
    let sender0 = env.create_light_account();
    let sender1 = env.create_light_account();
    let sender2 = env.create_light_account();
    let sender3 = env.create_light_account();
    let sender4 = env.create_light_account();
    let sender5 = env.create_light_account();
    let sender6 = env.create_light_account();
    let sender7 = env.create_light_account();

    let senders = [sender0, sender1, sender2, sender3, sender4, sender5, sender6, sender7];
    // Fill all 32 slots: 8 senders x 4 claims each.
    for sender in senders {
        for i in 0..4 {
            env.call_public(
                sender,
                Treasury::at(treasury).queue_relayer_claim(
                    i as Field,
                    i as Field,
                    l1_recipient,
                    1_000 as u128,
                    1 as u128,
                ),
            );
        }
    }

    // 33rd claim from a fresh 9th sender must revert "queue full".
    let sender8 = env.create_light_account();
    env.call_public(
        sender8,
        Treasury::at(treasury).queue_relayer_claim(
            0 as Field,
            0 as Field,
            l1_recipient,
            1_000 as u128,
            1 as u128,
        ),
    );
}

// R3: queue_relayer_claim must reject a fee larger than the claimed exit amount,
// so a single claim can never authorize a payout exceeding its own stated amount
// (blast-radius bound on top of the consume bonded-gate).
#[test(should_fail_with = "fee exceeds claim amount")]
unconstrained fn r3_queue_relayer_claim_rejects_fee_exceeding_amount() {
    let mut env = TestEnvironment::new();
    let deployer = env.create_light_account();
    let orderbook = env.create_light_account();

    let treasury = deploy_treasury(&mut env, deployer, orderbook);

    let maker = env.create_light_account();
    let l1_recipient = EthAddress::from_field(0xabcdef);

    // amount = 1, fee = the would-be entire pool. Pre-R3 this queued fine and a
    // permissionless consume drained tracked_balance. Now it must revert.
    env.call_public(
        maker,
        Treasury::at(treasury).queue_relayer_claim(
            0xfeed as Field,
            0xbeef as Field,
            l1_recipient,
            1 as u128,
            1_000_000_000 as u128,
        ),
    );
}

// R3: consume_relayer_claim now gates the caller to a bonded aggregator
// (view_bonded_amount(msg_sender) > 0) and pays min(fee, amount, balance). That
// cross-contract view + the Token fee transfer can't run in TXE (no cross-crate
// env.deploy of AggregatorRegistry/Token), so the consume happy-path AND the
// "caller is not a bonded aggregator" revert are covered in the Task 18
// integration e2e, exactly like the Orderbook's identical bonded gate. The
// previous TXE consume test (which relied on a permissionless consume) is
// intentionally removed: a permissionless consume is the very drain R3 closes.

// -- L18: per-sender cap pure helper -------------------------------------------

// L18: a maker may hold at most MAX_PENDING_PER_SENDER of the shared 32-slot relayer
// queue, so one actor cannot spam-fill it and DoS honest makers' queue_relayer_claim.
#[test]
fn l18_under_sender_cap_boundary() {
    assert(crate::under_sender_cap(0, 4), "0 < 4 ok");
    assert(crate::under_sender_cap(3, 4), "3 < 4 ok (last allowed)");
    assert(!crate::under_sender_cap(4, 4), "4 == cap rejected");
    assert(!crate::under_sender_cap(5, 4), "5 > cap rejected");
}
