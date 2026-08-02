// sdk/src/pools.test.ts
// Sub-8.2b unit tests for PoolsApi pure helpers (no PXE / contract calls).
// Uses node:test + node:assert (same pattern as orders.test.ts).

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  computeDeposit,
  computeBucketBounds,
  computeAllBucketBounds,
  depositRegime,
  PoolError,
} from "./pools.js";

const SCALE = 1_000_000_000_000_000_000n;

// ─── computeBucketBounds ──────────────────────────────────────────────────────

describe("computeBucketBounds", () => {
  test("bucket 0 bounds: sqrt_lower = pMinSqrt, sqrt_upper = pMinSqrt * growthNum / SCALE", () => {
    const pMin = 2n * SCALE / 10n; // 0.2e18
    const growth = 12n * SCALE / 10n; // 1.2e18 (20% wide buckets)
    const bounds = computeBucketBounds(pMin, growth, 0);
    assert.equal(bounds.sqrt_lower, pMin);
    assert.equal(bounds.sqrt_upper, (pMin * growth) / SCALE);
  });

  test("bucket 1 sqrt_lower equals bucket 0 sqrt_upper", () => {
    const pMin = SCALE; // 1e18
    const growth = (12n * SCALE) / 10n; // 1.2e18
    const b0 = computeBucketBounds(pMin, growth, 0);
    const b1 = computeBucketBounds(pMin, growth, 1);
    assert.equal(b0.sqrt_upper, b1.sqrt_lower);
  });

  test("bucket bounds are strictly increasing", () => {
    const pMin = SCALE;
    const growth = (11n * SCALE) / 10n;
    for (let i = 0; i < 15; i++) {
      const bi = computeBucketBounds(pMin, growth, i);
      const bi1 = computeBucketBounds(pMin, growth, i + 1);
      assert.ok(bi1.sqrt_lower > bi.sqrt_lower, `bucket ${i + 1} lower should exceed bucket ${i} lower`);
    }
  });
});

// ─── depositRegime ────────────────────────────────────────────────────────────

describe("depositRegime", () => {
  const bounds = { sqrt_lower: 100n, sqrt_upper: 200n };

  test("below-range when sqrt_p <= sqrt_lower", () => {
    assert.equal(depositRegime(100n, bounds), "below-range");
    assert.equal(depositRegime(50n, bounds), "below-range");
  });

  test("above-range when sqrt_p >= sqrt_upper", () => {
    assert.equal(depositRegime(200n, bounds), "above-range");
    assert.equal(depositRegime(300n, bounds), "above-range");
  });

  test("in-range when sqrt_lower < sqrt_p < sqrt_upper", () => {
    assert.equal(depositRegime(150n, bounds), "in-range");
  });
});

// ─── computeDeposit ───────────────────────────────────────────────────────────

describe("computeDeposit — fresh pool (below-range)", () => {
  // Mimics seed-lp.ts scenario: sqrt_p == p_min_sqrt means every bucket
  // has sqrt_lower >= sqrt_p → BelowRange → only token A is consumed.

  const pMin = SCALE; // 1e18 for simplicity
  const growth = (12n * SCALE) / 10n;
  const bounds = computeBucketBounds(pMin, growth, 8);
  const currentSqrtPrice = pMin; // pool is fresh; sqrt_p == p_min

  test("used_b is zero in below-range regime", () => {
    const amountA = 5_000n * 10n ** 6n; // 5000 tUSDC (6 decimals)
    const result = computeDeposit(amountA, 2n * SCALE, currentSqrtPrice, bounds);
    assert.equal(result.used_b, 0n, "used_b must be 0 in BelowRange");
    assert.equal(result.used_a, amountA, "used_a must equal amount_a in BelowRange");
    assert.ok(result.l_used > 0n, "l_used must be positive");
  });

  test("l_used is zero when amountA is zero in below-range", () => {
    const result = computeDeposit(0n, 1000n, currentSqrtPrice, bounds);
    assert.equal(result.l_used, 0n);
  });
});

describe("computeDeposit — above-range (only token B consumed)", () => {
  // sqrt_p is above the bucket's range → AboveRange → only token B counts.
  const bounds = { sqrt_lower: 100n * SCALE, sqrt_upper: 120n * SCALE };
  const sqrtP = 200n * SCALE; // above the bucket

  test("used_a is zero in above-range regime", () => {
    const amountB = 2n * SCALE;
    const result = computeDeposit(9999n, amountB, sqrtP, bounds);
    assert.equal(result.used_a, 0n, "used_a must be 0 in AboveRange");
    assert.equal(result.used_b, amountB, "used_b must equal amount_b in AboveRange");
    assert.ok(result.l_used > 0n);
  });
});

describe("computeDeposit — in-range (both tokens consumed)", () => {
  const sqrtLower = 90n * SCALE;
  const sqrtUpper = 110n * SCALE;
  const bounds = { sqrt_lower: sqrtLower, sqrt_upper: sqrtUpper };
  const sqrtP = 100n * SCALE; // right in the middle

  test("both used_a and used_b are positive in in-range regime", () => {
    // Large inputs so neither side is the limiting side trivially.
    const amountA = SCALE * 1_000_000n;
    const amountB = SCALE * 1_000_000n;
    const result = computeDeposit(amountA, amountB, sqrtP, bounds);
    assert.ok(result.used_a > 0n, "used_a must be positive in InRange");
    assert.ok(result.used_b > 0n, "used_b must be positive in InRange");
    assert.ok(result.l_used > 0n);
    // Neither side can exceed the input.
    assert.ok(result.used_a <= amountA);
    assert.ok(result.used_b <= amountB);
  });
});

// ─── PoolError ────────────────────────────────────────────────────────────────

describe("PoolError", () => {
  test("is an Error with name PoolError", () => {
    const e = new PoolError("INVALID_INPUT", "test error");
    assert.ok(e instanceof Error);
    assert.equal(e.name, "PoolError");
    assert.equal(e.code, "INVALID_INPUT");
    assert.equal(e.message, "test error");
  });
});

// ─── computeAllBucketBounds ───────────────────────────────────────────────────

describe("computeAllBucketBounds", () => {
  test("returns numBuckets bounds, [0].lower==pMin, contiguous", () => {
    const pMin = SCALE / 10n;
    const growth = (105n * SCALE) / 100n;
    const all = computeAllBucketBounds(pMin, growth, 16);
    assert.equal(all.length, 16);
    assert.equal(all[0].sqrt_lower, pMin);
    assert.equal(all[1].sqrt_lower, all[0].sqrt_upper); // contiguous
    assert.equal(all[0].sqrt_upper, computeBucketBounds(pMin, growth, 0).sqrt_upper);
  });
});
