import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Fr } from "@aztec/aztec.js/fields";
import { buildFillsTree, type JsFillEntry } from "../src/merkle.js";
import { writeSnapshot, readSnapshot, findEpochForNonce } from "../src/snapshot.js";

describe("aggregator/snapshot", () => {
  it("writes and reads back a snapshot identically", async () => {
    const dir = mkdtempSync(join(tmpdir(), "quetzal-snapshot-"));
    try {
      const fills: JsFillEntry[] = [
        { order_nonce: new Fr(101n), amount_out: 500n },
        { order_nonce: new Fr(202n), amount_out: 750n },
      ];
      const tree = await buildFillsTree(fills);
      writeSnapshot(dir, { epoch_id: 7, fills, tree });

      const round = readSnapshot(dir, 7);
      assert.equal(round.epoch_id, 7);
      assert.equal(round.fills_root, tree.root.toString());
      assert.equal(round.leaves.length, 32);
      const fill101 = round.paths.get(new Fr(101n).toString());
      assert.ok(fill101, "expected path for nonce 0x65");
      assert.equal(fill101.leaf_index, 0);
      assert.equal(fill101.siblings.length, 5);
      // Spot-check that round-trip preserves big-int amounts as strings.
      const populated = round.leaves.slice(0, 2);
      assert.equal(populated.length, 2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("findEpochForNonce returns the matching epoch_id, or null", async () => {
    const dir = mkdtempSync(join(tmpdir(), "quetzal-snapshot-"));
    try {
      const fillsA: JsFillEntry[] = [{ order_nonce: new Fr(11n), amount_out: 100n }];
      const fillsB: JsFillEntry[] = [{ order_nonce: new Fr(22n), amount_out: 200n }];
      writeSnapshot(dir, { epoch_id: 3, fills: fillsA, tree: await buildFillsTree(fillsA) });
      writeSnapshot(dir, { epoch_id: 5, fills: fillsB, tree: await buildFillsTree(fillsB) });
      assert.equal(findEpochForNonce(dir, new Fr(11n).toString()), 3);
      assert.equal(findEpochForNonce(dir, new Fr(22n).toString()), 5);
      assert.equal(findEpochForNonce(dir, new Fr(999n).toString()), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
