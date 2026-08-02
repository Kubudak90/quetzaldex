#!/usr/bin/env node
//
// Regenerates the address tables in docs-site/pages/reference/contracts.mdx from
// quetzal.config.json — the canonical address book. Every redeploy moves these,
// and hand-maintained copies went stale for eight weeks (the published page
// listed a dead rollup's contracts end to end), so they are generated now.
//
// Only the block between the BEGIN/END markers is rewritten; the prose around
// it is yours to edit.
//
//   pnpm exec tsx scripts/gen-docs-addresses.ts          # write
//   pnpm exec tsx scripts/gen-docs-addresses.ts --check  # CI: fail if stale
//
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const CONFIG = "quetzal.config.json";
const STATE = "redeploy-testnet-state.json";
const PAGE = "docs-site/pages/reference/contracts.mdx";
const BEGIN = "{/* BEGIN:generated-addresses — `pnpm exec tsx scripts/gen-docs-addresses.ts` */}";
const END = "{/* END:generated-addresses */}";

interface Pool { pool_id: number; address: string; token_a: string; token_b: string }
interface Config {
  nodeUrl: string; admin: string; orderbook: string; treasury: string;
  aggregatorRegistry: string; tUSDC: string; tETH: string; tBTC: string;
  pools: Pool[]; epoch_length: number;
  bucketPMinSqrt: string; bucketGrowthNum: string;
  l1: {
    governanceTimelock: string; emergencyTimelock: string;
    usdcBridge: string; wethBridge: string; wbtcBridge: string; l2Version: number;
  };
}

const cfg = JSON.parse(readFileSync(CONFIG, "utf8")) as Config;

// The deployed clearing vk_hash is pinned by the redeploy that produced this
// orderbook; fall back to a placeholder rather than printing a stale one.
let vkHash = "(see redeploy-testnet-state.json)";
if (existsSync(STATE)) {
  const st = JSON.parse(readFileSync(STATE, "utf8")) as { vkHash?: string; orderbook?: string };
  if (st.vkHash && st.orderbook?.toLowerCase() === cfg.orderbook.toLowerCase()) vkHash = `\`${st.vkHash}\``;
}

const SYMBOLS: Record<string, { sym: string; dec: number }> = {
  [cfg.tUSDC.toLowerCase()]: { sym: "tUSDC", dec: 6 },
  [cfg.tETH.toLowerCase()]: { sym: "tETH", dec: 18 },
  [cfg.tBTC.toLowerCase()]: { sym: "tBTC", dec: 8 },
};
const sym = (addr: string): string => SYMBOLS[addr.toLowerCase()]?.sym ?? addr.slice(0, 10) + "…";

const rows = (pairs: [string, string][]): string =>
  pairs.map(([k, v]) => `| ${k} | ${v} |`).join("\n");

const body = `
## Network

| Field | Value |
|---|---|
| Network | \`alpha-testnet\` |
| Aztec node | \`${cfg.nodeUrl}\` (browser-friendly proxy: \`https://node.quetzaldex.xyz\`) |
| L1 chain | Ethereum Sepolia (chain id 11155111) |
| L2 rollup version | \`${cfg.l1.l2Version}\` |
| Epoch length | ${cfg.epoch_length} L2 blocks |
| VK hash (clearing circuit) | ${vkHash} |

## Core L2 contracts

| Contract | Address |
|---|---|
${rows([
  ["**Admin (deploy + token minter)**", `\`${cfg.admin}\``],
  ["**Orderbook**", `\`${cfg.orderbook}\``],
  ["**Treasury**", `\`${cfg.treasury}\``],
  ["**AggregatorRegistry**", `\`${cfg.aggregatorRegistry}\``],
])}

## Tokens (L2, hybrid)

The trading tokens are **both** admin-mintable (for the faucet) **and**
bridge-claimable — L1 deposits credit these same contracts directly.

| Token | Address | Decimals |
|---|---|---|
${[cfg.tUSDC, cfg.tETH, cfg.tBTC].map(a => {
  const m = SYMBOLS[a.toLowerCase()];
  return `| **${m.sym}** | \`${a}\` | ${m.dec} |`;
}).join("\n")}

## Pools

| Pool | Pair (token_a / token_b) | Address |
|---|---|---|
${cfg.pools.map(p => `| ${p.pool_id} | ${sym(p.token_a)} / ${sym(p.token_b)} | \`${p.address}\` |`).join("\n")}

Per-pool bucket math is parameterized by:

- \`bucketPMinSqrt = ${BigInt(cfg.bucketPMinSqrt).toLocaleString("en-US").replace(/,/g, "_")}\`
- \`bucketGrowthNum = ${BigInt(cfg.bucketGrowthNum).toLocaleString("en-US").replace(/,/g, "_")}\` (1.5×, 16 buckets)

## L1 contracts (Sepolia)

| Contract | Address |
|---|---|
${rows([
  ["**Governance Timelock**", `\`${cfg.l1.governanceTimelock}\``],
  ["**Emergency Timelock**", `\`${cfg.l1.emergencyTimelock}\``],
  ["**USDC bridge**", `\`${cfg.l1.usdcBridge}\``],
  ["**WETH bridge**", `\`${cfg.l1.wethBridge}\``],
  ["**wBTC bridge**", `\`${cfg.l1.wbtcBridge}\``],
])}
`.trimEnd();

const page = readFileSync(PAGE, "utf8");
const b = page.indexOf(BEGIN);
const e = page.indexOf(END);
if (b === -1 || e === -1 || e < b) {
  console.error(`[gen-docs-addresses] markers not found in ${PAGE}; add:\n${BEGIN}\n${END}`);
  process.exit(1);
}
const next = page.slice(0, b + BEGIN.length) + "\n" + body + "\n\n" + page.slice(e);

if (process.argv.includes("--check")) {
  if (next !== page) {
    console.error(`[gen-docs-addresses] ${PAGE} is STALE vs ${CONFIG}. Run: pnpm exec tsx scripts/gen-docs-addresses.ts`);
    process.exit(1);
  }
  console.log("[gen-docs-addresses] up to date");
  process.exit(0);
}

writeFileSync(PAGE, next);
console.log(`[gen-docs-addresses] wrote ${PAGE} (rollup ${cfg.l1.l2Version}, ${cfg.pools.length} pools)`);
