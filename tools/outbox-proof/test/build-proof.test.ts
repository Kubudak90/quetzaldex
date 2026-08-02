import { test } from "node:test";
import { strict as assert } from "node:assert";
import { buildOutboxProof } from "../src/build-proof.js";

test("rejects non-0x l2TxHash", async () => {
  await assert.rejects(
    () => buildOutboxProof("http://localhost:8080", "abc", "0x" + "0".repeat(64)),
    /must be 0x-prefixed/,
  );
});

test("rejects malformed expectedContent (wrong length)", async () => {
  await assert.rejects(
    () => buildOutboxProof("http://localhost:8080", "0xabc", "0xdeadbeef"),
    /must be 0x \+ 32 bytes/,
  );
});

test("rejects expectedContent without 0x prefix", async () => {
  await assert.rejects(
    () => buildOutboxProof("http://localhost:8080", "0xabc", "0".repeat(66)),
    /must be 0x \+ 32 bytes/,
  );
});
