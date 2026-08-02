import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { traceBucketSwap, type PoolWithBuckets } from "../src/clearing.js";
import { SCALE } from "../src/buckets.js";

// Canonical single-sided, token-B-in (UP) swap. Keep IDENTICAL to the Noir #[test].
//
// NOTE on liquidity magnitude: the circuit's mul_div (circuits/clearing/src/pricing.nr)
// asserts the divisor `z < 2^64` (~1.8446e19). next_sqrt_p_up divides by L, so any
// clearing the circuit can verify MUST have bucket liquidity L < 2^64. We use
// L = 10 * SCALE = 1e19 (< 2^64, matches the existing c5 fixture's domain). A larger
// L (e.g. 1000 * SCALE = 1e21) is OUTSIDE the circuit's mul_div domain and would
// abort with "mul_div: z must be < 2^64" -- a domain limit, not a math drift.
const CANON: PoolWithBuckets = {
  reserveA: 10n * SCALE, reserveB: 0n, lpSupply: 10n * SCALE,
  currentSqrtPrice: SCALE,
  bucketBounds: [{ sqrt_lower: SCALE, sqrt_upper: 2n * SCALE }],
  bucketStates: [{ reserve_a: 10n * SCALE, reserve_b: 0n, liquidity: 10n * SCALE,
    cum_fee_a_per_share: 0n, cum_fee_b_per_share: 0n }],
};

// PINNED PARITY_FIXTURE. These exact values are also hardcoded into the Noir
// gate (circuits/clearing/src/test.nr ::
// task6_traceBucketSwap_deltas_satisfy_assert_bucket_step), which feeds them
// to assert_bucket_step and proves the circuit ACCEPTS them. If JS V3 math
// (nextSqrtPUp/swapStepOutA in src/buckets.ts) ever changes, this test fails
// here AND the Noir gate must be re-pinned from the new numbers -- catching drift.
const PINNED = {
  newSqrtPrice: 1000997000000000000n,
  newReserveA: 9990039930189600968n,
  newReserveB: 9970000000000000n,
  bucket_id: 0,
  reserve_a_sub: 9960069810399032n,
  reserve_b_add: 9970000000000000n,
  cum_fee_b_per_share_increment: 3000000000000n,
};

describe("traceBucketSwap <-> circuit assert_bucket_step parity", () => {
  it("pins canonical deltas (must match the Noir assert_bucket_step gate)", () => {
    const trace = traceBucketSwap(CANON, 0n, SCALE / 100n); // 0.01 token B in (gross)
    assert.equal(trace.bucketDeltas.length, 1, "single-bucket swap");
    const d = trace.bucketDeltas[0]!;

    assert.equal(trace.newSqrtPrice, PINNED.newSqrtPrice, "newSqrtPrice drift");
    assert.equal(trace.newReserveA, PINNED.newReserveA, "newReserveA drift");
    assert.equal(trace.newReserveB, PINNED.newReserveB, "newReserveB drift");
    assert.equal(d.bucket_id, PINNED.bucket_id, "bucket_id drift");
    assert.equal(d.reserve_a_sub, PINNED.reserve_a_sub, "reserve_a_sub drift");
    assert.equal(d.reserve_b_add, PINNED.reserve_b_add, "reserve_b_add drift");
    assert.equal(
      d.cum_fee_b_per_share_increment,
      PINNED.cum_fee_b_per_share_increment,
      "cum_fee_b_per_share_increment drift",
    );
  });
});
