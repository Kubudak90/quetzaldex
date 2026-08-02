// sdk/src/util/outbox-proof.test.ts
//
// Note: task spec wrote these as vitest tests, but @quetzal/sdk uses node:test
// (see package.json `test` script). Translating 1:1 — same 3 cases, same
// expected error type, identical assertions.
//
// (Live `computeL2ToL1MembershipWitness` execution requires a real Aztec node
// + a real finalised L2 tx; that path is exercised in Phase D manual E2E.)
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { buildOutboxProof, OutboxProofShapeError } from "./outbox-proof.js";

describe("buildOutboxProof", () => {
  test("rejects malformed l2TxHash", async () => {
    await assert.rejects(
      () =>
        buildOutboxProof(
          "https://node.example",
          "not-hex",
          "0x" + "11".repeat(32),
        ),
      OutboxProofShapeError,
    );
  });

  test("rejects malformed expectedContent (wrong length)", async () => {
    await assert.rejects(
      () =>
        buildOutboxProof(
          "https://node.example",
          "0x" + "11".repeat(32),
          "0xshort",
        ),
      OutboxProofShapeError,
    );
  });

  test("rejects expectedContent without 0x prefix", async () => {
    await assert.rejects(
      () =>
        buildOutboxProof(
          "https://node.example",
          "0x" + "11".repeat(32),
          "11".repeat(32),
        ),
      OutboxProofShapeError,
    );
  });

  test("rejects malformed l2TxHash (wrong length)", async () => {
    await assert.rejects(
      () =>
        buildOutboxProof(
          "https://node.example",
          "0x1234",
          "0x" + "11".repeat(32),
        ),
      OutboxProofShapeError,
    );
  });
});
