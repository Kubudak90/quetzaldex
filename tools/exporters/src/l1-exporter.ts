import { createPublicClient, http, getContract } from "viem";
import { mainnet, sepolia } from "viem/chains";
import { Gauge } from "prom-client";
import { setupRegistry, startServer } from "./shared/promClient.js";
import { readFileSync } from "node:fs";

const PORT = Number(process.env.PORT ?? 9100);
const CONFIG_PATH = process.env.QUETZAL_CONFIG ?? "quetzal.config.json";

interface QuetzalConfigL1 {
  rpcUrl: string;
  usdcBridge: string;
  wethBridge: string;
  wbtcBridge?: string;
}
interface QuetzalConfig { l1: QuetzalConfigL1; }

const cfg = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as QuetzalConfig;

const chain = cfg.l1.rpcUrl.includes("sepolia") ? sepolia : mainnet;
const client = createPublicClient({ chain, transport: http(cfg.l1.rpcUrl) });

const TOKEN_BRIDGE_ABI = [
  { name: "totalLocked", inputs: [], outputs: [{ type: "uint256" }], stateMutability: "view", type: "function" },
  { name: "maxTvl",      inputs: [], outputs: [{ type: "uint256" }], stateMutability: "view", type: "function" },
  { name: "paused",      inputs: [], outputs: [{ type: "bool" }],    stateMutability: "view", type: "function" },
] as const;

const reg = setupRegistry();
const totalLockedG = new Gauge({ name: "quetzal_bridge_total_locked",      help: "token amount locked in portal (native units)", labelNames: ["token"], registers: [reg] });
const maxTvlG      = new Gauge({ name: "quetzal_bridge_max_tvl",           help: "TVL cap (native units; 0 = unlimited)",      labelNames: ["token"], registers: [reg] });
const tvlUtilG     = new Gauge({ name: "quetzal_bridge_tvl_utilization",   help: "locked / max ratio",                          labelNames: ["token"], registers: [reg] });
const pausedG      = new Gauge({ name: "quetzal_bridge_paused",            help: "1 if paused, 0 if active",                    labelNames: ["token"], registers: [reg] });

async function scrape(): Promise<void> {
  const portals: Array<[string, string]> = [
    ["USDC", cfg.l1.usdcBridge],
    ["WETH", cfg.l1.wethBridge],
    ...(cfg.l1.wbtcBridge ? [["wBTC", cfg.l1.wbtcBridge] as [string, string]] : []),
  ];
  for (const [label, addr] of portals) {
    try {
      const c = getContract({ address: addr as `0x${string}`, abi: TOKEN_BRIDGE_ABI, client });
      const [locked, cap, paused] = await Promise.all([
        c.read.totalLocked(),
        c.read.maxTvl(),
        c.read.paused(),
      ]);
      // NOTE: Number(BigInt) loses precision for amounts > 2^53 (~9.007e15).
      // For 18-decimal tokens (WETH) at scales >= 9 ETH, the gauge value will
      // be approximate. This is acceptable for observability dashboards; if
      // exact accounting matters, switch to fixed-point conversion
      // (e.g., Number(amount / 10n**14n) for 4 sig-fig precision in 10^14 ticks).
      const lockedN = Number(locked);
      const capN = Number(cap);
      totalLockedG.labels(label).set(lockedN);
      maxTvlG.labels(label).set(capN);
      tvlUtilG.labels(label).set(capN > 0 ? lockedN / capN : 0);
      pausedG.labels(label).set(paused ? 1 : 0);
    } catch (e) {
      console.error(`l1-exporter scrape ${label} failed:`, e instanceof Error ? e.message : String(e));
    }
  }
}

setInterval(() => { scrape().catch((e) => console.error("scrape error:", e)); }, 30_000);
scrape().catch((e) => console.error("initial scrape error:", e));
startServer(reg, PORT);
