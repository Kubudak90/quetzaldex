import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Fr } from "@aztec/aztec.js/fields";
import { computeCi, replayOrderAcc, validateReveals } from "../src/validate.js";
import type { RevealPayload } from "../src/queue.js";

// Decoy-clear fix proof.
//
// A bulk order submits 1 real + N decoys in ONE tx; submit_order_bulk folds EVERY
// used slot's c_i into the epoch order_acc (a poseidon2 hash chain — order matters).
// The aggregator replays reveals sorted by order_nonce ASC. The SDK fix sorts the
// slots by order_nonce ASC before submitting, so the on-chain fold order == the
// aggregator's replay order; and it reveals ALL slots (decoys carry an unfillable
// limit, so they never fill — they only complete the chain).
//
// This proves: revealing ALL orders replays the order_acc (epoch clears), while the
// old real-only reveal fails the replay (the whole epoch was skipped).
describe("decoy bulk order_acc replay (the decoy-clear fix)", () => {
  const owner = 0xabcdn;
  const block = 100;
  const UNFILLABLE_HIGH = (1n << 128n) - 1n; // sell decoy limit — never crosses
  const path: [bigint, bigint, bigint] = [0x111n, 0x222n, 0n];

  // 1 real (crossable limit) + 2 decoys (unfillable), random-ish order_nonces.
  const orders = [
    { owner, side: true, amount_in: 1_000_000n, limit_price: 1_000_000_000_000_000n, order_nonce: 0x7e9an, submitted_at_block: block, path_len: 2, path },
    { owner, side: true, amount_in: 1_000_000n, limit_price: UNFILLABLE_HIGH, order_nonce: 0x0051n, submitted_at_block: block, path_len: 2, path },
    { owner, side: true, amount_in: 1_000_000n, limit_price: UNFILLABLE_HIGH, order_nonce: 0x00ecn, submitted_at_block: block, path_len: 2, path },
  ];

  function toReveal(o: (typeof orders)[number]): RevealPayload {
    return {
      epoch_id: 1,
      order_nonce: new Fr(o.order_nonce).toString(),
      side: o.side,
      amount_in: o.amount_in.toString(),
      limit_price: o.limit_price.toString(),
      submitted_at_block: o.submitted_at_block,
      owner: new Fr(o.owner).toString(),
      path_len: o.path_len as 2 | 3,
      path: [new Fr(o.path[0]).toString(), new Fr(o.path[1]).toString(), new Fr(o.path[2]).toString()],
    };
  }

  it("all-reveal (order_nonce-sorted on-chain fold) replays the order_acc and ACCEPTS; real-only FAILS", async () => {
    // On-chain order_acc: the SDK sorts used slots by order_nonce ASC before submit,
    // so the orderbook folds the c_i's in that order.
    const sorted = [...orders].sort((a, b) =>
      a.order_nonce < b.order_nonce ? -1 : a.order_nonce > b.order_nonce ? 1 : 0,
    );
    const cis = [];
    for (const o of sorted) cis.push(await computeCi(o));
    const onChainAcc = await replayOrderAcc(cis);

    // (a) Reveal ALL orders (in arbitrary order — the aggregator re-sorts by
    // order_nonce) → replay matches → ACCEPTS all 3.
    const accepted = await validateReveals(orders.map(toReveal), onChainAcc);
    assert.equal(accepted.length, 3, "all-reveal must replay the order_acc and accept");

    // (b) Reveal ONLY the real order (the old behaviour) → 1 c_i vs a 3-fold acc →
    // replay mismatch → REJECTS the whole batch (the decoy-clear bug).
    const realOnly = await validateReveals([toReveal(orders[0]!)], onChainAcc);
    assert.equal(realOnly.length, 0, "real-only reveal must FAIL the replay (the bug this fix closes)");
  });

  it("a WRONG fold order (slot order != order_nonce sort) would also fail — why the SDK sort is load-bearing", async () => {
    // If the orderbook folded in raw slot order (real, decoy, decoy) but the
    // order_nonces are NOT ascending in that order, the aggregator's order_nonce-sorted
    // replay diverges → mismatch. This is what the SDK slot-sort prevents.
    const unsortedFold = [];
    for (const o of orders) unsortedFold.push(await computeCi(o)); // raw slot order
    const wrongAcc = await replayOrderAcc(unsortedFold);
    // orders[0].nonce (0x7e9a) is NOT the smallest, so slot order != sorted order.
    const accepted = await validateReveals(orders.map(toReveal), wrongAcc);
    assert.equal(accepted.length, 0, "unsorted on-chain fold must fail the sorted replay");
  });
});
