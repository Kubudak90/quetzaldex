import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { computeClearing, type PoolWithBuckets, type ClearingOrder } from "../src/clearing.js";
import { SCALE } from "../src/buckets.js";

// Mirror of the test harness's single-bucket pool (sqrt 0.01..100).
function buildSinglePool(reserveA: bigint, reserveB: bigint): PoolWithBuckets {
  const sqrtLower = SCALE / 100n, sqrtUpper = SCALE * 100n, sqrtMid = SCALE;
  return {
    reserveA, reserveB, lpSupply: SCALE, currentSqrtPrice: sqrtMid,
    bucketBounds: [{ sqrt_lower: sqrtLower, sqrt_upper: sqrtUpper }],
    bucketStates: [{ reserve_a: reserveA, reserve_b: reserveB, liquidity: SCALE,
      cum_fee_a_per_share: 0n, cum_fee_b_per_share: 0n }],
  };
}

const sell = (nonce: bigint, limit: bigint): ClearingOrder => ({
  side: true, amountIn: 25n * SCALE, limitPrice: limit,
  submittedAtBlock: 1, orderNonce: nonce, owner: 0n,
});

describe("computeClearing — one-sided refinement fixed point (H1)", () => {
  // Repro (verified against the real code): pool 10000A/5000B, two 25-token sells.
  // Refinement dropped S2 (limit 0.02912 > full-set realized 0.01967), recomputed
  // P* over S1-only (0.03857), then computeClearing re-included S2 via clearingAt
  // (0.02912 <= 0.03857) and the full-volume swap paid S2 ~0.0196 A-per-B — 33%
  // BELOW its limit. The eligible-at-P* set is not a fixed point of the full filter.
  it("skips rather than fill a re-included order below its limit", () => {
    const pool = buildSinglePool(10_000n * SCALE, 5_000n * SCALE);
    const S1 = sell(1n, SCALE / 100n);              // 0.01 — kept at the full-set price
    const S2 = sell(2n, 2912n * SCALE / 100_000n);  // 0.02912 — dropped then re-included
    const res = computeClearing(pool, [S1, S2]);
    assert.equal(res.cleared, false, "must skip, not clear a below-limit fill");
  });

  // Guard against over-correction: a genuinely uniform-clearable one-sided book
  // (both sells satisfiable at the realized price) must still clear.
  it("still clears a one-sided book when every order is satisfiable at P*", () => {
    const pool = buildSinglePool(10_000n * SCALE, 5_000n * SCALE);
    const S1 = sell(1n, SCALE / 1000n); // 0.001 — well below any realized price
    const S2 = sell(2n, SCALE / 1000n); // 0.001 — both satisfiable together
    const res = computeClearing(pool, [S1, S2]);
    assert.equal(res.cleared, true, "a uniformly satisfiable book must still clear");
  });
});
