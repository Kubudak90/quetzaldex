// TXE tests for the LiquidityPool contract (Sub-2: concentrated liquidity).
// Run with: pnpm test:noir
//
// Sub-1 tests (V2 deposit/withdraw happy paths) are dropped -- they depended on
// the old flat-pool PoolState shape. Sub-2 happy-path tests need real Token
// deployment for escrow + authwit machinery (cross-package limitation per
// Sub-3 R1 deferral pattern); those land in tests/integration/concentrated-lp
// .test.ts (Task 21 dormant scaffold).

use crate::LiquidityPool;
use crate::LiquidityPool::{integer_sqrt, PoolState, PositionNote};
use crate::LiquidityPool::buckets::{
    compute_deposit_in_range, compute_deposit_below_range, compute_deposit_above_range,
};
use aztec::{
    protocol::{
        address::AztecAddress,
        hash::poseidon2_hash,
        traits::{Deserialize, FromField, Serialize},
    },
    test::helpers::test_environment::TestEnvironment,
};

// Standard bucket test fixture.
global TEST_SQRT_LOWER: u128 = 1_000_000_000_000_000_000;
global TEST_SQRT_UPPER: u128 = 1_224_744_871_391_589_049;
global TEST_SQRT_P: u128     = 1_118_033_988_749_894_848;
global TEST_P_MIN_SQRT: u128 = 100_000_000_000_000_000;     // sqrt(0.01)
global TEST_GROWTH_NUM: u128 = 1_500_000_000_000_000_000;   // 1.5e18

unconstrained fn deploy_pool(
    env: &mut TestEnvironment,
    deployer: AztecAddress,
    token_a: AztecAddress,
    token_b: AztecAddress,
) -> AztecAddress {
    let initializer_call = LiquidityPool::interface().constructor(
        token_a, token_b, TEST_P_MIN_SQRT, TEST_GROWTH_NUM, deployer,
    );
    env.deploy("LiquidityPool").with_public_initializer(deployer, initializer_call)
}

// Pool-side V3 math parity tests (mirror circuits/clearing/src/test.nr's b1-b5).
// These exercise the pool's `buckets.nr` duplicate of the V3 primitives.

#[test]
unconstrained fn pool_b1_compute_deposit_in_range_basic() {
    let m = compute_deposit_in_range(
        1_000_000_000 as u128, 1_000_000_000 as u128,
        TEST_SQRT_P, TEST_SQRT_LOWER, TEST_SQRT_UPPER,
    );
    assert(m.l_used > 0 as u128, "in_range mints positive L");
    assert(m.used_a <= 1_000_000_000 as u128, "used_a never exceeds x_a");
    assert(m.used_b <= 1_000_000_000 as u128, "used_b never exceeds x_b");
}

#[test]
unconstrained fn pool_b3_compute_deposit_below_range() {
    let m = compute_deposit_below_range(1_000_000_000 as u128, TEST_SQRT_LOWER, TEST_SQRT_UPPER);
    assert(m.used_a == 1_000_000_000 as u128, "all A consumed below range");
    assert(m.used_b == 0 as u128, "no B consumed below range");
    assert(m.l_used > 0 as u128, "L minted");
}

#[test]
unconstrained fn pool_b4_compute_deposit_above_range() {
    let m = compute_deposit_above_range(1_000_000_000 as u128, TEST_SQRT_LOWER, TEST_SQRT_UPPER);
    assert(m.used_a == 0 as u128, "no A consumed above range");
    assert(m.used_b == 1_000_000_000 as u128, "all B consumed above range");
    assert(m.l_used > 0 as u128, "L minted");
}

#[test]
unconstrained fn position_note_serialization_round_trip() {
    let note = PositionNote {
        bucket_id: 5,
        lp_share: 1_000_000,
        cum_fee_a_per_share_at_deposit: 7,
        cum_fee_b_per_share_at_deposit: 9,
        nonce: 0x1234567890abcdef,
        owner: AztecAddress::from_field(0xdeadbeef),
    };
    let bytes = note.serialize();
    let back = PositionNote::deserialize(bytes);
    assert(back.bucket_id == note.bucket_id, "bucket_id mismatch");
    assert(back.lp_share == note.lp_share, "lp_share mismatch");
    assert(back.nonce == note.nonce, "nonce mismatch");
}

#[test]
unconstrained fn constructor_initializes_pool_state() {
    let mut env = TestEnvironment::new();
    let deployer = env.create_light_account();
    let pool = deploy_pool(&mut env, deployer, deployer, deployer);

    let state: PoolState =
        env.execute_utility(LiquidityPool::at(pool).get_pool_state());
    assert(state.reserve_a == 0 as u128, "reserve_a starts at 0");
    assert(state.reserve_b == 0 as u128, "reserve_b starts at 0");
    assert(state.current_sqrt_price == TEST_P_MIN_SQRT, "sqrt_p starts at p_min_sqrt");
}

// Audit-#3: set_orderbook is gated to the deploy-time admin. The admin (the
// deployer) can wire the orderbook once; any other caller is rejected, which
// prevents front-running the post-deploy wiring with a malicious orderbook.
#[test]
unconstrained fn admin_can_set_orderbook() {
    let mut env = TestEnvironment::new();
    let deployer = env.create_light_account();
    let pool = deploy_pool(&mut env, deployer, deployer, deployer);

    let orderbook = AztecAddress::from_field(0xab1cde);
    let _ = env.call_public(deployer, LiquidityPool::at(pool).set_orderbook(orderbook));
}

#[test(should_fail_with = "only admin may set orderbook")]
unconstrained fn set_orderbook_rejects_non_admin_caller() {
    let mut env = TestEnvironment::new();
    let deployer = env.create_light_account();
    let pool = deploy_pool(&mut env, deployer, deployer, deployer);

    // A non-admin account attempts to front-run the orderbook wiring.
    let attacker = env.create_light_account();
    let evil_orderbook = AztecAddress::from_field(0xdead);
    let _ = env.call_public(attacker, LiquidityPool::at(pool).set_orderbook(evil_orderbook));
}

#[test]
unconstrained fn integer_sqrt_basic() {
    // Sub-1 integer_sqrt helper is still used by some paths; sanity check.
    assert(integer_sqrt(0 as u128) == 0 as u128, "sqrt(0)==0");
    assert(integer_sqrt(1 as u128) == 1 as u128, "sqrt(1)==1");
    assert(integer_sqrt(4 as u128) == 2 as u128, "sqrt(4)==2");
    assert(integer_sqrt(10 as u128) == 3 as u128, "floor(sqrt(10))==3");
}

// ============================================================================
// Clearing soundness audit #1 -- pool_state_commitment binding.
//
// apply_clearing recomputes a Poseidon2 commitment over the LIVE pool state
// (current_sqrt_price + active bucket slots) and asserts it equals the
// commitment embedded in the ClearingSwap.  This blocks a proof-replay or
// stale-proof attack: a clearing proof generated against pool state S cannot
// be applied to pool state S' != S.
//
// TXE can drive apply_clearing directly because it is a plain #[external("public")]
// function (not #[only_self]).  We wire a light-account as the orderbook so the
// msg_sender == orderbook guard passes.
//
// Conservation (#2) and pair-binding (#3) adversarial paths require either a
// live Token contract (cross-package, not feasible in pool's TXE crate) or
// close_epoch_and_clear_verified whose inner std::verify_proof_with_type is a
// no-op/blocked oracle in TXE (see memory/reference_aztec_txe_recursive_verify.md
// and contracts/orderbook/src/test.nr line ~483-493).  Those are validated on
// testnet in Task 11 Step 6.
// ============================================================================

// Helper: build the zero BucketDelta used as filler in a ClearingSwap.
unconstrained fn zero_bucket_delta() -> LiquidityPool::BucketDelta {
    LiquidityPool::BucketDelta {
        bucket_id: 0,
        reserve_a_add: 0 as u128,
        reserve_a_sub: 0 as u128,
        reserve_b_add: 0 as u128,
        reserve_b_sub: 0 as u128,
        cum_fee_a_per_share_increment: 0 as u128,
        cum_fee_b_per_share_increment: 0 as u128,
    }
}

// Audit #1 adversarial: apply_clearing MUST revert when the embedded
// pool_state_commitment does not match the live recomputed commitment.
//
// Attack scenario: an aggregator replays a clearing proof generated against an
// earlier pool state.  The contract recomputes the commitment over CURRENT storage
// and asserts equality, so any mismatch (including a fabricated constant) reverts.
#[test(should_fail_with = "pool state commitment mismatch")]
unconstrained fn apply_clearing_rejects_fabricated_commitment() {
    let mut env = TestEnvironment::new();
    let deployer = env.create_light_account();
    let pool = deploy_pool(&mut env, deployer, deployer, deployer);

    // Wire an orderbook so the msg_sender guard passes.
    let orderbook_addr = env.create_light_account();
    let _ = env.call_public(deployer, LiquidityPool::at(pool).set_orderbook(orderbook_addr));

    let zdelta = zero_bucket_delta();

    // pool_state_commitment is deliberately wrong (0xdeadbeef != the live recompute).
    let bad_swap = LiquidityPool::ClearingSwap {
        a_to_pool: 0 as u128,
        b_to_pool: 0 as u128,
        a_from_pool: 0 as u128,
        b_from_pool: 0 as u128,
        active_bucket_deltas: [zdelta, zdelta, zdelta, zdelta],
        active_bucket_count: 0,
        current_sqrt_price_after: TEST_P_MIN_SQRT,
        pool_state_commitment: 0xdeadbeef,
    };

    // Called AS the orderbook: the msg_sender guard passes, but the commitment
    // check fires and reverts.
    let _ = env.call_public(orderbook_addr, LiquidityPool::at(pool).apply_clearing(bad_swap));
}

// Audit #1 happy-path: apply_clearing MUST succeed when the commitment matches
// the live pool state.
//
// With active_bucket_count = 0 and the freshly-constructed pool, the contract
// computes:
//   commit_input[0] = current_sqrt_price (= TEST_P_MIN_SQRT)
//   commit_input[1..24] = 0   (no active buckets)
//   live_commitment = poseidon2_hash(commit_input)
//
// We compute the same hash in the test and pass it as pool_state_commitment.
// apply_clearing must accept it and write the updated (still-zero) state.
#[test]
unconstrained fn apply_clearing_accepts_correct_commitment() {
    let mut env = TestEnvironment::new();
    let deployer = env.create_light_account();
    let pool = deploy_pool(&mut env, deployer, deployer, deployer);

    // Wire an orderbook so the msg_sender guard passes.
    let orderbook_addr = env.create_light_account();
    let _ = env.call_public(deployer, LiquidityPool::at(pool).set_orderbook(orderbook_addr));

    // Read back current_sqrt_price to stay robust against future constructor changes.
    let state: LiquidityPool::PoolState =
        env.execute_utility(LiquidityPool::at(pool).get_pool_state());
    // Sanity: constructor must set sqrt_p to p_min_sqrt.
    assert(state.current_sqrt_price == TEST_P_MIN_SQRT, "fixture: sqrt_p must equal TEST_P_MIN_SQRT");

    // Recompute the commitment the contract will compute for this state.
    // Field layout (25 elements, matching apply_clearing commit_input):
    //   [0] = current_sqrt_price as Field
    //   [1..24] = 0  (active_bucket_count = 0, no bucket slots filled)
    let mut commit_input: [Field; 25] = [0; 25];
    commit_input[0] = state.current_sqrt_price as Field;
    let correct_commitment = poseidon2_hash(commit_input);

    let zdelta = zero_bucket_delta();

    // All flows are 0 and active_bucket_count = 0, so no Token transfers are
    // attempted inside apply_clearing (the `if a_from_pool > 0` guards skip them).
    // current_sqrt_price_after can stay equal to the current price (no swap).
    let good_swap = LiquidityPool::ClearingSwap {
        a_to_pool: 0 as u128,
        b_to_pool: 0 as u128,
        a_from_pool: 0 as u128,
        b_from_pool: 0 as u128,
        active_bucket_deltas: [zdelta, zdelta, zdelta, zdelta],
        active_bucket_count: 0,
        current_sqrt_price_after: TEST_P_MIN_SQRT,
        pool_state_commitment: correct_commitment,
    };

    // Must succeed: commitment matches the live recompute.
    let _ = env.call_public(orderbook_addr, LiquidityPool::at(pool).apply_clearing(good_swap));
}

// ============================================================================
// Clearing soundness audit #2 -- aggregate-flow / bucket-delta binding.
//
// deriveAggregateFlows (aggregator/src/clearing.ts) defines the four ClearingSwap
// flow fields as the summed per-bucket deltas:
//   a_to_pool   = Sum reserve_a_add
//   a_from_pool = Sum reserve_a_sub
//   b_to_pool   = Sum reserve_b_add
//   b_from_pool = Sum reserve_b_sub
// These flows are UNCONSTRAINED circuit public inputs, so a malicious aggregator
// could send flows inconsistent with its proven deltas (a conservation/drain gap).
// apply_clearing now re-derives the sums on-chain and asserts equality.
//
// These tests build a genuine SINGLE-bucket clearing against a fresh pool (bucket 0
// reads all-zero storage, so the commitment is over [sqrt_p, 0,0,0,0,0,0, 0...]).
// We keep all *_sub / *_from_pool at 0 so NO Token transfer is attempted inside
// apply_clearing (no live Token in the pool TXE crate); the non-zero reserve_a_add
// only writes storage. The new flow asserts fire BEFORE any transfer, so the
// adversarial case reverts without ever touching Token.
// ============================================================================

// Helper: recompute the live commitment for a fresh pool with a single active
// bucket (bucket_id 0, all reserves/fees zero in storage) at sqrt_price `sqrt_p`.
unconstrained fn fresh_single_bucket_commitment(sqrt_p: u128) -> Field {
    // Field layout (25 elements, matching apply_clearing commit_input):
    //   [0]    = sqrt_p
    //   [1]    = bucket_id (0)
    //   [2..6] = reserve_a, reserve_b, liquidity, cum_fee_a, cum_fee_b (all 0)
    //   [7..24]= 0 (no further active buckets)
    let mut commit_input: [Field; 25] = [0; 25];
    commit_input[0] = sqrt_p as Field;
    // base = 1 + 0*6 = 1; bucket_id = 0 -> commit_input[1] = 0 (already zero).
    poseidon2_hash(commit_input)
}

// Audit #2 happy-path: a single-bucket clearing where a_to_pool == Sum reserve_a_add
// (and the other three flows == their sums == 0) MUST be accepted by the new check.
#[test]
unconstrained fn apply_clearing_accepts_matching_flows() {
    let mut env = TestEnvironment::new();
    let deployer = env.create_light_account();
    let pool = deploy_pool(&mut env, deployer, deployer, deployer);

    let orderbook_addr = env.create_light_account();
    let _ = env.call_public(deployer, LiquidityPool::at(pool).set_orderbook(orderbook_addr));

    let state: LiquidityPool::PoolState =
        env.execute_utility(LiquidityPool::at(pool).get_pool_state());
    assert(state.current_sqrt_price == TEST_P_MIN_SQRT, "fixture: sqrt_p must equal TEST_P_MIN_SQRT");

    // Single active bucket (id 0) depositing 1_000 of token A into the bucket.
    // reserve_a_add = 1_000 -> a_to_pool must equal 1_000 to pass the new check.
    // All *_sub / *_from_pool stay 0 (no Token transfer attempted).
    let mut delta = zero_bucket_delta();
    delta.reserve_a_add = 1_000 as u128;

    let zdelta = zero_bucket_delta();
    let good_swap = LiquidityPool::ClearingSwap {
        a_to_pool: 1_000 as u128,   // == Sum reserve_a_add
        b_to_pool: 0 as u128,       // == Sum reserve_b_add
        a_from_pool: 0 as u128,     // == Sum reserve_a_sub
        b_from_pool: 0 as u128,     // == Sum reserve_b_sub
        active_bucket_deltas: [delta, zdelta, zdelta, zdelta],
        active_bucket_count: 1,
        current_sqrt_price_after: TEST_P_MIN_SQRT,
        pool_state_commitment: fresh_single_bucket_commitment(state.current_sqrt_price),
    };

    // Must succeed: every flow equals its proven delta sum.
    let _ = env.call_public(orderbook_addr, LiquidityPool::at(pool).apply_clearing(good_swap));
}

// Audit #2 adversarial: a_from_pool (= 1) does NOT equal Sum reserve_a_sub (= 0),
// so apply_clearing MUST revert on the flow-binding check -- BEFORE any token moves.
#[test(should_fail_with = "a_from_pool != sum reserve_a_sub")]
unconstrained fn apply_clearing_rejects_inconsistent_a_from_pool() {
    let mut env = TestEnvironment::new();
    let deployer = env.create_light_account();
    let pool = deploy_pool(&mut env, deployer, deployer, deployer);

    let orderbook_addr = env.create_light_account();
    let _ = env.call_public(deployer, LiquidityPool::at(pool).set_orderbook(orderbook_addr));

    let state: LiquidityPool::PoolState =
        env.execute_utility(LiquidityPool::at(pool).get_pool_state());

    // Same valid single-bucket clearing as the happy path (correct commitment +
    // a_to_pool == reserve_a_add), but a_from_pool is tampered to 1 while
    // Sum reserve_a_sub is 0. The new assert fires before the *_from_pool transfer.
    let mut delta = zero_bucket_delta();
    delta.reserve_a_add = 1_000 as u128;

    let zdelta = zero_bucket_delta();
    let bad_swap = LiquidityPool::ClearingSwap {
        a_to_pool: 1_000 as u128,
        b_to_pool: 0 as u128,
        a_from_pool: 1 as u128,     // != Sum reserve_a_sub (0): the drain gap.
        b_from_pool: 0 as u128,
        active_bucket_deltas: [delta, zdelta, zdelta, zdelta],
        active_bucket_count: 1,
        current_sqrt_price_after: TEST_P_MIN_SQRT,
        pool_state_commitment: fresh_single_bucket_commitment(state.current_sqrt_price),
    };

    let _ = env.call_public(orderbook_addr, LiquidityPool::at(pool).apply_clearing(bad_swap));
}
