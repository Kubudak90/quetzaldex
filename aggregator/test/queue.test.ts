import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { RevealQueue, type RevealPayload } from "../src/queue.js";

const SAMPLE: RevealPayload = {
  epoch_id: 7,
  order_nonce: "0xabc",
  side: false,
  amount_in: "1000",
  limit_price: "2000000000000000000",
  submitted_at_block: 42,
  owner: "0xdeadbeef",
};

describe("RevealQueue", () => {
  it("enqueue + drainEpoch returns inserted payloads", () => {
    const q = new RevealQueue();
    q.enqueue(SAMPLE);
    const drained = q.drainEpoch(7);
    assert.equal(drained.length, 1);
    assert.equal(drained[0]!.order_nonce, "0xabc");
  });

  it("drainEpoch returns empty array when no payloads for that epoch", () => {
    const q = new RevealQueue();
    q.enqueue({ ...SAMPLE, epoch_id: 7 });
    assert.deepEqual(q.drainEpoch(8), []);
  });

  it("drainEpoch removes payloads for that epoch (second drain returns empty)", () => {
    const q = new RevealQueue();
    q.enqueue(SAMPLE);
    q.drainEpoch(7);
    assert.deepEqual(q.drainEpoch(7), []);
  });

  it("dedupes by (epoch_id, order_nonce)", () => {
    const q = new RevealQueue();
    q.enqueue(SAMPLE);
    q.enqueue({ ...SAMPLE, amount_in: "9999" });   // same key, different body
    const drained = q.drainEpoch(7);
    assert.equal(drained.length, 1, "duplicate (epoch_id, order_nonce) must dedupe");
    // First-write-wins.
    assert.equal(drained[0]!.amount_in, "1000");
  });

  it("size() reports total queued payloads across all epochs", () => {
    const q = new RevealQueue();
    q.enqueue({ ...SAMPLE, epoch_id: 1, order_nonce: "0x1" });
    q.enqueue({ ...SAMPLE, epoch_id: 2, order_nonce: "0x2" });
    q.enqueue({ ...SAMPLE, epoch_id: 2, order_nonce: "0x3" });
    assert.equal(q.size(), 3);
  });

  // H4: the auto-roll / wouldClear gates must key on the CURRENT epoch, not the
  // global queue — a leftover reveal for a stale epoch must not block the current
  // (expired, empty) epoch from advancing.
  it("sizeForEpoch reports per-epoch counts and ignores other epochs", () => {
    const q = new RevealQueue();
    q.enqueue({ ...SAMPLE, epoch_id: 5, order_nonce: "0xstale" });
    q.enqueue({ ...SAMPLE, epoch_id: 9, order_nonce: "0xa" });
    q.enqueue({ ...SAMPLE, epoch_id: 9, order_nonce: "0xb" });
    assert.equal(q.sizeForEpoch(9), 2);
    assert.equal(q.sizeForEpoch(5), 1);
    // The current epoch 8 is empty even though the global queue is non-empty.
    assert.equal(q.sizeForEpoch(8), 0);
    assert.equal(q.size(), 3);
  });

  // M3: the queue is fed by an unauthenticated /reveal with attacker-controlled
  // epoch_id/order_nonce, so it must be bounded.
  it("rejects reveals for epochs far from the live one (setCurrentEpoch window)", () => {
    const q = new RevealQueue();
    q.setCurrentEpoch(100);
    q.enqueue({ ...SAMPLE, epoch_id: 100, order_nonce: "0x1" }); // in-window
    q.enqueue({ ...SAMPLE, epoch_id: 102, order_nonce: "0x2" }); // in-window (±2)
    q.enqueue({ ...SAMPLE, epoch_id: 5000, order_nonce: "0x3" }); // absurd future — rejected
    q.enqueue({ ...SAMPLE, epoch_id: 1, order_nonce: "0x4" }); // stale — rejected
    assert.equal(q.sizeForEpoch(100), 1);
    assert.equal(q.sizeForEpoch(102), 1);
    assert.equal(q.sizeForEpoch(5000), 0);
    assert.equal(q.size(), 2);
  });

  it("setCurrentEpoch evicts already-queued epochs outside the window", () => {
    const q = new RevealQueue();
    q.enqueue({ ...SAMPLE, epoch_id: 100, order_nonce: "0x1" });
    q.enqueue({ ...SAMPLE, epoch_id: 200, order_nonce: "0x2" });
    q.setCurrentEpoch(200); // epoch 100 is now far outside the ±2 window
    assert.equal(q.sizeForEpoch(100), 0);
    assert.equal(q.sizeForEpoch(200), 1);
  });

  it("caps reveals per epoch (drops excess beyond the max clearing set)", () => {
    const q = new RevealQueue();
    q.setCurrentEpoch(7);
    for (let i = 0; i < 600; i++) {
      q.enqueue({ ...SAMPLE, epoch_id: 7, order_nonce: "0x" + i.toString(16) });
    }
    assert.equal(q.sizeForEpoch(7), 512); // capped, not 600
  });
});
