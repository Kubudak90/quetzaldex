/**
 * Fixed-point helpers for the clearing aggregator. All amounts are `bigint`;
 * prices are quote-per-base, scaled by `SCALE` (1e18) - matching the Noir
 * `OrderNote.limit_price` field.
 */

/** Price fixed-point scale: a price of 1.0 is `SCALE`. */
export const SCALE = 1_000_000_000_000_000_000n;

/**
 * The 0.3% swap fee, applied to the swap input:
 * `input_after_fee = input * FEE_NUM / FEE_DEN`. The withheld `0.3%` is the LP fee.
 */
export const FEE_NUM = 9970n;
export const FEE_DEN = 10_000n;

/**
 * `a * b / denom`, truncated toward zero - equivalent to floor for non-negative
 * operands, which is every call site in the clearing algorithm (token amounts,
 * prices and fees are never negative). `bigint` is arbitrary-precision, so the
 * `a * b` intermediate is exact and never overflows; this helper centralises the
 * divide-by-zero guard and documents the truncating-division intent.
 */
export function mulDiv(a: bigint, b: bigint, denom: bigint): bigint {
  if (denom === 0n) throw new Error("mulDiv: division by zero");
  return (a * b) / denom;
}
