/**
 * Group B LOW hardening tests (2026-07-04)
 *
 *   L4 — bridgeProof/bridgeVk throw on field-count mismatch (clearing-cycle.ts + daemon.ts)
 *   L5 — findEpochForNonceHop uses in-memory index; writeHopSnapshot populates it
 *   L6 — RELAYER_MODE block in daemon.ts is guarded by main-module check (structural/import test)
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, unlinkSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { Fr } from "@aztec/aztec.js/fields";

// ── L4: bridgeProof / bridgeVk shape assertions ────────────────────────────
//
// The functions are module-private, so we exercise them indirectly through
// runOneClearingCycle (daemon.ts) by providing proof/vk buffers with wrong
// sizes and asserting the cycle throws. The clearing-cycle.ts copies contain
// identical code; only the daemon.ts entrypoint is exercised here (adding a
// separate MP harness would duplicate test setup without additional coverage).
import { runOneClearingCycle, type DaemonContext } from "../src/daemon.js";
import { RevealQueue } from "../src/queue.js";
import { computeCi, replayOrderAcc } from "../src/validate.js";
import { SCALE } from "../src/buckets.js";

// ── L5: snapshot index ─────────────────────────────────────────────────────
import {
  writeHopSnapshot,
  findEpochForNonceHop,
  _resetHopIndexForTest,
  type HopSnapshotInput,
} from "../src/snapshot.js";
import { buildHopFillsTree } from "../src/merkle.js";

// ── Helpers ────────────────────────────────────────────────────────────────

/** Build a minimal DaemonContext whose runBbProve returns a buffer of
 *  `proofFields` 32-byte fields and getVkBytes returns `vkFields` fields. */
function makeBridgeCtx(
  epochState: { epoch_id: number; closes_at_block: number; order_acc: Fr; order_count: number; cancel_acc: Fr; cancel_count: number },
  proofFields: number,
  vkFields: number,
  tmpDir: string,
): DaemonContext {
  return {
    queue: new RevealQueue(),
    snapshotsDir: tmpDir,
    getEpoch: async () => epochState,
    getPool: async () => ({
      reserve_a: 1_000_000n,
      reserve_b: 2_000_000n,
      lp_supply: 1_000_000n,
      current_sqrt_price: SCALE,
      bucketBounds: [{ sqrt_lower: SCALE / 100n, sqrt_upper: SCALE * 100n }],
      bucketStates: [{
        reserve_a: 1_000n * SCALE, reserve_b: 1_000n * SCALE, liquidity: SCALE,
        cum_fee_a_per_share: 0n, cum_fee_b_per_share: 0n,
      }],
    }),
    getBlockNumber: async () => epochState.closes_at_block, // at close
    runNargoExecute: async () => undefined,
    runBbProve: async () => Buffer.alloc(proofFields * 32),
    getVkBytes: async () => Buffer.alloc(vkFields * 32),
    submitClearing: async () => undefined,
  };
}

// ── L4 tests ───────────────────────────────────────────────────────────────

describe("L4: bridgeProof/bridgeVk — exact field-count assert (daemon.ts)", () => {
  it("L4-D1: proof buffer with wrong size throws with clear message", async () => {
    // Build a real epoch with one order so the cycle proceeds to runBbProve.
    const ci = await computeCi({
      owner: 0xa1n, side: false, amount_in: 1000n,
      limit_price: 2_000_000_000_000_000_000n, order_nonce: 0x42n,
      submitted_at_block: 5, path_len: 2, path: [0n, 0n, 0n],
    });
    const order_acc = await replayOrderAcc([ci]);
    const epochState = {
      epoch_id: 0, closes_at_block: 100, order_acc, order_count: 1,
      cancel_acc: new Fr(0n), cancel_count: 0,
    };

    const tmpDir = mkdtempSync(join(tmpdir(), "qz-b-l4-"));
    const ctx = makeBridgeCtx(epochState, 457 /* wrong: expected 458 */, 115, tmpDir);
    ctx.queue.enqueue({
      epoch_id: 0,
      order_nonce: new Fr(0x42n).toString(),
      side: false, amount_in: "1000",
      limit_price: "2000000000000000000",
      submitted_at_block: 5,
      owner: new Fr(0xa1n).toString(),
    });

    try {
      await assert.rejects(
        () => runOneClearingCycle(ctx),
        (err: Error) => {
          assert.ok(
            /proof has 457 fields, expected 458/.test(err.message),
            `unexpected message: ${err.message}`,
          );
          return true;
        },
        "expected bridgeProof to throw on wrong field count",
      );
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("L4-D2: vk buffer with wrong size throws with clear message", async () => {
    const ci = await computeCi({
      owner: 0xa2n, side: false, amount_in: 1000n,
      limit_price: 2_000_000_000_000_000_000n, order_nonce: 0x43n,
      submitted_at_block: 5, path_len: 2, path: [0n, 0n, 0n],
    });
    const order_acc = await replayOrderAcc([ci]);
    const epochState = {
      epoch_id: 0, closes_at_block: 100, order_acc, order_count: 1,
      cancel_acc: new Fr(0n), cancel_count: 0,
    };

    const tmpDir = mkdtempSync(join(tmpdir(), "qz-b-l4-vk-"));
    // Correct proof size (500), wrong vk size (114 instead of 115).
    const ctx = makeBridgeCtx(epochState, 458, 114 /* wrong: expected 115 */, tmpDir);
    ctx.queue.enqueue({
      epoch_id: 0,
      order_nonce: new Fr(0x43n).toString(),
      side: false, amount_in: "1000",
      limit_price: "2000000000000000000",
      submitted_at_block: 5,
      owner: new Fr(0xa2n).toString(),
    });

    try {
      await assert.rejects(
        () => runOneClearingCycle(ctx),
        (err: Error) => {
          assert.ok(
            /vk has 114 fields, expected 115/.test(err.message),
            `unexpected message: ${err.message}`,
          );
          return true;
        },
        "expected bridgeVk to throw on wrong field count",
      );
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("L4-D3: correct sizes (458/115) do NOT throw", async () => {
    const ci = await computeCi({
      owner: 0xa3n, side: false, amount_in: 1000n,
      limit_price: 2_000_000_000_000_000_000n, order_nonce: 0x44n,
      submitted_at_block: 5, path_len: 2, path: [0n, 0n, 0n],
    });
    const order_acc = await replayOrderAcc([ci]);
    const epochState = {
      epoch_id: 0, closes_at_block: 100, order_acc, order_count: 1,
      cancel_acc: new Fr(0n), cancel_count: 0,
    };

    const tmpDir = mkdtempSync(join(tmpdir(), "qz-b-l4-ok-"));
    const submitCalls: number[] = [];
    const ctx = makeBridgeCtx(epochState, 458, 115, tmpDir);
    (ctx as DaemonContext & { submitClearing: (a: unknown) => Promise<void> }).submitClearing =
      async (_a) => { submitCalls.push(1); };
    ctx.queue.enqueue({
      epoch_id: 0,
      order_nonce: new Fr(0x44n).toString(),
      side: false, amount_in: "1000",
      limit_price: "2000000000000000000",
      submitted_at_block: 5,
      owner: new Fr(0xa3n).toString(),
    });

    try {
      await runOneClearingCycle(ctx);
      assert.equal(submitCalls.length, 1, "should have called submitClearing once");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ── L5 tests ───────────────────────────────────────────────────────────────

describe("L5: findEpochForNonceHop — in-memory index populated by writeHopSnapshot", () => {
  beforeEach(() => {
    // Reset the module-level index so each test starts clean.
    _resetHopIndexForTest();
  });

  it("L5-1: after writeHopSnapshot, lookup succeeds without directory rescan", async () => {
    const dir = mkdtempSync(join(tmpdir(), "qz-b-l5-"));
    try {
      const nonce = new Fr(0xdeadbeefn);
      const nonceHex = nonce.toString();

      const tree = await buildHopFillsTree(
        [{ owner: new Fr(0xa1n), order_nonce: nonce, hop_index: 0, amount_out: 999n, pool_id: 0 }],
        64,
      );
      const snap: HopSnapshotInput = {
        epoch_id: 7,
        fills_root: tree.root.toString(),
        hop_fills: [{ order_nonce: nonceHex, hop_index: 0, amount_out: "999", pool_id: 0, leaf_index: 0 }],
        paths: tree.paths,
      };
      writeHopSnapshot(dir, snap);

      // Delete the file from disk so a rescan would return null.
      const filePath = join(dir, "epoch-7.json");
      assert.ok(existsSync(filePath), "snapshot file should exist after write");
      unlinkSync(filePath);
      assert.ok(!existsSync(filePath), "snapshot file should be deleted");

      // findEpochForNonceHop must still return 7 from the in-memory index.
      const result = findEpochForNonceHop(dir, nonceHex);
      assert.equal(result, 7, "should return epoch_id from in-memory index without filesystem rescan");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("L5-2: zero-amount fills are NOT indexed (not claimable)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "qz-b-l5-zero-"));
    try {
      const nonce = new Fr(0xcafebaben);
      const nonceHex = nonce.toString();

      // Build a snapshot where the fill has amount_out = "0" (decoy / unfilled).
      const snap: HopSnapshotInput = {
        epoch_id: 3,
        fills_root: new Fr(0n).toString(),
        hop_fills: [{ order_nonce: nonceHex, hop_index: 0, amount_out: "0", pool_id: 0, leaf_index: 0 }],
        paths: new Map(),
      };
      writeHopSnapshot(dir, snap);

      // Should not be found (zero-amount fills are not indexed).
      const result = findEpochForNonceHop(dir, nonceHex);
      assert.equal(result, null, "zero-amount fill must not be indexed");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("L5-3: nonce not present in any snapshot returns null", () => {
    const dir = mkdtempSync(join(tmpdir(), "qz-b-l5-null-"));
    try {
      const result = findEpochForNonceHop(dir, new Fr(0x999n).toString());
      assert.equal(result, null, "unknown nonce should return null");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── L6 real child-process test ────────────────────────────────────────────
//
// The guard `import.meta.url === pathToFileURL(process.argv[1]).href` in
// daemon.ts prevents the RELAYER_MODE block from firing when daemon.ts is
// imported as a library module rather than run as main. A re-import of an
// already-cached ESM module never re-executes top-level code, so any test
// that simply re-imports within the same process is vacuous.
//
// This test spawns a FRESH child process whose process.argv[1] is a temp
// entry script (not daemon.ts itself), imports daemon.ts inside that script,
// and asserts the child:
//   (a) exits 0 — no crash / no process.exit(1) from missing L1 config
//   (b) prints "IMPORTED_CLEAN" — the import completes and execution continues
//   (c) does NOT print the relayer startup line — the RELAYER_MODE block did
//       not fire (if the guard were removed it would fire and attempt to start
//       the relayer, throwing on missing L1_RPC_URL and exiting 1).

describe("L6: daemon.ts RELAYER_MODE block is guarded by main-module check", () => {
  it("L6-1: child process with RELAYER_MODE=1 imports daemon.ts cleanly and exits 0", async () => {
    // Compute the absolute path to daemon.ts relative to this test file.
    const daemonAbsPath = fileURLToPath(new URL("../src/daemon.ts", import.meta.url));
    const entryPath = join(tmpdir(), `qz-l6-entry-${process.pid}.ts`);

    // Entry script: process.argv[1] = entryPath (NOT daemon.ts), so the guard
    // `import.meta.url === pathToFileURL(process.argv[1]).href` inside daemon.ts
    // evaluates to false even with RELAYER_MODE=1.
    writeFileSync(
      entryPath,
      `import ${JSON.stringify(daemonAbsPath)};\nconsole.log("IMPORTED_CLEAN");\n`,
    );

    const { stdout, stderr, code } = await new Promise<{
      stdout: string;
      stderr: string;
      code: number | null;
    }>((resolve) => {
      const child = spawn(
        process.execPath,
        ["--import", "tsx", entryPath],
        { env: { ...process.env, RELAYER_MODE: "1" } },
      );
      let out = "", err = "";
      child.stdout.on("data", (d: Buffer) => { out += d.toString(); });
      child.stderr.on("data", (d: Buffer) => { err += d.toString(); });
      child.on("close", (c) => resolve({ stdout: out, stderr: err, code: c }));
    });

    try { rmSync(entryPath, { force: true }); } catch { /* best-effort cleanup */ }

    assert.equal(
      code, 0,
      `child exited ${code} — expected 0\nstdout:\n${stdout}\nstderr:\n${stderr}`,
    );
    assert.ok(
      stdout.includes("IMPORTED_CLEAN"),
      `expected "IMPORTED_CLEAN" in stdout — import did not complete\nstdout:\n${stdout}\nstderr:\n${stderr}`,
    );
    // The startup log emitted inside the RELAYER_MODE block (see daemon.ts).
    // If the main-module guard fires, this string appears and the child exits 1.
    assert.ok(
      !stdout.includes("daemon: RELAYER_MODE=1"),
      `relayer startup log appeared — main-module guard may be broken\nstdout:\n${stdout}`,
    );
  });
});
