import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { bucketNetSwap, type PoolWithBuckets } from "../src/clearing.js";
import { SCALE } from "../src/buckets.js";

// Single-sided pool: all token A in one funded bucket, price at the bucket's lower edge.
function singleSidedPool(): PoolWithBuckets {
  const sqrtLower = SCALE;            // 1.0
  const sqrtUpper = 2n * SCALE;       // 2.0
  const liquidity = 1_000n * SCALE;
  return {
    reserveA: 1_000n * SCALE,
    reserveB: 0n,
    lpSupply: liquidity,
    currentSqrtPrice: sqrtLower,       // at the bottom edge -> 100% token A
    bucketBounds: [{ sqrt_lower: sqrtLower, sqrt_upper: sqrtUpper }],
    bucketStates: [
      { reserve_a: 1_000n * SCALE, reserve_b: 0n, liquidity,
        cum_fee_a_per_share: 0n, cum_fee_b_per_share: 0n },
    ],
  };
}

function twoSidedMidBucketPool(): PoolWithBuckets {
  const sqrtLower = SCALE, sqrtUpper = 2n * SCALE, liquidity = 1_000n * SCALE;
  return {
    reserveA: 500n * SCALE, reserveB: 500n * SCALE, lpSupply: liquidity,
    currentSqrtPrice: (3n * SCALE) / 2n, // 1.5, mid-bucket so a price-down swap is feasible
    bucketBounds: [{ sqrt_lower: sqrtLower, sqrt_upper: sqrtUpper }],
    bucketStates: [{ reserve_a: 500n * SCALE, reserve_b: 500n * SCALE, liquidity,
      cum_fee_a_per_share: 0n, cum_fee_b_per_share: 0n }],
  };
}

describe("bucketNetSwap (concentrated net-swap-at-price)", () => {
  it("netA=0 returns a no-op swap at price p", () => {
    const pool = singleSidedPool();
    const r = bucketNetSwap(pool, 0n, SCALE);
    assert.equal(r.ammAIn, 0n);
    assert.equal(r.ammBIn, 0n);
    assert.equal(r.realizedP, SCALE);
    assert.equal(r.newReserveB, 0n);
  });

  it("token-B-in (sell) bootstraps a single-sided pool: A out, B in, price moves up", () => {
    const pool = singleSidedPool();
    const r = bucketNetSwap(pool, -1n * SCALE, SCALE);
    assert.equal(r.saturated ?? false, false);
    assert.ok(r.ammBIn > 0n, "token B should flow in");
    assert.ok(r.ammAOut > 0n, "token A should flow out of the pool");
    assert.ok(r.realizedP > 0n, "realized price defined");
    assert.ok(r.newReserveB > 0n, "pool now holds token B (two-sided)");
  });

  it("oversized swap sets saturated=true (does not throw)", () => {
    const pool = singleSidedPool();
    const r = bucketNetSwap(pool, -1_000_000n * SCALE, SCALE);
    assert.equal(r.saturated, true);
  });

  it("token-A-in (buy) moves price down: A in, B out, not saturated", () => {
    const pool = twoSidedMidBucketPool();
    // netA > 0: token A flows in. (p is unused for sizing in this direction.)
    const r = bucketNetSwap(pool, 1n * SCALE, SCALE);
    assert.equal(r.saturated ?? false, false);
    assert.ok(r.ammAIn > 0n, "token A flows in");
    assert.ok(r.ammBOut > 0n, "token B flows out of the pool");
    assert.ok(r.realizedP > 0n, "realized price defined");
    assert.equal(r.feeAmountA, 0n, "fees tracked per-bucket, not surfaced");
  });
});
