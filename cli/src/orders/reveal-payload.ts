import { Fr } from "@aztec/aztec.js/fields";
import type { PlaceOrderResult, BulkPlaceOrderResult } from "@quetzal/sdk";
import type { RevealPayload } from "../reveal.js";

// Reveal-payload builders shared by the `order` command's single and bulk paths.
//
// H6/H7: the aggregator folds submitted_at_block AND the canonical side into c_i
// (aggregator/src/validate.ts), so a reveal that carries 0 for the anchor block or
// the raw (un-canonicalized) side makes the order_acc replay mismatch — which is
// all-or-nothing, so it strands EVERY order in the epoch. These builders take the
// values straight from the SDK place-order result, which read them back from the
// on-chain OrderNote, so the reveal always matches what the contract bound.

/** Single-order reveal. `amount`/`limitPrice` are the (side-agnostic) input values;
 *  side/submitted_at_block/path come from the canonical SDK result. */
export function buildOrderReveal(
  result: PlaceOrderResult,
  input: { amount: bigint; limitPrice: bigint },
  owner: string,
): RevealPayload {
  return {
    epoch_id: result.epoch,
    order_nonce: new Fr(result.orderNonce).toString(),
    side: result.side,
    amount_in: input.amount.toString(),
    limit_price: input.limitPrice.toString(),
    submitted_at_block: result.submittedAtBlock,
    owner,
    path_len: result.path_len,
    path: result.path,
  };
}

/** One reveal per used slot (real + every decoy), in the order_nonce-sorted order
 *  the epoch order_acc folded them. The caller MUST broadcast all of them. */
export function buildBulkReveals(result: BulkPlaceOrderResult, owner: string): RevealPayload[] {
  return result.reveals.map((r) => ({
    epoch_id: result.epoch,
    order_nonce: new Fr(r.orderNonce).toString(),
    side: r.side,
    amount_in: r.amountIn.toString(),
    limit_price: r.limitPrice.toString(),
    submitted_at_block: result.submittedAtBlock,
    owner,
    path_len: r.pathLen as 2 | 3,
    path: r.path,
  }));
}
