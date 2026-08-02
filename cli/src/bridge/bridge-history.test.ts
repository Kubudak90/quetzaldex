import { test } from "node:test";
import { strict as assert } from "node:assert";
// Sub-6b Task 2.8: lifted to @quetzal/sdk.
import { isRoundTripRisk, type DepositRecord } from "@quetzal/sdk/privacy/bridge-history";

const rec = (amount: bigint): DepositRecord => ({
  blockNumber: 100n,
  timestamp: 1000,
  txHash: "0xabc" as `0x${string}`,
  bridgeAddr: "0x0000000000000000000000000000000000000001" as `0x${string}`,
  amount,
  l2Recipient: "0x0000000000000000000000000000000000000000000000000000000000000000" as `0x${string}`,
  isPrivate: false,
});

test("no risk when records empty", () => {
  assert.equal(isRoundTripRisk(1000n, []).risk, false);
});

test("exact-match amount is risk", () => {
  const r = isRoundTripRisk(1_000_000n, [rec(1_000_000n)]);
  assert.equal(r.risk, true);
  assert.equal(r.matched?.amount, 1_000_000n);
});

test("within +5% tolerance is risk", () => {
  // 1_040_000 is 4% above 1_000_000 → within tolerance
  const r = isRoundTripRisk(1_040_000n, [rec(1_000_000n)]);
  assert.equal(r.risk, true);
});

test("beyond +5% tolerance is not risk", () => {
  // 1_060_000 is 6% above 1_000_000 → outside tolerance
  const r = isRoundTripRisk(1_060_000n, [rec(1_000_000n)]);
  assert.equal(r.risk, false);
});
