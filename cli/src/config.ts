import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export interface QuetzalPool {
  pool_id: number;
  token_a: string;     // canonical (lex-ordered) lower hex address
  token_b: string;     // canonical (lex-ordered) higher hex address
  address: string;     // Pool contract address
}

export interface QuetzalConfigL1 {
  rpcUrl?: string;
  usdc?: string;
  weth?: string;
  wbtc?: string;
  inbox?: string;
  outbox?: string;
  multisig?: string;
  emergencyMultisig?: string;
  governanceTimelock?: string;
  emergencyTimelock?: string;
  usdcBridge?: string;
  wethBridge?: string;
  wbtcBridge?: string;
  timelockDelaySec?: number;
  maxTvlUsdc?: string;
  maxTvlWeth?: string;
  maxTvlWbtc?: string;
}

export interface QuetzalConfig {
  nodeUrl: string;
  tUSDC: string;
  tETH: string;
  tBTC?: string;       // Sub-4: optional alias for third token
  pools: QuetzalPool[];  // Sub-4: multi-pool registry
  orderbook: string;
  admin: string;
  aggregatorRegistry?: string;
  treasury?: string;
  bucketPMinSqrt?: string;
  bucketGrowthNum?: string;
  /** Sub-5c: L1 contract addresses + bridge/multisig/timelock config */
  l1?: QuetzalConfigL1;
}

const REQUIRED: (keyof QuetzalConfig)[] = ["nodeUrl", "tUSDC", "tETH", "orderbook", "admin", "pools"];

export function loadConfig(path = "quetzal.config.json"): QuetzalConfig {
  const abs = resolve(process.cwd(), path);
  let parsed: Partial<QuetzalConfig>;
  try {
    parsed = JSON.parse(readFileSync(abs, "utf8")) as Partial<QuetzalConfig>;
  } catch (e) {
    throw new Error(`could not read config at ${abs}: ${e instanceof Error ? e.message : String(e)}`);
  }
  for (const key of REQUIRED) {
    if (parsed[key] === undefined || parsed[key] === null) {
      throw new Error(`config at ${abs} missing required field "${key}"`);
    }
  }
  if (!Array.isArray(parsed.pools) || parsed.pools.length === 0) {
    throw new Error(`config at ${abs}: pools must be a non-empty array`);
  }
  return parsed as QuetzalConfig;
}
