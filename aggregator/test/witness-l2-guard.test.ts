/**
 * L2 unit tests: buildClearingWitnessMultiPair input-validation guards.
 * Verifies the ported checks (order count, cancel count, max-per-epoch, and
 * unknown fill nonce) that were missing from the multi-pair builder.
 */
import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { buildClearingWitnessMultiPair } from "../src/witness.js";

/** Minimal valid args with 1 order, 0 cancels, 0 pools, 0 fills. */
function minArgs(override: Record<string, unknown> = {}) {
  return {
    epoch: { order_acc: 1n, cancel_acc: 0n, order_count: 1, cancel_count: 0 },
    orders: [{ side: false, amount_in: 0n, limit_price: 0n, order_nonce: 42n, submitted_at_block: 1, owner: 0n }],
    cancellationIndices: [],
    perPoolClearings: [],
    fills: [],
    ...override,
  };
}

describe("L2 buildClearingWitnessMultiPair input-validation guards", () => {
  it("L2-A: orders.length !== epoch.order_count throws", async () => {
    await assert.rejects(
      () => buildClearingWitnessMultiPair({
        epoch: { order_acc: 0n, cancel_acc: 0n, order_count: 2, cancel_count: 0 },
        orders: [{ side: false, amount_in: 0n, limit_price: 0n, order_nonce: 1n, submitted_at_block: 1, owner: 0n }],
        cancellationIndices: [],
        perPoolClearings: [],
        fills: [],
      }),
      /order_count/,
      "should throw when orders.length != epoch.order_count",
    );
  });

  it("L2-B: orders.length > maxPerEpoch throws", async () => {
    // maxOrders defaults to MAX_ORDERS_PER_EPOCH = 32; pass maxOrders=1 to trigger the cap.
    const orders = Array.from({ length: 2 }, (_, i) => ({
      side: false, amount_in: 0n, limit_price: 0n,
      order_nonce: BigInt(i + 1), submitted_at_block: 1, owner: 0n,
    }));
    await assert.rejects(
      () => buildClearingWitnessMultiPair({
        epoch: { order_acc: 0n, cancel_acc: 0n, order_count: 2, cancel_count: 0 },
        orders,
        cancellationIndices: [],
        perPoolClearings: [],
        fills: [],
        maxOrders: 1,
      }),
      /maxPerEpoch/,
      "should throw when orders.length > maxPerEpoch",
    );
  });

  it("L2-C: cancellationIndices.length !== epoch.cancel_count throws", async () => {
    await assert.rejects(
      () => buildClearingWitnessMultiPair({
        epoch: { order_acc: 0n, cancel_acc: 0n, order_count: 1, cancel_count: 2 },
        orders: [{ side: false, amount_in: 0n, limit_price: 0n, order_nonce: 1n, submitted_at_block: 1, owner: 0n }],
        cancellationIndices: [0],  // length 1, but cancel_count = 2
        perPoolClearings: [],
        fills: [],
      }),
      /cancel_count/,
      "should throw when cancellationIndices.length != epoch.cancel_count",
    );
  });

  it("L2-D: fill with unknown orderNonce throws (not found in orders)", async () => {
    // order_nonce 42n is in orders, but fill uses nonce 99n which is not.
    await assert.rejects(
      () => buildClearingWitnessMultiPair({
        epoch: { order_acc: 1n, cancel_acc: 0n, order_count: 1, cancel_count: 0 },
        orders: [{ side: false, amount_in: 0n, limit_price: 0n, order_nonce: 42n, submitted_at_block: 1, owner: 0n }],
        cancellationIndices: [],
        perPoolClearings: [],
        fills: [{ orderNonce: 99n, hop_index: 0, amountOut: 100n, pool_id: 0, owner: 0n }],
      }),
      /not found in orders/,
      "should throw when fill orderNonce is not in orders",
    );
  });

  it("L2-E: fill with matching orderNonce does NOT throw (positive case)", async () => {
    // Fill nonce 42n exists in orders — must succeed.
    await assert.doesNotReject(
      () => buildClearingWitnessMultiPair({
        epoch: { order_acc: 1n, cancel_acc: 0n, order_count: 1, cancel_count: 0 },
        orders: [{ side: false, amount_in: 0n, limit_price: 0n, order_nonce: 42n, submitted_at_block: 1, owner: 0n }],
        cancellationIndices: [],
        perPoolClearings: [],
        fills: [{ orderNonce: 42n, hop_index: 0, amountOut: 100n, pool_id: 0, owner: 0n }],
      }),
      "fill with known nonce should not throw",
    );
  });
});
