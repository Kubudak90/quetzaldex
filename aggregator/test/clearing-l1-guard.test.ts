/**
 * L1 unit tests: traceBucketSwap containment guard.
 * Verifies that an out-of-grid currentSqrtPrice throws "currentSqrtPrice outside
 * bucket grid" rather than silently producing negative deltas.
 */
import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { traceBucketSwap } from "../src/clearing.js";
import { SCALE } from "../src/buckets.js";
import type { PoolWithBuckets } from "../src/clearing.js";

/** Build a two-bucket pool with the given currentSqrtPrice. */
function makeTwoBucketPool(currentSqrtPrice: bigint): PoolWithBuckets {
  const sqrtLo0 = SCALE;          // bucket 0: [1.0, 2.0)
  const sqrtHi0 = SCALE * 2n;
  const sqrtLo1 = SCALE * 2n;     // bucket 1: [2.0, 3.0)
  const sqrtHi1 = SCALE * 3n;
  const liq = SCALE;
  const bucketState = {
    reserve_a: 1000n * SCALE,
    reserve_b: 1000n * SCALE,
    liquidity: liq,
    cum_fee_a_per_share: 0n,
    cum_fee_b_per_share: 0n,
  };
  return {
    reserveA: 2000n * SCALE,
    reserveB: 2000n * SCALE,
    lpSupply: SCALE,
    currentSqrtPrice,
    bucketBounds: [
      { sqrt_lower: sqrtLo0, sqrt_upper: sqrtHi0 },
      { sqrt_lower: sqrtLo1, sqrt_upper: sqrtHi1 },
    ],
    bucketStates: [bucketState, { ...bucketState }],
  };
}

describe("L1 traceBucketSwap containment guard", () => {
  it("L1-A: below-grid currentSqrtPrice throws (no negative deltas)", () => {
    // Price at 0.5 * SCALE is below both buckets ([SCALE, 2*SCALE) and [2*SCALE, 3*SCALE)).
    const pool = makeTwoBucketPool(SCALE / 2n);
    // A buy order (netB > 0) into a below-grid pool must throw, not return negative deltas.
    assert.throws(
      () => traceBucketSwap(pool, 0n, SCALE / 100n),
      /outside bucket grid/,
      "expected containment-guard throw for below-grid sqrtPrice",
    );
  });

  it("L1-B: above-grid currentSqrtPrice throws", () => {
    // Price at 4 * SCALE is above both buckets (top of grid is 3 * SCALE).
    const pool = makeTwoBucketPool(SCALE * 4n);
    // A sell order (netA > 0) into an above-grid pool must throw.
    assert.throws(
      () => traceBucketSwap(pool, SCALE / 100n, 0n),
      /outside bucket grid/,
      "expected containment-guard throw for above-grid sqrtPrice",
    );
  });

  it("L1-C: in-grid currentSqrtPrice does NOT throw (positive-case sanity)", () => {
    // Price at 1.5 * SCALE is inside bucket 0 ([SCALE, 2*SCALE)).
    const pool = makeTwoBucketPool((SCALE * 3n) / 2n);
    // A small buy must succeed without throwing.
    assert.doesNotThrow(
      () => traceBucketSwap(pool, 0n, SCALE / 1000n),
      "in-grid price should not trigger the containment guard",
    );
  });
});
