//! Sub-2: V3 math primitives (pool-contract duplicate of
//! circuits/clearing/src/buckets.nr). Parity must be maintained --
//! see contracts/pool/src/test.nr's structural assertions.
//!
//! All values are u128 in 1e18-scaled Q-format.

/// Fixed-point scale.
pub global SCALE: u128 = 1_000_000_000_000_000_000;

/// mul_div(a, b, c) = floor(a * b / c). For pathologically-large inputs the
/// naive product overflows u128 and reverts (safe failure -- no fund loss).
/// Test-fixture amounts never overflow.
pub fn mul_div(a: u128, b: u128, c: u128) -> u128 {
    assert(c != 0 as u128, "mul_div: divisor is zero");
    (a * b) / c
}

pub struct BucketBounds {
    pub sqrt_lower: u128,
    pub sqrt_upper: u128,
}

pub struct DepositMath {
    pub l_used: u128,
    pub used_a: u128,
    pub used_b: u128,
}

pub fn compute_deposit_in_range(
    x_a: u128,
    x_b: u128,
    sqrt_p: u128,
    sqrt_lower: u128,
    sqrt_upper: u128,
) -> DepositMath {
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

pub fn compute_deposit_above_range(
    x_b: u128,
    sqrt_lower: u128,
    sqrt_upper: u128,
) -> DepositMath {
    let span = sqrt_upper - sqrt_lower;
    let l_used = mul_div(x_b, SCALE, span);
    DepositMath { l_used, used_a: 0 as u128, used_b: x_b }
}

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
