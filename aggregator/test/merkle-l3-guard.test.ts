/**
 * L3 unit tests: buildHopFillsTree size/power-of-2/duplicate guards.
 * Verifies the three guards added to buildHopFillsTree that its 32-leaf
 * counterpart (buildFillsTree) already had.
 */
import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { Fr } from "@aztec/aztec.js/fields";
import { buildHopFillsTree } from "../src/merkle.js";
import type { HopFillLeaf } from "../src/merkle.js";

function makeFill(nonce: bigint, hopIndex: 0 | 1): HopFillLeaf {
  return { owner: new Fr(0xfeedn), order_nonce: new Fr(nonce), hop_index: hopIndex, amount_out: 100n, pool_id: 0 };
}

describe("L3 buildHopFillsTree guards", () => {
  it("L3-A: fills.length > depth throws", async () => {
    const fills = [makeFill(1n, 0), makeFill(2n, 0), makeFill(3n, 0)];
    await assert.rejects(
      () => buildHopFillsTree(fills, 2),   // depth=2, fills=3 → overflow
      /too many fills/,
      "should throw when fills exceed depth",
    );
  });

  it("L3-B: non-power-of-2 depth throws", async () => {
    await assert.rejects(
      () => buildHopFillsTree([], 3),      // 3 is not a power of 2
      /power of 2/,
      "should throw for non-power-of-2 depth",
    );
  });

  it("L3-B2: another non-power-of-2 depth throws (depth=6)", async () => {
    await assert.rejects(
      () => buildHopFillsTree([], 6),
      /power of 2/,
    );
  });

  it("L3-C: duplicate ${order_nonce}:${hop_index} throws", async () => {
    // Same nonce AND same hop_index → duplicate key.
    const fills = [makeFill(42n, 0), makeFill(42n, 0)];
    await assert.rejects(
      () => buildHopFillsTree(fills, 4),
      /duplicate/,
      "should throw on duplicate nonce:hop_index combination",
    );
  });

  it("L3-D: same nonce but different hop_index is allowed (two-hop order)", async () => {
    // nonce=42, hop=0 and nonce=42, hop=1 are DISTINCT keys — must not throw.
    const fills = [makeFill(42n, 0), makeFill(42n, 1)];
    await assert.doesNotReject(
      () => buildHopFillsTree(fills, 4),
      "same nonce with different hop_index should be allowed",
    );
  });

  it("L3-E: power-of-2 depth with fills within limit succeeds", async () => {
    const fills = [makeFill(1n, 0), makeFill(2n, 0)];
    await assert.doesNotReject(
      () => buildHopFillsTree(fills, 4),
      "valid inputs should not throw",
    );
  });

  it("L3-F: depth=1 is a valid power of 2 with 0 or 1 fill", async () => {
    await assert.doesNotReject(
      () => buildHopFillsTree([], 1),
    );
    await assert.doesNotReject(
      () => buildHopFillsTree([makeFill(1n, 0)], 1),
    );
  });
});
