//! Fixed-point arithmetic + payout/eligibility primitives for clearing.

pub global SCALE: u128 = 1_000_000_000_000_000_000;   // 1e18, matches aggregator's fixed-point
pub global FEE_NUM: u128 = 30;                         // 30 bps numerator
pub global FEE_DEN: u128 = 10_000;                     // 30 bps denominator

// 2^64, used to split u128 values into hi/lo u64 halves.
global TWO_POW_64: u128 = 18_446_744_073_709_551_616; // 2^64

/// (x * y) / z with floor rounding.
///
/// The product x*y can reach ~2^188 when x or y is near 1e18 (~2^60), which
/// overflows u128. We compute it via a 256-bit intermediate represented as a
/// pair of u128 (hi, lo) using long multiplication over u64 limbs, then do
/// long division by z.
///
/// Spec s6.7 fallback: Field `/` in Noir is modular inverse, not integer floor
/// division, so we use the u64 hi/lo limb approach throughout.
///
/// Caller must ensure z >= 1 and that the true quotient fits in u128.
pub fn mul_div(x: u128, y: u128, z: u128) -> u128 {
    assert(z != 0 as u128, "mul_div: divide by zero");

    // Split x and y into 64-bit halves: x = x_hi * 2^64 + x_lo
    let x_lo: u128 = x % TWO_POW_64;
    let x_hi: u128 = x / TWO_POW_64;
    let y_lo: u128 = y % TWO_POW_64;
    let y_hi: u128 = y / TWO_POW_64;

    // Compute 256-bit product p = x * y = (x_hi * 2^64 + x_lo) * (y_hi * 2^64 + y_lo)
    //   = x_hi*y_hi * 2^128  +  (x_hi*y_lo + x_lo*y_hi) * 2^64  +  x_lo*y_lo
    //
    // Each partial product fits in u128 because each factor is < 2^64.
    let p0: u128 = x_lo * y_lo;                    // bits [0..127]
    let p1: u128 = x_lo * y_hi;                    // bits [64..191]
    let p2: u128 = x_hi * y_lo;                    // bits [64..191]
    let p3: u128 = x_hi * y_hi;                    // bits [128..255]

    // Accumulate into (lo128, hi128) -- a pair of u128 representing a 256-bit value
    // where the full product = hi128 * 2^128 + lo128.

    // lo128 starts with p0, then add p1<<64 and p2<<64
    let lo128: u128 = p0 + (p1 % TWO_POW_64) * TWO_POW_64 + (p2 % TWO_POW_64) * TWO_POW_64;

    // carries from lo128 into hi128
    // lo128 = p0 + (p1_lo + p2_lo)*2^64; extract carry
    // We compute carry step by step to avoid overflow (each add could overflow u128).
    let lo_a: u128 = p0;
    let p1_lo_shifted = (p1 % TWO_POW_64) * TWO_POW_64;
    let lo_b = lo_a + p1_lo_shifted;
    let carry_ab: u128 = if lo_b < lo_a { 1 } else { 0 };
    let p2_lo_shifted = (p2 % TWO_POW_64) * TWO_POW_64;
    let lo_c = lo_b + p2_lo_shifted;
    let carry_bc: u128 = if lo_c < lo_b { 1 } else { 0 };

    // Unused: lo128 value is lo_c; we don't actually need lo128 directly below.
    // hi128 accumulates the high parts.
    let hi128: u128 = p3 + p1 / TWO_POW_64 + p2 / TWO_POW_64 + carry_ab + carry_bc;

    // Now divide the 256-bit number (hi128 * 2^128 + lo_c) by z using long division.
    // We do two passes: first reduce hi128 mod z (getting a remainder < z that fits
    // in a u128), then combine with lo_c for the final division.
    //
    // Pass 1: quotient_hi = hi128 / z,  rem1 = hi128 % z
    let quot_hi: u128 = hi128 / z;
    let rem1: u128 = hi128 % z;
    // (This contributes quot_hi * 2^128 to the final quotient, but since the caller
    //  guarantees the true quotient fits in u128, quot_hi must be 0.)
    assert(quot_hi == 0 as u128, "mul_div: intermediate overflow");

    // Pass 2: divide (rem1 * 2^128 + lo_c) by z.
    // rem1 < z <= 2^128, so rem1 * 2^128 can be huge. We do the 128-bit long division
    // by splitting lo_c into two 64-bit halves and doing two digit-by-digit steps,
    // using rem1 as the running remainder.
    //
    // Step 2a: bring in the high 64 bits of lo_c.
    let lo_c_hi: u128 = lo_c / TWO_POW_64;
    let lo_c_lo: u128 = lo_c % TWO_POW_64;

    // Dividend for step 2a = rem1 * 2^64 + lo_c_hi
    // = concatenation of rem1 (high) and lo_c_hi (low 64 bits).
    // We need (rem1 * 2^64 + lo_c_hi) / z and mod z.
    // rem1 < z, so rem1 * 2^64 < z * 2^64.  The quotient of this step fits in 64 bits.
    //
    // Use the standard multi-word division step:
    //   q2a = (rem1 * 2^64 + lo_c_hi) / z
    //   r2a = (rem1 * 2^64 + lo_c_hi) % z
    //
    // If z fits in 64 bits, rem1 * 2^64 fits in u128 safely:
    //   rem1 < z < 2^64 => rem1 * 2^64 < 2^128 (fine)
    // If z >= 2^64, then rem1 < z, so rem1 <= z-1 < 2^128.  We need
    //   rem1 * 2^64 which can overflow u128 if rem1 >= 2^64.
    //   But in that case the dividend > 2^128 and we can't compute it directly.
    //
    // For our use case: z is at most ~2e18 < 2^61, so z < 2^64 always. That means
    // rem1 < z < 2^64 too, and rem1 * 2^64 < 2^128 -- safe.
    //
    // (If future callers use z >= 2^64, this will assert below.)
    assert(z < TWO_POW_64, "mul_div: z must be < 2^64 for this implementation");

    let dividend_2a: u128 = rem1 * TWO_POW_64 + lo_c_hi;
    let q2a: u128 = dividend_2a / z;
    let r2a: u128 = dividend_2a % z;

    // Step 2b: bring in the low 64 bits of lo_c.
    let dividend_2b: u128 = r2a * TWO_POW_64 + lo_c_lo;
    let q2b: u128 = dividend_2b / z;
    // r2b = dividend_2b % z  (the final remainder, which we discard for floor)

    // Final quotient = q2a * 2^64 + q2b
    q2a * TWO_POW_64 + q2b
}

use crate::types::OrderPreimage;

/// Per-order eligibility at the clearing price (spec sec 6.2.7).
///   Buy  (side=false): limit_price >= clearing_price (willing to pay up to limit).
///   Sell (side=true):  limit_price <= clearing_price (willing to accept >= limit).
pub fn eligible(order: OrderPreimage, clearing_price: u128) -> bool {
    if order.side {
        // sell
        order.limit_price <= clearing_price
    } else {
        // buy
        order.limit_price >= clearing_price
    }
}

/// Canonical payout formula (spec sec 6.2.8). Result is the amount_out
/// the order receives in its output token, post-fee.
///   Buy:  out_b = ((amount_in * SCALE) / P*) * (FEE_DEN - FEE_NUM) / FEE_DEN
///   Sell: out_a = ((amount_in * P*) / SCALE) * (FEE_DEN - FEE_NUM) / FEE_DEN
pub fn payout(order: OrderPreimage, clearing_price: u128) -> u128 {
    let gross: u128 = if order.side {
        // sell: amount_in (token B) * P* / SCALE -> token A
        mul_div(order.amount_in, clearing_price, SCALE)
    } else {
        // buy: amount_in (token A) * SCALE / P* -> token B
        mul_div(order.amount_in, SCALE, clearing_price)
    };
    mul_div(gross, FEE_DEN - FEE_NUM, FEE_DEN)
}

/// max(0, x - y) without underflow. Used by main.nr to express
/// "a_to_pool = max(0, gross_buy_in_a - seller_payouts_a)" cleanly.
pub fn saturating_sub(x: u128, y: u128) -> u128 {
    if x > y { x - y } else { 0 as u128 }
}

// ============================================================================
// Sub-4: per-hop eligibility + payout helpers.
// ============================================================================

/// Sub-4: order eligibility at a clearing price p_star.
///   ask (side=true):  limit_price <= p_star
///   bid (side=false): limit_price >= p_star
pub fn eligible_with_p(side: bool, limit_price: u128, p_star: u128) -> bool {
    if side {
        limit_price <= p_star
    } else {
        limit_price >= p_star
    }
}

/// Sub-4: per-hop payout = amount_in * (SCALE/p_star or p_star/SCALE) * fee.
///   ask (side=true):  amount_in (path[last]) * p_star / SCALE -> path[0]
///   bid (side=false): amount_in (path[0])   * SCALE / p_star -> path[last]
pub fn payout_at_price(amount_in: u128, p_star: u128, side: bool) -> u128 {
    let gross: u128 = if side {
        mul_div(amount_in, p_star, SCALE)
    } else {
        mul_div(amount_in, SCALE, p_star)
    };
    mul_div(gross, FEE_DEN - FEE_NUM, FEE_DEN)
}

// ============================================================================
// SETTLE-INV (Sub-conservation): per-(pool,token) solvency + anti-grief floor.
// ============================================================================

/// SETTLE-INV (c) -- per-token SOLVENCY. The orderbook holds `escrow` (filled
/// makers' gross input in token T) and receives `from_pool` (T out of the pool);
/// it spends `to_pool` (T into the pool) plus `pay` (Sum claim_fill payouts in T).
/// Solvent iff it never pays/sends more T than it holds:
///   pay + to_pool <= from_pool + escrow
/// Fee-agnostic: `to_pool` is post-fee (the 0.3% LP fee is withheld from input and
/// retained by the orderbook), so the inequality holds with the fee as slack and
/// never bricks an honest clearing. This is what lets the manual float be removed.
pub fn token_solvent(pay: u128, to_pool: u128, from_pool: u128, escrow: u128) -> bool {
    pay + to_pool <= from_pool + escrow
}

/// SETTLE-INV (b) -- pro-rata floor share of a receive-group's paid-out total.
/// A filled maker must receive at least this, so a cheating aggregator cannot
/// starve a filled maker below their proportional share. mul_div floors; the
/// kernel's non-last fills equal this exactly and the residual-absorbing last
/// fill exceeds it, so honest conservation-exact fills always satisfy `>= floor`.
/// NOTE: `sum_in_group` is the mul_div divisor, so per-group filled input must
/// stay < 2^64 (~1.8e19 raw units) -- fine at the live ~1e8 token scale.
pub fn floor_share(pay_group: u128, amount_in: u128, sum_in_group: u128) -> u128 {
    mul_div(pay_group, amount_in, sum_in_group)
}

/// SETTLE-INV (b) -- a PROVABLE, tight upper bound on the LP fee the orderbook
/// RETAINS in token T, expressed from the PUBLIC post-fee pool inflow `to_pool`.
///
/// The AMM withholds the 0.3% fee from the gross input: on-chain
///   to_pool = floor(remaining * (FEE_DEN - FEE_NUM) / FEE_DEN)   (aggregator traceBucketSwap)
///   retained = remaining - to_pool
/// so `retained` is a function of the GROSS input `remaining`, while `to_pool` is a
/// FLOORED function of it. Inverting that floor needs BOTH the inner `+1` and the
/// outer ceil: `ceil((to_pool+1)*FEE_NUM/(FEE_DEN-FEE_NUM))` is the exact worst-case
/// `retained` over all `remaining` that floor to this `to_pool`. It is a provable
/// upper bound (>= retained for EVERY input, incl. to_pool=0 -> 1, covering the
/// dust-escrow output-token edge) and tight to <= 1 raw unit, so avail_floor stays
/// <= the kernel's true net payout xTotal and an honest CoW clear NEVER bricks.
///
/// (The earlier `0.3%*GROSS escrow` collapsed avail_floor to 0 on thin CoW; the
/// dropped `+1` variant `ceil(to_pool*30/9970)` undercounts by 1 on the dense
/// to_pool in {332,664,997,...} family and FATALLY bricks honest clears.)
pub fn ceil_fee_from_net(to_pool: u128) -> u128 {
    let denom: u128 = FEE_DEN - FEE_NUM; // 9970
    let num: u128 = (to_pool + 1 as u128) * FEE_NUM; // (to_pool+1)*30, < 2^128 at token scale
    // ceil(num/denom) = floor((num + denom - 1)/denom). Plain `/` floors u128 in Noir.
    (num + (denom - 1 as u128)) / denom
}
