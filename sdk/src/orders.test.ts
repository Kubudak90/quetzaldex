// sdk/src/orders.test.ts
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { Fr } from "@aztec/aztec.js/fields";
import { validatePlaceOrderInput, validateBulkInput, MAX_ORDERS_PER_BULK, MAX_DECOYS, rethrowSubmitError, hopProofToClaimArgs } from "./orders.js";
import { OrderError } from "./errors.js";

describe("validatePlaceOrderInput", () => {
  test("rejects amount <= 0", () => {
    assert.throws(
      () => validatePlaceOrderInput({ side: "sell", amount: 0n, limitPrice: 5000n, path: ["tUSDC", "tETH"] }),
      OrderError,
    );
  });
  test("rejects limitPrice <= 0", () => {
    assert.throws(
      () => validatePlaceOrderInput({ side: "sell", amount: 1n, limitPrice: 0n, path: ["tUSDC", "tETH"] }),
      OrderError,
    );
  });
  test("rejects path length < 2", () => {
    assert.throws(
      () => validatePlaceOrderInput({ side: "sell", amount: 1n, limitPrice: 5000n, path: ["tUSDC"] }),
      OrderError,
    );
  });
  test("rejects path length > 3", () => {
    assert.throws(
      () => validatePlaceOrderInput({ side: "sell", amount: 1n, limitPrice: 5000n, path: ["a", "b", "c", "d"] }),
      OrderError,
    );
  });
  test("accepts valid 2-hop", () => {
    assert.doesNotThrow(
      () => validatePlaceOrderInput({ side: "sell", amount: 1n, limitPrice: 5000n, path: ["tUSDC", "tETH"] }),
    );
  });
});

describe("validateBulkInput", () => {
  test("rejects decoyCount > 4 (Sub-6a A5 cap)", () => {
    assert.throws(
      () => validateBulkInput({ side: "sell", amount: 1n, limitPrice: 5000n, path: ["tUSDC", "tETH"], decoyCount: 5 }),
      OrderError,
    );
  });
  test("rejects decoyCount < 0", () => {
    assert.throws(
      () => validateBulkInput({ side: "sell", amount: 1n, limitPrice: 5000n, path: ["tUSDC", "tETH"], decoyCount: -1 }),
      OrderError,
    );
  });
  test("accepts decoyCount=0 (no decoys = single-order semantics)", () => {
    assert.doesNotThrow(
      () => validateBulkInput({ side: "sell", amount: 1n, limitPrice: 5000n, path: ["tUSDC", "tETH"], decoyCount: 0 }),
    );
  });
  test("accepts decoyCount=4 (max anonymity set)", () => {
    assert.doesNotThrow(
      () => validateBulkInput({ side: "sell", amount: 1n, limitPrice: 5000n, path: ["tUSDC", "tETH"], decoyCount: 4 }),
    );
  });
});

describe("constants", () => {
  test("MAX_ORDERS_PER_BULK = 5 (Sub-6a A5 downsize)", () => {
    assert.equal(MAX_ORDERS_PER_BULK, 5);
  });
  test("MAX_DECOYS = 4 (MAX_ORDERS_PER_BULK - 1)", () => {
    assert.equal(MAX_DECOYS, 4);
  });
});

describe("rethrowSubmitError — node 'Invalid proof' mapping", () => {
  const expectMapped = (msg: string) => {
    assert.throws(
      () => rethrowSubmitError(new Error(msg)),
      (e: unknown) => {
        assert.ok(e instanceof OrderError, "maps to OrderError");
        assert.equal((e as OrderError).code, "ESCROW_FAILED");
        // Tightly bind to the mapped message: it must restate the rejection AND
        // carry the hedge — not just contain a generic word.
        assert.match((e as OrderError).message, /rejected this transaction's proof/);
        assert.match((e as OrderError).message, /has not yet been isolated/);
        return true;
      },
    );
  };

  test("'Invalid tx: Invalid proof' → actionable ESCROW_FAILED", () => {
    expectMapped("Invalid tx: Invalid proof");
  });
  test("matches case-insensitively / embedded", () => {
    expectMapped("Error: [Error: INVALID PROOF]");
  });
  test("preserves the original message as cause", () => {
    const orig = new Error("Invalid proof");
    assert.throws(
      () => rethrowSubmitError(orig),
      (e: unknown) => (e as OrderError).cause === orig,
    );
  });
  test("passes through unrelated errors unchanged", () => {
    const orig = new Error("epoch closed");
    assert.throws(
      () => rethrowSubmitError(orig),
      (e: unknown) => {
        assert.equal(e, orig); // same instance, not wrapped
        assert.ok(!(e instanceof OrderError));
        return true;
      },
    );
  });
  test("non-Error inputs become an Error (not silently swallowed)", () => {
    assert.throws(() => rethrowSubmitError("weird string"), Error);
  });
  // L10: narrowed to /invalid\s*proof/i — non-proof "Invalid tx:" rejections must
  // pass through unchanged so the caller sees the actionable original reason.
  test("'Invalid tx: Insufficient fee payer balance' passes through unchanged (not mapped)", () => {
    const orig = new Error("Invalid tx: Insufficient fee payer balance");
    assert.throws(
      () => rethrowSubmitError(orig),
      (e: unknown) => {
        assert.equal(e, orig, "must rethrow the original instance, not wrap it");
        assert.ok(!(e instanceof OrderError), "must NOT be an OrderError");
        return true;
      },
    );
  });
});

describe("hopProofToClaimArgs (Sub-4 browser claim marshalling)", () => {
  const NONCE = "0x007e9a2151e9f1fbcf14b3ead589e99a1b6f6bb1be00b2d652edb01767fc4a19";
  const leaf = {
    order_nonce: NONCE,
    hop_index: 0,
    amount_out: "99699958",
    pool_id: 0,
    leaf_index: 0,
    sibling_path: ["0x01", "0x02", "0x03", "0x04", "0x05", "0x06"],
  };

  test("marshals a hop-proof leaf into the 7 typed claim_fill args (mirrors CLI)", () => {
    const args = hopProofToClaimArgs(leaf, 11);
    assert.equal(args.epochId, 11);
    assert.equal(args.orderNonce.toString(), NONCE);
    assert.equal(args.hopIndex, 0n);
    assert.equal(args.amountOut, 99699958n);
    assert.equal(args.poolId, 0n);
    assert.equal(args.leafIndex, 0n);
    assert.equal(args.siblingPath.length, 6);
    assert.ok(args.siblingPath.every((s) => s instanceof Fr));
    assert.equal(args.siblingPath[0]!.toString(), new Fr(1n).toString());
  });

  test("rejects a sibling path that isn't depth-6", () => {
    assert.throws(() => hopProofToClaimArgs({ ...leaf, sibling_path: ["0x01"] }, 11), OrderError);
  });
});
