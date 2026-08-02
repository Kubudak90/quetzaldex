import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Fr } from "@aztec/aztec.js/fields";
import { runOneClearingCycle, type DaemonContext } from "../src/daemon.js";
import { RevealQueue } from "../src/queue.js";
import { computeCi, replayOrderAcc } from "../src/validate.js";
import { SCALE } from "../src/buckets.js";

interface SubmitProbe {
  calls: number;
  lastArgs: unknown;
}

interface BucketBoundsT { sqrt_lower: bigint; sqrt_upper: bigint }
interface BucketStateT {
  reserve_a: bigint; reserve_b: bigint; liquidity: bigint;
  cum_fee_a_per_share: bigint; cum_fee_b_per_share: bigint;
}

function makeCtx(
  epochState: { epoch_id: number; closes_at_block: number; order_acc: Fr; order_count: number; cancel_acc: Fr; cancel_count: number },
  poolState: {
    reserve_a: bigint; reserve_b: bigint; lp_supply: bigint;
    current_sqrt_price?: bigint;
    bucketBounds?: BucketBoundsT[];
    bucketStates?: BucketStateT[];
  },
  blockNow: number,
): DaemonContext & { submitted: SubmitProbe; tmpDir: string } {
  const submitted: SubmitProbe = { calls: 0, lastArgs: null };
  const tmpDir = mkdtempSync(join(tmpdir(), "quetzal-daemon-test-"));
  return {
    queue: new RevealQueue(),
    snapshotsDir: tmpDir,
    getEpoch: async () => epochState,
    getPool: async () => poolState,
    getBlockNumber: async () => blockNow,
    runNargoExecute: async () => undefined,
    runBbProve: async () => Buffer.alloc(458 * 32), // v5 bb ZK UltraHonk proof size
    getVkBytes: async () => Buffer.alloc(115 * 32),
    submitClearing: async (args) => {
      submitted.calls += 1;
      submitted.lastArgs = args;
    },
    submitted,
    tmpDir,
  };
}

describe("daemon.runOneClearingCycle", () => {
  it("D1: when block >= closes_at_block + matching reveal, submits one clearing tx", async () => {
    const ci = await computeCi({
      owner: 0xa1n, side: false, amount_in: 1000n,
      limit_price: 2_000_000_000_000_000_000n, order_nonce: 0x42n,
      submitted_at_block: 5, path_len: 2, path: [0n, 0n, 0n],
    });
    const order_acc = await replayOrderAcc([ci]);

    const ctx = makeCtx(
      {
        epoch_id: 0,
        closes_at_block: 100,
        order_acc,
        order_count: 1,
        cancel_acc: new Fr(0n),
        cancel_count: 0,
      },
      {
        reserve_a: 1_000_000n, reserve_b: 2_000_000n, lp_supply: 1_000_000n,
        // Phase F2: the concentrated engine needs a funded bucket. One wide
        // bucket with the current price in-range so the lone buy swaps against it.
        current_sqrt_price: SCALE,
        bucketBounds: [{ sqrt_lower: SCALE / 100n, sqrt_upper: SCALE * 100n }],
        bucketStates: [{
          reserve_a: 1_000n * SCALE, reserve_b: 1_000n * SCALE, liquidity: SCALE,
          cum_fee_a_per_share: 0n, cum_fee_b_per_share: 0n,
        }],
      },
      100,
    );

    ctx.queue.enqueue({
      epoch_id: 0,
      order_nonce: new Fr(0x42n).toString(),
      side: false,
      amount_in: "1000",
      limit_price: "2000000000000000000",
      submitted_at_block: 5,
      owner: new Fr(0xa1n).toString(),
    });

    try {
      await runOneClearingCycle(ctx);
      assert.equal(ctx.submitted.calls, 1, "exactly one submitClearing call");
    } finally {
      rmSync(ctx.tmpDir, { recursive: true, force: true });
    }
  });

  it("D2: when block < closes_at_block, does NOT submit (epoch not yet at close)", async () => {
    const ctx = makeCtx(
      {
        epoch_id: 0,
        closes_at_block: 100,
        order_acc: new Fr(0n),
        order_count: 0,
        cancel_acc: new Fr(0n),
        cancel_count: 0,
      },
      { reserve_a: 1_000_000n, reserve_b: 2_000_000n, lp_supply: 1_000_000n },
      50,
    );

    try {
      await runOneClearingCycle(ctx);
      assert.equal(ctx.submitted.calls, 0, "no submit before close");
    } finally {
      rmSync(ctx.tmpDir, { recursive: true, force: true });
    }
  });

  it("D3: when reveal is tampered (order_acc mismatch), does NOT submit", async () => {
    // On-chain order_acc says there's 1 order, but the reveal in our queue is
    // tampered (amount_in flipped). validateReveals returns [] -> daemon skips.
    const ci_real = await computeCi({
      owner: 0xa1n, side: false, amount_in: 1000n,
      limit_price: 2_000_000_000_000_000_000n, order_nonce: 0x42n,
      submitted_at_block: 5, path_len: 2, path: [0n, 0n, 0n],
    });
    const order_acc = await replayOrderAcc([ci_real]);

    const ctx = makeCtx(
      {
        epoch_id: 0,
        closes_at_block: 100,
        order_acc,
        order_count: 1,
        cancel_acc: new Fr(0n),
        cancel_count: 0,
      },
      { reserve_a: 1_000_000n, reserve_b: 2_000_000n, lp_supply: 1_000_000n },
      100,
    );

    // Tampered amount_in
    ctx.queue.enqueue({
      epoch_id: 0,
      order_nonce: new Fr(0x42n).toString(),
      side: false,
      amount_in: "1001",     // wrong
      limit_price: "2000000000000000000",
      submitted_at_block: 5,
      owner: new Fr(0xa1n).toString(),
    });

    try {
      await runOneClearingCycle(ctx);
      assert.equal(ctx.submitted.calls, 0, "tampered reveal must not submit");
    } finally {
      rmSync(ctx.tmpDir, { recursive: true, force: true });
    }
  });
});
