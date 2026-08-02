/**
 * Sub-2: V3 math primitives (JS mirror of circuits/clearing/src/buckets.nr
 * and contracts/pool/src/buckets.nr). Parity must be maintained -- see
 * aggregator/test/buckets.parity.test.ts.
 *
 * All inputs/outputs are bigint in 1e18-scaled Q-format.
 */

export const SCALE = 1_000_000_000_000_000_000n;

export interface BucketBounds {
  sqrt_lower: bigint;
  sqrt_upper: bigint;
}

export interface BucketState {
  reserve_a: bigint;
  reserve_b: bigint;
  liquidity: bigint;
  cum_fee_a_per_share: bigint;
  cum_fee_b_per_share: bigint;
}

export interface DepositMath {
  l_used: bigint;
  used_a: bigint;
  used_b: bigint;
}

function mulDiv(a: bigint, b: bigint, c: bigint): bigint {
  if (c === 0n) throw new Error("mul_div: divisor is zero");
  return (a * b) / c;
}

export function computeDepositInRange(
  x_a: bigint, x_b: bigint,
  sqrt_p: bigint, sqrt_lower: bigint, sqrt_upper: bigint,
): DepositMath {
  const sqrt_p_x_upper = mulDiv(sqrt_p, sqrt_upper, SCALE);
  const span_upper = sqrt_upper - sqrt_p;
  const span_lower = sqrt_p - sqrt_lower;

  const l_a = mulDiv(x_a, sqrt_p_x_upper, span_upper);
  const l_b = mulDiv(x_b, SCALE, span_lower);
  const l_used = l_a < l_b ? l_a : l_b;

  const used_a = mulDiv(l_used, span_upper, sqrt_p_x_upper);
  const used_b = mulDiv(l_used, span_lower, SCALE);

  return { l_used, used_a, used_b };
}

export function computeDepositBelowRange(
  x_a: bigint, sqrt_lower: bigint, sqrt_upper: bigint,
): DepositMath {
  const sqrt_lower_x_upper = mulDiv(sqrt_lower, sqrt_upper, SCALE);
  const span = sqrt_upper - sqrt_lower;
  const l_used = mulDiv(x_a, sqrt_lower_x_upper, span);
  return { l_used, used_a: x_a, used_b: 0n };
}

export function computeDepositAboveRange(
  x_b: bigint, sqrt_lower: bigint, sqrt_upper: bigint,
): DepositMath {
  const span = sqrt_upper - sqrt_lower;
  const l_used = mulDiv(x_b, SCALE, span);
  return { l_used, used_a: 0n, used_b: x_b };
}

export function computeDeposit(
  x_a: bigint, x_b: bigint,
  sqrt_p: bigint, bounds: BucketBounds,
): DepositMath {
  if (sqrt_p <= bounds.sqrt_lower) {
    return computeDepositBelowRange(x_a, bounds.sqrt_lower, bounds.sqrt_upper);
  } else if (sqrt_p >= bounds.sqrt_upper) {
    return computeDepositAboveRange(x_b, bounds.sqrt_lower, bounds.sqrt_upper);
  } else {
    return computeDepositInRange(x_a, x_b, sqrt_p, bounds.sqrt_lower, bounds.sqrt_upper);
  }
}

export function maxAInToUpper(state: BucketState, bounds: BucketBounds, sqrt_p: bigint): bigint {
  const span = bounds.sqrt_upper - sqrt_p;
  const denom = mulDiv(sqrt_p, bounds.sqrt_upper, SCALE);
  return mulDiv(state.liquidity, span, denom);
}

export function maxBInToLower(state: BucketState, bounds: BucketBounds, sqrt_p: bigint): bigint {
  const span = sqrt_p - bounds.sqrt_lower;
  return mulDiv(state.liquidity, span, SCALE);
}

/**
 * Sub-2.5: V3 swap-step math. Q-format 1e18, round-down convention.
 */

/** input is token B going in (pool moves UP) */
export function nextSqrtPUp(L: bigint, sqrtP: bigint, deltaB: bigint): bigint {
  return sqrtP + (deltaB * SCALE) / L;
}

/** input is token A going in (pool moves DOWN)
 *
 * R6: MUST stay byte-identical to circuits/clearing/src/buckets.nr::next_sqrt_p_down,
 * which the clearing circuit asserts with no tolerance. The circuit floors TWICE
 * (inner `mul_div(delta_a, sqrt_p, SCALE)`, then outer `mul_div(sqrt_p, L, denom)`);
 * a single floor over `(sqrtP*L*SCALE)/(L*SCALE + deltaA*sqrtP)` keeps an exact
 * denominator and diverges at every price != 1.0, making buy-heavy epochs unprovable.
 * See test/buckets-down-parity.test.ts.
 */
export function nextSqrtPDown(L: bigint, sqrtP: bigint, deltaA: bigint): bigint {
  const denom = L + (deltaA * sqrtP) / SCALE; // inner floor
  return (sqrtP * L) / denom; // outer floor
}

/** token A paid out as pool moved UP from sqrtP to sqrtPNew (precondition: sqrtPNew >= sqrtP) */
export function swapStepOutA(L: bigint, sqrtP: bigint, sqrtPNew: bigint): bigint {
  const denom = (sqrtP * sqrtPNew) / SCALE;
  return (L * (sqrtPNew - sqrtP)) / denom;
}

/** token B paid out as pool moved DOWN from sqrtP to sqrtPNew (precondition: sqrtPNew <= sqrtP) */
export function swapStepOutB(L: bigint, sqrtP: bigint, sqrtPNew: bigint): bigint {
  return (L * (sqrtP - sqrtPNew)) / SCALE;
}
