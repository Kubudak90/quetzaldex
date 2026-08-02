import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildSplitSchedule } from "./bridge-schedule.js";

const RECIP = "0x" + "1".repeat(40);

describe("buildSplitSchedule (H5: split exits must preserve the privacy mode)", () => {
  it("stamps every scheduled leg with isPrivate=true for a private exit", () => {
    const legs = buildSplitSchedule("USDC", 1_000_000n, RECIP, 4, 7, true);
    assert.equal(legs.length, 4);
    for (const l of legs) assert.equal(l.isPrivate, true);
  });

  it("stamps isPrivate=false for a public exit", () => {
    const legs = buildSplitSchedule("USDC", 1_000_000n, RECIP, 3, 7, false);
    for (const l of legs) assert.equal(l.isPrivate, false);
  });

  it("still splits the full amount across the legs (no regression)", () => {
    const total = 1_000_000n;
    const legs = buildSplitSchedule("USDC", total, RECIP, 5, 7, true);
    const sum = legs.reduce((a, l) => a + BigInt(l.amount), 0n);
    assert.equal(sum, total);
    assert.equal(legs.length, 5);
  });
});
