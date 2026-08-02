import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { recoverForwardedFee } from "../src/clearing.js";
import { SCALE } from "../src/buckets.js";

// Pure-TS mirror of contracts/pool/src/main.nr withdrawal arithmetic (floor bigint).
// Pins the M17 fee-pot solvency argument: principal is pro-rata over NET reserves,
// earned is paid from the pot and capped at its balance -- SUM payouts <= holdings.

interface Bucket { reserve: bigint; liquidity: bigint; cumFee: bigint; }
interface Pot { balance: bigint; }
interface Position { share: bigint; cumFeeAtDeposit: bigint; }

// apply one clearing to a bucket (single token side, matching main.nr apply_clearing)
function applyClearing(b: Bucket, pot: Pot, reserveAdd: bigint, stepFee: bigint) {
  const inc = (stepFee * SCALE) / b.liquidity;            // aggregator cum_fee_inc
  const { feeB } = recoverForwardedFee(
    [{ cum_fee_a_per_share_increment: 0n, cum_fee_b_per_share_increment: inc }],
    [b.liquidity],
  );
  b.reserve += reserveAdd;                                 // NET add only
  pot.balance += feeB;                                     // fee -> pot
  b.cumFee += inc;
  return { forwarded: feeB, inc };
}

// withdraw one position (matching main.nr withdraw + _apply_withdraw_from_bucket)
function withdraw(b: Bucket, pot: Pot, p: Position): bigint {
  const principal = b.liquidity === 0n ? 0n : (p.share * b.reserve) / b.liquidity;
  const claim = (p.share * (b.cumFee - p.cumFeeAtDeposit)) / SCALE;
  const earned = claim > pot.balance ? pot.balance : claim; // the M17 cap
  assert.ok(b.reserve >= principal, "bucket reserve underflow (principal)");
  assert.ok(pot.balance >= earned, "fee pot underflow (earned)");
  b.reserve -= principal;
  pot.balance -= earned;
  b.liquidity -= p.share;
  return principal + earned;
}

describe("M17 pool solvency simulation (fee pot model)", () => {
  it("C1 regression: the reserve-credited model was insolvent by exactly the fee", () => {
    // OLD (task-6) model: fee credited into reserve; earned paid ON TOP.
    const reserve = 1_000_000_000n + 997_000n + 3_000n; // fee-inclusive
    const L = 1_000_000n;
    const inc = (3_000n * SCALE) / L;
    const principal = (L * reserve) / L;                // sole LP scoops ALL of it
    const earned = (L * inc) / SCALE;
    const payout = principal + earned;
    assert.equal(payout - reserve, 3_000n, "deficit == the fee, the C1 double-claim");
  });

  it("sole LP: pot model pays principal(net) + earned(pot), fully solvent", () => {
    const b: Bucket = { reserve: 1_000_000_000n, liquidity: 1_000_000n, cumFee: 0n };
    const pot: Pot = { balance: 0n };
    const p: Position = { share: 1_000_000n, cumFeeAtDeposit: 0n };
    applyClearing(b, pot, 997_000n, 3_000n);
    const holdings = b.reserve + pot.balance;
    const payout = withdraw(b, pot, p);
    assert.equal(payout, holdings, "sole LP takes net principal + full pot");
    assert.equal(b.reserve, 0n, "principal drains net reserve exactly");
    assert.equal(pot.balance, 0n, "pot fully paid out as earned");
  });

  it("multi-LP sequential withdrawals all succeed (no last-withdrawer underflow)", () => {
    const b: Bucket = { reserve: 1_000_000_000n, liquidity: 1_000_000n, cumFee: 0n };
    const pot: Pot = { balance: 0n };
    // two LPs, 60/40
    const p1: Position = { share: 600_000n, cumFeeAtDeposit: 0n };
    const p2: Position = { share: 400_000n, cumFeeAtDeposit: 0n };
    applyClearing(b, pot, 997_000n, 3_000n);
    const holdings = b.reserve + pot.balance;
    const out1 = withdraw(b, pot, p1);   // must not throw
    const out2 = withdraw(b, pot, p2);   // must not throw -- the old model broke HERE
    assert.ok(out1 + out2 <= holdings, "total payouts within holdings");
    assert.equal(b.reserve, 0n);
  });

  it("I1: cross-clearing floor gap absorbed by the cap (claim 13 vs pot 12)", () => {
    const b: Bucket = { reserve: 10_000_000n, liquidity: 3_000_000n, cumFee: 0n };
    const pot: Pot = { balance: 0n };
    const p: Position = { share: 3_000_000n, cumFeeAtDeposit: 0n };
    const r1 = applyClearing(b, pot, 100_000n, 7n);  // forwarded floor = 6
    const r2 = applyClearing(b, pot, 100_000n, 7n);  // forwarded floor = 6
    assert.equal(r1.forwarded + r2.forwarded, 12n, "credited = sum of per-clearing floors");
    const claim = (p.share * b.cumFee) / SCALE;
    assert.equal(claim, 13n, "accumulated claim exceeds credited by 1 (floor gap)");
    const payout = withdraw(b, pot, p);              // must NOT throw: cap absorbs the gap
    assert.equal(pot.balance, 0n, "pot fully drained, nothing overdrawn");
    assert.ok(payout > 0n);
  });
});
