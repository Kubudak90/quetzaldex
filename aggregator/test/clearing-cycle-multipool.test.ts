/**
 * Genuine multi-pool clearing: focused unit tests for the clearing-cycle's
 * pool/path SELECTION logic + its composition with computeClearingMultiPair.
 *
 * Regression target: the previous Sub-9.3 MVP stub hardcoded `path = pool-0
 * tokens` and `activePoolIds = {0}` for EVERY order, so a 3-pool epoch produced
 * 3 fills against a 1-pool active set, detonating the circuit's
 * `assert(pool_slot != INVALID_POOL_ID)`. These tests prove the selection now:
 *   1. resolves each reveal's REAL path to its own pool_id (0/1/2),
 *   2. unions those into activePoolIds = {0,1,2},
 *   3. reads 3 pool states, and
 *   4. computeClearingMultiPair returns activePoolCount==3 with each fill
 *      carrying its correct pool_id (never INVALID_POOL_ID).
 *
 * These are pure (no PXE / wallet): we exercise the extracted `resolveRevealPath`
 * helper + feed its output into computeClearingMultiPair directly, mirroring the
 * exact composition `runOneClearingCycleMP` performs.
 */
import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import {
  buildU128PoolRegistry,
  resolveRevealPath,
  resolvePoolIdU128,
} from "../src/clearing-cycle.js";
import { computeClearingMultiPair } from "../src/clearing.js";
import type { ClearingOrderMultiPair, PoolStateForRouting } from "../src/clearing.js";
import { INVALID_POOL_ID } from "../src/witness.js";
import { SCALE } from "../src/buckets.js";

// Real Sub-9 testnet addresses where u128 truncation DISAGREES with full-bigint
// ordering — the case the previous stub's pool-0 hardcode masked.
const tUSDC = "0x0525a0e5a940daf669e98d5b98c46f85f4782b6f4c5af2e5d69db808375c349c";
const tETH = "0x2efbaf6bd19c028cc8782a2d9e6b7b660a66476c890abe47aeaa06ec7a471ab5";
const tBTC = "0x02c078075c3cbbc6c135f3ef4e4ae85e9765a56995e0aff4f638d44294638afc";

// pool 0 = USDC/ETH, pool 1 = USDC/BTC, pool 2 = ETH/BTC.
const REGISTRY = buildU128PoolRegistry([
  { pool_id: 0, address: "0xa", token_a: tETH, token_b: tUSDC },
  { pool_id: 1, address: "0xb", token_a: tBTC, token_b: tUSDC },
  { pool_id: 2, address: "0xc", token_a: tETH, token_b: tBTC },
]);

/**
 * Fake getPoolState: a funded single-bucket (bucket-0) pool with liquidity on
 * BOTH reserves so a buy+sell pair crosses through the V3 trace. (A truly
 * single-sided pool can't price a cross — see the stub-mode blocker memo — so we
 * fund both sides; the SELECTION logic under test is identical either way.)
 */
function fakeGetPoolState(reserveA: bigint, reserveB: bigint): PoolStateForRouting {
  const sqrtLower = SCALE / 100n; // 0.01
  const sqrtUpper = SCALE * 100n; // 100.0
  const sqrtMid = SCALE;          // 1.0
  return {
    reserveA,
    reserveB,
    lpSupply: SCALE,
    currentSqrtPrice: sqrtMid,
    bucketBounds: [{ sqrt_lower: sqrtLower, sqrt_upper: sqrtUpper }],
    bucketStates: [{
      reserve_a: reserveA,
      reserve_b: reserveB,
      liquidity: SCALE,
      cum_fee_a_per_share: 0n,
      cum_fee_b_per_share: 0n,
    }],
  };
}

/** Shape mirroring ValidatedReveal's path-bearing subset + base order fields. */
interface FakeReveal {
  side: boolean;
  amount_in: bigint;
  limit_price: bigint;
  submitted_at_block: number;
  order_nonce: bigint;
  path_len: number;
  path: [bigint, bigint, bigint];
}

describe("genuine multi-pool clearing — cycle selection", () => {
  // Pool-0 fallback path (full-field), used only when a reveal omits its path.
  const POOL0 = REGISTRY.find((p) => p.pool_id === 0)!;
  const fallbackPath: [bigint, bigint, bigint] = [
    POOL0.token_a_full ?? POOL0.token_a,
    POOL0.token_b_full ?? POOL0.token_b,
    0n,
  ];

  it("resolveRevealPath maps each 1-hop reveal to its OWN pool (0/1/2)", () => {
    const r0 = resolveRevealPath(REGISTRY, { path_len: 2, path: [BigInt(tUSDC), BigInt(tETH), 0n] }, fallbackPath);
    const r1 = resolveRevealPath(REGISTRY, { path_len: 2, path: [BigInt(tUSDC), BigInt(tBTC), 0n] }, fallbackPath);
    const r2 = resolveRevealPath(REGISTRY, { path_len: 2, path: [BigInt(tETH), BigInt(tBTC), 0n] }, fallbackPath);
    assert.deepEqual(r0.hops, [0]);
    assert.deepEqual(r1.hops, [1]);
    assert.deepEqual(r2.hops, [2]);
    assert.equal(r0.usedFallback, false);
    // routingPath is u128-truncated; full path preserved for c_i binding.
    const mask = (1n << 128n) - 1n;
    assert.equal(r0.routingPath[0], BigInt(tUSDC) & mask);
    assert.equal(r0.path[0], BigInt(tUSDC));
  });

  it("resolveRevealPath preserves the pool-0 fallback for an omitted path", () => {
    const r = resolveRevealPath(REGISTRY, { path_len: 2, path: [0n, 0n, 0n] }, fallbackPath);
    assert.equal(r.usedFallback, true);
    assert.deepEqual(r.hops, [0]);
    assert.equal(r.path[0], fallbackPath[0]); // full-field fallback bound for c_i
  });

  it("resolveRevealPath throws a clear error for an unregistered path", () => {
    assert.throws(
      () => resolveRevealPath(REGISTRY, { path_len: 2, path: [0x123n, 0x456n, 0n] }, fallbackPath),
      /does not resolve to a registered pool/,
    );
  });

  it("resolveRevealPath resolves both hops of a 2-hop path", () => {
    // USDC -> ETH (pool 0) -> BTC (pool 2)
    const r = resolveRevealPath(
      REGISTRY,
      { path_len: 3, path: [BigInt(tUSDC), BigInt(tETH), BigInt(tBTC)] },
      fallbackPath,
    );
    assert.deepEqual(r.hops, [0, 2]);
    assert.equal(r.path_len, 3);
  });

  it("3 reveals across pools 0/1/2 => activePoolIds={0,1,2}, 3 states, activePoolCount==3", () => {
    // One matched buy+sell pair per pool so each pool actually crosses; the
    // SELECTION (path -> pool resolution + active-pool union) is what's under test.
    const reveals: FakeReveal[] = [
      // pool 0: USDC/ETH
      { side: false, amount_in: 100n * SCALE, limit_price: 5n * SCALE, submitted_at_block: 1, order_nonce: 10n, path_len: 2, path: [BigInt(tUSDC), BigInt(tETH), 0n] },
      { side: true,  amount_in: 50n * SCALE,  limit_price: SCALE / 2n,  submitted_at_block: 1, order_nonce: 11n, path_len: 2, path: [BigInt(tUSDC), BigInt(tETH), 0n] },
      // pool 1: USDC/BTC
      { side: false, amount_in: 100n * SCALE, limit_price: 5n * SCALE, submitted_at_block: 1, order_nonce: 20n, path_len: 2, path: [BigInt(tUSDC), BigInt(tBTC), 0n] },
      { side: true,  amount_in: 50n * SCALE,  limit_price: SCALE / 2n,  submitted_at_block: 1, order_nonce: 21n, path_len: 2, path: [BigInt(tUSDC), BigInt(tBTC), 0n] },
      // pool 2: ETH/BTC
      { side: false, amount_in: 100n * SCALE, limit_price: 5n * SCALE, submitted_at_block: 1, order_nonce: 30n, path_len: 2, path: [BigInt(tETH), BigInt(tBTC), 0n] },
      { side: true,  amount_in: 50n * SCALE,  limit_price: SCALE / 2n,  submitted_at_block: 1, order_nonce: 31n, path_len: 2, path: [BigInt(tETH), BigInt(tBTC), 0n] },
    ];

    // --- replicate runOneClearingCycleMP's selection block exactly ---
    const routed = reveals.map((v) =>
      resolveRevealPath(REGISTRY, { path_len: v.path_len, path: v.path }, fallbackPath),
    );

    const clearingOrders: ClearingOrderMultiPair[] = reveals.map((v, i) => ({
      side: v.side,
      amountIn: v.amount_in,
      limitPrice: v.limit_price,
      submittedAtBlock: v.submitted_at_block,
      orderNonce: v.order_nonce,
      owner: 0n,
      path_len: routed[i]!.path_len,
      path: routed[i]!.routingPath,
    }));

    const activePoolIds = new Set<number>();
    for (const r of routed) for (const pid of r.hops) activePoolIds.add(pid);
    assert.deepEqual([...activePoolIds].sort((a, b) => a - b), [0, 1, 2]);

    // Fake getPoolState reads exactly the resolved active pools.
    const poolStateMap = new Map<number, PoolStateForRouting>();
    for (const pid of activePoolIds) {
      poolStateMap.set(pid, fakeGetPoolState(10_000n * SCALE, 5_000n * SCALE));
    }
    assert.equal(poolStateMap.size, 3, "reads 3 pool states");

    const clearing = computeClearingMultiPair({
      orders: clearingOrders,
      pools: poolStateMap,
      registry: REGISTRY,
    });

    assert.equal(clearing.cleared, true);
    assert.equal(clearing.activePoolCount, 3, "3 distinct active pools");
    assert.deepEqual(
      clearing.perPoolClearings.map((p) => p.pool_id),
      [0, 1, 2],
      "perPoolClearings sorted by pool_id ascending (circuit convention)",
    );

    // Every fill must carry its order's RESOLVED pool — never INVALID_POOL_ID,
    // and never the old hardcoded pool-0 for the pool-1/pool-2 orders.
    assert.ok(clearing.fills.length >= 3, "at least one fill per pool");
    const expectedPool: Record<string, number> = {
      "10": 0, "11": 0, "20": 1, "21": 1, "30": 2, "31": 2,
    };
    for (const f of clearing.fills) {
      assert.notEqual(f.pool_id, INVALID_POOL_ID, "no fill resolves to INVALID_POOL_ID");
      assert.equal(
        f.pool_id,
        expectedPool[f.orderNonce.toString()],
        `fill for order ${f.orderNonce} routes to its own pool`,
      );
    }
    // Sanity: a fill exists in each pool.
    const poolsWithFills = new Set(clearing.fills.map((f) => f.pool_id));
    assert.deepEqual([...poolsWithFills].sort((a, b) => a - b), [0, 1, 2]);
  });

  it("u128-truncated routingPath resolves identically to resolvePoolIdU128 on full tokens", () => {
    // Guard the cross-module resolution contract: computeClearingMultiPair's
    // path.ts::resolvePoolId (full-bigint on routingPath) must agree with the
    // cycle's resolvePoolIdU128 (truncates internally) on full tokens.
    const r = resolveRevealPath(REGISTRY, { path_len: 2, path: [BigInt(tETH), BigInt(tBTC), 0n] }, fallbackPath);
    assert.equal(resolvePoolIdU128(REGISTRY, BigInt(tETH), BigInt(tBTC)), r.hops[0]);
  });
});
