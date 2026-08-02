#!/usr/bin/env node
// Sub-6b 1.2 fix-up: wire the 3 already-deployed L2 bridge tokens to their
// L1 portals via the governance timelock. Picks up from where deploy-bridge.ts
// crashed at the schedule step (bytes32 arg format bug, fixed in the same commit).
//
// Reads L2 token addresses from CLI args; reads bridge + timelock addrs from
// quetzal.config.json. Updates quetzal.config.json.{tUSDC, tETH, tBTC, admin}
// with the new bridge-mode addresses on success.
//
// Usage:
//   dotenv -e .env.testnet -- pnpm tsx scripts/wire-portals.ts \
//     <aUSDC> <aWETH> <aWBTC>
import { readFileSync, writeFileSync } from "node:fs";
import { Fr } from "@aztec/aztec.js/fields";
import { wirePortalL2Token } from "./deploy-bridge.js";

const [, , aUSDC, aWETH, aWBTC] = process.argv;
if (!aUSDC || !aWETH || !aWBTC) {
  console.error("usage: wire-portals.ts <aUSDC> <aWETH> <aWBTC>");
  process.exit(1);
}

const cfg = JSON.parse(readFileSync("quetzal.config.json", "utf8")) as Record<string, unknown> & {
  l1?: { governanceTimelock?: string; usdcBridge?: string; wethBridge?: string; wbtcBridge?: string };
};
const l1 = cfg.l1 ?? {};
if (!l1.governanceTimelock || !l1.usdcBridge || !l1.wethBridge || !l1.wbtcBridge) {
  throw new Error("quetzal.config.json missing l1.{governanceTimelock,usdcBridge,wethBridge,wbtcBridge}");
}

async function main(): Promise<void> {
  const aUSDCBytes32 = new Fr(BigInt(aUSDC)).toString();
  const aWETHBytes32 = new Fr(BigInt(aWETH)).toString();
  const aWBTCBytes32 = new Fr(BigInt(aWBTC)).toString();

  await wirePortalL2Token(l1.governanceTimelock!, l1.usdcBridge!, aUSDCBytes32, "USDC");
  await wirePortalL2Token(l1.governanceTimelock!, l1.wethBridge!, aWETHBytes32, "WETH");
  await wirePortalL2Token(l1.governanceTimelock!, l1.wbtcBridge!, aWBTCBytes32, "wBTC");

  // Read deploy-bridge-state.json for the L2 admin (account that deployed tokens)
  const bs = JSON.parse(readFileSync("deploy-bridge-state.json", "utf8")) as { address?: string };
  const admin = bs.address ?? cfg.admin;

  // Save new bridge-mode addresses to a SECONDARY section to preserve m3 trade tokens
  // (the spec's deploy-bridge.ts overwrites tUSDC/tETH/tBTC; we keep both worlds).
  const merged = {
    ...cfg,
    bridge: {
      aUSDC,
      aWETH,
      aWBTC,
      admin,
      deployedAtUnix: Math.floor(Date.now() / 1000),
    },
  };
  writeFileSync("quetzal.config.json", JSON.stringify(merged, null, 2));
  console.log("");
  console.log("Wired all 3 portals. quetzal.config.json.bridge.* populated.");
  console.log("(m3-era tUSDC/tETH/orderbook PRESERVED at top level for trade flows.)");
}

main().catch((e) => {
  const msg = (e instanceof Error ? e.message : String(e)).replace(/0x[0-9a-fA-F]{64,}/g, "0x<REDACTED>");
  console.error(msg);
  process.exit(1);
});
