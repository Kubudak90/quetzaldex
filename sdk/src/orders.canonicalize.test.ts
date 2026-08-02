// sdk/src/orders.canonicalize.test.ts
// Sub-6c A4: unit tests for canonical path normalization.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { canonicalizePath } from "./orders.js";
import { OrderError } from "./errors.js";

describe("canonicalizePath", () => {
  test("already-canonical 2-hop unchanged", () => {
    const r = canonicalizePath("sell", ["0x10", "0x20"]);
    assert.equal(r.side, "sell");
    assert.deepEqual(r.path, ["0x10", "0x20"]);
  });

  test("reversed 2-hop flips side + reverses path", () => {
    const r = canonicalizePath("sell", ["0x20", "0x10"]);
    assert.equal(r.side, "buy");
    assert.deepEqual(r.path, ["0x10", "0x20"]);
  });

  test("3-hop endpoints canonical, middle preserved", () => {
    const r = canonicalizePath("buy", ["0x10", "0x99", "0x20"]);
    assert.equal(r.side, "buy");
    assert.deepEqual(r.path, ["0x10", "0x99", "0x20"]);
  });

  test("3-hop reversed endpoints flips + reverses (middle moves with)", () => {
    const r = canonicalizePath("buy", ["0x20", "0x99", "0x10"]);
    assert.equal(r.side, "sell");
    assert.deepEqual(r.path, ["0x10", "0x99", "0x20"]);
  });

  test("equal endpoints throws OrderError", () => {
    assert.throws(
      () => canonicalizePath("buy", ["0x10", "0x10"]),
      OrderError,
    );
  });

  test("round-trip: canonicalize twice = idempotent", () => {
    const once = canonicalizePath("sell", ["0x30", "0x10"]);
    const twice = canonicalizePath(once.side, once.path);
    assert.deepEqual(twice, once);
  });

  // Sub-9.1 regression: the on-chain canonical check truncates the Field
  // address to u128 (lower 128 bits) before comparing. For addresses whose
  // top-half ordering disagrees with their bottom-half ordering, a naive
  // full-bigint comparison disagrees with the contract.
  //
  // Real-world example from Sub-9 testnet:
  //   tUSDC = 0x0525a0e5a940daf669e98d5b98c46f85f4782b6f4c5af2e5d69db808375c349c
  //   tETH  = 0x2efbaf6bd19c028cc8782a2d9e6b7b660a66476c890abe47aeaa06ec7a471ab5
  //   Full:  tUSDC < tETH  (top byte 0x05 < 0x2e)
  //   u128:  tUSDC > tETH  (lower 128 bits: 0xf478…349c > 0xa664…1ab5)
  // The canonical path per contract is [tETH, tUSDC] (sorted by u128 ASC),
  // not the natural [tUSDC, tETH] a full-bigint compare would yield.
  test("u128 truncation disagrees with full-bigint compare", () => {
    const tUSDC = "0x0525a0e5a940daf669e98d5b98c46f85f4782b6f4c5af2e5d69db808375c349c";
    const tETH  = "0x2efbaf6bd19c028cc8782a2d9e6b7b660a66476c890abe47aeaa06ec7a471ab5";
    // Caller asks for a "buy" tUSDC->tETH. Contract considers [tETH, tUSDC]
    // canonical → SDK must reverse path + flip side.
    const r = canonicalizePath("buy", [tUSDC, tETH]);
    assert.equal(r.side, "sell");
    assert.deepEqual(r.path, [tETH, tUSDC]);
  });
});
