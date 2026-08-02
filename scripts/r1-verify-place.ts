// R1 on-chain verification — place a SINGLE buy order against the new orderbook
// and reveal it to the LOCAL aggregator (http://localhost:3099). The local agg
// (my R1+R6+SETTLE-INV code) should clear the epoch with the new owner-bound leaf
// + new clearing VK, proving R1 works on-chain. Saves the order to
// sub9-e2e-state.json so scripts/claim-fill-e2e.ts can redeem it.
import { readFileSync, writeFileSync } from "node:fs";
import { QuetzalClient } from "../sdk/src/index.js";

const s = JSON.parse(readFileSync("sub9-e2e-state.json", "utf8"));
const c = JSON.parse(readFileSync("quetzal.config.json", "utf8"));
const AGG = process.env.AGG ?? "http://localhost:3099";

const cl = await QuetzalClient.connect({
  network: "alpha-testnet", nodeUrl: process.env.AZTEC_NODE_URL!,
  account: { type: "schnorr", secret: s.childSecret, salt: s.childSalt, signingKey: s.childSigningKey, proverEnabled: true, dataDirectory: "./sub9-e2e-pxe" },
  contracts: { orderbook: c.orderbook, tUSDC: c.tUSDC, tETH: c.tETH, tBTC: c.tBTC, admin: c.admin, pools: c.pools, aggregatorRegistry: c.aggregatorRegistry, treasury: c.treasury },
});
console.log("[r1] maker:", cl.address.toString(), "orderbook:", c.orderbook.slice(0, 14), "agg:", AGG);

const input = { side: "buy" as const, amount: 300000n, limitPrice: 1_000_000_000_000_000n, path: ["tUSDC", "tETH"] };
console.log("[r1] funding private (shield)...");
await cl.orders.fundPrivateForOrder(input, 0);

console.log("[r1] placeOrder (single, no decoys)...");
const res = await cl.orders.placeOrder(input);
console.log("[r1] placed: nonce=0x" + res.orderNonce.toString(16).slice(0, 14) + " epoch=" + res.epoch + " block=" + res.blockNumber + " submittedAtBlock=" + res.submittedAtBlock);

const ok = await cl.aggregator.directReveal(AGG, {
  epoch_id: res.epoch, order_nonce: "0x" + res.orderNonce.toString(16), side: true,
  amount_in: input.amount.toString(), limit_price: input.limitPrice.toString(),
  submitted_at_block: res.submittedAtBlock, owner: cl.address.toString(),
  submission_tx_hash: res.txHash, path_len: res.path_len, path: res.path,
});
console.log("[r1] revealed to local agg ok=" + ok);

s.submittedOrder = {
  txHash: res.txHash, nonce: "0x" + res.nonce.toString(16), orderNonce: "0x" + res.orderNonce.toString(16),
  epoch: res.epoch, blockNumber: res.blockNumber, submittedAtBlock: res.submittedAtBlock,
  path_len: res.path_len, path: res.path,
};
writeFileSync("sub9-e2e-state.json", JSON.stringify(s, null, 2));
console.log("[r1] saved submittedOrder to sub9-e2e-state.json — epoch " + res.epoch + " should CLEAR on the local agg");
await cl.stop?.();
