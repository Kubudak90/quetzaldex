// Recover the orphaned place (mined-but-unsaved due to response code-19): read the
// maker's OrderNotes + current epoch so we can re-reveal the order to the agg.
// REVEAL=1 also reveals the best-match orphan (amount_in=300000, newest) to AGG.
import { readFileSync } from "node:fs";
import { QuetzalClient } from "../sdk/src/index.js";
const s = JSON.parse(readFileSync("sub9-e2e-state.json", "utf8"));
const c = JSON.parse(readFileSync("quetzal.config.json", "utf8"));
const AGG = process.env.AGG ?? "http://localhost:3099";
const cl = await QuetzalClient.connect({
  network: "alpha-testnet", nodeUrl: process.env.AZTEC_NODE_URL!,
  account: { type: "schnorr", secret: s.childSecret, salt: s.childSalt, signingKey: s.childSigningKey, proverEnabled: false, dataDirectory: "./sub9-e2e-pxe" },
  contracts: { orderbook: c.orderbook, tUSDC: c.tUSDC, tETH: c.tETH, tBTC: c.tBTC, admin: c.admin, pools: c.pools, aggregatorRegistry: c.aggregatorRegistry, treasury: c.treasury },
});
console.log("maker:", cl.address.toString());
const reads = (cl as any).reads;
const orders = await reads.getOrders();
console.log("getOrders count:", orders.length);
for (const o of orders) console.log(`  nonce=0x${o.nonce.toString(16)} side=${o.side} amount_in=${o.amount_in} limit=${o.limit_price} submitted_at_block=${o.submitted_at_block}`);
const ep = await reads.getCurrentEpoch();
console.log("currentEpoch:", JSON.stringify(ep, (_k, v) => typeof v === "bigint" ? v.toString() : v));

const cands = orders.filter((o: any) => o.amount_in === 300000n).sort((a: any, b: any) => Number(b.submitted_at_block - a.submitted_at_block));
const orphan = cands[0];
console.log("ORPHAN pick:", orphan ? `nonce=0x${orphan.nonce.toString(16)} submitted_at_block=${orphan.submitted_at_block}` : "NONE");

if (process.env.REVEAL === "1" && orphan) {
  const epochId = Number(process.env.EPOCH_ID ?? ep.epoch_id);
  console.log(`revealing orphan to ${AGG} for epoch ${epochId} ...`);
  const ok = await cl.aggregator.directReveal(AGG, {
    epoch_id: epochId,
    order_nonce: "0x" + orphan.nonce.toString(16),
    side: orphan.side,
    amount_in: orphan.amount_in.toString(),
    limit_price: orphan.limit_price.toString(),
    submitted_at_block: Number(orphan.submitted_at_block),
    owner: cl.address.toString(),
    path_len: 2,
    path: ["tUSDC", "tETH"],
  });
  console.log("directReveal ok=" + ok);
}
await cl.stop?.();
