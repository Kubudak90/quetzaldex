import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import {
  findClearingPrice,
  computeClearing,
  computeClearingV2,
  computeClearingMultiPair,
  traceBucketSwap,
  type PoolWithBuckets,
  type ClearingOrder,
  type ClearingOrderMultiPair,
} from "../src/clearing.js";
import { SCALE } from "../src/buckets.js";
import type { PoolRegistry } from "../src/path.js";

function singleSidedPool(): PoolWithBuckets {
  const sqrtLower = SCALE, sqrtUpper = 2n * SCALE, liquidity = 1_000n * SCALE;
  return {
    reserveA: 1_000n * SCALE, reserveB: 0n, lpSupply: liquidity,
    currentSqrtPrice: sqrtLower,
    bucketBounds: [{ sqrt_lower: sqrtLower, sqrt_upper: sqrtUpper }],
    bucketStates: [{ reserve_a: 1_000n * SCALE, reserve_b: 0n, liquidity,
      cum_fee_a_per_share: 0n, cum_fee_b_per_share: 0n }],
  };
}

// This single-bucket pool (sqrt 1.0 -> 2.0, i.e. price 1.0 -> 4.0) realizes ~0.999
// token-A-per-token-B for a small sell. A SELL's limitPrice is the MINIMUM A-per-B it
// will accept, so a satisfiable sell limit must be <= ~0.999. The original tests used
// limitPrice = 100*SCALE (demanding 100x the realized price), which only "cleared" under
// the old bisection-on-limit bug (BUG 2) that paid the seller at the unsatisfiable limit
// and drained the pool. Corrected to SELL_LIMIT below the realized price.
const SELL_LIMIT = SCALE / 2n; // 0.5 < realized ~0.999 -> satisfiable

describe("findClearingPrice (concentrated)", () => {
  it("single-sided pool with a sell order finds a price (was null under aggregate model)", () => {
    const pool = singleSidedPool();
    // One sell: pays token B, wants token A. limit below the realized AMM price.
    const batch: ClearingOrder[] = [
      { side: true, amountIn: 1n * SCALE, limitPrice: SELL_LIMIT,
        submittedAtBlock: 1, orderNonce: 1n, owner: 0n },
    ];
    const p = findClearingPrice(pool, batch);
    assert.notEqual(p, null, "expected a clearing price for a single-sided pool");
    assert.ok((p as bigint) > 0n);
  });
});

describe("computeClearing (concentrated)", () => {
  it("single-sided pool clears one sell order with a real fill", () => {
    const pool = singleSidedPool();
    const batch: ClearingOrder[] = [
      { side: true, amountIn: 1n * SCALE, limitPrice: SELL_LIMIT,
        submittedAtBlock: 1, orderNonce: 7n, owner: 0n },
    ];
    const r = computeClearing(pool, batch);
    assert.equal(r.cleared, true);
    assert.equal(r.fills.length, 1);
    assert.equal(r.fills[0]!.orderNonce, 7n);
    assert.ok(r.fills[0]!.amountOut > 0n, "seller receives token A");
    assert.ok(r.newReserveB > 0n, "pool gained token B");
  });
});

describe("computeClearingV2 (concentrated, single-sided)", () => {
  it("single-sided pool returns cleared:true with bucket deltas", () => {
    const pool = singleSidedPool();
    const batch: ClearingOrder[] = [
      { side: true, amountIn: 1n * SCALE, limitPrice: SELL_LIMIT,
        submittedAtBlock: 1, orderNonce: 9n, owner: 0n },
    ];
    const r = computeClearingV2(pool, batch);
    assert.equal(r.cleared, true);
    assert.ok(r.bucketDeltas!.length > 0, "emits bucket deltas");
    assert.ok(r.bucketStatesBefore!.length === r.bucketDeltas!.length);
    assert.ok(r.currentSqrtPriceAfter! > pool.currentSqrtPrice, "price moved up");
  });
});

// ===========================================================================
// CONSERVATION TESTS (pin the two clearing.ts defects fixed on this branch).
// Each was written to FAIL on the pre-fix code and PASS after.
// ===========================================================================

describe("clearing conservation (BUG-1: single bucket trace, no double fee)", () => {
  it("C1: V2 reserves equal a SINGLE direct traceBucketSwap of the net input", () => {
    // BUG-1: computeClearing traces buckets once at P* (fee withheld once); the old V2
    // re-derived netA/netB from base.newReserve* and traced AGAIN, withholding the 0.3%
    // fee a second time -> V2 reserves reflected a 0.997x-smaller swap than the fills/P*.
    // Now V2 reuses computeClearing's trace, so its reserves must equal a single trace.
    const pool = singleSidedPool();
    const batch: ClearingOrder[] = [
      { side: true, amountIn: 1n * SCALE, limitPrice: SELL_LIMIT,
        submittedAtBlock: 1, orderNonce: 11n, owner: 0n },
    ];
    const r = computeClearingV2(pool, batch);
    assert.equal(r.cleared, true);

    // Expected reserves from a SINGLE trace of the same net token-B input (= amountIn).
    // For a pure sell book, bucketNetSwap routes inB == Σ amountIn of token B in.
    const expected = traceBucketSwap(singleSidedPool(), 0n, 1n * SCALE);

    assert.equal(r.newReserveA, expected.newReserveA,
      "V2 reserveA must equal a single-trace reserveA (no second 0.997x)");
    assert.equal(r.newReserveB, expected.newReserveB,
      "V2 reserveB must equal a single-trace reserveB (no second 0.997x)");
    // Sanity: a DOUBLE trace (the old bug) would move reserveB strictly less.
    const doubled = traceBucketSwap(singleSidedPool(), 0n, expected.newReserveB);
    assert.notEqual(doubled.newReserveB, r.newReserveB,
      "double-trace reserveB must differ from the correct single-trace value");
  });
});

// Single-bucket pool for multi-pair conservation, sqrtMid=1.0 so a sell has room.
function buildSinglePool(reserveA: bigint, reserveB: bigint): PoolWithBuckets {
  const sqrtLower = SCALE / 100n, sqrtUpper = SCALE * 100n, sqrtMid = SCALE;
  return {
    reserveA, reserveB, lpSupply: SCALE, currentSqrtPrice: sqrtMid,
    bucketBounds: [{ sqrt_lower: sqrtLower, sqrt_upper: sqrtUpper }],
    bucketStates: [{ reserve_a: reserveA, reserve_b: reserveB, liquidity: SCALE,
      cum_fee_a_per_share: 0n, cum_fee_b_per_share: 0n }],
  };
}

describe("clearing conservation (BUG-2: realized-price one-sided clearing)", () => {
  const reg: PoolRegistry = [{ pool_id: 0, token_a: 0x111n, token_b: 0x222n }];

  it("C2: single-sided sell — Σ fills.amountOut == pool a_from_pool (conservation)", () => {
    // The seller pays token B and receives token A. The token A paid out (Σ hopPayout)
    // must equal the token A the pool actually releases (a_from_pool = Σ reserve_a_sub).
    // The old code's wrong P* (bisected onto the limit) broke this; the realized-price P*
    // makes hopPayout reproduce a_from_pool exactly (modulo integer rounding).
    const pools = new Map<number, PoolWithBuckets>();
    pools.set(0, buildSinglePool(10_000n * SCALE, 5_000n * SCALE));
    const orders: ClearingOrderMultiPair[] = [
      // limit 0.01 is BELOW the realized ~0.0197 A-per-B -> satisfiable, clears.
      { side: true, amountIn: 50n * SCALE, limitPrice: SCALE / 100n,
        submittedAtBlock: 1, orderNonce: 21n, owner: 0n, path: [0x111n, 0x222n, 0n], path_len: 2 },
    ];
    const r = computeClearingMultiPair({ orders, pools, registry: reg });
    assert.equal(r.cleared, true);

    let sumOut = 0n;
    for (const f of r.fills) sumOut += f.amountOut;
    const pc = r.perPoolClearings.find((p) => p.pool_id === 0)!;
    let aFromPool = 0n;
    for (const d of pc.bucketDeltas) aFromPool += d.reserve_a_sub;

    const diff = sumOut > aFromPool ? sumOut - aFromPool : aFromPool - sumOut;
    // Pure integer-rounding residual (compounded inAfterFee + mulDiv truncations). This is
    // tiny vs the swap (~9.8e17) AND vs a fee leak (~0.3% = ~2.9e15 would fail this).
    assert.ok(diff <= 100n,
      `conservation: |Σ fills - a_from_pool| = ${diff} must be a rounding residual, ` +
      `not a 0.3% fee leak (~2.9e15). sumOut=${sumOut} a_from_pool=${aFromPool}`);
    assert.ok(sumOut > 0n && aFromPool > 0n, "non-trivial clearing");
  });

  it("C3a: P* is the realized AMM price for a one-sided sell (NOT the limit)", () => {
    // Sell limit 0.5 sits far below the realized ~0.999; P* must equal the realized AMM
    // price, never the limit. (For a SELL, eligibility requires limit <= P*, so P* >= limit;
    // the assertion is P* == realized and P* != limit.)
    const pool = singleSidedPool();
    const sell: ClearingOrder = { side: true, amountIn: 1n * SCALE, limitPrice: SELL_LIMIT,
      submittedAtBlock: 1, orderNonce: 31n, owner: 0n };
    const r = computeClearing(pool, [sell]);
    assert.equal(r.cleared, true);
    assert.notEqual(r.clearingPrice, sell.limitPrice, "P* must not be the limit");

    // Realized price = ammAOut * SCALE / inAfterFee (the value hopPayout consumes).
    const trace = traceBucketSwap(singleSidedPool(), 0n, 1n * SCALE);
    let ammAOut = 0n;
    for (const d of trace.bucketDeltas) ammAOut += d.reserve_a_sub;
    const inAfterFee = (1n * SCALE * (10_000n - 30n)) / 10_000n;
    const realized = (ammAOut * SCALE) / inAfterFee;
    assert.equal(r.clearingPrice, realized, "P* must equal the realized AMM price");
    assert.ok(r.clearingPrice > sell.limitPrice,
      "realized (0.999) is far above the 0.5 sell limit");
  });

  it("C3b: P* < limit for a one-sided BUY with a generous limit (realized, not limit)", () => {
    // A BUY pays token A, wants token B; limit is the MAX A-per-B it pays. With a generous
    // high limit the realized AMM price sits below it -> P* < limit, proving P* tracks the
    // realized price rather than snapping to the order's limit.
    const pool = buildSinglePool(10_000n * SCALE, 5_000n * SCALE);
    const buy: ClearingOrder = { side: false, amountIn: 5n * SCALE, limitPrice: 10n * SCALE,
      submittedAtBlock: 1, orderNonce: 32n, owner: 0n };
    const r = computeClearing(pool, [buy]);
    assert.equal(r.cleared, true);
    assert.ok(r.clearingPrice < buy.limitPrice,
      `P* (${r.clearingPrice}) must be below the generous buy limit (${buy.limitPrice})`);
    assert.ok(r.clearingPrice > 0n);
  });

  it("C4: an unsatisfiable limit does NOT clear (skip, no drain)", () => {
    // A sell demanding 2.0 A-per-B against a pool that realizes ~0.999 cannot be met.
    // The old bug "cleared" it at P*=2.0 and tried to pay 2x what the pool holds (drain).
    // Now both computeClearing and computeClearingV2 must skip (cleared:false).
    const pool = singleSidedPool();
    const sell: ClearingOrder = { side: true, amountIn: 1n * SCALE, limitPrice: 2n * SCALE,
      submittedAtBlock: 1, orderNonce: 41n, owner: 0n };
    const r = computeClearing(pool, [sell]);
    assert.equal(r.cleared, false, "unsatisfiable sell must be skipped, not drained");
    assert.equal(r.fills.length, 0);
    assert.equal(r.newReserveA, pool.reserveA, "reserves untouched on skip");
    assert.equal(r.newReserveB, pool.reserveB, "reserves untouched on skip");

    const v2 = computeClearingV2(pool, [sell]);
    assert.equal(v2.cleared, false, "V2 must skip too");
    assert.deepEqual(v2.bucketDeltas, [], "no bucket deltas on skip");
  });
});
