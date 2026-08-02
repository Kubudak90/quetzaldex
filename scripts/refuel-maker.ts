// One-off: refuel the sub9 maker's fee-juice via faucet drip + redeemClaim
// (redeemClaim pays via the claim itself, so no existing FJ needed).
import { readFileSync } from "node:fs";
import { request as httpsRequest } from "node:https";
import { QuetzalClient } from "../sdk/src/index.js";

const s = JSON.parse(readFileSync("sub9-e2e-state.json", "utf8"));
const c = JSON.parse(readFileSync("quetzal.config.json", "utf8"));
const BK = process.env.FAUCET_BYPASS_KEY!;
const FAUCET = "https://faucet.quetzaldex.xyz";
const addr = s.childAddress as string;

function drip(): Promise<any> {
  const payload = JSON.stringify({ address: addr, captchaToken: BK });
  return new Promise((resolve, reject) => {
    const req = httpsRequest(`${FAUCET}/api/drip`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) },
      timeout: 15 * 60_000,
    }, (res) => {
      const ch: Buffer[] = []; res.on("data", (d) => ch.push(d));
      res.on("end", () => { try { resolve(JSON.parse(Buffer.concat(ch).toString())); } catch (e) { reject(e); } });
    });
    req.on("error", reject); req.on("timeout", () => req.destroy(new Error("drip timeout")));
    req.write(payload); req.end();
  });
}

const client = await QuetzalClient.connect({
  network: "alpha-testnet",
  nodeUrl: process.env.AZTEC_NODE_URL!,
  account: { type: "schnorr", secret: s.childSecret, salt: s.childSalt, signingKey: s.childSigningKey, proverEnabled: true, dataDirectory: "./sub9-e2e-pxe" },
  contracts: { orderbook: c.orderbook, tUSDC: c.tUSDC, tETH: c.tETH, tBTC: c.tBTC, admin: c.admin, pools: c.pools, aggregatorRegistry: c.aggregatorRegistry, treasury: c.treasury },
});
console.log("[refuel] maker:", client.address.toString());
const before = await client.fees.getJuiceBalance();
console.log("[refuel] FJ before:", before.toString());
import { existsSync } from "node:fs";
import { writeFileSync } from "node:fs";
const CLAIM_CACHE = "/tmp/qz-maker-claim.json";
let d: any;
if (existsSync(CLAIM_CACHE)) {
  d = JSON.parse(readFileSync(CLAIM_CACHE, "utf8"));
  console.log("[refuel] reusing cached claim leaf=" + d.claimData.messageLeafIndex);
} else {
  console.log("[refuel] dripping...");
  d = await drip();
  if (d.success && d.claimData) writeFileSync(CLAIM_CACHE, JSON.stringify(d));
}
if (!d.success || !d.claimData) throw new Error("drip failed: " + JSON.stringify(d).slice(0, 300));
console.log("[refuel] drip OK claimAmount=" + d.claimData.claimAmount + " leaf=" + d.claimData.messageLeafIndex);
console.log("[refuel] redeeming (retries while L1->L2 propagates)...");
const r = await client.fees.redeemClaim(d.claimData, { timeoutMs: 12 * 60_000, onProgress: (p) => console.log("  phase:", p) });
console.log("[refuel] redeemed tx=" + r.txHash);
const after = await client.fees.getJuiceBalance();
console.log("[refuel] FJ after:", after.toString());
await client.stop?.();
