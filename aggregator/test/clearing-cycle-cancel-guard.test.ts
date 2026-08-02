import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runOneClearingCycleMP } from "../src/clearing-cycle.js";

// H2: the production cycle hardcodes cancellationIndices: [] while feeding the
// real on-chain cancel_count into the clearing witness, so ANY cancel_order during
// an epoch makes the circuit's cancel_acc replay mismatch — every nargo execute
// fails. Worse, the reveals are drained (destructively) BEFORE that failure, so the
// epoch's legit orders are lost. Until cancel-index collection is implemented, the
// cycle must skip a cancel-bearing epoch BEFORE draining, preserving the reveals.

function fakeCtx(cancel_count: number, onDrain: () => void) {
  return {
    getBlockNumber: async () => 100,
    getEpoch: async () => ({
      epoch_id: 5,
      closes_at_block: 10,
      order_count: 1,
      order_acc: 0n,
      cancel_acc: 0n,
      cancel_count,
    }),
    queue: {
      size: () => 1,
      drainEpoch: () => {
        onDrain();
        return [];
      },
    },
  } as unknown as Parameters<typeof runOneClearingCycleMP>[0];
}

describe("runOneClearingCycleMP — cancel guard (H2)", () => {
  it("skips a cancel-bearing epoch WITHOUT draining its reveals", async () => {
    let drained = false;
    const status = await runOneClearingCycleMP(
      fakeCtx(1, () => { drained = true; }),
      () => {},
    );
    assert.equal(status, "skipped:cancels-unsupported");
    assert.equal(drained, false, "reveals must be preserved (not drained) when cancels are present");
  });
});
