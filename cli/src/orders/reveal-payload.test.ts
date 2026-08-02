import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Fr } from "@aztec/aztec.js/fields";
import { buildOrderReveal, buildBulkReveals } from "./reveal-payload.js";

const OWNER = "0x00000000000000000000000000000000000000000000000000000000000000aa";

describe("buildOrderReveal (H6: never 0 anchor / raw side)", () => {
  const result = {
    txHash: "0xtx",
    nonce: 1n,
    orderNonce: 0x1234n,
    epoch: 7,
    blockNumber: 124_800,
    submittedAtBlock: 124_760, // the EXACT anchor block bound into c_i (≠ blockNumber, ≠ 0)
    side: true, // canonical side (may differ from the raw user side after path flip)
    path_len: 2 as const,
    path: ["0xa", "0xb", "0x0"] as [string, string, string],
  };

  it("forwards the SDK result's submittedAtBlock, never 0", () => {
    const p = buildOrderReveal(result, { amount: 300_000n, limitPrice: 1_000_000_000n }, OWNER);
    assert.equal(p.submitted_at_block, 124_760);
    assert.notEqual(p.submitted_at_block, 0);
  });

  it("uses the canonical side from the result, not the caller's raw side", () => {
    const p = buildOrderReveal(result, { amount: 300_000n, limitPrice: 1n }, OWNER);
    assert.equal(p.side, true);
  });

  it("carries the canonical path + input amount/limit + owner + nonce", () => {
    const p = buildOrderReveal(result, { amount: 300_000n, limitPrice: 999n }, OWNER);
    assert.equal(p.epoch_id, 7);
    assert.equal(p.order_nonce, new Fr(0x1234n).toString());
    assert.equal(p.amount_in, "300000");
    assert.equal(p.limit_price, "999");
    assert.equal(p.owner, OWNER);
    assert.equal(p.path_len, 2);
    assert.deepEqual(p.path, ["0xa", "0xb", "0x0"]);
  });
});

describe("buildBulkReveals (H7: broadcast EVERY slot, not zero)", () => {
  const result = {
    txHash: "0xtx",
    realNonce: 0x10n,
    decoyNonces: [0x20n, 0x30n],
    epoch: 9,
    blockNumber: 200_010,
    submittedAtBlock: 200_000,
    side: true, // canonical side of the real order (M11)
    path_len: 2 as const,
    path: ["0xa", "0xb", "0x0"] as [string, string, string],
    reveals: [
      { orderNonce: 0x10n, side: true, amountIn: 5n, limitPrice: 111n, pathLen: 2, path: ["0xa", "0xb", "0x0"] as [string, string, string] },
      { orderNonce: 0x20n, side: true, amountIn: 5n, limitPrice: 999_999n, pathLen: 2, path: ["0xa", "0xb", "0x0"] as [string, string, string] },
      { orderNonce: 0x30n, side: true, amountIn: 5n, limitPrice: 999_999n, pathLen: 2, path: ["0xa", "0xb", "0x0"] as [string, string, string] },
    ],
  };

  it("emits one payload per reveal slot (real + decoys), none dropped", () => {
    const payloads = buildBulkReveals(result, OWNER);
    assert.equal(payloads.length, 3);
    assert.deepEqual(
      payloads.map((p) => p.order_nonce),
      [0x10n, 0x20n, 0x30n].map((n) => new Fr(n).toString()),
    );
  });

  it("stamps every slot with the real order's submittedAtBlock (never 0)", () => {
    for (const p of buildBulkReveals(result, OWNER)) {
      assert.equal(p.submitted_at_block, 200_000);
      assert.equal(p.epoch_id, 9);
      assert.equal(p.owner, OWNER);
    }
  });
});
