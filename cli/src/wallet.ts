import { QuetzalClient } from "@quetzal/sdk";
import type { QuetzalConfig } from "./config.js";

export interface CliContext {
  client: QuetzalClient;
  config: QuetzalConfig;
}

function detectNetwork(nodeUrl: string): "alpha-testnet" | "sandbox" | "mainnet" {
  if (nodeUrl.includes("testnet")) return "alpha-testnet";
  if (nodeUrl.includes("localhost") || nodeUrl.includes("127.0.0.1")) return "sandbox";
  return "mainnet";
}

/**
 * Establish a QuetzalClient for the CLI process.
 *
 * Sub-6b Task 2.8: the CLI no longer constructs an EmbeddedWallet directly;
 * instead it instantiates the SDK's `QuetzalClient` with a `test-account`
 * adapter (which spins up the same EmbeddedWallet + pre-funded local network
 * test accounts the CLI used pre-2.8). Contracts in `quetzal.config.json`
 * are propagated through so the SDK auto-registers them against the PXE.
 */
export async function openCli(config: QuetzalConfig, accountIndex: number): Promise<CliContext> {
  const network = detectNetwork(config.nodeUrl);
  const client = await QuetzalClient.connect({
    network,
    nodeUrl: config.nodeUrl,
    account: { type: "test-account", accountIndex },
    contracts: {
      orderbook: config.orderbook,
      tUSDC: config.tUSDC,
      tETH: config.tETH,
      tBTC: config.tBTC,
      pools: config.pools,
      admin: config.admin,
      aggregatorRegistry: config.aggregatorRegistry,
      treasury: config.treasury,
    },
    l1: config.l1
      ? {
          rpcUrl: config.l1.rpcUrl,
          makerAddr: process.env.L1_MAKER_ADDR,
          usdcBridge: config.l1.usdcBridge,
          wethBridge: config.l1.wethBridge,
          wbtcBridge: config.l1.wbtcBridge,
        }
      : undefined,
  });
  return { client, config };
}
