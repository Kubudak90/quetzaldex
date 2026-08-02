/**
 * Sub-3 e2e: two aggregators register + race for one clearing.
 *
 * Status: DORMANT pending the dev stack (anvil:18545 + aztec:18080). Docker
 * is broken on this dev box (per memory/project_week05c_integration_gap.md);
 * the test is structurally laid out so a future session with a live stack
 * can fill in the implementation.
 *
 * E1: two aggregators register, both attempt clearing the same epoch, the
 *     first valid submission wins, the second's tx reverts with
 *     "order_acc mismatch" (the 5d-4 freshness gate). Treasury credits the
 *     winner by AGGREGATOR_FEE; the second aggregator earns nothing.
 * E2: same setup but a tampered reveal is POSTed to one aggregator while
 *     the honest reveal goes to the other. The tampered aggregator's
 *     validateReveals discards the bad payload, then its clearing has
 *     missing orders (order_acc mismatch) and reverts. The honest
 *     aggregator wins.
 *
 * Both tests require the full 4-phase deploy from scripts/deploy-tokens.ts,
 * plus the bb prove ClientIVC pipeline (~5-6 min wallclock per clearing),
 * plus mock aggregator HTTP servers in the test harness. They subsume the
 * still-dormant 5d-3/5d-4 testnet validation.
 *
 * To run when the stack is up:
 *   pnpm test --filter='./tests/**' -- --test-name-pattern='Sub-3 e2e'
 */
import { describe, it } from "node:test";

describe("Sub-3 e2e — bonded aggregator race", { skip: true }, () => {
  it("E1: alice wins the race; bob reverts; alice gets paid", () => {
    // Implementer expands by mirroring tests/integration/clearing.test.ts's
    // E1 deploy + submit + prove + verify scaffold, with the new wrinkle:
    // two AggregatorRegistry registrations, two clearing daemons running
    // mock HTTP servers (one per aggregator), and a parallel
    // close_epoch_and_clear_verified race via Promise.allSettled. Inspect
    // both tx receipts: one mined, one reverted with "order_acc mismatch".
    // Assert: alice's tUSDC public balance += AGGREGATOR_FEE; treasury
    // tracked_balance decreased by AGGREGATOR_FEE.
  });

  it("E2: aggregator with tampered reveal discards it; honest one wins", () => {
    // Same setup as E1, but POST a tampered reveal (amount_in flipped) to
    // bob's mock server. Bob's daemon runs validateReveals which rejects
    // the bad payload, so bob has fewer orders than on-chain. Bob's
    // clearing then fails the freshness gate. Alice wins.
  });
});
