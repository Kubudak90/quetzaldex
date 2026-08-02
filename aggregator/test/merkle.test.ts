import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Fr } from "@aztec/aztec.js/fields";
import { poseidon2Hash } from "@aztec/foundation/crypto/poseidon";
import { buildFillsTree, fillLeaf, merkleRoot32 } from "../src/merkle.js";
import type { JsFillEntry } from "../src/merkle.js";

describe("aggregator/merkle", () => {
  it("fillLeaf((0,0)) equals poseidon2([0,0]) — empty-slot sentinel", async () => {
    const leaf = await fillLeaf(new Fr(0n), 0n);
    const expected = await poseidon2Hash([0n, 0n]);
    assert.equal(leaf.toString(), expected.toString());
  });

  it("fillLeaf is sensitive to order_nonce", async () => {
    const a = await fillLeaf(new Fr(1n), 100n);
    const b = await fillLeaf(new Fr(2n), 100n);
    assert.notEqual(a.toString(), b.toString());
  });

  it("fillLeaf is sensitive to amount_out", async () => {
    const a = await fillLeaf(new Fr(1n), 100n);
    const b = await fillLeaf(new Fr(1n), 101n);
    assert.notEqual(a.toString(), b.toString());
  });

  it("merkleRoot32 of all empty leaves equals the circuit-verified EMPTY_ROOT constant", async () => {
    // EMPTY_ROOT computed via Task 3's bb-verified circuit-side merkle_root_32.
    // This is the Noir↔JS parity anchor — if it drifts, the contract's
    // recursive verify will reject every clearing.
    const EMPTY_ROOT = "0x01c28fe1059ae0237b72334700697bdf465e03df03986fe05200cadeda66bd76";
    const empty = await fillLeaf(new Fr(0n), 0n);
    const leaves: Fr[] = Array(32).fill(empty);
    const root = await merkleRoot32(leaves);
    assert.equal(root.toString(), EMPTY_ROOT);
  });

  it("buildFillsTree returns a path that reconstructs root for every populated slot", async () => {
    const fills: JsFillEntry[] = [
      { order_nonce: new Fr(11n), amount_out: 100n },
      { order_nonce: new Fr(22n), amount_out: 200n },
      { order_nonce: new Fr(33n), amount_out: 300n },
    ];
    const out = await buildFillsTree(fills);
    assert.equal(out.leaves.length, 32);

    // Re-walk the path for each populated slot.
    for (const fill of fills) {
      const path = out.paths.get(fill.order_nonce.toString());
      assert.ok(path, `missing path for nonce ${fill.order_nonce}`);
      const leaf = await fillLeaf(fill.order_nonce, fill.amount_out);
      let current = leaf;
      let idx = path.leaf_index;
      for (let level = 0; level < 5; level++) {
        const bit = idx & 1;
        const sibling = path.siblings[level]!;
        current = bit === 0
          ? await poseidon2Hash([current.toBigInt(), sibling.toBigInt()])
          : await poseidon2Hash([sibling.toBigInt(), current.toBigInt()]);
        idx >>= 1;
      }
      assert.equal(idx, 0, "leaf_index must consume all 5 bits");
      assert.equal(
        current.toString(),
        out.root.toString(),
        `path for nonce ${fill.order_nonce.toString()} did not reconstruct root`,
      );
    }
  });

  it("buildFillsTree throws on duplicate order_nonce", async () => {
    const fills: JsFillEntry[] = [
      { order_nonce: new Fr(7n), amount_out: 100n },
      { order_nonce: new Fr(7n), amount_out: 200n },
    ];
    await assert.rejects(() => buildFillsTree(fills), /duplicate/);
  });

  it("merkleRoot32 of a single non-zero leaf at index 0 pins to a stable JS value", async () => {
    // Regression anchor: catches any future drift in fillLeaf or merkleRoot32
    // for non-zero inputs (the EMPTY_ROOT test only covers the all-zero case).
    // Value computed by THIS implementation at task time; if the test ever fails,
    // either the hash function changed or one of the helpers regressed.
    const leaves: Fr[] = [];
    leaves.push(await fillLeaf(new Fr(7n), 42n));
    const empty = await fillLeaf(new Fr(0n), 0n);
    for (let i = 1; i < 32; i++) leaves.push(empty);
    const root = await merkleRoot32(leaves);
    assert.equal(
      root.toString(),
      "0x2c2ddd7f54ef1ed64fd58225f183a8012bb6bd47efe426755f715b28147ab41a",
    );
  });
});

import { buildHopFillsTree } from "../src/merkle.js";

describe("Sub-4 64-leaf hop-fills Merkle", () => {
  it("HF1: empty tree returns deterministic root", async () => {
    const t1 = await buildHopFillsTree([], 64);
    const t2 = await buildHopFillsTree([], 64);
    assert.equal(t1.leaves.length, 64);
    assert.equal(t1.root.toString(), t2.root.toString());
  });

  it("HF2: 2-hop fill produces 2 leaves; root differs from empty", async () => {
    const empty = await buildHopFillsTree([], 64);
    const filled = await buildHopFillsTree([
      { owner: new Fr(0xfeedn), order_nonce: new Fr(42n), hop_index: 0, amount_out: 100n, pool_id: 0 },
      { owner: new Fr(0xfeedn), order_nonce: new Fr(42n), hop_index: 1, amount_out: 50n, pool_id: 2 },
    ], 64);
    assert.notEqual(filled.root.toString(), empty.root.toString());
    assert.equal(filled.leaves.length, 64);
  });

  it("HF3: hop_index distinguishes leaves with same nonce", async () => {
    const r0 = await buildHopFillsTree([
      { owner: new Fr(0xfeedn), order_nonce: new Fr(42n), hop_index: 0, amount_out: 100n, pool_id: 0 },
    ], 64);
    const r1 = await buildHopFillsTree([
      { owner: new Fr(0xfeedn), order_nonce: new Fr(42n), hop_index: 1, amount_out: 100n, pool_id: 0 },
    ], 64);
    // Same nonce + pool_id + amount but different hop_index → different root
    assert.notEqual(r0.root.toString(), r1.root.toString());
  });

  // R1: the hop-fill leaf binds the OWNER so claim_fill (which recomputes the leaf
  // with owner = msg_sender) cannot be satisfied by anyone but the filled maker.
  // The leaf MUST be poseidon2([owner, order_nonce, hop_index, amount_out, pool_id])
  // — byte-identical to circuits/clearing/src/merkle.nr::hop_fill_leaf and the
  // contract claim_fill leaf. Empty/pad slot = poseidon2([0,0,0,0,0]).
  it("R1: leaf binds owner — poseidon2([owner, nonce, hop, amount, pool])", async () => {
    const owner = new Fr(0xa11cen).toBigInt();
    const t = await buildHopFillsTree([
      { owner: new Fr(0xa11cen), order_nonce: new Fr(7n), hop_index: 0, amount_out: 999n, pool_id: 1 },
    ], 64);
    const expectedLeaf = await poseidon2Hash([owner, 7n, 0n, 999n, 1n]);
    assert.equal(t.leaves[0]!.toString(), expectedLeaf.toString(), "leaf must be the 5-element owner-bound hash");
    // Cross-layer parity anchor: this exact literal is also asserted in
    // circuits/clearing/src/test.nr::r1_hop_fill_leaf_owner_bound_parity_pin and is
    // what the contract claim_fill recomputes with owner = msg_sender. If any of the
    // three drifts, clearing's on-chain recursive verify rejects every settlement.
    assert.equal(t.leaves[0]!.toString(), "0x044beee99b56df47b028379439ab8209c2fbd62f90c1e01cc54058f3104578de");
  });

  it("R1: changing ONLY the owner changes the root (cross-maker theft is blocked)", async () => {
    const alice = await buildHopFillsTree([
      { owner: new Fr(0xa11cen), order_nonce: new Fr(7n), hop_index: 0, amount_out: 999n, pool_id: 1 },
    ], 64);
    const bob = await buildHopFillsTree([
      { owner: new Fr(0xb0bn), order_nonce: new Fr(7n), hop_index: 0, amount_out: 999n, pool_id: 1 },
    ], 64);
    // Same nonce/hop/amount/pool, different owner → different leaf → different root.
    assert.notEqual(alice.root.toString(), bob.root.toString());
  });

  it("R1: empty/pad slot is poseidon2([0,0,0,0,0])", async () => {
    const t = await buildHopFillsTree([], 64);
    const expectedEmpty = await poseidon2Hash([0n, 0n, 0n, 0n, 0n]);
    assert.equal(t.leaves[0]!.toString(), expectedEmpty.toString());
  });
});
