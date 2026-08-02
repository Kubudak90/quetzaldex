//! Sub-2: V3 math primitives shared between the clearing circuit and (with
//! a parallel duplicate in contracts/pool/src/buckets.nr) the pool contract +
//! JS aggregator in aggregator/src/buckets.ts.
//!
//! All values are u128 in 1e18-scaled Q-format. Square roots are pre-computed
//! by the caller (the circuit / pool stores sqrt_P, not P, to keep arithmetic
//! linear in the V3 swap formulas).

use crate::pricing::{mul_div, SCALE, ceil_fee_from_net, saturating_sub};
use crate::types::{BucketBounds, BucketDelta, BucketState, MAX_ACTIVE_BUCKETS_PER_EPOCH, NUM_BUCKETS};

/// Result of a deposit's liquidity math: (l_used, used_a, used_b).
pub struct DepositMath {
    pub l_used: u128,
    pub used_a: u128,
    pub used_b: u128,
}

/// In-range deposit math: sqrt_lower < sqrt_p < sqrt_upper.
/// L_used = min(L_a, L_b) where:
///   L_a = x_a * (sqrt_p * sqrt_upper / SCALE) / (sqrt_upper - sqrt_p)
///   L_b = x_b * SCALE / (sqrt_p - sqrt_lower)
/// used_a, used_b recomputed from L_used to leave a clean residual for refund.
pub fn compute_deposit_in_range(
    x_a: u128,
    x_b: u128,
    sqrt_p: u128,
    sqrt_lower: u128,
    sqrt_upper: u128,
) -> DepositMath {
    // sqrt_p * sqrt_upper might overflow u128 -- use mul_div for safety.
    let sqrt_p_x_upper = mul_div(sqrt_p, sqrt_upper, SCALE);
    let span_upper = sqrt_upper - sqrt_p;
    let span_lower = sqrt_p - sqrt_lower;

    let l_a = mul_div(x_a, sqrt_p_x_upper, span_upper);
    let l_b = mul_div(x_b, SCALE, span_lower);
    let l_used = if l_a < l_b { l_a } else { l_b };

    let used_a = mul_div(l_used, span_upper, sqrt_p_x_upper);
    let used_b = mul_div(l_used, span_lower, SCALE);

    DepositMath { l_used, used_a, used_b }
}

/// Below-range deposit math: sqrt_p <= sqrt_lower. Bucket holds only token A.
/// L_used = x_a * (sqrt_upper * sqrt_lower / SCALE) / (sqrt_upper - sqrt_lower)
pub fn compute_deposit_below_range(
    x_a: u128,
    sqrt_lower: u128,
    sqrt_upper: u128,
) -> DepositMath {
    let sqrt_lower_x_upper = mul_div(sqrt_lower, sqrt_upper, SCALE);
    let span = sqrt_upper - sqrt_lower;
    let l_used = mul_div(x_a, sqrt_lower_x_upper, span);
    DepositMath { l_used, used_a: x_a, used_b: 0 as u128 }
}

/// Above-range deposit math: sqrt_p >= sqrt_upper. Bucket holds only token B.
/// L_used = x_b * SCALE / (sqrt_upper - sqrt_lower)
pub fn compute_deposit_above_range(
    x_b: u128,
    sqrt_lower: u128,
    sqrt_upper: u128,
) -> DepositMath {
    let span = sqrt_upper - sqrt_lower;
    let l_used = mul_div(x_b, SCALE, span);
    DepositMath { l_used, used_a: 0 as u128, used_b: x_b }
}

/// Dispatch on sqrt_p vs bucket bounds. The caller must already have escrowed
/// x_a + x_b; the returned used_a/used_b indicate what to keep and the
/// difference is the refund.
pub fn compute_deposit(
    x_a: u128,
    x_b: u128,
    sqrt_p: u128,
    bounds: BucketBounds,
) -> DepositMath {
    if sqrt_p <= bounds.sqrt_lower {
        compute_deposit_below_range(x_a, bounds.sqrt_lower, bounds.sqrt_upper)
    } else if sqrt_p >= bounds.sqrt_upper {
        compute_deposit_above_range(x_b, bounds.sqrt_lower, bounds.sqrt_upper)
    } else {
        compute_deposit_in_range(x_a, x_b, sqrt_p, bounds.sqrt_lower, bounds.sqrt_upper)
    }
}

/// Maximum amount of token A that can be added before sqrt_p reaches
/// sqrt_upper (the swap leaves this bucket going UP). Used by the aggregator
/// to determine bucket-boundary crossings during clearing.
pub fn max_a_in_to_upper(state: BucketState, bounds: BucketBounds, sqrt_p: u128) -> u128 {
    // max_a = liquidity * (sqrt_upper - sqrt_p) / (sqrt_p * sqrt_upper / SCALE)
    let span = bounds.sqrt_upper - sqrt_p;
    let denom = mul_div(sqrt_p, bounds.sqrt_upper, SCALE);
    mul_div(state.liquidity, span, denom)
}

/// Maximum amount of token B that can be added before sqrt_p reaches
/// sqrt_lower (the swap leaves this bucket going DOWN).
pub fn max_b_in_to_lower(state: BucketState, bounds: BucketBounds, sqrt_p: u128) -> u128 {
    // max_b = liquidity * (sqrt_p - sqrt_lower) / SCALE
    let span = sqrt_p - bounds.sqrt_lower;
    mul_div(state.liquidity, span, SCALE)
}

/// Sub-2.5: V3 swap-step math.
pub fn next_sqrt_p_up(L: u128, sqrt_p: u128, delta_b: u128) -> u128 {
    sqrt_p + mul_div(delta_b, SCALE, L)
}

pub fn next_sqrt_p_down(L: u128, sqrt_p: u128, delta_a: u128) -> u128 {
    // Avoid overflow: factor out SCALE from numerator and denominator.
    // sqrt_p * L * SCALE / (L * SCALE + delta_a * sqrt_p)
    //   = sqrt_p * L / (L + delta_a * sqrt_p / SCALE)
    let denom = L + mul_div(delta_a, sqrt_p, SCALE);
    mul_div(sqrt_p, L, denom)
}

/// Pool moved UP: sqrt_p_new >= sqrt_p. Violations panic via u128 underflow.
pub fn swap_step_out_a(L: u128, sqrt_p: u128, sqrt_p_new: u128) -> u128 {
    let denom = mul_div(sqrt_p, sqrt_p_new, SCALE);
    mul_div(L, sqrt_p_new - sqrt_p, denom)
}

/// Pool moved DOWN: sqrt_p_new <= sqrt_p. Violations panic via u128 underflow.
pub fn swap_step_out_b(L: u128, sqrt_p: u128, sqrt_p_new: u128) -> u128 {
    mul_div(L, sqrt_p - sqrt_p_new, SCALE)
}

/// Sub-2.5: assert that a single bucket's pre + post state are consistent
/// with the BucketDelta and chain through sqrt_p. Returns sqrt_p_out so the
/// caller can chain across multiple active buckets.
///
/// Direction is inferred from the delta:
///   reserve_b_add > 0 (and reserve_a_sub > 0) => UP (B in, A out)
///   reserve_a_add > 0 (and reserve_b_sub > 0) => DOWN (A in, B out)
///   both zero on each side => no-op slot, skip
pub fn assert_bucket_step(
    before: BucketState,
    after: BucketState,
    delta: BucketDelta,
    sqrt_p_in: u128,
) -> u128 {
    // Reserves consistent with delta.
    assert(after.reserve_a == before.reserve_a + delta.reserve_a_add - delta.reserve_a_sub,
           "bucket reserve_a delta mismatch");
    assert(after.reserve_b == before.reserve_b + delta.reserve_b_add - delta.reserve_b_sub,
           "bucket reserve_b delta mismatch");
    // Liquidity preserved across swap (no add/withdraw inside a clearing).
    assert(after.liquidity == before.liquidity, "bucket liquidity changed during swap");

    // Fee cum_*_per_share consistent with cum_fee_*_per_share_increment.
    assert(after.cum_fee_a_per_share == before.cum_fee_a_per_share + delta.cum_fee_a_per_share_increment,
           "bucket cum_fee_a mismatch");
    assert(after.cum_fee_b_per_share == before.cum_fee_b_per_share + delta.cum_fee_b_per_share_increment,
           "bucket cum_fee_b mismatch");

    // sqrt_p out = sqrt_p_in updated per the V3 formula matching the delta.
    let mut sqrt_p_out = sqrt_p_in;
    if delta.reserve_b_add > 0 as u128 {
        // UP: B in by reserve_b_add (after-fee amount; matches aggregator), A out.
        // H11: only reserve_b_add (input) and reserve_a_sub (output, checked below)
        // may move. The reserve consistency asserts above net add-vs-sub, so an
        // UNCONSTRAINED reserve_b_sub / reserve_a_add lets a prover attach a phantom
        // B-out (draining b_from_pool) or A-in to an UP bucket while still balancing
        // `after`. Since the aggregate *_from_pool flows feed settlement, pin them to 0.
        // (The honest aggregator emits exactly this shape -- see clearing.ts:651-654
        // direction=true and test c5.)
        assert(delta.reserve_b_sub == 0 as u128, "UP bucket must not sub B");
        assert(delta.reserve_a_add == 0 as u128, "UP bucket must not add A");
        sqrt_p_out = next_sqrt_p_up(before.liquidity, sqrt_p_in, delta.reserve_b_add);
        let expected_out_a = swap_step_out_a(before.liquidity, sqrt_p_in, sqrt_p_out);
        // Allow 1-unit dust (rounding).
        let dust = if expected_out_a >= delta.reserve_a_sub {
            expected_out_a - delta.reserve_a_sub
        } else {
            delta.reserve_a_sub - expected_out_a
        };
        assert(dust <= 1 as u128, "bucket out_a deviates from V3 formula");
    } else if delta.reserve_a_add > 0 as u128 {
        // DOWN: A in, B out. H11: mirror -- only reserve_a_add + reserve_b_sub move.
        assert(delta.reserve_a_sub == 0 as u128, "DOWN bucket must not sub A");
        assert(delta.reserve_b_add == 0 as u128, "DOWN bucket must not add B");
        sqrt_p_out = next_sqrt_p_down(before.liquidity, sqrt_p_in, delta.reserve_a_add);
        let expected_out_b = swap_step_out_b(before.liquidity, sqrt_p_in, sqrt_p_out);
        let dust = if expected_out_b >= delta.reserve_b_sub {
            expected_out_b - delta.reserve_b_sub
        } else {
            delta.reserve_b_sub - expected_out_b
        };
        assert(dust <= 1 as u128, "bucket out_b deviates from V3 formula");
    } else {
        // No-op slot (padding): every reserve AND fee movement must be zero. Without
        // this a prover could drain via a "no-op" bucket whose subs are non-zero
        // (the reserve asserts above would still balance an all-zero before/after).
        // The honest aggregator zero-pads these slots (daemon.ts:225-226).
        assert(delta.reserve_a_add == 0 as u128, "no-op bucket must be zero (a_add)");
        assert(delta.reserve_a_sub == 0 as u128, "no-op bucket must be zero (a_sub)");
        assert(delta.reserve_b_add == 0 as u128, "no-op bucket must be zero (b_add)");
        assert(delta.reserve_b_sub == 0 as u128, "no-op bucket must be zero (b_sub)");
        assert(delta.cum_fee_a_per_share_increment == 0 as u128, "no-op bucket fee_a must be zero");
        assert(delta.cum_fee_b_per_share_increment == 0 as u128, "no-op bucket fee_b must be zero");
    }
    sqrt_p_out
}

/// M17: the fee implied by a pool's per-bucket cum_fee increments -- the amount
/// that must be FORWARDED to the pool with the clearing. Per real bucket:
/// fee_rec_T = mul_div(cum_fee_T_per_share_increment, liquidity_before, SCALE)
/// (floor). Floor subadditivity: any split of liquidity into LP shares claims at
/// most fee_rec of this increment, so reserves grown by fee_rec are solvent for
/// every withdrawal pattern. Padding slots (bucket_id >= NUM_BUCKETS) add zero.
/// Mirrors aggregator recoverForwardedFee and the pool contract binding assert.
pub fn recovered_fee(
    before: [BucketState; MAX_ACTIVE_BUCKETS_PER_EPOCH],
    deltas: [BucketDelta; MAX_ACTIVE_BUCKETS_PER_EPOCH],
) -> (u128, u128) {
    let mut fee_a: u128 = 0 as u128;
    let mut fee_b: u128 = 0 as u128;
    for k in 0..MAX_ACTIVE_BUCKETS_PER_EPOCH {
        if deltas[k].bucket_id < NUM_BUCKETS {
            fee_a = fee_a
                + mul_div(deltas[k].cum_fee_a_per_share_increment, before[k].liquidity, SCALE);
            fee_b = fee_b
                + mul_div(deltas[k].cum_fee_b_per_share_increment, before[k].liquidity, SCALE);
        }
    }
    (fee_a, fee_b)
}

/// H12: bound a pool's total minted fee-per-share to the fee it actually collected.
/// Each bucket's fee-per-share increment implies a fee of mul_div(inc, liquidity, SCALE)
/// (the inverse of the aggregator's cum_fee_inc = stepFee * SCALE / liquidity).
/// Summed over the pool's real buckets, that must not exceed
/// ceil_fee_from_net(to_pool - recovered): to_pool is GROSS post-M17 (post-fee adds
/// plus the forwarded fee), so the budget is keyed off the net inflow and a prover
/// cannot enlarge its own budget by minting more fee.
/// An adversarial prover who inflates any increment (to over-credit an LP) pushes the sum
/// past the bound and the proof is rejected, so the pool can never pay out more fee than
/// it took in (no drain). Padding slots (bucket_id >= NUM_BUCKETS) carry zero increments
/// (H11 no-op branch) and add nothing. a_to_pool pairs with cum_fee_a (DOWN swaps, A in);
/// b_to_pool with cum_fee_b (UP swaps, B in).
pub fn assert_pool_fee_conservation(
    before: [BucketState; MAX_ACTIVE_BUCKETS_PER_EPOCH],
    deltas: [BucketDelta; MAX_ACTIVE_BUCKETS_PER_EPOCH],
    a_to_pool: u128,
    b_to_pool: u128,
) {
    let (fee_a_recovered, fee_b_recovered) = recovered_fee(before, deltas);
    // M17: to_pool is GROSS (net adds + forwarded fee). Key the budget off the net
    // inflow so a prover cannot use its own minted fee to enlarge the budget.
    // Honest: net == sum(reserve_add), which verify_bucket_step already pins to the
    // V3 price transition, so the budget is anchored to real swap input.
    let net_a = saturating_sub(a_to_pool, fee_a_recovered);
    let net_b = saturating_sub(b_to_pool, fee_b_recovered);
    assert(fee_a_recovered <= ceil_fee_from_net(net_a), "fee_a minted exceeds collected");
    assert(fee_b_recovered <= ceil_fee_from_net(net_b), "fee_b minted exceeds collected");
}

/// #1: bind the proof to the pool's before-state. Field order MUST match
/// contracts/pool/src/main.nr's on-chain recompute (Task 5) and the JS
/// aggregator (Task 8) EXACTLY:
///   [ sqrt_p_before,
///     (bucket_id, reserve_a, reserve_b, liquidity, cum_fee_a, cum_fee_b) * active_count ]
/// Inactive slots (i >= active_count) are ZERO-PADDED; both circuit and contract
/// always hash the FULL 25-element array (no variable-length prefix), so the
/// digest is unambiguous. The Task 5 contract must likewise zero-initialize a
/// [Field; 25] and fill only active slots. before_states[i] pairs with
/// deltas[i].bucket_id.
pub fn pool_state_commitment(
    sqrt_p_before: u128,
    before_states: [BucketState; MAX_ACTIVE_BUCKETS_PER_EPOCH],
    deltas: [BucketDelta; MAX_ACTIVE_BUCKETS_PER_EPOCH],
    active_count: u32,
) -> Field {
    // 1 (sqrt) + 6 * MAX_ACTIVE_BUCKETS_PER_EPOCH(=4) = 25 elements.
    let mut input: [Field; 25] = [0; 25];
    input[0] = sqrt_p_before as Field;
    for i in 0..MAX_ACTIVE_BUCKETS_PER_EPOCH {
        let base = 1 + i * 6;
        let active = (i as u32) < active_count;
        input[base + 0] = if active { deltas[i].bucket_id as Field } else { 0 };
        input[base + 1] = if active { before_states[i].reserve_a as Field } else { 0 };
        input[base + 2] = if active { before_states[i].reserve_b as Field } else { 0 };
        input[base + 3] = if active { before_states[i].liquidity as Field } else { 0 };
        input[base + 4] = if active { before_states[i].cum_fee_a_per_share as Field } else { 0 };
        input[base + 5] = if active { before_states[i].cum_fee_b_per_share as Field } else { 0 };
    }
    poseidon::poseidon2::Poseidon2::hash(input, 25)
}
