import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computeWithdrawContent } from "./sha256-content.js";

// M19: golden-vector parity with the L1 Solidity _withdrawContent and the Noir
// withdraw_content helper. Same literals asserted in all three languages. Fixed inputs:
// l1Recipient = 0x33..33 (20 bytes), amount = 123456789.
const L1 = "0x3333333333333333333333333333333333333333";
const AMOUNT = 123456789n;

describe("M19 computeWithdrawContent golden vectors", () => {
  it("withdraw public matches the shared golden vector", () => {
    assert.equal(
      computeWithdrawContent(L1, AMOUNT, false),
      "0x00706f0d1c76b1411fa40f1b5243f66db8fe671c26464bf1475dd4c348dcf7f6",
    );
  });
  it("withdraw private matches the shared golden vector", () => {
    assert.equal(
      computeWithdrawContent(L1, AMOUNT, true),
      "0x006de33747bb380f044f1e16230ba9c2b88643c25aff92264cf61c910aeb1bba",
    );
  });
});
