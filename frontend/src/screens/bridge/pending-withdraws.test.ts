import { describe, test, expect, beforeEach } from "vitest";
import {
  addPendingWithdraw,
  loadPendingWithdraws,
  markWithdrawComplete,
  type PendingWithdraw,
} from "./pending-withdraws";

const sample: PendingWithdraw = {
  token: "aUSDC",
  amount: "1000000",
  l1Recipient: "0xcF582A37AaE1E580b63666587FFa42d84169bA62",
  isPrivate: false,
  l2TxHash: ("0x" + "11".repeat(32)) as `0x${string}`,
  status: "pending",
  createdAt: 1779900000000,
};

beforeEach(() => { localStorage.clear(); });

describe("pending-withdraws persistence", () => {
  test("addPendingWithdraw + loadPendingWithdraws round-trip", () => {
    addPendingWithdraw(sample);
    expect(loadPendingWithdraws()).toEqual([sample]);
  });

  test("markWithdrawComplete flips status by l2TxHash", () => {
    addPendingWithdraw(sample);
    markWithdrawComplete(sample.l2TxHash, "0xabc");
    const list = loadPendingWithdraws();
    expect(list[0]?.status).toBe("complete");
    expect(list[0]?.l1WithdrawTxHash).toBe("0xabc");
  });

  test("loadPendingWithdraws returns [] on missing / corrupt", () => {
    expect(loadPendingWithdraws()).toEqual([]);
    localStorage.setItem("quetzal-pending-withdraws", "{not-json");
    expect(loadPendingWithdraws()).toEqual([]);
  });
});
