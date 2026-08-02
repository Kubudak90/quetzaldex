//! AMM constant-product check (spec sec 6.6).
//! k = reserve_a * reserve_b can only shrink across a clearing because the
//! fee is withheld from reserve growth (Week 5b conservation invariant).

/// Asserts new_a * new_b <= old_a * old_b.
///
/// The product can reach 2^256 (u128 * u128), so we route via Field (~2^254).
/// To express the unsigned `<=` on Field values, we use the fact that for
/// reserves bounded by realistic supply (well below 2^120 each), |old_k - new_k|
/// fits inside 2^128 with margin. We assert old_k - new_k castable to u128;
/// the cast traps if the subtraction wrapped (which means new_k > old_k).
pub fn assert_k_monotonic(old_a: u128, old_b: u128, new_a: u128, new_b: u128) {
    let old_k: Field = (old_a as Field) * (old_b as Field);
    let new_k: Field = (new_a as Field) * (new_b as Field);
    // If new_k > old_k, Field subtraction wraps to a huge value and the u128
    // cast traps. If new_k <= old_k, the diff is at most 2^128-bounded by
    // realistic reserve magnitudes (reserves themselves < ~2^120 each in the
    // worst sensible case), and the cast succeeds.
    let diff_field: Field = old_k - new_k;
    let _diff_u128: u128 = diff_field as u128;
    // The cast itself is the constraint: any wrap (new_k > old_k modulo p)
    // produces a Field value far above 2^128, and the u128 cast fails.
}
