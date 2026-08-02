import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { computeClearingV2, computeClearingMultiPair, MIN_FILL_AMOUNT_IN } from "../src/clearing.js";
import type { ClearingOrderMultiPair, PoolStateForRouting } from "../src/clearing.js";
import { SCALE } from "../src/buckets.js";
import type { PoolRegistry } from "../src/path.js";

describe("computeClearingV2 (Sub-2.5 bucket-aware)", () => {
  it("V1: BUY-only batch routes through traceBucketSwap and emits deltas", () => {
    const pMinSqrt = SCALE / 10n;
    const growth = (SCALE * 15n) / 10n;
    const bounds = [];
    let lo = pMinSqrt;
    for (let i = 0; i < 16; i++) {
      const hi = (lo * growth) / SCALE;
      bounds.push({ sqrt_lower: lo, sqrt_upper: hi });
      lo = hi;
    }
    const states = bounds.map(() => ({
      reserve_a: 0n, reserve_b: 0n, liquidity: 0n,
      cum_fee_a_per_share: 0n, cum_fee_b_per_share: 0n,
    }));
    // Seed bucket 4 with substantial liquidity
    states[4] = {
      reserve_a: 1000n * SCALE, reserve_b: 1000n * SCALE,
      liquidity: SCALE, cum_fee_a_per_share: 0n, cum_fee_b_per_share: 0n,
    };

    // Set currentSqrtPrice INSIDE bucket 4 (3/4 through its width)
    const b4 = bounds[4]!;
    const sqrtP = b4.sqrt_lower + ((b4.sqrt_upper - b4.sqrt_lower) * 3n) / 4n;

    const result = computeClearingV2(
      {
        reserveA: 1000n * SCALE, reserveB: 1000n * SCALE,
        lpSupply: SCALE, currentSqrtPrice: sqrtP,
        bucketBounds: bounds, bucketStates: states,
      },
      [{
        side: false, amountIn: SCALE / 100n, limitPrice: SCALE * 1000n,
        submittedAtBlock: 1, orderNonce: 42n, owner: 0n,
      }, {
        // matching sell so the clearing has both sides
        side: true, amountIn: SCALE / 100n, limitPrice: SCALE / 1000n,
        submittedAtBlock: 1, orderNonce: 43n, owner: 0n,
      }],
    );
    assert.equal(result.cleared, true, "clearing succeeded");
    assert.ok(result.bucketDeltas !== undefined, "result has bucketDeltas");
    assert.ok(Array.isArray(result.bucketStatesBefore), "result has bucketStatesBefore");
    assert.ok(Array.isArray(result.bucketStatesAfter), "result has bucketStatesAfter");
    assert.ok(result.currentSqrtPriceAfter !== undefined, "result has currentSqrtPriceAfter");
  });
});

/**
 * Build a minimal PoolStateForRouting with a single wide bucket.
 * sqrt_lower must be > 0 to avoid division-by-zero in traceBucketSwap
 * (the V3 formula has denom = sqrtP * sqrt_lower / SCALE).
 * We place currentSqrtPrice at the geometric midpoint of the bucket so both
 * buy and sell directions have room to move.
 */
function buildSinglePool(reserveA: bigint, reserveB: bigint): PoolStateForRouting {
  const sqrtLower = SCALE / 100n;          // 0.01 in 1e18 fixed-point
  const sqrtUpper = SCALE * 100n;          // 100.0 in 1e18 fixed-point
  const sqrtMid   = SCALE;                 // 1.0 (geometric midpoint approx)
  return {
    reserveA, reserveB, lpSupply: SCALE,
    currentSqrtPrice: sqrtMid,
    bucketBounds: [{ sqrt_lower: sqrtLower, sqrt_upper: sqrtUpper }],
    bucketStates: [{
      reserve_a: reserveA, reserve_b: reserveB,
      liquidity: SCALE,
      cum_fee_a_per_share: 0n, cum_fee_b_per_share: 0n,
    }],
  };
}

describe("Sub-4 computeClearingMultiPair", () => {
  const reg: PoolRegistry = [
    { pool_id: 0, token_a: 0x111n, token_b: 0x222n },  // tUSDC/tETH
    { pool_id: 1, token_a: 0x111n, token_b: 0x333n },  // tUSDC/tBTC
    { pool_id: 2, token_a: 0x222n, token_b: 0x333n },  // tETH/tBTC
  ];

  it("R1: 1-hop only batch routes to single pool (Sub-1 regression)", () => {
    const pools = new Map<number, PoolStateForRouting>();
    pools.set(0, buildSinglePool(10_000n * SCALE, 5_000n * SCALE));

    const orders: ClearingOrderMultiPair[] = [
      { side: false, amountIn: 100n * SCALE, limitPrice: 5n * SCALE,
        submittedAtBlock: 1, orderNonce: 42n, owner: 0n,
        path: [0x111n, 0x222n, 0n], path_len: 2 },
      { side: true, amountIn: 50n * SCALE, limitPrice: SCALE / 2n,
        submittedAtBlock: 1, orderNonce: 43n, owner: 0n,
        path: [0x111n, 0x222n, 0n], path_len: 2 },
    ];
    const r = computeClearingMultiPair({ orders, pools, registry: reg });
    assert.equal(r.cleared, true);
    assert.equal(r.activePoolCount, 1);
    assert.equal(r.perPoolClearings[0]!.pool_id, 0);
    // All fills should be 1-hop (hop_index = 0)
    for (const f of r.fills) {
      assert.equal(f.hop_index, 0);
    }
    assert.ok(r.fills.length >= 1);
  });

  it("R2: 2-hop order is dropped entirely (SETTLE-INV v1 disables 2-hop)", () => {
    const pools = new Map<number, PoolStateForRouting>();
    pools.set(0, buildSinglePool(10_000n * SCALE, 5_000n * SCALE));   // USDC/ETH
    pools.set(2, buildSinglePool(5_000n * SCALE, 200n * SCALE));      // ETH/BTC

    const orders: ClearingOrderMultiPair[] = [
      // A 2-hop order that WOULD be eligible — must still be dropped under SETTLE-INV.
      { side: false, amountIn: 100n * SCALE, limitPrice: 10_000n * SCALE,
        submittedAtBlock: 1, orderNonce: 42n, owner: 0n,
        path: [0x111n, 0x222n, 0x333n], path_len: 3 },
      // 1-hop counterparties on the two pools.
      { side: true, amountIn: 50n * SCALE, limitPrice: SCALE / 10n,
        submittedAtBlock: 1, orderNonce: 100n, owner: 0n,
        path: [0x111n, 0x222n, 0n], path_len: 2 },
      { side: true, amountIn: 1n * SCALE, limitPrice: SCALE / 100n,
        submittedAtBlock: 1, orderNonce: 101n, owner: 0n,
        path: [0x222n, 0x333n, 0n], path_len: 2 },
    ];
    const r = computeClearingMultiPair({ orders, pools, registry: reg });
    // SETTLE-INV: the 2-hop order (42n) produces NO fills.
    const fills42 = r.fills.filter((f) => f.orderNonce === 42n);
    assert.equal(fills42.length, 0, "2-hop order must be dropped (no fills)");
    // No fill anywhere may carry hop_index 1 (the 2-hop second leg is gone).
    for (const f of r.fills) {
      assert.equal(f.hop_index, 0, "no hop=1 fills when 2-hop is disabled");
    }
  });

  it("R3: 2-hop ineligible composite drops BOTH legs", () => {
    const pools = new Map<number, PoolStateForRouting>();
    pools.set(0, buildSinglePool(10_000n * SCALE, 5_000n * SCALE));
    pools.set(2, buildSinglePool(5_000n * SCALE, 200n * SCALE));

    const orders: ClearingOrderMultiPair[] = [{
      // Maker wants BTC for USDC but limit is extremely tight (0.001 BTC per USDC)
      side: false, amountIn: 100n * SCALE, limitPrice: SCALE / 1000n,
      submittedAtBlock: 1, orderNonce: 42n, owner: 0n,
      path: [0x111n, 0x222n, 0x333n], path_len: 3,
    }];
    const r = computeClearingMultiPair({ orders, pools, registry: reg });
    const fills42 = r.fills.filter((f) => f.orderNonce === 42n);
    assert.equal(fills42.length, 0, "2-hop ineligible -> no legs filled");
  });

  it("R5: 1-hop fills are conservation-exact (match the kernel, not hopPayout)", () => {
    // SETTLE-INV: the multi-pair emitter must reuse the per-pool kernel's
    // conservation-exact fills (computeClearing distributes xTotal/yTotal with
    // last-absorbs-residual, so Σ amountOut == the pool's true side-total).
    // The old emitter recomputed via hopPayout, which overshoots by the
    // rounding/CoW gap and underflows the orderbook on claim.
    const pool = buildSinglePool(10_000n * SCALE, 5_000n * SCALE);
    const pools = new Map<number, PoolStateForRouting>();
    pools.set(0, pool);
    const orders: ClearingOrderMultiPair[] = [
      { side: false, amountIn: 100n * SCALE, limitPrice: 5n * SCALE,
        submittedAtBlock: 1, orderNonce: 42n, owner: 0n, path: [0x111n, 0x222n, 0n], path_len: 2 },
      { side: true, amountIn: 50n * SCALE, limitPrice: SCALE / 2n,
        submittedAtBlock: 1, orderNonce: 43n, owner: 0n, path: [0x111n, 0x222n, 0n], path_len: 2 },
    ];
    const r = computeClearingMultiPair({ orders, pools, registry: reg });
    // Reference: the conservation-exact kernel on the same single-pool sub-batch.
    const kernel = computeClearingV2(pool, orders);
    assert.ok(kernel.fills.length >= 1, "kernel produced fills");
    for (const kf of kernel.fills) {
      const mf = r.fills.find((f) => f.orderNonce === kf.orderNonce);
      assert.ok(mf, `multi-pair has a fill for ${kf.orderNonce}`);
      assert.equal(
        mf!.amountOut, kf.amountOut,
        "multi-pair fill must equal the conservation-exact kernel fill",
      );
    }
  });

  it("R6: SETTLE-INV dust-guard drops sub-MIN_FILL_AMOUNT_IN orders (no dust fill, brick-proof)", () => {
    // The on-chain anti-grief floor can brick an honest single-maker clear when a
    // receive group's total is dust. The aggregator must never EMIT such a fill:
    // sub-MIN orders are carried forward (no fill), so the circuit never sees a
    // dust group. Above-MIN orders in the same pool still clear normally.
    const pools = new Map<number, PoolStateForRouting>();
    pools.set(0, buildSinglePool(10_000n * SCALE, 5_000n * SCALE));
    const orders: ClearingOrderMultiPair[] = [
      { side: false, amountIn: 100n * SCALE, limitPrice: 5n * SCALE,
        submittedAtBlock: 1, orderNonce: 42n, owner: 0n, path: [0x111n, 0x222n, 0n], path_len: 2 },
      { side: true, amountIn: 50n * SCALE, limitPrice: SCALE / 2n,
        submittedAtBlock: 1, orderNonce: 43n, owner: 0n, path: [0x111n, 0x222n, 0n], path_len: 2 },
      // DUST buy: amountIn one below the guard — must be dropped (carried forward).
      { side: false, amountIn: MIN_FILL_AMOUNT_IN - 1n, limitPrice: 5n * SCALE,
        submittedAtBlock: 1, orderNonce: 99n, owner: 0n, path: [0x111n, 0x222n, 0n], path_len: 2 },
    ];
    const r = computeClearingMultiPair({ orders, pools, registry: reg });
    assert.equal(
      r.fills.filter((f) => f.orderNonce === 99n).length, 0,
      "dust order (< MIN_FILL_AMOUNT_IN) must not produce a fill",
    );
    assert.ok(r.fills.length >= 1, "above-MIN orders must still clear");
    // A fill exactly AT the threshold is allowed (boundary is strict <).
    assert.ok(MIN_FILL_AMOUNT_IN > 0n, "guard threshold is positive");
  });
});
