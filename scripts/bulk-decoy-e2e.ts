// Decoy-clear fix on-chain proof: place a BULK order (1 real + 2 decoys) via the
// fixed SDK, reveal ALL slots, and the aggregator should CLEAR the epoch (the real
// fills, decoys don't) instead of skipping it on replay-mismatch.
import { readFileSync } from "node:fs";
import { QuetzalClient } from "../sdk/src/index.js";

const s = JSON.parse(readFileSync("sub9-e2e-state.json", "utf8"));
const c = JSON.parse(readFileSync("quetzal.config.json", "utf8"));
const AGG = "https://aggregator.quetzaldex.xyz";

const cl = await QuetzalClient.connect({
  network: "alpha-testnet", nodeUrl: process.env.AZTEC_NODE_URL!,
  account: { type: "schnorr", secret: s.childSecret, salt: s.childSalt, signingKey: s.childSigningKey, proverEnabled: true, dataDirectory: "./sub9-e2e-pxe" },
  contracts: { orderbook: c.orderbook, tUSDC: c.tUSDC, tETH: c.tETH, tBTC: c.tBTC, admin: c.admin, pools: c.pools, aggregatorRegistry: c.aggregatorRegistry, treasury: c.treasury },
});
console.log("[bulk] maker:", cl.address.toString());

const input = { side: "buy" as const, amount: 300000n, limitPrice: 1_000_000_000_000_000n, path: ["tUSDC", "tETH"], decoyCount: 2 };
console.log("[bulk] funding private (shield 3x)...");
await cl.orders.fundPrivateForOrder({ side: input.side, amount: input.amount, limitPrice: input.limitPrice, path: input.path }, input.decoyCount);

console.log("[bulk] placeOrderBulk (1 real + 2 decoys)...");
const res = await cl.orders.placeOrderBulk(input);
console.log("[bulk] placed: real=0x" + res.realNonce.toString(16).slice(0, 12) + " decoys=" + res.decoyNonces.length + " epoch=" + res.epoch + " reveals=" + res.reveals.length);

for (const r of res.reveals) {
  const ok = await cl.aggregator.directReveal(AGG, {
    epoch_id: res.epoch, order_nonce: "0x" + r.orderNonce.toString(16), side: r.side,
    amount_in: r.amountIn.toString(), limit_price: r.limitPrice.toString(),
    submitted_at_block: res.submittedAtBlock, owner: cl.address.toString(),
    submission_tx_hash: res.txHash, path_len: r.pathLen, path: r.path,
  });
  const kind = r.orderNonce === res.realNonce ? "REAL " : "decoy";
  console.log("[bulk]   revealed " + kind + " 0x" + r.orderNonce.toString(16).slice(0, 10) + " limit=" + r.limitPrice.toString().slice(0, 8) + " ok=" + ok);
}
console.log("[bulk] ALL " + res.reveals.length + " REVEALED for epoch " + res.epoch + " — aggregator should CLEAR (not skip:replay-mismatch)");
await cl.stop?.();
