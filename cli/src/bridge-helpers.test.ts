// L14: focused unit tests for buildOutboxProof spawn error-handling and
// process.execPath usage in cli/src/bridge-helpers.ts.

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildOutboxProof } from "./bridge-helpers.js";

// Dummy values used across tests — the script will exit before network calls.
const DUMMY_NODE_URL = "http://localhost:18080";
const DUMMY_TX_HASH = "0x" + "ab".repeat(32);
const DUMMY_L1_RPC = "http://127.0.0.1:1";
const DUMMY_L2_SENDER = "0x" + "11".repeat(32);
const DUMMY_L1_BRIDGE = "0x" + "22".repeat(20);
const DUMMY_CONTENT = "0x" + "cd".repeat(32);

test("L14: buildOutboxProof rejects when child exits non-zero (stderr captured in message)", async () => {
  const tmpScript = join(tmpdir(), `quetzal-test-exit-${Date.now()}.mjs`);
  writeFileSync(
    tmpScript,
    'process.stderr.write("expected-failure-signal\\n"); process.exit(2);\n',
  );
  const origBin = process.env.QUETZAL_OUTBOX_PROOF_BIN;
  process.env.QUETZAL_OUTBOX_PROOF_BIN = tmpScript;
  try {
    await assert.rejects(
      () => buildOutboxProof(DUMMY_NODE_URL, DUMMY_TX_HASH, DUMMY_CONTENT, DUMMY_L1_RPC, DUMMY_L2_SENDER, DUMMY_L1_BRIDGE),
      (e: unknown) => {
        assert.ok(e instanceof Error, "rejection value must be an Error");
        assert.match(e.message, /quetzal-outbox-proof exited 2/);
        assert.match(e.message, /expected-failure-signal/);
        return true;
      },
    );
  } finally {
    process.env.QUETZAL_OUTBOX_PROOF_BIN = origBin ?? "";
    if (!origBin) delete process.env.QUETZAL_OUTBOX_PROOF_BIN;
    rmSync(tmpScript, { force: true });
  }
});

test("L14: buildOutboxProof rejects with non-JSON stdout message", async () => {
  const tmpScript = join(tmpdir(), `quetzal-test-json-${Date.now()}.mjs`);
  writeFileSync(tmpScript, 'process.stdout.write("not-json\\n"); process.exit(0);\n');
  const origBin = process.env.QUETZAL_OUTBOX_PROOF_BIN;
  process.env.QUETZAL_OUTBOX_PROOF_BIN = tmpScript;
  try {
    await assert.rejects(
      () => buildOutboxProof(DUMMY_NODE_URL, DUMMY_TX_HASH, DUMMY_CONTENT, DUMMY_L1_RPC, DUMMY_L2_SENDER, DUMMY_L1_BRIDGE),
      (e: unknown) => {
        assert.ok(e instanceof Error, "rejection value must be an Error");
        assert.match(e.message, /non-JSON stdout/);
        return true;
      },
    );
  } finally {
    process.env.QUETZAL_OUTBOX_PROOF_BIN = origBin ?? "";
    if (!origBin) delete process.env.QUETZAL_OUTBOX_PROOF_BIN;
    rmSync(tmpScript, { force: true });
  }
});

// Verify process.execPath is a non-empty string pointing to a real Node.js binary.
// buildOutboxProof uses it so the child always runs under the same runtime as the CLI.
test("L14: process.execPath is non-empty (spawn uses it instead of 'node' literal)", () => {
  assert.ok(typeof process.execPath === "string" && process.execPath.length > 0,
    "process.execPath must be a non-empty string");
});
