// Loads QuetzalContracts from Vite VITE_QUETZAL_* env vars at build time.
// Set via Vercel project env on the production frontend. Local dev: copy
// the values from quetzal.config.json into .env.local.
//
// All fields are required for SDK reads/writes to function (orderbook +
// 3 tokens + 3 pools + admin + registry + treasury). If any are missing,
// returns undefined and SDK reads will throw ConfigError on first use —
// the LandingScreen surfaces this as a "contracts not configured" error.

import type { QuetzalContracts } from "@quetzal/sdk";

interface ViteEnvShape {
  VITE_QUETZAL_ORDERBOOK?: string;
  VITE_QUETZAL_TUSDC?: string;
  VITE_QUETZAL_TETH?: string;
  VITE_QUETZAL_TBTC?: string;
  VITE_QUETZAL_ADMIN?: string;
  VITE_QUETZAL_AGGREGATOR_REGISTRY?: string;
  VITE_QUETZAL_TREASURY?: string;
  VITE_QUETZAL_POOL_USDC_ETH?: string;
  VITE_QUETZAL_POOL_USDC_BTC?: string;
  VITE_QUETZAL_POOL_ETH_BTC?: string;
  // L1 bridge (Sepolia) — needed by client.bridge.deposit / prepareL1Withdraw.
  VITE_L1_USDC_BRIDGE?: string;
  VITE_L1_WETH_BRIDGE?: string;
  VITE_L1_WBTC_BRIDGE?: string;
  VITE_L1_RPC_URL?: string;
}

/** Shape of NetworkConfig.l1 we populate (subset of the SDK's NetworkConfigL1). */
export interface EnvL1Config {
  usdcBridge?: string;
  wethBridge?: string;
  wbtcBridge?: string;
  rpcUrl?: string;
}

/**
 * Reads contract addresses from `import.meta.env.VITE_QUETZAL_*`.
 * Returns `undefined` if no addresses are configured at all (dev-mode bare
 * frontend). Returns a partial-but-typed object if SOME are configured —
 * caller is responsible for surfacing missing-field errors at the SDK level.
 *
 * The optional `envOverride` parameter is for unit tests that can't rely on
 * Vite injecting `import.meta.env`.
 */
export function loadContractsFromEnv(envOverride?: ViteEnvShape): QuetzalContracts | undefined {
  // Vite injects env at build time as `import.meta.env`. In test/runtime
  // environments without Vite, fall back to an empty object.
  const env = envOverride ?? (((import.meta as { env?: ViteEnvShape }).env ?? {}) as ViteEnvShape);

  if (!env.VITE_QUETZAL_ORDERBOOK) {
    // No contracts configured — return undefined so SDK throws a clear
    // "MISSING_ENV" error on first read instead of crashing here.
    return undefined;
  }

  const pools: QuetzalContracts["pools"] = [];
  // Pool 0 — USDC/ETH (canonical order is determined by deployer, but the SDK
  // resolves pools by index, so we keep deploy-time ordering: 0=USDC/ETH,
  // 1=USDC/BTC, 2=ETH/BTC).
  if (env.VITE_QUETZAL_POOL_USDC_ETH && env.VITE_QUETZAL_TUSDC && env.VITE_QUETZAL_TETH) {
    pools.push({
      pool_id: 0,
      address: env.VITE_QUETZAL_POOL_USDC_ETH,
      token_a: env.VITE_QUETZAL_TUSDC,
      token_b: env.VITE_QUETZAL_TETH,
    });
  }
  if (env.VITE_QUETZAL_POOL_USDC_BTC && env.VITE_QUETZAL_TUSDC && env.VITE_QUETZAL_TBTC) {
    pools.push({
      pool_id: 1,
      address: env.VITE_QUETZAL_POOL_USDC_BTC,
      token_a: env.VITE_QUETZAL_TUSDC,
      token_b: env.VITE_QUETZAL_TBTC,
    });
  }
  if (env.VITE_QUETZAL_POOL_ETH_BTC && env.VITE_QUETZAL_TETH && env.VITE_QUETZAL_TBTC) {
    pools.push({
      pool_id: 2,
      address: env.VITE_QUETZAL_POOL_ETH_BTC,
      token_a: env.VITE_QUETZAL_TETH,
      token_b: env.VITE_QUETZAL_TBTC,
    });
  }

  return {
    orderbook: env.VITE_QUETZAL_ORDERBOOK,
    tUSDC: env.VITE_QUETZAL_TUSDC ?? "",
    tETH:  env.VITE_QUETZAL_TETH  ?? "",
    tBTC:  env.VITE_QUETZAL_TBTC,
    admin: env.VITE_QUETZAL_ADMIN,
    aggregatorRegistry: env.VITE_QUETZAL_AGGREGATOR_REGISTRY,
    treasury: env.VITE_QUETZAL_TREASURY,
    pools,
  };
}

/**
 * Reads the L1 bridge config from `import.meta.env.VITE_L1_*`. Without this the
 * SDK's `config.l1` is undefined and `client.bridge.deposit` throws
 * "config.l1 (usdcBridge/wethBridge/wbtcBridge) is required for deposit".
 * Returns undefined when no L1 bridge addresses are configured.
 */
export function loadL1FromEnv(envOverride?: ViteEnvShape): EnvL1Config | undefined {
  const env = envOverride ?? (((import.meta as { env?: ViteEnvShape }).env ?? {}) as ViteEnvShape);
  if (!env.VITE_L1_USDC_BRIDGE && !env.VITE_L1_WETH_BRIDGE && !env.VITE_L1_WBTC_BRIDGE) {
    return undefined;
  }
  return {
    usdcBridge: env.VITE_L1_USDC_BRIDGE,
    wethBridge: env.VITE_L1_WETH_BRIDGE,
    wbtcBridge: env.VITE_L1_WBTC_BRIDGE,
    rpcUrl: env.VITE_L1_RPC_URL,
  };
}
