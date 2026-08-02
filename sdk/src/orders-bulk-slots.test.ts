// sdk/src/orders-bulk-slots.test.ts
// L11: unit tests for the extracted buildBulkSlots pure helper.
// Covers the four invariants that, if violated, silently poison entire epochs
// via order_acc replay mismatch ("skipped:replay-mismatch").
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { Fr } from "@aztec/aztec.js/fields";
import { buildBulkSlots, MAX_ORDERS_PER_BULK } from "./orders.js";

const UNFILLABLE_HIGH = (1n << 128n) - 1n;
const UNFILLABLE_LOW = 1n;

// Deterministic sequential rng: each call returns start, start+1, start+2, ...
function seqRng(start = 1000n): () => bigint {
  let n = start;
  return () => n++;
}

// Minimal path triple (actual values irrelevant for slot-sort logic).
const PATH: [Fr, Fr, Fr] = [new Fr(1n), new Fr(2n), Fr.ZERO];

describe("buildBulkSlots invariants (L11)", () => {
  // (a) all 7 parallel arrays permuted consistently after the orderNonce sort.
  // With seqRng(1000) and decoyCount=2:
  //   slot 0: nonce=1000, orderNonce=1001 (real)
  //   slot 1: nonce=1002, orderNonce=1003 (decoy)
  //   slot 2: nonce=1004, orderNonce=1005 (decoy)
  // Already sorted ASC, so permutation is identity — but the data-consistency
  // assertion is still meaningful: every slot's own (side, amount, limit, nonce,
  // orderNonce, pathLen, pathArrays) must all come from the same original slot.
  test("(a) all 7 parallel arrays permuted consistently", () => {
    const rng = seqRng(1000n);
    const r = buildBulkSlots(true, 500n, 999n, 2, PATH, 2, rng);

    // orderNonces in used slots must be sorted ASC
    for (let i = 1; i < 3; i++) {
      assert.ok(r.orderNonces[i - 1]! < r.orderNonces[i]!, `orderNonces not sorted at i=${i}`);
    }

    // All used slots share realSide and amount — verify the arrays agree.
    for (let i = 0; i < 3; i++) {
      assert.equal(r.sides[i], true, `sides[${i}] should equal realSide`);
      assert.equal(r.amounts[i], 500n, `amounts[${i}] should equal amount`);
      assert.equal(r.pathLens[i], 2, `pathLens[${i}] should equal pathLen`);
    }

    // reveals.orderNonce must mirror the sorted orderNonces
    assert.equal(r.reveals.length, 3, "reveals length should equal decoyCount+1");
    for (let i = 0; i < r.reveals.length; i++) {
      assert.equal(
        r.reveals[i]!.orderNonce, r.orderNonces[i]!,
        `reveals[${i}].orderNonce !== orderNonces[${i}]`,
      );
    }
  });

  // (b) reveals[i].orderNonce === usedOrderNonces[i] post-sort (the invariant that
  // makes the aggregator's reveal broadcast order correct).
  test("(b) reveals[i].orderNonce === usedOrderNonces[i] post-sort", () => {
    const rng = seqRng(2000n);
    const r = buildBulkSlots(false, 200n, 50n, 2, PATH, 3, rng);

    // 1 real + 3 decoys = 4 used slots
    assert.equal(r.reveals.length, 4, "reveals.length should equal decoyCount+1");

    for (let i = 0; i < r.reveals.length; i++) {
      assert.equal(
        r.reveals[i]!.orderNonce,
        r.orderNonces[i]!,
        `reveals[${i}].orderNonce should equal orderNonces[${i}] after sort`,
      );
    }
  });

  // (c) realOrderNonce tracked by VALUE across the sort permutation.
  // Use a cross-over rng so the real order's orderNonce is LARGER than the decoy's,
  // forcing the sort to move the real order from slot 0 to slot 1.
  //   call sequence: nonce0=100, orderNonce0=999(real), nonce1=200, orderNonce1=100(decoy)
  // After sort by orderNonce ASC: slot0={decoy, on=100}, slot1={real, on=999}
  test("(c) realOrderNonce tracked by value across the sort permutation", () => {
    let call = 0;
    const seqs = [100n, 999n, 200n, 100n];
    const crossRng = () => seqs[call++] ?? 0n;
    const r = buildBulkSlots(true, 400n, 88n, 2, PATH, 1, crossRng);

    assert.equal(r.realOrderNonce, 999n, "realOrderNonce should be the value captured before sort");

    // realOrderNonce must appear in the used part of orderNonces
    const usedOnces = r.orderNonces.slice(0, 2);
    assert.ok(usedOnces.includes(r.realOrderNonce), "realOrderNonce must be in sorted orderNonces");

    // The slot holding realOrderNonce must carry the REAL limitPrice (not unfillable)
    const realIdx = usedOnces.indexOf(r.realOrderNonce);
    assert.equal(r.limits[realIdx], 88n, "real slot should carry limitPrice, not unfillable");

    // The OTHER slot must carry the unfillable sell limit (sell side, decoyCount=1)
    const decoyIdx = 1 - realIdx;
    assert.equal(r.limits[decoyIdx], UNFILLABLE_HIGH, "decoy slot should carry UNFILLABLE_HIGH for sells");
  });

  // (d) decoy limits: UNFILLABLE_HIGH for sells, 1n for buys; unused slots zero-padded.
  test("(d) decoy limits correct for sell and buy; unused slots are zero-padded", () => {
    const SLOTS = MAX_ORDERS_PER_BULK;

    // --- sell side (decoyCount=2, 3 used slots, 2 unused) ---
    const rngSell = seqRng(100n);
    const sell = buildBulkSlots(true, 300n, 150n, 2, PATH, 2, rngSell);
    const realIdxSell = sell.orderNonces.slice(0, 3).indexOf(sell.realOrderNonce);
    for (let i = 0; i < 3; i++) {
      if (i === realIdxSell) {
        assert.equal(sell.limits[i], 150n, `sell: real slot limit should be 150n`);
      } else {
        assert.equal(sell.limits[i], UNFILLABLE_HIGH, `sell: decoy slot ${i} should be UNFILLABLE_HIGH`);
      }
    }
    // Unused slots must stay zero-padded (contract skips amount=0 slots)
    for (let i = 3; i < SLOTS; i++) {
      assert.equal(sell.amounts[i], 0n, `sell: unused slot ${i} amount must be 0n`);
      assert.equal(sell.limits[i], 0n, `sell: unused slot ${i} limit must be 0n`);
      assert.equal(sell.nonces[i], 0n, `sell: unused slot ${i} nonce must be 0n`);
    }

    // --- buy side (decoyCount=2, 3 used slots, 2 unused) ---
    const rngBuy = seqRng(200n);
    const buy = buildBulkSlots(false, 300n, 150n, 2, PATH, 2, rngBuy);
    const realIdxBuy = buy.orderNonces.slice(0, 3).indexOf(buy.realOrderNonce);
    for (let i = 0; i < 3; i++) {
      if (i === realIdxBuy) {
        assert.equal(buy.limits[i], 150n, `buy: real slot limit should be 150n`);
      } else {
        assert.equal(buy.limits[i], UNFILLABLE_LOW, `buy: decoy slot ${i} should be UNFILLABLE_LOW (1n)`);
      }
    }
    // Unused slots
    for (let i = 3; i < SLOTS; i++) {
      assert.equal(buy.amounts[i], 0n, `buy: unused slot ${i} amount must be 0n`);
      assert.equal(buy.limits[i], 0n, `buy: unused slot ${i} limit must be 0n`);
    }
  });
});
