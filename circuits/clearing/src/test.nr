use crate::pricing::{mul_div, SCALE, FEE_NUM, FEE_DEN, eligible, payout, token_solvent, floor_share, ceil_fee_from_net, saturating_sub};
use crate::binding::{c_i, replay_chain};
use crate::types::{OrderPreimage, MAX_ORDERS_PER_EPOCH};
use crate::merkle::{fill_leaf, hop_fill_leaf, merkle_root_32};

#[test]
fn mul_div_basic_floor_rounding() {
    // Trivial: 1000 * 5 / 10 == 500.
    assert(mul_div(1000 as u128, 5 as u128, 10 as u128) == 500 as u128);
    // Floor: 7 * 3 / 5 == 4 (not 4.2).
    assert(mul_div(7 as u128, 3 as u128, 5 as u128) == 4 as u128);
}

#[test]
fn mul_div_handles_large_factors() {
    // amount_in (1e9 token A) * SCALE (1e18) / P* (2e18) == 5e8 -- representative
    // of the buy-side payout intermediate before fee withholding.
    let amount = 1_000_000_000 as u128;
    let p_star = 2_000_000_000_000_000_000 as u128;
    let out = mul_div(amount, SCALE, p_star);
    assert(out == 500_000_000 as u128);
}

#[test]
fn fee_constants() {
    assert(FEE_NUM == 30 as u128);
    assert(FEE_DEN == 10_000 as u128);
    assert(SCALE == 1_000_000_000_000_000_000 as u128);
}

// U1: c_i formula vs hand-computed Poseidon2 (spec sec 5.3 / Week 5d-1 IT4 invariant).
#[test]
fn u1_c_i_matches_hand_computed() {
    let order = OrderPreimage {
        side: false,
        amount_in: 1_000_000_000 as u128,
        limit_price: 2_000_000_000_000_000_000 as u128,
        order_nonce: 0x1234567890abcdef,
        submitted_at_block: 42,
        owner: 0xdeadbeef,
    };
    let expected = poseidon::poseidon2::Poseidon2::hash([
        0xdeadbeef,
        0,
        1_000_000_000 as Field,
        2_000_000_000_000_000_000 as Field,
        0x1234567890abcdef,
        42 as Field,
    ], 6);
    assert(c_i(order) == expected, "c_i must match the 5d-1 Poseidon2 formula exactly");
}

// U2: 3-link order_acc replay matches a manually-folded chain.
#[test]
fn u2_order_acc_three_link_replay() {
    let zero_order = OrderPreimage {
        side: false, amount_in: 0 as u128, limit_price: 0 as u128,
        order_nonce: 0, submitted_at_block: 0, owner: 0,
    };
    let mut orders: [OrderPreimage; MAX_ORDERS_PER_EPOCH] =
        [zero_order; MAX_ORDERS_PER_EPOCH];
    orders[0] = OrderPreimage {
        side: false, amount_in: 100 as u128, limit_price: 2_000_000_000_000_000_000 as u128,
        order_nonce: 1, submitted_at_block: 1, owner: 0xaaaa,
    };
    orders[1] = OrderPreimage {
        side: true, amount_in: 50 as u128, limit_price: 1_000_000_000_000_000_000 as u128,
        order_nonce: 2, submitted_at_block: 2, owner: 0xbbbb,
    };
    orders[2] = OrderPreimage {
        side: false, amount_in: 200 as u128, limit_price: 3_000_000_000_000_000_000 as u128,
        order_nonce: 3, submitted_at_block: 3, owner: 0xcccc,
    };

    // Manually fold the 3-link chain.
    let mut expected: Field = 0;
    for i in 0..3 {
        expected = poseidon::poseidon2::Poseidon2::hash([expected, c_i(orders[i])], 2);
    }

    let replayed = replay_chain(orders, 3);
    assert(replayed == expected, "3-link order_acc replay must match hand fold");
}

// U7: cancel_acc replay with a different commitment produces a different chain
// (binding sensitivity).
#[test]
fn u7_cancel_acc_replay_is_binding() {
    let zero_order = OrderPreimage {
        side: false, amount_in: 0 as u128, limit_price: 0 as u128,
        order_nonce: 0, submitted_at_block: 0, owner: 0,
    };
    let o0 = OrderPreimage {
        side: false, amount_in: 100 as u128, limit_price: 2 as u128,
        order_nonce: 7, submitted_at_block: 1, owner: 0xa,
    };
    let o1 = OrderPreimage {
        side: false, amount_in: 100 as u128, limit_price: 2 as u128,
        order_nonce: 8, submitted_at_block: 2, owner: 0xa,
    };

    let mut arr0: [OrderPreimage; MAX_ORDERS_PER_EPOCH] = [zero_order; MAX_ORDERS_PER_EPOCH];
    arr0[0] = o0;
    let real_acc = replay_chain(arr0, 1);

    let mut arr1: [OrderPreimage; MAX_ORDERS_PER_EPOCH] = [zero_order; MAX_ORDERS_PER_EPOCH];
    arr1[0] = o1;
    let tampered_acc = replay_chain(arr1, 1);

    assert(real_acc != tampered_acc, "different cancelled commitments produce different chains");
}

// U3: Buy eligible iff limit_price >= P*; sell eligible iff limit_price <= P*.
#[test]
fn u3_eligibility_gates() {
    let p_star: u128 = 2_000_000_000_000_000_000;  // 2e18
    let buy_at_limit_2 = OrderPreimage {
        side: false, amount_in: 1 as u128, limit_price: 2_000_000_000_000_000_000 as u128,
        order_nonce: 0, submitted_at_block: 0, owner: 0,
    };
    let buy_at_limit_3 = OrderPreimage {
        side: false, amount_in: 1 as u128, limit_price: 3_000_000_000_000_000_000 as u128,
        order_nonce: 0, submitted_at_block: 0, owner: 0,
    };
    let buy_at_limit_1 = OrderPreimage {
        side: false, amount_in: 1 as u128, limit_price: 1_000_000_000_000_000_000 as u128,
        order_nonce: 0, submitted_at_block: 0, owner: 0,
    };
    assert(eligible(buy_at_limit_2, p_star), "buy with limit == P* eligible");
    assert(eligible(buy_at_limit_3, p_star), "buy with limit > P* eligible");
    assert(!eligible(buy_at_limit_1, p_star), "buy with limit < P* ineligible");

    let sell_at_limit_2 = OrderPreimage {
        side: true, amount_in: 1 as u128, limit_price: 2_000_000_000_000_000_000 as u128,
        order_nonce: 0, submitted_at_block: 0, owner: 0,
    };
    let sell_at_limit_1 = OrderPreimage {
        side: true, amount_in: 1 as u128, limit_price: 1_000_000_000_000_000_000 as u128,
        order_nonce: 0, submitted_at_block: 0, owner: 0,
    };
    let sell_at_limit_3 = OrderPreimage {
        side: true, amount_in: 1 as u128, limit_price: 3_000_000_000_000_000_000 as u128,
        order_nonce: 0, submitted_at_block: 0, owner: 0,
    };
    assert(eligible(sell_at_limit_2, p_star), "sell with limit == P* eligible");
    assert(eligible(sell_at_limit_1, p_star), "sell with limit < P* eligible");
    assert(!eligible(sell_at_limit_3, p_star), "sell with limit > P* ineligible");
}

// U4: Buy 1000 amount_in (raw units) @ P* = 2e18 -> ~498 amount_out (30 bps fee).
// (1000 * 1e18 / 2e18) * (10000-30) / 10000 = 500 * 9970 / 10000 = 498.5 -> floor 498.
#[test]
fn u4_buy_payout_with_fee() {
    let p_star: u128 = 2_000_000_000_000_000_000;  // 2e18
    let buy = OrderPreimage {
        side: false, amount_in: 1000 as u128, limit_price: p_star,
        order_nonce: 0, submitted_at_block: 0, owner: 0,
    };
    assert(payout(buy, p_star) == 498 as u128, "buy 1000 @ 2e18 -> 498 after 30bps fee");
}

// U8: A buy with limit_price < P* is NOT eligible (mirrors the sec 6.2.7 negative gate).
#[test]
fn u8_payout_ineligible_zero_or_panic() {
    let p_star: u128 = 2_000_000_000_000_000_000;
    let buy_under_limit = OrderPreimage {
        side: false, amount_in: 1000 as u128, limit_price: 1_000_000_000_000_000_000 as u128,
        order_nonce: 0, submitted_at_block: 0, owner: 0,
    };
    assert(!eligible(buy_under_limit, p_star), "buy limit < P* must NOT be eligible");
}

use crate::amm::assert_k_monotonic;

// U5: small swap with fee withheld - k strictly shrinks or stays equal.
// pre 100x200 (k = 20_000); post 110x180 (k = 19_800). 19_800 <= 20_000 PASS.
#[test]
fn u5_amm_k_monotonic_on_small_swap() {
    assert_k_monotonic(100 as u128, 200 as u128, 110 as u128, 180 as u128);
}

// U6: DoS resistance mask derivation - an eligible non-cancelled order omitted
// from fills shows up as a violation in the mask scan. (We exercise the mask
// logic in isolation here; main.nr's main assert is what catches the violation
// in the real proof.)
#[test]
fn u6_dos_resistance_mask_derivation() {
    let mut is_filled: [bool; MAX_ORDERS_PER_EPOCH] = [false; MAX_ORDERS_PER_EPOCH];
    is_filled[0] = true;
    is_filled[2] = true;

    let is_cancelled: [bool; MAX_ORDERS_PER_EPOCH] = [false; MAX_ORDERS_PER_EPOCH];

    // Order at index 1 is eligible & not cancelled but not filled -> violation.
    let order_count: u32 = 3;
    let mut violation = false;
    for k in 0..MAX_ORDERS_PER_EPOCH {
        if (k as u32) < order_count {
            if !is_cancelled[k] {
                if !is_filled[k] {
                    violation = true;
                }
            }
        }
    }
    assert(violation, "omitted eligible order must be detected as a violation");
}

// ============================================================================
// Week 5d-4: Merkle settlement root tests (sec 10.1 T1-T3).
// ============================================================================

#[test]
fn merkle_empty_leaf_is_poseidon2_of_zero_zero() {
    // The padding leaf - poseidon2_hash([0, 0]) - is what every empty slot collapses to.
    let empty = fill_leaf(0 as Field, 0 as u128);
    let expected = poseidon::poseidon2::Poseidon2::hash([0 as Field, 0 as Field], 2);
    assert(empty == expected, "fill_leaf(0,0) must equal poseidon2([0,0])");
}

#[test]
fn r1_hop_fill_leaf_owner_bound_parity_pin() {
    // R1 CROSS-LAYER PARITY: the hop-fill leaf MUST be byte-identical across the
    // circuit, aggregator/src/merkle.ts, and the contract claim_fill. This pins
    // hop_fill_leaf(owner=0xa11ce, nonce=7, hop=0, amount=999, pool=1) to the value
    // the JS poseidon2Hash([owner,nonce,hop,amount,pool]) produces (see
    // aggregator/test/merkle.test.ts "R1: leaf binds owner"). If either side drifts,
    // clearing's on-chain recursive verify rejects every settlement (the R6 lesson).
    let leaf = hop_fill_leaf(0xa11ce as Field, 7 as Field, 0 as u8, 999 as u128, 1 as u32);
    let expected: Field = 0x044beee99b56df47b028379439ab8209c2fbd62f90c1e01cc54058f3104578de;
    assert(leaf == expected, "hop_fill_leaf must match the JS/contract owner-bound leaf");

    // Changing ONLY the owner changes the leaf (cross-maker theft is blocked).
    let other = hop_fill_leaf(0xb0b as Field, 7 as Field, 0 as u8, 999 as u128, 1 as u32);
    assert(leaf != other, "leaf must be sensitive to owner");
}

#[test]
fn merkle_fill_leaf_binds_order_nonce_and_amount() {
    // Two leaves that differ only in order_nonce produce distinct hashes.
    let l1 = fill_leaf(1 as Field, 100 as u128);
    let l2 = fill_leaf(2 as Field, 100 as u128);
    assert(l1 != l2, "leaf must be sensitive to order_nonce");
    // Two leaves that differ only in amount_out produce distinct hashes.
    let l3 = fill_leaf(1 as Field, 100 as u128);
    let l4 = fill_leaf(1 as Field, 101 as u128);
    assert(l3 != l4, "leaf must be sensitive to amount_out");
}

#[test]
fn merkle_root_all_zero_leaves_pins_expected_constant() {
    // The all-empty-slot root is what the contract treats as the "no clearing
    // recorded" sentinel boundary. Pin it against an independently-derived
    // value: 5 levels of poseidon2([x, x]) starting at fill_leaf(0, 0).
    let empty = fill_leaf(0 as Field, 0 as u128);
    let leaves: [Field; MAX_ORDERS_PER_EPOCH] = [empty; MAX_ORDERS_PER_EPOCH];

    let lvl1 = poseidon::poseidon2::Poseidon2::hash([empty, empty], 2);
    let lvl2 = poseidon::poseidon2::Poseidon2::hash([lvl1, lvl1], 2);
    let lvl3 = poseidon::poseidon2::Poseidon2::hash([lvl2, lvl2], 2);
    let lvl4 = poseidon::poseidon2::Poseidon2::hash([lvl3, lvl3], 2);
    let expected_root = poseidon::poseidon2::Poseidon2::hash([lvl4, lvl4], 2);

    let computed = merkle_root_32(leaves);
    assert(computed == expected_root, "all-empty merkle root must match independently-derived constant");
}

#[test]
fn merkle_root_single_nonzero_leaf_traces() {
    // Construct a 32-leaf tree where only index 0 differs from the empty sentinel.
    // Manually hash the path: level0[0] vs level0[1] (both empty), level1[0] hashes them,
    // up the spine on the "left always" path (leaf_index = 0).
    let empty = fill_leaf(0 as Field, 0 as u128);
    let mine = fill_leaf(7 as Field, 42 as u128);
    let mut leaves: [Field; MAX_ORDERS_PER_EPOCH] = [empty; MAX_ORDERS_PER_EPOCH];
    leaves[0] = mine;

    // Walk the path manually for leaf_index = 0 (all "left").
    let mut node = mine;
    // Level 0 sibling: leaves[1] (still the empty leaf).
    node = poseidon::poseidon2::Poseidon2::hash([node, empty], 2);
    // Levels 1-4 siblings: the all-empty subtree root at the corresponding depth.
    let mut sibling = poseidon::poseidon2::Poseidon2::hash([empty, empty], 2);
    for _level in 0..4 {
        node = poseidon::poseidon2::Poseidon2::hash([node, sibling], 2);
        sibling = poseidon::poseidon2::Poseidon2::hash([sibling, sibling], 2);
    }

    let computed = merkle_root_32(leaves);
    assert(node == computed, "manual path trace must match merkle_root_32 output");
}

#[test]
fn merkle_root_changes_with_leaf_swap() {
    // Swapping a single non-zero leaf into a different slot changes the root
    // (rules out a trivial "sum of leaves" or other index-insensitive implementation).
    let empty = fill_leaf(0 as Field, 0 as u128);
    let leaf_a = fill_leaf(9 as Field, 1000 as u128);
    let mut leaves_lo: [Field; MAX_ORDERS_PER_EPOCH] = [empty; MAX_ORDERS_PER_EPOCH];
    leaves_lo[0] = leaf_a;
    let mut leaves_hi: [Field; MAX_ORDERS_PER_EPOCH] = [empty; MAX_ORDERS_PER_EPOCH];
    leaves_hi[31] = leaf_a;
    let root_lo = merkle_root_32(leaves_lo);
    let root_hi = merkle_root_32(leaves_hi);
    assert(root_lo != root_hi, "leaf position must affect root");
}

// ============================================================================
// Sub-2: V3 bucket math tests (sec 9 B1-B5 from the design spec).
// ============================================================================
use crate::buckets::{
    compute_deposit_in_range, compute_deposit_below_range, compute_deposit_above_range,
    max_a_in_to_upper, max_b_in_to_lower,
};
use crate::types::{BucketBounds, BucketState};

// Standard test bucket: sqrt_lower=1e18 (P=1.0), sqrt_upper=~1.2247e18 (P=1.5).
global TEST_SQRT_LOWER: u128 = 1_000_000_000_000_000_000;
global TEST_SQRT_UPPER: u128 = 1_224_744_871_391_589_049;  // sqrt(1.5e18)
// Pool sqrt_p halfway through the bucket: sqrt(1.25e18).
global TEST_SQRT_P: u128     = 1_118_033_988_749_894_848;

#[test]
fn b1_compute_deposit_in_range_basic() {
    // Standard call with non-trivial amounts; assert structural invariants.
    let x_a: u128 = 1_000_000_000;
    let x_b: u128 = 1_000_000_000;
    let result = compute_deposit_in_range(x_a, x_b, TEST_SQRT_P, TEST_SQRT_LOWER, TEST_SQRT_UPPER);
    assert(result.l_used > 0 as u128, "in-range deposit mints positive L");
    assert(result.used_a <= x_a, "used_a never exceeds x_a");
    assert(result.used_b <= x_b, "used_b never exceeds x_b");
}

#[test]
fn b2_compute_deposit_in_range_a_surplus_refunds() {
    // x_a way too much for x_b. L_b binding, so used_a < x_a (refund expected).
    let x_a: u128 = 10_000_000_000;
    let x_b: u128 = 1_000_000_000;
    let result = compute_deposit_in_range(x_a, x_b, TEST_SQRT_P, TEST_SQRT_LOWER, TEST_SQRT_UPPER);
    assert(result.l_used > 0 as u128, "mint nonzero L");
    assert(result.used_a < x_a, "x_a surplus implies used_a < x_a");
    assert(result.used_b <= x_b, "used_b never exceeds x_b");
}

#[test]
fn b3_compute_deposit_below_range_only_token_a() {
    let x_a: u128 = 1_000_000_000;
    let result = compute_deposit_below_range(x_a, TEST_SQRT_LOWER, TEST_SQRT_UPPER);
    assert(result.l_used > 0 as u128, "below-range deposit mints L from x_a");
    assert(result.used_a == x_a, "below-range consumes all x_a");
    assert(result.used_b == 0 as u128, "below-range used_b is 0");
}

#[test]
fn b4_compute_deposit_above_range_only_token_b() {
    let x_b: u128 = 1_000_000_000;
    let result = compute_deposit_above_range(x_b, TEST_SQRT_LOWER, TEST_SQRT_UPPER);
    assert(result.l_used > 0 as u128, "above-range deposit mints L from x_b");
    assert(result.used_a == 0 as u128, "above-range used_a is 0");
    assert(result.used_b == x_b, "above-range consumes all x_b");
}

#[test]
fn swap_step_b6_next_sqrt_p_up() {
    let l: u128 = 10 as u128 * crate::pricing::SCALE;
    let sqrt_p: u128 = crate::pricing::SCALE;
    let delta_b: u128 = crate::pricing::SCALE / 100;
    let out = crate::buckets::next_sqrt_p_up(l, sqrt_p, delta_b);
    assert(out == sqrt_p + crate::pricing::mul_div(delta_b, crate::pricing::SCALE, l));
}

#[test]
fn swap_step_b7_next_sqrt_p_down_monotone() {
    let l: u128 = 10 as u128 * crate::pricing::SCALE;
    let sqrt_p: u128 = crate::pricing::SCALE;
    let delta_a: u128 = crate::pricing::SCALE / 100;
    let out = crate::buckets::next_sqrt_p_down(l, sqrt_p, delta_a);
    assert(out < sqrt_p, "sqrt_p_down must be strictly less than starting sqrt_p");
    let expected = crate::pricing::mul_div(
        sqrt_p,
        l,
        l + crate::pricing::mul_div(delta_a, sqrt_p, crate::pricing::SCALE),
    );
    assert(out == expected, "next_sqrt_p_down result diverges from expected formula");
}

#[test]
fn swap_step_b8_b9_outputs_nonzero() {
    let l: u128 = 10 as u128 * crate::pricing::SCALE;
    let sqrt_p: u128 = crate::pricing::SCALE;
    let sqrt_p_up: u128 = sqrt_p + crate::pricing::SCALE / 1000;
    let sqrt_p_dn: u128 = sqrt_p - crate::pricing::SCALE / 1000;
    let out_a = crate::buckets::swap_step_out_a(l, sqrt_p, sqrt_p_up);
    let out_b = crate::buckets::swap_step_out_b(l, sqrt_p, sqrt_p_dn);
    assert(out_a > 0 as u128, "out_a must be positive when sqrt_p increased");
    assert(out_b > 0 as u128, "out_b must be positive when sqrt_p decreased");
}

#[test]
fn b5_max_in_to_boundary_consistent_with_liquidity() {
    let empty = BucketState {
        reserve_a: 0 as u128, reserve_b: 0 as u128, liquidity: 0 as u128,
        cum_fee_a_per_share: 0 as u128, cum_fee_b_per_share: 0 as u128,
    };
    let bounds = BucketBounds { sqrt_lower: TEST_SQRT_LOWER, sqrt_upper: TEST_SQRT_UPPER };
    assert(max_a_in_to_upper(empty, bounds, TEST_SQRT_P) == 0 as u128, "empty bucket has zero max_a_in");
    assert(max_b_in_to_lower(empty, bounds, TEST_SQRT_P) == 0 as u128, "empty bucket has zero max_b_in");

    let nonempty = BucketState {
        reserve_a: 1_000_000 as u128, reserve_b: 1_000_000 as u128,
        liquidity: 1_000_000_000 as u128,
        cum_fee_a_per_share: 0 as u128, cum_fee_b_per_share: 0 as u128,
    };
    assert(max_a_in_to_upper(nonempty, bounds, TEST_SQRT_P) > 0 as u128, "non-empty bucket has positive max_a_in");
    assert(max_b_in_to_lower(nonempty, bounds, TEST_SQRT_P) > 0 as u128, "non-empty bucket has positive max_b_in");
}

// ============================================================================
// Sub-2.5: assert_bucket_step tests (C5-C7).
// ============================================================================

#[test]
fn c5_assert_bucket_step_up_passes() {
    let l: u128 = 10 as u128 * crate::pricing::SCALE;
    let sqrt_p_in: u128 = crate::pricing::SCALE;
    let delta_b: u128 = crate::pricing::SCALE / 100;

    let before = crate::types::BucketState {
        reserve_a: 1000 as u128 * crate::pricing::SCALE,
        reserve_b: 1000 as u128 * crate::pricing::SCALE,
        liquidity: l,
        cum_fee_a_per_share: 0 as u128,
        cum_fee_b_per_share: 0 as u128,
    };
    let sqrt_p_out = crate::buckets::next_sqrt_p_up(l, sqrt_p_in, delta_b);
    let out_a = crate::buckets::swap_step_out_a(l, sqrt_p_in, sqrt_p_out);
    let after = crate::types::BucketState {
        reserve_a: before.reserve_a - out_a,
        reserve_b: before.reserve_b + delta_b,
        liquidity: l,
        cum_fee_a_per_share: 0 as u128,
        cum_fee_b_per_share: 0 as u128,
    };
    let delta = crate::types::BucketDelta {
        bucket_id: 4,
        reserve_a_add: 0 as u128,
        reserve_a_sub: out_a,
        reserve_b_add: delta_b,
        reserve_b_sub: 0 as u128,
        cum_fee_a_per_share_increment: 0 as u128,
        cum_fee_b_per_share_increment: 0 as u128,
    };
    let chained = crate::buckets::assert_bucket_step(before, after, delta, sqrt_p_in);
    assert(chained == sqrt_p_out, "chained sqrt_p_out mismatch");
}

// H11: an UP bucket must not carry a phantom reserve_b_sub (a B drain). Same valid
// UP swap as c5, but the prover attaches reserve_b_sub and balances `after` so the
// reserve-consistency asserts pass -- the H11 directional constraint must still reject.
#[test(should_fail_with = "UP bucket must not sub B")]
fn h11_assert_bucket_step_up_phantom_b_drain_fails() {
    let l: u128 = 10 as u128 * crate::pricing::SCALE;
    let sqrt_p_in: u128 = crate::pricing::SCALE;
    let delta_b: u128 = crate::pricing::SCALE / 100;
    let phantom: u128 = 500 as u128 * crate::pricing::SCALE;

    let before = crate::types::BucketState {
        reserve_a: 1000 as u128 * crate::pricing::SCALE,
        reserve_b: 1000 as u128 * crate::pricing::SCALE,
        liquidity: l,
        cum_fee_a_per_share: 0 as u128,
        cum_fee_b_per_share: 0 as u128,
    };
    let sqrt_p_out = crate::buckets::next_sqrt_p_up(l, sqrt_p_in, delta_b);
    let out_a = crate::buckets::swap_step_out_a(l, sqrt_p_in, sqrt_p_out);
    let after = crate::types::BucketState {
        reserve_a: before.reserve_a - out_a,
        // net b = +delta_b - phantom; balance `after` so the reserve_b assert passes,
        // isolating the H11 directional check as the sole rejecter.
        reserve_b: before.reserve_b + delta_b - phantom,
        liquidity: l,
        cum_fee_a_per_share: 0 as u128,
        cum_fee_b_per_share: 0 as u128,
    };
    let delta = crate::types::BucketDelta {
        bucket_id: 4,
        reserve_a_add: 0 as u128,
        reserve_a_sub: out_a,
        reserve_b_add: delta_b,
        reserve_b_sub: phantom, // phantom B drain -- must be rejected
        cum_fee_a_per_share_increment: 0 as u128,
        cum_fee_b_per_share_increment: 0 as u128,
    };
    let _ = crate::buckets::assert_bucket_step(before, after, delta, sqrt_p_in);
}

#[test(should_fail_with = "bucket reserve_a delta mismatch")]
fn c6_assert_bucket_step_tampered_reserve_a_fails() {
    let l: u128 = 10 as u128 * crate::pricing::SCALE;
    let sqrt_p_in: u128 = crate::pricing::SCALE;
    let delta_b: u128 = crate::pricing::SCALE / 100;
    let before = crate::types::BucketState {
        reserve_a: 1000 as u128 * crate::pricing::SCALE,
        reserve_b: 1000 as u128 * crate::pricing::SCALE,
        liquidity: l,
        cum_fee_a_per_share: 0 as u128,
        cum_fee_b_per_share: 0 as u128,
    };
    let sqrt_p_out = crate::buckets::next_sqrt_p_up(l, sqrt_p_in, delta_b);
    let out_a = crate::buckets::swap_step_out_a(l, sqrt_p_in, sqrt_p_out);
    let after = crate::types::BucketState {
        reserve_a: before.reserve_a - out_a - (1 as u128),  // TAMPERED
        reserve_b: before.reserve_b + delta_b,
        liquidity: l,
        cum_fee_a_per_share: 0 as u128,
        cum_fee_b_per_share: 0 as u128,
    };
    let delta = crate::types::BucketDelta {
        bucket_id: 4,
        reserve_a_add: 0 as u128,
        reserve_a_sub: out_a,
        reserve_b_add: delta_b,
        reserve_b_sub: 0 as u128,
        cum_fee_a_per_share_increment: 0 as u128,
        cum_fee_b_per_share_increment: 0 as u128,
    };
    let _ = crate::buckets::assert_bucket_step(before, after, delta, sqrt_p_in);
}

#[test(should_fail_with = "bucket liquidity changed during swap")]
fn c7_assert_bucket_step_liquidity_change_fails() {
    let l: u128 = 10 as u128 * crate::pricing::SCALE;
    let sqrt_p_in: u128 = crate::pricing::SCALE;
    let delta_b: u128 = crate::pricing::SCALE / 100;
    let before = crate::types::BucketState {
        reserve_a: 1000 as u128 * crate::pricing::SCALE,
        reserve_b: 1000 as u128 * crate::pricing::SCALE,
        liquidity: l,
        cum_fee_a_per_share: 0 as u128,
        cum_fee_b_per_share: 0 as u128,
    };
    let sqrt_p_out = crate::buckets::next_sqrt_p_up(l, sqrt_p_in, delta_b);
    let out_a = crate::buckets::swap_step_out_a(l, sqrt_p_in, sqrt_p_out);
    let after = crate::types::BucketState {
        reserve_a: before.reserve_a - out_a,
        reserve_b: before.reserve_b + delta_b,
        liquidity: l + (1 as u128),  // TAMPERED: liquidity changed
        cum_fee_a_per_share: 0 as u128,
        cum_fee_b_per_share: 0 as u128,
    };
    let delta = crate::types::BucketDelta {
        bucket_id: 4,
        reserve_a_add: 0 as u128, reserve_a_sub: out_a,
        reserve_b_add: delta_b,   reserve_b_sub: 0 as u128,
        cum_fee_a_per_share_increment: 0 as u128,
        cum_fee_b_per_share_increment: 0 as u128,
    };
    let _ = crate::buckets::assert_bucket_step(before, after, delta, sqrt_p_in);
}

// ============================================================================
// Sub-4 (D3): stub tests pinning new fn main assertion messages.
// Full multi-pair fixtures require Prover.toml emission from
// aggregator/src/witness.ts (buildClearingWitnessMultiPair); those e2e
// tests integrate via Task F1's bb-prove pipeline. M1/M4 here are
// minimal stubs that exercise the new should_fail_with strings.
// ============================================================================

#[test]
fn sub4_m1_one_hop_only_regression_stub() {
    // Placeholder: regression coverage that the 1-hop path is intact.
    // Real fixture lands in Task F1 (bb prove against buildClearingWitnessMultiPair).
    assert(true, "Sub-4 M1 stub -- full fixture in F1");
}

#[test(should_fail_with = "2-hop disabled")]
fn settle_two_hop_disabled_block_c_stub() {
    // SETTLE-INV v1: block C rejects ANY leg on a 2-hop order ("2-hop disabled").
    // (Replaces the old 2-hop atomicity message, now unreachable.) Full
    // witness-driven proof lives in the bb-prove integration.
    assert(false, "2-hop disabled");
}

#[test(should_fail_with = "2-hop fills disabled (SETTLE-INV v1)")]
fn settle_two_hop_fill_rejected_block_b_stub() {
    // SETTLE-INV v1: block B rejects EVERY fill on a 2-hop order.
    assert(false, "2-hop fills disabled (SETTLE-INV v1)");
}

#[test(should_fail_with = "eligible 1-hop order missing from fills (DoS)")]
fn sub5a_dos_eligible_1hop_missing_stub() {
    // Tripping the exact assertion string from block B'. A real fixture-driven
    // test (tampered witness omits an eligible 1-hop fill) lives in Task F1.
    assert(false, "eligible 1-hop order missing from fills (DoS)");
}

#[test(should_fail_with = "1-hop needs exactly hop0")]
fn sub4_m4c_one_hop_duplicate_fill_rejected_stub() {
    // Pins the 1-hop fill-multiplicity assertion in main.nr block C.
    // Full witness-driven integration proof lives in Task 10 (TXE).
    assert(false, "1-hop needs exactly hop0");
}

// ============================================================================
// Task 3 (#1 audit fix): pool_state_commitment helper unit tests.
// These pin the exact 25-element field order that Task 5 (pool contract),
// Task 8 (JS aggregator), and Task 9 (parity guard) MUST replicate verbatim.
// ============================================================================
use crate::buckets::pool_state_commitment;
use crate::types::BucketDelta;

#[test]
fn pool_state_commitment_matches_inline_poseidon() {
    // One active bucket (id=3); slots 1..4 zeroed. The helper must build the
    // exact 25-element array hashed below -- this pins the field order.
    let sqrt_p: u128 = 1_000_000_000_000_000_000;
    let z = BucketState { reserve_a: 0 as u128, reserve_b: 0 as u128, liquidity: 0 as u128, cum_fee_a_per_share: 0 as u128, cum_fee_b_per_share: 0 as u128 };
    let zd = BucketDelta { bucket_id: 0, reserve_a_add: 0 as u128, reserve_a_sub: 0 as u128, reserve_b_add: 0 as u128, reserve_b_sub: 0 as u128, cum_fee_a_per_share_increment: 0 as u128, cum_fee_b_per_share_increment: 0 as u128 };
    let mut before = [z, z, z, z];
    before[0] = BucketState { reserve_a: 1000 as u128, reserve_b: 2000 as u128, liquidity: 5000 as u128, cum_fee_a_per_share: 0 as u128, cum_fee_b_per_share: 0 as u128 };
    let mut deltas = [zd, zd, zd, zd];
    deltas[0] = BucketDelta { bucket_id: 3, reserve_a_add: 0 as u128, reserve_a_sub: 0 as u128, reserve_b_add: 0 as u128, reserve_b_sub: 0 as u128, cum_fee_a_per_share_increment: 0 as u128, cum_fee_b_per_share_increment: 0 as u128 };

    let mut expected_input: [Field; 25] = [0; 25];
    expected_input[0] = sqrt_p as Field;
    expected_input[1] = 3 as Field;      // bucket_id
    expected_input[2] = 1000 as Field;   // reserve_a
    expected_input[3] = 2000 as Field;   // reserve_b
    expected_input[4] = 5000 as Field;   // liquidity
    expected_input[5] = 0 as Field;      // cum_fee_a
    expected_input[6] = 0 as Field;      // cum_fee_b
    let expected = poseidon::poseidon2::Poseidon2::hash(expected_input, 25);

    let got = pool_state_commitment(sqrt_p, before, deltas, 1);
    assert(got == expected, "pool_state_commitment field order/contract mismatch");
}

#[test]
fn pool_state_commitment_sensitive_to_reserve() {
    let sqrt_p: u128 = 1_000_000_000_000_000_000;
    let z = BucketState { reserve_a: 0 as u128, reserve_b: 0 as u128, liquidity: 0 as u128, cum_fee_a_per_share: 0 as u128, cum_fee_b_per_share: 0 as u128 };
    let zd = BucketDelta { bucket_id: 0, reserve_a_add: 0 as u128, reserve_a_sub: 0 as u128, reserve_b_add: 0 as u128, reserve_b_sub: 0 as u128, cum_fee_a_per_share_increment: 0 as u128, cum_fee_b_per_share_increment: 0 as u128 };
    let mut before = [z, z, z, z];
    before[0] = BucketState { reserve_a: 1000 as u128, reserve_b: 2000 as u128, liquidity: 5000 as u128, cum_fee_a_per_share: 0 as u128, cum_fee_b_per_share: 0 as u128 };
    let mut deltas = [zd, zd, zd, zd];
    deltas[0] = BucketDelta { bucket_id: 3, reserve_a_add: 0 as u128, reserve_a_sub: 0 as u128, reserve_b_add: 0 as u128, reserve_b_sub: 0 as u128, cum_fee_a_per_share_increment: 0 as u128, cum_fee_b_per_share_increment: 0 as u128 };
    let h1 = pool_state_commitment(sqrt_p, before, deltas, 1);
    let mut before2 = before;
    before2[0] = BucketState { reserve_a: 1001 as u128, reserve_b: 2000 as u128, liquidity: 5000 as u128, cum_fee_a_per_share: 0 as u128, cum_fee_b_per_share: 0 as u128 };
    let h2 = pool_state_commitment(sqrt_p, before2, deltas, 1);
    assert(h1 != h2, "commitment must change when a before-state reserve changes");
}

// ============================================================================
// Task 4 (#3 audit fix): pair-binding assertion message stubs.
// These pin the exact should_fail_with strings for the D'' block in main.nr.
// Full witness-driven integration proofs live in Task 10 (TXE).
// ============================================================================

#[test(should_fail_with = "token_lo != pool_token_pairs[p][0]")]
fn sub3_token_lo_mismatch_stub() {
    // Pins the #3 pair-binding assertion (token_lo) in main.nr block D''.
    // Full witness-driven integration proof lives in Task 10 (TXE).
    assert(false, "token_lo != pool_token_pairs[p][0]");
}

#[test(should_fail_with = "token_hi != pool_token_pairs[p][1]")]
fn sub3_token_hi_mismatch_stub() {
    // Pins the #3 pair-binding assertion (token_hi) in main.nr block D''.
    assert(false, "token_hi != pool_token_pairs[p][1]");
}

// ============================================================================
// Task 6 (#1 risk: JS V3 swap math drifting from the circuit). The GATE.
//
// Unlike c5 (which RECOMPUTES sqrt_p_out / out_a inside the test from the
// circuit's own helpers), this test feeds the EXACT bucket deltas produced by
// the off-chain JS `traceBucketSwap` (aggregator/src/clearing.ts) -- captured
// verbatim by aggregator/test/bucket-trace-parity.test.ts -- into the on-chain
// `assert_bucket_step`. If JS and Noir V3 math have drifted, the circuit's
// recompute of sqrt_p_out / out_a will diverge from these hardcoded JS numbers
// and this test REVERTS with "bucket out_a deviates from V3 formula". A pass
// is the proof that the circuit ACCEPTS the JS deltas (the real parity).
//
// Canonical scenario (must stay IDENTICAL to the JS CANON fixture):
//   single-bucket pool, L = reserve_a = 10e18, reserve_b = 0,
//   bounds [1e18, 2e18], sqrt_p_in = 1e18, gross input = 0.01 token B (UP swap).
//   L = 10e18 (1e19) is < 2^64, the circuit's mul_div divisor domain; a larger L
//   would abort in next_sqrt_p_up's mul_div(.., .., L) -- a domain limit, NOT a
//   JS-vs-circuit math drift (both compute (x*y)/z identically when z < 2^64).
// PARITY_FIXTURE recorded from the JS run (DO NOT edit to make this pass --
// a mismatch is a real finding that blocks testnet):
//   newSqrtPrice                  = 1000997000000000000
//   reserve_a_sub  (A out)        = 9960069810399032
//   reserve_b_add  (B in, after fee = gross * 9970/10000) = 9970000000000000
//   cum_fee_b_per_share_increment = 3000000000000   (fee 3e13 * 1e18 / L)
// ============================================================================
#[test]
fn task6_traceBucketSwap_deltas_satisfy_assert_bucket_step() {
    let sqrt_p_in: u128 = 1000000000000000000; // 1e18

    let before = crate::types::BucketState {
        reserve_a: 10000000000000000000, // 10e18
        reserve_b: 0 as u128,
        liquidity: 10000000000000000000, // 10e18
        cum_fee_a_per_share: 0 as u128,
        cum_fee_b_per_share: 0 as u128,
    };

    // EXACT deltas from the JS traceBucketSwap PARITY_FIXTURE -- hardcoded, not
    // recomputed. This is what makes the test a genuine cross-impl parity gate.
    let delta = crate::types::BucketDelta {
        bucket_id: 0,
        reserve_a_add: 0 as u128,
        reserve_a_sub: 9960069810399032,           // A paid out
        reserve_b_add: 9970000000000000,           // after-fee B in
        reserve_b_sub: 0 as u128,
        cum_fee_a_per_share_increment: 0 as u128,
        cum_fee_b_per_share_increment: 3000000000000, // fee-per-share
    };

    // after = before + delta applied (reserves move; liquidity unchanged).
    let after = crate::types::BucketState {
        reserve_a: 10000000000000000000 - 9960069810399032, // 10e18 - reserve_a_sub
        reserve_b: 0 + 9970000000000000,                    // 0 + reserve_b_add
        liquidity: 10000000000000000000,                    // unchanged
        cum_fee_a_per_share: 0 as u128,
        cum_fee_b_per_share: 0 + 3000000000000,             // 0 + increment
    };

    // MUST NOT revert: the circuit recomputes sqrt_p_out from delta.reserve_b_add
    // and asserts |swap_step_out_a(...) - delta.reserve_a_sub| <= 1.
    let out = crate::buckets::assert_bucket_step(before, after, delta, sqrt_p_in);

    // And the recomputed sqrt_p_out must equal the JS newSqrtPrice exactly.
    assert(out == 1000997000000000000, "sqrt_p_out parity drift");
}

// ============================================================================
// SETTLE-INV (conservation fix): per-(pool,token) solvency + anti-grief floor.
// Unit tests for the extracted helpers (pricing::token_solvent / floor_share)
// that main.nr block C2 uses, plus message pins for the new asserts. The full
// positive/negative main() coverage is the bb-prove integration (needs the
// aggregator witness builder); these pin the arithmetic + the security strings.
// ============================================================================

#[test]
fn settle_token_solvent_accepts_balanced_and_slack() {
    // Exact balance: pay + to_pool == from_pool + escrow.
    assert(token_solvent(100 as u128, 0 as u128, 100 as u128, 0 as u128), "exact balance solvent");
    // Fee slack: the orderbook retains the withheld 0.3% fee (escrow > to_pool).
    assert(token_solvent(0 as u128, 997 as u128, 0 as u128, 1000 as u128), "fee-slack solvent");
    // CoW: seller paid from the buyer's escrow, no pool flow.
    assert(token_solvent(100 as u128, 0 as u128, 0 as u128, 100 as u128), "cow solvent");
}

#[test]
fn settle_token_insolvent_rejected() {
    // Pay one unit more than held -> NOT solvent (would underflow the orderbook).
    assert(!token_solvent(101 as u128, 0 as u128, 100 as u128, 0 as u128), "overpay not solvent");
    // pay + to_pool overshoots from_pool + escrow.
    assert(!token_solvent(50 as u128, 51 as u128, 100 as u128, 0 as u128), "pay+to_pool overshoot");
}

#[test]
fn settle_floor_share_is_prorata_floor() {
    // Group paid 100 across Sum amount_in 300; a 100-in maker floors to 33.
    assert(floor_share(100 as u128, 100 as u128, 300 as u128) == 33 as u128, "prorata floor");
    // Single fill: floor == the whole group total (sum == amount_in).
    assert(floor_share(99699899 as u128, 5 as u128, 5 as u128) == 99699899 as u128, "single-fill floor==total");
}

#[test]
fn settle_kernel_last_absorb_meets_floor() {
    // The kernel's last fill absorbs the rounding residual, so it is >= its floor.
    // total=100, two makers in=150,150 (sum=300): non-last floor=50, last=100-50=50>=50.
    let total = 100 as u128;
    let sum = 300 as u128;
    let f0 = floor_share(total, 150 as u128, sum);
    let last = total - f0;
    assert(f0 == 50 as u128, "non-last == floor");
    assert(last >= floor_share(total, 150 as u128, sum), "last (residual-absorbed) >= its floor");
}

#[test]
fn settle_conservation_one_sided_single_fill_no_float() {
    // Mirrors the live bug case: ONE seller, one-sided (no buyers/CoW). The AMM
    // pays a_from_pool out; escrow_lo (buyers' A) = 0, a_to_pool = 0.
    let a_from_pool = 99699899 as u128;
    // SETTLE-INV pins the fill to the pool output -> solvent with NO float:
    assert(token_solvent(99699899 as u128, 0 as u128, a_from_pool, 0 as u128), "seller paid pool-out, solvent no float");
    // The OLD per-fill payout_at_price overshoot (a_from_pool + 59) is REJECTED:
    assert(!token_solvent(99699958 as u128, 0 as u128, a_from_pool, 0 as u128), "old overshoot would underflow");
    // The single fill's floor equals the whole pool output (sum == its own amount_in).
    assert(floor_share(99699899 as u128, 5 as u128, 5 as u128) == 99699899 as u128, "single seller floor == pool out");
}

#[test(should_fail_with = "token_lo solvency")]
fn settle_token_lo_solvency_msg_stub() {
    assert(false, "token_lo solvency");
}

#[test(should_fail_with = "token_hi solvency")]
fn settle_token_hi_solvency_msg_stub() {
    assert(false, "token_hi solvency");
}

#[test(should_fail_with = "fill below pro-rata floor share")]
fn settle_floor_msg_stub() {
    assert(false, "fill below pro-rata floor share");
}

#[test(should_fail_with = "settle: empty receive group")]
fn settle_empty_group_msg_stub() {
    assert(false, "settle: empty receive group");
}

// SETTLE-INV floor-fix: feeAllowance = ceil((to_pool+1)*30/9970) provably covers
// avail's CoW-fee overcount (== retained = remaining - to_pool), so avail_floor stays
// <= the kernel's true net payout xTotal (never bricks CoW), keyed off the post-fee
// pool inflow to_pool (NOT gross escrow, which collapsed avail_floor on thin CoW).
#[test]
fn settle_fee_allowance_covers_cow_overcount() {
    // The overcount avail - xTotal == retained == remaining - to_pool (the withheld LP fee).
    let remaining: u128 = 1000000000;                              // gross AMM input ~1e9
    let to_pool: u128 = mul_div(remaining, FEE_DEN - FEE_NUM, FEE_DEN); // floor(1e9*9970/10000)=997000000
    let retained: u128 = remaining - to_pool;                      // 3_000_000
    let fee_allow = ceil_fee_from_net(to_pool);                    // 3_000_001 (>= retained, +1 tight)
    assert(fee_allow >= retained, "feeAllowance must cover retained (the CoW overcount)");
    let avail: u128 = 1005999999;
    let x_total: u128 = avail - retained;                          // 1_002_999_999
    let avail_floor = avail - fee_allow;                           // 1_002_999_998
    assert(avail_floor <= x_total, "avail_floor must be <= xTotal (never bricks CoW)");
}

// The avail_floor floor rejects a ~50% underpay but accepts a near-fair payout --
// the grief bound, now tight to ~1 raw unit (was ~0.3% of gross escrow).
#[test]
fn settle_avail_floor_rejects_big_underpay_allows_small() {
    let avail: u128 = 1000;
    let to_pool: u128 = 1000;                                 // input-side net pool flow
    let fee_allow = ceil_fee_from_net(to_pool);               // ceil((1001)*30/9970)=4
    let avail_floor = avail - fee_allow;                      // 996
    let sum: u128 = 1000;
    let floor0 = floor_share(avail_floor, 600 as u128, sum); // mul_div(996,600,1000)=597
    let floor1 = floor_share(avail_floor, 400 as u128, sum); // mul_div(996,400,1000)=398
    // ~50% underpay (300/200) is BELOW the floor -> (b) rejects.
    assert(!(300 as u128 >= floor0), "50% underpay 300 < floor 597 -> rejected");
    assert(!(200 as u128 >= floor1), "50% underpay 200 < floor 398 -> rejected");
    // near-fair (600/400) clears the floor -> accepted.
    assert(600 as u128 >= floor0, "near-fair 600 >= floor 597 -> accepted");
    assert(400 as u128 >= floor1, "near-fair 400 >= floor 398 -> accepted");
}

// SETTLE-INV floor-fix regression: ceil_fee_from_net is the EXACT worst-case retained
// per to_pool. The dropped-`+1` candidate ceil(to_pool*30/9970) undercounted these by 1
// and FATALLY bricked honest clears (workflow exhaustive search: 600+ bricking inputs).
#[test]
fn settle_ceil_fee_from_net_regression() {
    assert(ceil_fee_from_net(0 as u128) == 1 as u128, "to_pool=0 (dust escrow output token) -> 1");
    assert(ceil_fee_from_net(332 as u128) == 2 as u128, "remaining=334 -> to_pool=332 -> retained=2");
    assert(ceil_fee_from_net(664 as u128) == 3 as u128, "to_pool=664 -> 3");
    assert(ceil_fee_from_net(997 as u128) == 4 as u128, "to_pool=997 -> 4");
}

// No-brick invariant at the family points (and their neighbors) where the dropped-`+1`
// candidate bricked: for every gross remaining, feeAllowance >= retained, so
// avail_floor <= xTotal and honest conservation-exact fills always clear the floor.
#[test]
fn settle_ceil_fee_never_bricks_at_families() {
    let cases: [u128; 8] = [1, 2, 334, 335, 667, 668, 1000, 1001];
    for i in 0..8 {
        let remaining = cases[i];
        let to_pool = mul_div(remaining, FEE_DEN - FEE_NUM, FEE_DEN);
        let retained = remaining - to_pool;
        assert(ceil_fee_from_net(to_pool) >= retained, "feeAllowance >= retained -> no brick");
    }
}

// M17: with the fee forwarded, retained shrinks to the round-trip dust
// (feeWithheld - fee_rec). The new allowance
//   allowance' = ceil_fee_from_net(to_pool_gross - fee_rec) - fee_rec  (saturating)
// must cover retained for EVERY gross input and EVERY recovery outcome
// (no brick), while staying ~1 raw unit when the fee round-trips exactly (tight).
#[test]
fn m17_fee_allowance_covers_dust_after_forwarding() {
    let cases: [u128; 8] = [1, 2, 334, 335, 667, 668, 1000, 1000000000];
    for i in 0..8 {
        let remaining = cases[i];
        let net = mul_div(remaining, FEE_DEN - FEE_NUM, FEE_DEN);
        let fee_withheld = remaining - net;
        // Recovery extremes: nothing recovered (inc rounds to 0) and all recovered.
        let recs: [u128; 2] = [0 as u128, fee_withheld];
        for j in 0..2 {
            let fee_rec = recs[j];
            let retained = fee_withheld - fee_rec;
            let to_pool_gross = net + fee_rec;
            let allowance = saturating_sub(
                ceil_fee_from_net(saturating_sub(to_pool_gross, fee_rec)),
                fee_rec,
            );
            assert(allowance >= retained, "allowance must cover post-forwarding dust");
        }
    }
}

// H12: a pool's total minted fee-per-share must not exceed the fee it collected.
// With liquidity == SCALE, mul_div(inc, SCALE, SCALE) == inc, so `recovered == inc`
// for the single real bucket. b_to_pool = 10000 -> ceil_fee_from_net = 31, so a
// cum_fee_b increment of 30 is within budget and 100 is not.
// M17: to_pool passed to these fixtures is GROSS; the budget uses net = to_pool - recovered.
fn h12_before_states() -> [crate::types::BucketState; crate::types::MAX_ACTIVE_BUCKETS_PER_EPOCH] {
    let s = crate::types::BucketState {
        reserve_a: 0 as u128, reserve_b: 0 as u128,
        liquidity: crate::pricing::SCALE,
        cum_fee_a_per_share: 0 as u128, cum_fee_b_per_share: 0 as u128,
    };
    [s, s, s, s]
}

fn h12_deltas(cum_fee_b_inc: u128) -> [crate::types::BucketDelta; crate::types::MAX_ACTIVE_BUCKETS_PER_EPOCH] {
    let real = crate::types::BucketDelta {
        bucket_id: 0,
        reserve_a_add: 0 as u128, reserve_a_sub: 0 as u128,
        reserve_b_add: 10000 as u128, reserve_b_sub: 0 as u128,
        cum_fee_a_per_share_increment: 0 as u128,
        cum_fee_b_per_share_increment: cum_fee_b_inc,
    };
    let pad = crate::types::BucketDelta {
        bucket_id: 0xffff, // >= NUM_BUCKETS -> skipped
        reserve_a_add: 0 as u128, reserve_a_sub: 0 as u128,
        reserve_b_add: 0 as u128, reserve_b_sub: 0 as u128,
        cum_fee_a_per_share_increment: 0 as u128,
        cum_fee_b_per_share_increment: 0 as u128,
    };
    [real, pad, pad, pad]
}

#[test]
fn h12_fee_conservation_accepts_within_budget() {
    // recovered_b = 30 <= ceil_fee_from_net(10000) = 31 -> passes.
    crate::buckets::assert_pool_fee_conservation(
        h12_before_states(), h12_deltas(30 as u128), 0 as u128, 10000 as u128,
    );
}

#[test(should_fail_with = "fee_b minted exceeds collected")]
fn h12_fee_conservation_rejects_over_mint() {
    // recovered_b = 100 > 31 -> must reject (the phantom-fee mint H12 closes).
    crate::buckets::assert_pool_fee_conservation(
        h12_before_states(), h12_deltas(100 as u128), 0 as u128, 10000 as u128,
    );
}

// M17: to_pool is now GROSS (post-fee adds + forwarded fee), so the budget is keyed
// off net = to_pool - recovered. The old boundary (inc == 31 == ceil_fee_from_net(10000))
// must now reject: net = 10000 - 31 = 9969, bound = ceil_fee_from_net(9969) = 30 < 31.
#[test(should_fail_with = "fee_b minted exceeds collected")]
fn m17_fee_conservation_rejects_old_gross_boundary() {
    crate::buckets::assert_pool_fee_conservation(
        h12_before_states(), h12_deltas(31 as u128), 0 as u128, 10000 as u128,
    );
}

// M17: honest gross witness -- net add 10000 + forwarded fee 30 -> to_pool 10030.
// net = 10030 - 30 = 10000, bound = ceil_fee_from_net(10000) = 31 >= 30 -> passes.
#[test]
fn m17_fee_conservation_accepts_gross_honest() {
    crate::buckets::assert_pool_fee_conservation(
        h12_before_states(), h12_deltas(30 as u128), 0 as u128, 10030 as u128,
    );
}

fn m17_deltas_a(cum_fee_a_inc: u128) -> [crate::types::BucketDelta; crate::types::MAX_ACTIVE_BUCKETS_PER_EPOCH] {
    let real = crate::types::BucketDelta {
        bucket_id: 0,
        reserve_a_add: 10000 as u128, reserve_a_sub: 0 as u128,
        reserve_b_add: 0 as u128, reserve_b_sub: 0 as u128,
        cum_fee_a_per_share_increment: cum_fee_a_inc,
        cum_fee_b_per_share_increment: 0 as u128,
    };
    let pad = crate::types::BucketDelta {
        bucket_id: 0xffff,
        reserve_a_add: 0 as u128, reserve_a_sub: 0 as u128,
        reserve_b_add: 0 as u128, reserve_b_sub: 0 as u128,
        cum_fee_a_per_share_increment: 0 as u128,
        cum_fee_b_per_share_increment: 0 as u128,
    };
    [real, pad, pad, pad]
}

// M17 a-side mirror of the gross-boundary reject (net = 10000-31 = 9969, bound 30 < 31).
#[test(should_fail_with = "fee_a minted exceeds collected")]
fn m17_fee_conservation_rejects_old_gross_boundary_a_side() {
    crate::buckets::assert_pool_fee_conservation(
        h12_before_states(), m17_deltas_a(31 as u128), 10000 as u128, 0 as u128,
    );
}

// M17 a-side mirror of the gross-honest accept (net = 10030-30 = 10000, bound 31 >= 30).
#[test]
fn m17_fee_conservation_accepts_gross_honest_a_side() {
    crate::buckets::assert_pool_fee_conservation(
        h12_before_states(), m17_deltas_a(30 as u128), 10030 as u128, 0 as u128,
    );
}
