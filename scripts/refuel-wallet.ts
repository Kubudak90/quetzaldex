// Generic fee-juice refuel for ANY schnorr wallet via faucet drip + redeemClaim.
// Creds/address/PXE via env: RF_SECRET, RF_SALT, RF_KEY, RF_ADDR, RF_PXE, RF_CACHE.
// (redeemClaim pays via the claim itself, so no pre-existing FJ needed.)
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { request as httpsRequest } from "node:https";
import { QuetzalClient } from "../sdk/src/index.js";

const c = JSON.parse(readFileSync("quetzal.config.json", "utf8"));
const addr = process.env.RF_ADDR!;
const FAUCET = "https://faucet.quetzaldex.xyz";
const CACHE = process.env.RF_CACHE ?? `/tmp/qz-claim-${addr.slice(2, 12)}.json`;

function drip(): Promise<any> {
  const payload = JSON.stringify({ address: addr, captchaToken: process.env.FAUCET_BYPASS_KEY ?? "x" });
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
  account: { type: "schnorr", secret: process.env.RF_SECRET!, salt: process.env.RF_SALT!, signingKey: process.env.RF_KEY!, proverEnabled: true, dataDirectory: process.env.RF_PXE ?? "./testnet-m4-pxe" },
  contracts: { orderbook: c.orderbook, tUSDC: c.tUSDC, tETH: c.tETH, tBTC: c.tBTC, admin: c.admin, pools: c.pools, aggregatorRegistry: c.aggregatorRegistry, treasury: c.treasury },
});
console.log("[refuel] wallet:", client.address.toString());
const before = await client.fees.getJuiceBalance();
console.log("[refuel] FJ before:", before.toString());

let d: any;
if (existsSync(CACHE)) { d = JSON.parse(readFileSync(CACHE, "utf8")); console.log("[refuel] reusing cached claim"); }
else { console.log("[refuel] dripping..."); d = await drip(); if (d.success && d.claimData) writeFileSync(CACHE, JSON.stringify(d)); }
if (!d.success || !d.claimData) throw new Error("drip failed: " + JSON.stringify(d).slice(0, 200));
console.log("[refuel] drip OK claimAmount=" + d.claimData.claimAmount);
const r = await client.fees.redeemClaim(d.claimData, { timeoutMs: 12 * 60_000, onProgress: (p) => console.log("  phase:", p) });
console.log("[refuel] redeemed tx=" + r.txHash);
const after = await client.fees.getJuiceBalance();
console.log("[refuel] FJ after:", after.toString());
if (after > before) { try { (await import("node:fs")).unlinkSync(CACHE); } catch {} } // consumed; drop cache
await client.stop?.();
