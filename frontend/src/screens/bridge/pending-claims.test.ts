import { describe, test, expect, beforeEach } from "vitest";
import {
  addPendingClaim,
  loadPendingClaims,
  removePendingClaim,
  type PendingClaim,
} from "./pending-claims";

const sample: PendingClaim = {
  token: "aUSDC",
  amount: "1000000",
  secret: "0x" + "11".repeat(32),
  secretHash: "0x" + "22".repeat(32),
  messageHash: "0x" + "33".repeat(32),
  messageIndex: "42",
  isPrivate: false,
  createdAt: 1779900000000,
};

beforeEach(() => { localStorage.clear(); });

describe("pending-claims persistence", () => {
  test("addPendingClaim + loadPendingClaims round-trip", () => {
    addPendingClaim(sample);
    expect(loadPendingClaims()).toEqual([sample]);
  });

  test("multiple claims preserved in order", () => {
    const second: PendingClaim = { ...sample, messageIndex: "43" };
    addPendingClaim(sample);
    addPendingClaim(second);
    expect(loadPendingClaims()).toEqual([sample, second]);
  });

  test("removePendingClaim filters by messageIndex", () => {
    const second: PendingClaim = { ...sample, messageIndex: "43" };
    addPendingClaim(sample);
    addPendingClaim(second);
    removePendingClaim("42");
    expect(loadPendingClaims()).toEqual([second]);
  });

  test("loadPendingClaims returns [] on missing / corrupt", () => {
    expect(loadPendingClaims()).toEqual([]);
    localStorage.setItem("quetzal-pending-claims", "{not-json");
    expect(loadPendingClaims()).toEqual([]);
  });
});
