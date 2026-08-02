// Smoke test for SDK schnorr fix: does client.reads.getCurrentEpoch()
// work against live testnet now?
//
// Reads contract addresses from quetzal.config.json so it stays in sync with
// the latest deploy (Sub-9.4+). Hardcoded addresses were a Sub-9 drift hazard.
import { readFileSync } from "node:fs";
import { QuetzalClient } from "../sdk/src/index.js";

interface QuetzalConfigJson {
  nodeUrl?: string;
  admin: string;
  orderbook: string;
  tUSDC: string;
  tETH: string;
  tBTC?: string;
  aggregatorRegistry?: string;
  treasury?: string;
  pools: Array<{ pool_id: number; token_a: string; token_b: string; address: string }>;
}

async function main() {
  const cfg = JSON.parse(readFileSync("quetzal.config.json", "utf8")) as QuetzalConfigJson;
  const nodeUrl = process.env.AZTEC_NODE_URL ?? cfg.nodeUrl;
  if (!nodeUrl) throw new Error("AZTEC_NODE_URL env (or nodeUrl in config) is required");
  const secret = process.env.AGGREGATOR_L2_SECRET || "0x" + "11".repeat(32);
  console.log("connecting to", nodeUrl);
  console.log("orderbook:", cfg.orderbook);

  const client = await QuetzalClient.connect({
    network: "alpha-testnet",
    nodeUrl,
    account: { type: "schnorr", secret },
    contracts: {
      orderbook: cfg.orderbook,
      tUSDC: cfg.tUSDC,
      tETH: cfg.tETH,
      tBTC: cfg.tBTC,
      admin: cfg.admin,
      pools: cfg.pools,
      aggregatorRegistry: cfg.aggregatorRegistry,
      treasury: cfg.treasury,
    },
  });
  console.log("connected; client.address =", client.address.toString());

  console.log("calling client.reads.getCurrentEpoch() ...");
  const epoch = await client.reads.getCurrentEpoch();
  console.log("✅ getCurrentEpoch OK:", JSON.stringify(epoch, (_k, v) => typeof v === "bigint" ? v.toString() : v));
}
main().catch((e) => { console.error("❌ FAILED:", e); process.exit(1); });
