import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { traceBucketSwap, deriveAggregateFlows, type PoolWithBuckets } from "../src/clearing.js";
import { SCALE } from "../src/buckets.js";

function makePool(): PoolWithBuckets {
  // 16 buckets, geometric 1.5x spacing.
  // Bucket 0: [1e18, 1.5e18). currentSqrtPrice is set to the midpoint of bucket 0
  // so that both BUY (UP) and SELL (DOWN) have room within the bucket.
  const bounds = Array.from({ length: 16 }, (_, i) => ({
    sqrt_lower: SCALE * (i === 0 ? 1n : (15n ** BigInt(i)) / (10n ** BigInt(i)) ),
    sqrt_upper: SCALE * (15n ** BigInt(i + 1)) / (10n ** BigInt(i + 1)),
  }));
  // Active bucket has reserves + liquidity; others are empty.
  const states = Array.from({ length: 16 }, () => ({
    reserve_a: 0n, reserve_b: 0n, liquidity: 0n,
    cum_fee_a_per_share: 0n, cum_fee_b_per_share: 0n,
  }));
  states[0] = {
    reserve_a: 1_000_000n, reserve_b: 1_000_000n, liquidity: 1_000_000n,
    cum_fee_a_per_share: 0n, cum_fee_b_per_share: 0n,
  };
  // Midpoint of bucket 0 so both BUY and SELL directions have capacity.
  const midpoint0 = (bounds[0]!.sqrt_lower + bounds[0]!.sqrt_upper) / 2n;
  return {
    reserveA: 1_000_000n, reserveB: 1_000_000n, lpSupply: 0n,
    currentSqrtPrice: midpoint0,
    bucketBounds: bounds,
    bucketStates: states,
  };
}

describe("traceBucketSwap (Sub-2 single-bucket case)", () => {
  it("zero flow returns identity", () => {
    const pool = makePool();
    const out = traceBucketSwap(pool, 0n, 0n);
    assert.equal(out.bucketDeltas.length, 0);
    assert.equal(out.newSqrtPrice, pool.currentSqrtPrice);
    assert.equal(out.newReserveA, pool.reserveA);
    assert.equal(out.newReserveB, pool.reserveB);
  });

  it("netA > 0 (A flows in) produces single BucketDelta with reserve_a_add", () => {
    const pool = makePool();
    const out = traceBucketSwap(pool, 1_000n, 0n);
    assert.equal(out.bucketDeltas.length, 1);
    // V3: reserve_a_add = after-fee stepIn (fee withheld separately in cum_fee)
    assert.equal(out.bucketDeltas[0]!.reserve_a_add, 997n);
    assert.equal(out.bucketDeltas[0]!.reserve_b_add, 0n);
    assert.ok(out.bucketDeltas[0]!.reserve_b_sub > 0n);
    assert.ok(out.bucketDeltas[0]!.cum_fee_a_per_share_increment > 0n);
  });

  it("netB > 0 (B flows in) produces single BucketDelta with reserve_b_add", () => {
    const pool = makePool();
    const out = traceBucketSwap(pool, 0n, 1_000n);
    assert.equal(out.bucketDeltas.length, 1);
    // V3: reserve_b_add = after-fee stepIn (fee withheld separately in cum_fee)
    assert.equal(out.bucketDeltas[0]!.reserve_b_add, 997n);
    assert.equal(out.bucketDeltas[0]!.reserve_a_add, 0n);
    assert.ok(out.bucketDeltas[0]!.reserve_a_sub > 0n);
    assert.ok(out.bucketDeltas[0]!.cum_fee_b_per_share_increment > 0n);
  });

  it("empty bucket throws (no liquidity to absorb flow)", () => {
    const pool = makePool();
    // Clear out bucket 0; all other buckets also empty — pool has zero liquidity.
    pool.bucketStates[0] = {
      reserve_a: 0n, reserve_b: 0n, liquidity: 0n,
      cum_fee_a_per_share: 0n, cum_fee_b_per_share: 0n,
    };
    assert.throws(() => traceBucketSwap(pool, 1_000n, 0n), /swap exceeded all buckets/);
  });
});

function buildPool(_sqrtP: bigint, activeIdx: number): PoolWithBuckets {
  const pMinSqrt = SCALE / 10n;
  const growth = (SCALE * 15n) / 10n;
  const bounds = [];
  let lo = pMinSqrt;
  for (let i = 0; i < 16; i++) {
    const hi = (lo * growth) / SCALE;
    bounds.push({ sqrt_lower: lo, sqrt_upper: hi });
    lo = hi;
  }
  // Place currentSqrtPrice 3/4 of the way through the active bucket so that
  // maxBin (= L * (upper - sqrtP) / SCALE) is 1/4 of the bucket width.
  // That keeps the per-bucket leftover small enough for the adjacent
  // half-liquidity bucket to absorb in cross-bucket tests.
  const activeBounds = bounds[activeIdx]!;
  const width = activeBounds.sqrt_upper - activeBounds.sqrt_lower;
  const currentSqrtPrice = activeBounds.sqrt_lower + (width * 3n) / 4n;

  const states = bounds.map(() => ({
    reserve_a: 0n, reserve_b: 0n, liquidity: 0n,
    cum_fee_a_per_share: 0n, cum_fee_b_per_share: 0n,
  }));
  states[activeIdx] = {
    reserve_a: 1000n * SCALE,
    reserve_b: 1000n * SCALE,
    liquidity: SCALE,
    cum_fee_a_per_share: 0n,
    cum_fee_b_per_share: 0n,
  };
  return {
    reserveA: 1000n * SCALE,
    reserveB: 1000n * SCALE,
    lpSupply: SCALE,
    currentSqrtPrice,
    bucketBounds: bounds,
    bucketStates: states,
  };
}

describe("traceBucketSwap multi-bucket (Sub-2.5)", () => {
  it("M1: in-bucket BUY (small netB) stays in active bucket", () => {
    const pool = buildPool(SCALE / 5n, 4);
    const out = traceBucketSwap(pool, 0n, SCALE / 1000n);
    assert.equal(out.bucketDeltas.length, 1, "single bucket touched");
    assert.equal(out.bucketDeltas[0]!.bucket_id, 4);
    assert.ok(out.newSqrtPrice > pool.currentSqrtPrice, "sqrt_p moved UP");
  });

  it("M2: cross-bucket BUY exits bucket k to bucket k+1", () => {
    const pool = buildPool(SCALE / 5n, 4);
    const bucket4 = pool.bucketStates[4]!;
    const upper4 = pool.bucketBounds[4]!.sqrt_upper;
    const maxBin = (bucket4.liquidity * (upper4 - pool.currentSqrtPrice)) / SCALE;
    const netB = maxBin * 2n;
    pool.bucketStates[5] = {
      reserve_a: 500n * SCALE, reserve_b: 500n * SCALE,
      liquidity: SCALE / 2n, cum_fee_a_per_share: 0n, cum_fee_b_per_share: 0n,
    };
    const out = traceBucketSwap(pool, 0n, netB);
    assert.ok(out.bucketDeltas.length >= 2, "crossed at least 2 buckets");
    assert.equal(out.bucketDeltas[0]!.bucket_id, 4);
    assert.equal(out.bucketDeltas[1]!.bucket_id, 5);
  });

  it("M3: BUY skips empty bucket 5 to reach bucket 6", () => {
    const pool = buildPool(SCALE / 5n, 4);
    const bucket4 = pool.bucketStates[4]!;
    const upper4 = pool.bucketBounds[4]!.sqrt_upper;
    const maxBin = (bucket4.liquidity * (upper4 - pool.currentSqrtPrice)) / SCALE;
    pool.bucketStates[6] = {
      reserve_a: 500n * SCALE, reserve_b: 500n * SCALE,
      liquidity: SCALE / 2n, cum_fee_a_per_share: 0n, cum_fee_b_per_share: 0n,
    };
    const out = traceBucketSwap(pool, 0n, maxBin * 2n);
    const ids = out.bucketDeltas.map((d) => d.bucket_id);
    assert.ok(!ids.includes(5), "empty bucket 5 not in deltas");
    assert.ok(ids.includes(4) && ids.includes(6), "buckets 4 and 6 in deltas");
  });
});

describe("traceBucketSwap multi-bucket DOWN (Sub-2.5)", () => {
  it("M4: in-bucket DOWN (small netA) stays in active bucket", () => {
    const pool = buildPool(SCALE / 5n, 4);
    const out = traceBucketSwap(pool, SCALE / 1000n, 0n);
    assert.equal(out.bucketDeltas.length, 1);
    assert.equal(out.bucketDeltas[0]!.bucket_id, 4);
    assert.ok(out.newSqrtPrice < pool.currentSqrtPrice, "sqrt_p moved DOWN");
  });

  it("M5: cross-bucket DOWN exits bucket k to bucket k-1", () => {
    const pool = buildPool(SCALE / 5n, 4);
    const bucket4 = pool.bucketStates[4]!;
    const lower4 = pool.bucketBounds[4]!.sqrt_lower;
    const denom = (pool.currentSqrtPrice * lower4) / SCALE;
    const maxAin = (bucket4.liquidity * (pool.currentSqrtPrice - lower4)) / denom;
    // Bucket 3 needs liquidity >= bucket 4 because sqrtP enters bucket 3 at its
    // upper bound (= lower4) and must absorb ~0.5 * maxAin of remainder;
    // SCALE/2n stepInMax is ~493e15, remainder is ~535e15, so use SCALE.
    pool.bucketStates[3] = {
      reserve_a: 1000n * SCALE, reserve_b: 1000n * SCALE,
      liquidity: SCALE, cum_fee_a_per_share: 0n, cum_fee_b_per_share: 0n,
    };
    const out = traceBucketSwap(pool, maxAin * 2n, 0n);
    const ids = out.bucketDeltas.map((d) => d.bucket_id).sort();
    assert.deepEqual(ids, [3, 4], "buckets 3 and 4 crossed in that order");
    assert.ok(out.newSqrtPrice < pool.currentSqrtPrice, "sqrt_p moved DOWN");
  });

  it("M6: trace exceeds 4 buckets => throws", () => {
    const pool = buildPool(SCALE / 5n, 4);
    for (const k of [0, 1, 2, 3]) {
      pool.bucketStates[k] = {
        reserve_a: 10n * SCALE, reserve_b: 10n * SCALE,
        liquidity: SCALE / 1000n, cum_fee_a_per_share: 0n, cum_fee_b_per_share: 0n,
      };
    }
    assert.throws(
      () => traceBucketSwap(pool, 10000n * SCALE, 0n),
      /touched .* cap 4|exceeded all buckets/,
    );
  });
});

describe("traceBucketSwap invariants (Sub-2.5)", () => {
  it("M7: sum of stepIn across deltas equals netB (after fee)", () => {
    const pool = buildPool(SCALE / 5n, 4);
    const bucket4 = pool.bucketStates[4]!;
    const upper4 = pool.bucketBounds[4]!.sqrt_upper;
    const maxBin = (bucket4.liquidity * (upper4 - pool.currentSqrtPrice)) / SCALE;
    pool.bucketStates[5] = {
      reserve_a: 1000n * SCALE, reserve_b: 1000n * SCALE,
      liquidity: SCALE, cum_fee_a_per_share: 0n, cum_fee_b_per_share: 0n,
    };
    const netB = maxBin * 2n;
    const out = traceBucketSwap(pool, 0n, netB);
    const sumBIn = out.bucketDeltas.reduce((acc, d) => acc + d.reserve_b_add, 0n);
    const FEE_NUM = 30n, FEE_DEN = 10_000n;
    const afterFee = (netB * (FEE_DEN - FEE_NUM)) / FEE_DEN;
    assert.equal(sumBIn, afterFee, "sumBIn matches netB after 0.3% fee");
  });

  it("M8: newReserveA + newReserveB consistent with delta aggregation", () => {
    const pool = buildPool(SCALE / 5n, 4);
    const out = traceBucketSwap(pool, 0n, SCALE / 1000n);
    let aggA = 0n, aggB = 0n;
    for (const d of out.bucketDeltas) {
      aggA += d.reserve_a_add - d.reserve_a_sub;
      aggB += d.reserve_b_add - d.reserve_b_sub;
    }
    assert.equal(out.newReserveA, pool.reserveA + aggA);
    assert.equal(out.newReserveB, pool.reserveB + aggB);
  });
});

describe("M17: gross to_pool conservation (fee forwarded)", () => {
  it("gross taker input == aToPool + dust; dust >= 0 and small", () => {
    const pool = makePool();
    const out = traceBucketSwap(pool, 1_000n, 0n); // A in (DOWN)
    const liq = out.bucketDeltas.map((d) => pool.bucketStates[d.bucket_id]!.liquidity);
    const flows = deriveAggregateFlows(out.bucketDeltas, liq);
    const dust = 1_000n - flows.aToPool;
    assert.ok(dust >= 0n, "aToPool never exceeds the gross input");
    assert.ok(dust <= BigInt(out.bucketDeltas.length), "dust bounded by touched-bucket count");
    // makePool's L = 1e6 divides SCALE exactly, so the fee round-trips: dust == 0.
    assert.equal(flows.aToPool, 1_000n, "997 net add + 3 forwarded fee");
  });
});
