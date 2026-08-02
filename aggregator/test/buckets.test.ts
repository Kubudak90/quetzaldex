import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  computeDepositInRange, computeDepositBelowRange, computeDepositAboveRange,
  computeDeposit, maxAInToUpper, maxBInToLower,
  SCALE,
} from "../src/buckets.js";

const SQRT_LOWER = 1_000_000_000_000_000_000n;  // sqrt(1.0e18)
const SQRT_UPPER = 1_224_744_871_391_589_049n;  // sqrt(1.5e18)
const SQRT_P     = 1_118_033_988_749_894_848n;  // sqrt(1.25e18)

describe("buckets.computeDepositInRange", () => {
  it("basic call mints positive L, used_* within input bounds", () => {
    const x_a = 1_000_000_000n;
    const x_b = 1_000_000_000n;
    const m = computeDepositInRange(x_a, x_b, SQRT_P, SQRT_LOWER, SQRT_UPPER);
    assert.ok(m.l_used > 0n);
    assert.ok(m.used_a <= x_a);
    assert.ok(m.used_b <= x_b);
  });

  it("A surplus → l_b binding, used_a < x_a", () => {
    const x_a = 10_000_000_000n;
    const x_b = 1_000_000_000n;
    const m = computeDepositInRange(x_a, x_b, SQRT_P, SQRT_LOWER, SQRT_UPPER);
    assert.ok(m.l_used > 0n);
    assert.ok(m.used_a < x_a, "expected refund on a");
  });
});

describe("buckets.computeDepositBelowRange", () => {
  it("consumes all x_a, mints L, used_b is 0", () => {
    const m = computeDepositBelowRange(1_000_000_000n, SQRT_LOWER, SQRT_UPPER);
    assert.ok(m.l_used > 0n);
    assert.equal(m.used_a, 1_000_000_000n);
    assert.equal(m.used_b, 0n);
  });
});

describe("buckets.computeDepositAboveRange", () => {
  it("consumes all x_b, mints L, used_a is 0", () => {
    const m = computeDepositAboveRange(1_000_000_000n, SQRT_LOWER, SQRT_UPPER);
    assert.ok(m.l_used > 0n);
    assert.equal(m.used_a, 0n);
    assert.equal(m.used_b, 1_000_000_000n);
  });
});

describe("buckets.computeDeposit (dispatch)", () => {
  const bounds = { sqrt_lower: SQRT_LOWER, sqrt_upper: SQRT_UPPER };

  it("dispatches to below_range when sqrt_p <= sqrt_lower", () => {
    const m = computeDeposit(1_000_000_000n, 5_000_000_000n, 100_000_000_000_000_000n, bounds);
    assert.equal(m.used_b, 0n, "below-range path used");
  });

  it("dispatches to above_range when sqrt_p >= sqrt_upper", () => {
    const m = computeDeposit(5_000_000_000n, 1_000_000_000n, 5_000_000_000_000_000_000n, bounds);
    assert.equal(m.used_a, 0n, "above-range path used");
  });

  it("dispatches to in_range for sqrt_p between bounds", () => {
    const m = computeDeposit(1_000_000_000n, 1_000_000_000n, SQRT_P, bounds);
    assert.ok(m.used_a > 0n);
    assert.ok(m.used_b > 0n);
  });
});

describe("buckets.maxAInToUpper / maxBInToLower", () => {
  const bounds = { sqrt_lower: SQRT_LOWER, sqrt_upper: SQRT_UPPER };

  it("empty bucket → zero flow both ways", () => {
    const state = {
      reserve_a: 0n, reserve_b: 0n, liquidity: 0n,
      cum_fee_a_per_share: 0n, cum_fee_b_per_share: 0n,
    };
    assert.equal(maxAInToUpper(state, bounds, SQRT_P), 0n);
    assert.equal(maxBInToLower(state, bounds, SQRT_P), 0n);
  });

  it("non-empty bucket has positive max in both directions", () => {
    const state = {
      reserve_a: 1_000_000n, reserve_b: 1_000_000n, liquidity: 1_000_000_000n,
      cum_fee_a_per_share: 0n, cum_fee_b_per_share: 0n,
    };
    assert.ok(maxAInToUpper(state, bounds, SQRT_P) > 0n);
    assert.ok(maxBInToLower(state, bounds, SQRT_P) > 0n);
  });
});

// ============================================================================
// Sub-2.5: V3 swap-step math (B6-B10)
// ============================================================================
import {
  nextSqrtPUp,
  nextSqrtPDown,
  swapStepOutA,
  swapStepOutB,
} from "../src/buckets.js";

describe("V3 swap-step math (Sub-2.5)", () => {
  it("B6: nextSqrtPUp adds delta_b * SCALE / L", () => {
    const L = 10n * SCALE;
    const sqrtP = SCALE;
    const deltaB = SCALE / 100n;
    const out = nextSqrtPUp(L, sqrtP, deltaB);
    assert.equal(out, sqrtP + (deltaB * SCALE) / L);
  });

  it("B7: nextSqrtPDown matches (sqrt_p * L * SCALE)/(L * SCALE + delta_a * sqrt_p)", () => {
    const L = 10n * SCALE;
    const sqrtP = SCALE;
    const deltaA = SCALE / 100n;
    const out = nextSqrtPDown(L, sqrtP, deltaA);
    const expected = (sqrtP * L * SCALE) / (L * SCALE + deltaA * sqrtP);
    assert.equal(out, expected);
  });

  it("B8: swapStepOutA = L * (sqrt_p_new - sqrt_p) / mul_div(sqrt_p, sqrt_p_new, SCALE)", () => {
    const L = 10n * SCALE;
    const sqrtP = SCALE;
    const sqrtPNew = sqrtP + SCALE / 1000n;
    const out = swapStepOutA(L, sqrtP, sqrtPNew);
    const denom = (sqrtP * sqrtPNew) / SCALE;
    assert.equal(out, (L * (sqrtPNew - sqrtP)) / denom);
  });

  it("B9: swapStepOutB = L * (sqrt_p - sqrt_p_new) / SCALE", () => {
    const L = 10n * SCALE;
    const sqrtP = SCALE;
    const sqrtPNew = sqrtP - SCALE / 1000n;
    const out = swapStepOutB(L, sqrtP, sqrtPNew);
    assert.equal(out, (L * (sqrtP - sqrtPNew)) / SCALE);
  });

  it("B10: round-trip up-then-down at single bucket converges to within dust", () => {
    const L = 10n * SCALE;
    const sqrtP0 = SCALE;
    const deltaB = SCALE / 100n;
    const sqrtP1 = nextSqrtPUp(L, sqrtP0, deltaB);
    const outA = swapStepOutA(L, sqrtP0, sqrtP1);
    const sqrtP2 = nextSqrtPDown(L, sqrtP1, outA);
    const outB = swapStepOutB(L, sqrtP1, sqrtP2);
    const dust = deltaB > outB ? deltaB - outB : outB - deltaB;
    assert.ok(dust * 10n ** 12n < deltaB, `round-trip dust ${dust} too large`);
  });
});

// Parity-spirit: structural assertions mirroring circuits/clearing/src/test.nr
// b1-b5 expectations. Tighter numeric parity (exact bigint equality) is left
// to a future fixture-capture pass.
describe("buckets parity (structural)", () => {
  it("F1 in_range A-surplus matches structural Noir B2", () => {
    const m = computeDepositInRange(10_000_000_000n, 1_000_000_000n, SQRT_P, SQRT_LOWER, SQRT_UPPER);
    assert.ok(m.used_a < 10_000_000_000n);
    assert.ok(m.l_used > 0n);
  });
  it("F2 below_range matches Noir B3", () => {
    const m = computeDepositBelowRange(1_000_000_000n, SQRT_LOWER, SQRT_UPPER);
    assert.equal(m.used_a, 1_000_000_000n);
    assert.equal(m.used_b, 0n);
    assert.ok(m.l_used > 0n);
  });
  it("F3 above_range matches Noir B4", () => {
    const m = computeDepositAboveRange(1_000_000_000n, SQRT_LOWER, SQRT_UPPER);
    assert.equal(m.used_a, 0n);
    assert.equal(m.used_b, 1_000_000_000n);
    assert.ok(m.l_used > 0n);
  });
});
