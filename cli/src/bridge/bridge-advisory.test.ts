// cli/src/bridge/bridge-advisory.test.ts
// Sub-6a C5: bridge advisory unit tests.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
// Sub-6b Task 2.8: modules now live in @quetzal/sdk.
import { isRoundTripRisk, type DepositRecord } from "@quetzal/sdk/privacy/bridge-history";
import { buildSplitSchedule } from "@quetzal/sdk/privacy/bridge-schedule";

// Helper to construct a well-typed DepositRecord with minimal fields.
const makeRecord = (amount: bigint): DepositRecord => ({
  blockNumber: 100n,
  timestamp: 1_000_000,
  txHash: "0xdeadbeef" as `0x${string}`,
  bridgeAddr: "0x0000000000000000000000000000000000000001" as `0x${string}`,
  amount,
  l2Recipient: "0x0000000000000000000000000000000000000000000000000000000000000000" as `0x${string}`,
  isPrivate: true,
});

describe("isRoundTripRisk", () => {
  test("returns no risk on empty records", () => {
    const result = isRoundTripRisk(1_000_000n, [], 5);
    assert.equal(result.risk, false);
    assert.equal(result.matched, null);
  });

  test("flags exact-amount match", () => {
    const rec = makeRecord(1_000_000n);
    const result = isRoundTripRisk(1_000_000n, [rec], 5);
    assert.equal(result.risk, true);
    assert.equal(result.matched, rec);
  });

  test("flags within-tolerance match (+3%)", () => {
    const rec = makeRecord(1_000_000n);
    // 1_030_000 is 3% above 1_000_000 — within 5% tolerance
    const result = isRoundTripRisk(1_030_000n, [rec], 5);
    assert.equal(result.risk, true);
    assert.equal(result.matched, rec);
  });

  test("ignores out-of-tolerance amount (>5%)", () => {
    const rec = makeRecord(1_000_000n);
    // 1_100_000 is 10% above 1_000_000 — outside 5% tolerance
    const result = isRoundTripRisk(1_100_000n, [rec], 5);
    assert.equal(result.risk, false);
    assert.equal(result.matched, null);
  });
});

describe("buildSplitSchedule", () => {
  test("rejects splitInto < 2", () => {
    assert.throws(() => buildSplitSchedule("USDC", 1_000_000n, "0xabc", 1, 3, false), /--split-into/);
  });

  test("rejects splitInto > 20", () => {
    assert.throws(() => buildSplitSchedule("USDC", 1_000_000n, "0xabc", 21, 3, false), /--split-into/);
  });

  test("rejects intervalDays < 1", () => {
    assert.throws(() => buildSplitSchedule("USDC", 1_000_000n, "0xabc", 3, 0, false), /--interval-days/);
  });

  test("rejects intervalDays > 90", () => {
    assert.throws(() => buildSplitSchedule("USDC", 1_000_000n, "0xabc", 3, 91, false), /--interval-days/);
  });

  test("preserves total amount exactly across all splits", () => {
    const total = 1_234_567_890n;
    const schedule = buildSplitSchedule("USDC", total, "0xabc", 5, 3, false);
    assert.equal(schedule.length, 5);
    const sum = schedule.reduce((acc, e) => acc + BigInt(e.amount), 0n);
    assert.equal(sum, total);
  });

  test("staggers exits by intervalDays", () => {
    const schedule = buildSplitSchedule("USDC", 1_000_000n, "0xabc", 3, 7, false);
    const day = 86400;
    assert.equal(schedule[1].submitAfterUnix - schedule[0].submitAfterUnix, 7 * day);
    assert.equal(schedule[2].submitAfterUnix - schedule[1].submitAfterUnix, 7 * day);
  });

  test("first entry has submitAfterUnix == now (immediate)", () => {
    const before = Math.floor(Date.now() / 1000);
    const schedule = buildSplitSchedule("USDC", 1_000_000n, "0xabc", 2, 1, false);
    const after = Math.floor(Date.now() / 1000);
    assert.ok(schedule[0].submitAfterUnix >= before);
    assert.ok(schedule[0].submitAfterUnix <= after);
  });

  test("all entries pending status with null L2 fields", () => {
    const schedule = buildSplitSchedule("USDC", 1_000_000n, "0xabc", 3, 1, false);
    for (const e of schedule) {
      assert.equal(e.status, "pending");
      assert.equal(e.l2TxHash, null);
      assert.equal(e.l2EpochAtSubmit, null);
    }
  });

  test("deterministic noise within +/-20% per non-last entry", () => {
    const total = 1_000_000_000n; // 1B units
    const schedule = buildSplitSchedule("USDC", total, "0xabc", 5, 3, false);
    const baseAmount = total / 5n; // 200_000_000n
    const lowerBound = (baseAmount * 80n) / 100n;
    const upperBound = (baseAmount * 120n) / 100n;
    for (let i = 0; i < schedule.length - 1; i++) {
      const amt = BigInt(schedule[i].amount);
      assert.ok(amt >= lowerBound, `entry ${i} below lower bound: ${amt}`);
      assert.ok(amt <= upperBound, `entry ${i} above upper bound: ${amt}`);
    }
  });
});
