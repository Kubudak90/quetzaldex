#!/usr/bin/env node
// Sub-6b 1.2 fix-up #2: wire WETH + wBTC portals only.
// USDC already wired by wire-portals.ts; this picks up after the cast nonce
// cache stalled (forge broadcast had advanced the on-chain nonce mid-run).
//
// Usage:
//   dotenv -e .env.testnet -- pnpm tsx scripts/wire-remaining.ts \
//     <aWETH> <aWBTC>
import { readFileSync, writeFileSync } from "node:fs";
import { Fr } from "@aztec/aztec.js/fields";
import { wirePortalL2Token } from "./deploy-bridge.js";

const [, , aWETH, aWBTC] = process.argv;
if (!aWETH || !aWBTC) {
  console.error("usage: wire-remaining.ts <aWETH> <aWBTC>");
  process.exit(1);
}

const cfg = JSON.parse(readFileSync("quetzal.config.json", "utf8")) as Record<string, unknown> & {
  l1?: { governanceTimelock?: string; wethBridge?: string; wbtcBridge?: string };
  bridge?: { aUSDC?: string; admin?: string };
};
const l1 = cfg.l1 ?? {};
if (!l1.governanceTimelock || !l1.wethBridge || !l1.wbtcBridge) {
  throw new Error("quetzal.config.json missing l1.{governanceTimelock,wethBridge,wbtcBridge}");
}

async function main(): Promise<void> {
  const aWETHBytes32 = new Fr(BigInt(aWETH)).toString();
  const aWBTCBytes32 = new Fr(BigInt(aWBTC)).toString();

  await wirePortalL2Token(l1.governanceTimelock!, l1.wethBridge!, aWETHBytes32, "WETH");
  await wirePortalL2Token(l1.governanceTimelock!, l1.wbtcBridge!, aWBTCBytes32, "wBTC");

  const merged = {
    ...cfg,
    bridge: {
      ...(cfg.bridge ?? {}),
      aWETH,
      aWBTC,
    },
  };
  writeFileSync("quetzal.config.json", JSON.stringify(merged, null, 2));
  console.log("");
  console.log("WETH + wBTC portals wired. quetzal.config.json.bridge.{aWETH,aWBTC} added.");
}

main().catch((e) => {
  const msg = (e instanceof Error ? e.message : String(e)).replace(/0x[0-9a-fA-F]{64,}/g, "0x<REDACTED>");
  console.error(msg);
  process.exit(1);
});
