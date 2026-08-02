/**
 * Sub-9.3: unit tests for clearing-cycle.ts helpers.
 *
 * Heavy stuff (full runOneClearingCycleMP) is exercised by the integration
 * smoke; here we cover only the pure helpers that don't need a wallet / PXE.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  buildU128PoolRegistry,
  resolvePoolIdU128,
  isCycleInFlight,
} from "../src/clearing-cycle.js";

describe("buildU128PoolRegistry — u128 canonical ordering", () => {
  test("Sub-9 tUSDC/tETH pair: u128 truncation disagrees with full-bigint", () => {
    const tUSDC = "0x0525a0e5a940daf669e98d5b98c46f85f4782b6f4c5af2e5d69db808375c349c";
    const tETH = "0x2efbaf6bd19c028cc8782a2d9e6b7b660a66476c890abe47aeaa06ec7a471ab5";
    // Full bigint: tUSDC < tETH (0x05 < 0x2e top byte)
    assert.ok(BigInt(tUSDC) < BigInt(tETH));
    // u128 truncation: tUSDC's lower 128 bits > tETH's
    const mask = (1n << 128n) - 1n;
    assert.ok((BigInt(tUSDC) & mask) > (BigInt(tETH) & mask));

    const reg = buildU128PoolRegistry([
      { pool_id: 0, address: "0xabc", token_a: tETH, token_b: tUSDC },
    ]);
    assert.equal(reg.length, 1);
    // Registry should store lo = tETH u128 (smaller), hi = tUSDC u128 (larger)
    assert.equal(reg[0]!.token_a, BigInt(tETH) & mask);
    assert.equal(reg[0]!.token_b, BigInt(tUSDC) & mask);
  });

  test("3 pools mapped correctly", () => {
    const tUSDC = "0x0525a0e5a940daf669e98d5b98c46f85f4782b6f4c5af2e5d69db808375c349c";
    const tETH = "0x2efbaf6bd19c028cc8782a2d9e6b7b660a66476c890abe47aeaa06ec7a471ab5";
    const tBTC = "0x02c078075c3cbbc6c135f3ef4e4ae85e9765a56995e0aff4f638d44294638afc";
    const reg = buildU128PoolRegistry([
      { pool_id: 0, address: "0xa", token_a: tETH, token_b: tUSDC },
      { pool_id: 1, address: "0xb", token_a: tBTC, token_b: tUSDC },
      { pool_id: 2, address: "0xc", token_a: tETH, token_b: tBTC },
    ]);
    assert.equal(reg.length, 3);
    assert.deepEqual(reg.map((p) => p.pool_id), [0, 1, 2]);
  });
});

describe("resolvePoolIdU128 — order-agnostic lookup", () => {
  test("lookup by either order finds the pool", () => {
    const tUSDC = "0x0525a0e5a940daf669e98d5b98c46f85f4782b6f4c5af2e5d69db808375c349c";
    const tETH = "0x2efbaf6bd19c028cc8782a2d9e6b7b660a66476c890abe47aeaa06ec7a471ab5";
    const reg = buildU128PoolRegistry([
      { pool_id: 0, address: "0xa", token_a: tETH, token_b: tUSDC },
    ]);
    assert.equal(resolvePoolIdU128(reg, BigInt(tUSDC), BigInt(tETH)), 0);
    assert.equal(resolvePoolIdU128(reg, BigInt(tETH), BigInt(tUSDC)), 0);
  });

  test("unknown pair returns -1", () => {
    const tUSDC = "0x0525a0e5a940daf669e98d5b98c46f85f4782b6f4c5af2e5d69db808375c349c";
    const tETH = "0x2efbaf6bd19c028cc8782a2d9e6b7b660a66476c890abe47aeaa06ec7a471ab5";
    const reg = buildU128PoolRegistry([
      { pool_id: 0, address: "0xa", token_a: tETH, token_b: tUSDC },
    ]);
    assert.equal(resolvePoolIdU128(reg, 0x123n, 0x456n), -1);
  });
});

describe("isCycleInFlight — module-level guard", () => {
  test("false at module load", () => {
    assert.equal(isCycleInFlight(), false);
  });
});
