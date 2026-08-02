#!/usr/bin/env node
//
// Sub-5c A4: end-to-end deploy ceremony for Quetzal's L1↔L2 bridge.
//
// One command:
//   pnpm tsx scripts/deploy-bridge.ts
//
// Side effects:
//   - L1 forge: deploys governance TimelockController + emergency TimelockController +
//                3 TokenBridge proxies (USDC, WETH, wBTC)
//   - L2 aztec.js: deploys aUSDC + aWETH + aWBTC Token contracts
//                  (constructor_with_minter_bridged, portal_addr = corresponding L1 bridge)
//   - L1 cast: schedule+execute setL2TokenAddress on each portal via governance timelock
//   - Output: writes/updates quetzal.config.json
//
// Required env:
//   NETWORK                       testnet | mainnet | local
//   AZTEC_NODE_URL                Aztec rollup RPC
//   L1_RPC_URL                    Sepolia | Mainnet RPC
//   L1_USDC_ADDR, L1_WETH_ADDR, L1_WBTC_ADDR  canonical asset addresses
//   L1_INBOX_ADDR, L1_OUTBOX_ADDR
//   L1_MULTISIG_ADDR              governance multisig
//   L1_EMERGENCY_MULTISIG_ADDR    emergency multisig (separate)
//   DEPLOYER_PK                   L1 deployer private key
//
// Optional env:
//   SKIP_L1=1                     reuse quetzal.config.json's l1 addresses (post-failure resume)
//

import { spawn } from "node:child_process";
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { Fr } from "@aztec/aztec.js/fields";
import { EthAddress } from "@aztec/aztec.js/addresses";
import { bootstrapAztecWallet } from "./lib/aztec-wallet-bootstrap.js";
import { TokenContract } from "../tests/integration/generated/Token.js";

const NETWORK = process.env.NETWORK ?? "testnet";
if (!["testnet", "mainnet", "local"].includes(NETWORK)) {
  throw new Error(`NETWORK must be 'testnet' | 'mainnet' | 'local', got '${NETWORK}'`);
}

const AZTEC_NODE_URL = process.env.AZTEC_NODE_URL ?? "https://rpc.testnet.aztec-labs.com";
const L1_RPC_URL     = process.env.L1_RPC_URL     ?? "https://eth-sepolia.public.blastapi.io";
const L1_USDC_ADDR   = process.env.L1_USDC_ADDR   ?? "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238";
const L1_WETH_ADDR   = process.env.L1_WETH_ADDR   ?? "0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14";
const L1_WBTC_ADDR   = process.env.L1_WBTC_ADDR   ?? "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599";
const L1_INBOX_ADDR  = requireEnv("L1_INBOX_ADDR");
const L1_OUTBOX_ADDR = requireEnv("L1_OUTBOX_ADDR");
const L1_MULTISIG_ADDR           = requireEnv("L1_MULTISIG_ADDR");
const L1_EMERGENCY_MULTISIG_ADDR = requireEnv("L1_EMERGENCY_MULTISIG_ADDR");
const DEPLOYER_PK                = requireEnv("DEPLOYER_PK");

const TIMELOCK_DELAY_SEC   = NETWORK === "mainnet" ? 7 * 24 * 3600 : 0;

// Per-asset TVL caps in token native units. Target: ~$10k per portal at mainnet launch.
// Native unit decimals differ: USDC=6, WETH=18, wBTC=8.
//   USDC: 10_000 * 10^6  = 10_000_000_000 (≈ $10k)
//   WETH: 4    * 10^18    = 4_000_000_000_000_000_000 (≈ $10k @ $2,500/ETH; round-trip cap)
//   wBTC: 0.1  * 10^8     = 10_000_000 (≈ $10k @ $100,000/BTC; conservative)
const MAX_TVL_USDC: bigint = NETWORK === "mainnet" ? 10_000_000_000n              : 0n;
const MAX_TVL_WETH: bigint = NETWORK === "mainnet" ? 4_000_000_000_000_000_000n   : 0n;
const MAX_TVL_WBTC: bigint = NETWORK === "mainnet" ? 10_000_000n                  : 0n;

const FAUCET_URL = NETWORK === "testnet"
  ? "https://aztec-faucet.dev-nethermind.xyz/api/drip"
  : undefined;

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`required env var ${name} not set`);
  return v;
}

function runForge(args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("forge", args, { cwd, stdio: "inherit" });
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`forge exited ${code}`))));
  });
}

function castCalldata(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("cast", ["calldata", ...args]);
    let out = "";
    child.stdout?.on("data", (d: Buffer) => { out += d.toString(); });
    child.on("exit", (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(`cast calldata exited ${code}`))));
  });
}

function castSend(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("cast", ["send", ...args], { stdio: "inherit" });
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`cast send exited ${code}`))));
  });
}

async function castSendWithRetry(args: string[], label: string): Promise<void> {
  const maxAttempts = 6;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await castSend(args);
      return;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (attempt === maxAttempts) throw new Error(`${label}: gave up after ${maxAttempts} attempts: ${msg}`);
      console.log(`  ${label} attempt ${attempt} failed (${msg.slice(0, 80)}); sleeping 15s + retry`);
      await new Promise((r) => setTimeout(r, 15_000));
    }
  }
}

interface DeployedL1 {
  governanceTimelock: string;
  emergencyTimelock: string;
  usdcBridge: string;
  wethBridge: string;
  wbtcBridge: string;
}

interface DeployedL2 {
  aUSDC: string;
  aWETH: string;
  aWBTC: string;
  adminAddr: string;
}

async function deployL1Stack(): Promise<DeployedL1> {
  const args = [
    "script",
    "--rpc-url", L1_RPC_URL,
    "--private-key", DEPLOYER_PK,
    "--broadcast",
    "--sig", "run(address,address,address,address,address,address,address,uint256,uint256,uint256,uint256)",
    "script/DeployAllBridges.s.sol:DeployAllBridges",
    L1_USDC_ADDR, L1_WETH_ADDR, L1_WBTC_ADDR,
    L1_INBOX_ADDR, L1_OUTBOX_ADDR,
    L1_MULTISIG_ADDR, L1_EMERGENCY_MULTISIG_ADDR,
    TIMELOCK_DELAY_SEC.toString(),
    MAX_TVL_USDC.toString(),
    MAX_TVL_WETH.toString(),
    MAX_TVL_WBTC.toString(),
  ];
  console.log("Running forge deploy");
  await runForge(args, "contracts-l1");

  const chainId = NETWORK === "mainnet" ? 1 : NETWORK === "testnet" ? 11155111 : 31337;
  const broadcastPath = `contracts-l1/broadcast/DeployAllBridges.s.sol/${chainId}/run-latest.json`;
  if (!existsSync(broadcastPath)) {
    throw new Error(`forge broadcast log not found at ${broadcastPath}`);
  }
  const broadcast = JSON.parse(readFileSync(broadcastPath, "utf8")) as {
    transactions: Array<{ contractName: string; contractAddress: string; transactionType: string }>;
  };
  const creates = broadcast.transactions.filter(
    (t) => t.transactionType === "CREATE" || t.transactionType === "CREATE2",
  );
  const timelocks = creates.filter((t) => t.contractName === "TimelockController");
  const proxies = creates.filter((t) => t.contractName === "ERC1967Proxy");
  if (timelocks.length !== 2 || proxies.length !== 3) {
    throw new Error(
      `unexpected broadcast: ${timelocks.length} timelocks (want 2) + ${proxies.length} proxies (want 3)`,
    );
  }
  return {
    governanceTimelock: timelocks[0].contractAddress,
    emergencyTimelock: timelocks[1].contractAddress,
    usdcBridge: proxies[0].contractAddress,
    wethBridge: proxies[1].contractAddress,
    wbtcBridge: proxies[2].contractAddress,
  };
}

async function deployL2Tokens(usdcBridgeL1: string, wethBridgeL1: string, wbtcBridgeL1: string): Promise<DeployedL2> {
  const { wallet, account } = await bootstrapAztecWallet(
    AZTEC_NODE_URL,
    "deploy-bridge-state.json",
    FAUCET_URL,
  );
  try {
    // constructor_with_minter_bridged(name, symbol, decimals, minter, portal_addr)
    // The generated Token.ts may be stale and not yet include constructor_with_minter_bridged
    // in its type definitions; the `as any` cast is intentional — codegen regenerates on
    // `pnpm codegen`. The contract artifact includes the method and the deploy succeeds.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const TokenContractAny = TokenContract as any;

    // Bootstrap step 4 consumes the fee-juice claim during account deploy, so
    // by the time we reach here the account has spendable fee-juice balance.
    // All 3 token deploys pay from that balance via the default fee method.
    const deployBridgedToken = async (
      name: string,
      symbol: string,
      decimals: number,
      portalL1Addr: string,
    ) => {
      const paddedName   = name.padEnd(31, "\0");
      const paddedSymbol = symbol.padEnd(31, "\0");
      // EthAddress wraps a 20-byte Ethereum address; the Noir type EthAddress
      // serialises to a single field element (20 bytes right-padded to 32 bytes).
      const portalEthAddress = EthAddress.fromString(portalL1Addr);
      const deployed = await TokenContractAny.deployWithOpts(
        { wallet, method: "constructor_with_minter_bridged" },
        paddedName, paddedSymbol, decimals, account, portalEthAddress,
      ).send({ from: account });
      return deployed.contract;
    };

    const aUSDC = await deployBridgedToken("aUSDC", "aUSDC", 6,  usdcBridgeL1);
    const aWETH = await deployBridgedToken("aWETH", "aWETH", 18, wethBridgeL1);
    const aWBTC = await deployBridgedToken("aWBTC", "aWBTC", 8,  wbtcBridgeL1);

    return {
      aUSDC: aUSDC.address.toString(),
      aWETH: aWETH.address.toString(),
      aWBTC: aWBTC.address.toString(),
      adminAddr: account.toString(),
    };
  } finally {
    await wallet.stop();
  }
}

/**
 * Sub-5c A4: schedule + (for testnet/local with delay=0) execute
 * setL2TokenAddress on a portal via the TimelockController.
 *
 * On mainnet (delay=7d), only schedules. The execute call must be run
 * by an operator after the 7-day window via the printed cast command.
 *
 * Exported so F2 / other scripts can import directly.
 *
 * @param timelockAddr  governance TimelockController address
 * @param bridgeAddr    TokenBridge proxy address
 * @param l2TokenHex    bytes32 hex (0x-prefixed, 32 bytes) of the L2 Token address
 * @param label         human-readable label (e.g. "USDC", "WETH") for logs
 */
export async function wirePortalL2Token(
  timelockAddr: string,
  bridgeAddr: string,
  l2TokenHex: string,
  label: string,
): Promise<void> {
  if (!l2TokenHex.startsWith("0x") || l2TokenHex.length !== 66) {
    throw new Error(`l2TokenHex must be 0x-prefixed 32 bytes (66 chars), got ${l2TokenHex}`);
  }
  const innerCalldata = await castCalldata(["setL2TokenAddress(bytes32)", l2TokenHex]);

  console.log(`Scheduling setL2TokenAddress for ${label}Bridge → ${l2TokenHex}`);
  await castSendWithRetry([
    "--rpc-url", L1_RPC_URL, "--private-key", DEPLOYER_PK,
    timelockAddr,
    "schedule(address,uint256,bytes,bytes32,bytes32,uint256)",
    bridgeAddr, "0", innerCalldata, "0x0000000000000000000000000000000000000000000000000000000000000000", "0x0000000000000000000000000000000000000000000000000000000000000000", TIMELOCK_DELAY_SEC.toString(),
  ], `${label} schedule`);

  if (TIMELOCK_DELAY_SEC === 0) {
    console.log(`Executing setL2TokenAddress for ${label}Bridge immediately (delay=0)`);
    await castSendWithRetry([
      "--rpc-url", L1_RPC_URL, "--private-key", DEPLOYER_PK,
      timelockAddr,
      "execute(address,uint256,bytes,bytes32,bytes32)",
      bridgeAddr, "0", innerCalldata, "0x0000000000000000000000000000000000000000000000000000000000000000", "0x0000000000000000000000000000000000000000000000000000000000000000",
    ]);
  } else {
    console.log(`Mainnet delay = ${TIMELOCK_DELAY_SEC}s. After window, run:`);
    console.log(
      `  cast send ${timelockAddr} "execute(address,uint256,bytes,bytes32,bytes32)" ${bridgeAddr} 0 ${innerCalldata} 0x0 0x0`,
    );
  }
}

async function main() {
  console.log(`Sub-5c deploy on ${NETWORK}`);
  console.log(`  L1 USDC: ${L1_USDC_ADDR}`);
  console.log(`  L1 WETH: ${L1_WETH_ADDR}`);
  console.log(`  L1 wBTC: ${L1_WBTC_ADDR}`);
  console.log(`  Governance multisig: ${L1_MULTISIG_ADDR} (delay ${TIMELOCK_DELAY_SEC}s)`);
  console.log(`  Emergency multisig:  ${L1_EMERGENCY_MULTISIG_ADDR} (delay 0s)`);
  console.log(`  Max TVL USDC: ${MAX_TVL_USDC} (≈$10k mainnet, unlimited testnet)`);
  console.log(`  Max TVL WETH: ${MAX_TVL_WETH} (≈$10k mainnet, unlimited testnet)`);
  console.log(`  Max TVL wBTC: ${MAX_TVL_WBTC} (≈$10k mainnet, unlimited testnet)`);
  console.log("");

  let l1: DeployedL1;
  if (process.env.SKIP_L1 === "1") {
    console.log("SKIP_L1=1; reading L1 addresses from quetzal.config.json");
    const cfgRaw = JSON.parse(readFileSync("quetzal.config.json", "utf8")) as Record<string, unknown>;
    const l1Cfg = cfgRaw.l1 as DeployedL1 | undefined;
    if (
      !l1Cfg?.governanceTimelock ||
      !l1Cfg.emergencyTimelock ||
      !l1Cfg.usdcBridge ||
      !l1Cfg.wethBridge ||
      !l1Cfg.wbtcBridge
    ) {
      throw new Error(
        "SKIP_L1=1 set but quetzal.config.json is missing one or more of: " +
        "l1.{governanceTimelock, emergencyTimelock, usdcBridge, wethBridge, wbtcBridge}",
      );
    }
    l1 = {
      governanceTimelock: l1Cfg.governanceTimelock,
      emergencyTimelock: l1Cfg.emergencyTimelock,
      usdcBridge: l1Cfg.usdcBridge,
      wethBridge: l1Cfg.wethBridge,
      wbtcBridge: l1Cfg.wbtcBridge,
    };
  } else {
    console.log("=== L1 deploy ===");
    l1 = await deployL1Stack();
  }
  console.log(`GovernanceTimelock: ${l1.governanceTimelock}`);
  console.log(`EmergencyTimelock:  ${l1.emergencyTimelock}`);
  console.log(`USDCBridge:         ${l1.usdcBridge}`);
  console.log(`WETHBridge:         ${l1.wethBridge}`);
  console.log(`wBTCBridge:         ${l1.wbtcBridge}`);
  console.log("");

  console.log("=== L2 deploy ===");
  const l2 = await deployL2Tokens(l1.usdcBridge, l1.wethBridge, l1.wbtcBridge);
  console.log(`aUSDC: ${l2.aUSDC}`);
  console.log(`aWETH: ${l2.aWETH}`);
  console.log(`aWBTC: ${l2.aWBTC}`);
  console.log("");

  console.log("=== Wiring portals → L2 tokens (timelock-gated) ===");
  // AztecAddress is a 32-byte field element; Fr serialisation gives us a
  // 0x-prefixed 32-byte hex string (66 chars) as required by setL2TokenAddress(bytes32).
  const aUSDCBytes32 = new Fr(BigInt(l2.aUSDC)).toString();
  const aWETHBytes32 = new Fr(BigInt(l2.aWETH)).toString();
  const aWBTCBytes32 = new Fr(BigInt(l2.aWBTC)).toString();

  await wirePortalL2Token(l1.governanceTimelock, l1.usdcBridge, aUSDCBytes32, "USDC");
  await wirePortalL2Token(l1.governanceTimelock, l1.wethBridge, aWETHBytes32, "WETH");
  await wirePortalL2Token(l1.governanceTimelock, l1.wbtcBridge, aWBTCBytes32, "wBTC");

  // Write quetzal.config.json
  const cfgPath = "quetzal.config.json";
  const existing = existsSync(cfgPath)
    ? (JSON.parse(readFileSync(cfgPath, "utf8")) as Record<string, unknown>)
    : {};
  const config = {
    ...existing,
    network: NETWORK,
    nodeUrl: AZTEC_NODE_URL,
    tUSDC: l2.aUSDC,
    tETH:  l2.aWETH,
    tBTC:  l2.aWBTC,
    admin: l2.adminAddr,
    l1: {
      rpcUrl: L1_RPC_URL,
      usdc: L1_USDC_ADDR,
      weth: L1_WETH_ADDR,
      wbtc: L1_WBTC_ADDR,
      inbox: L1_INBOX_ADDR,
      outbox: L1_OUTBOX_ADDR,
      multisig: L1_MULTISIG_ADDR,
      emergencyMultisig: L1_EMERGENCY_MULTISIG_ADDR,
      governanceTimelock: l1.governanceTimelock,
      emergencyTimelock: l1.emergencyTimelock,
      usdcBridge: l1.usdcBridge,
      wethBridge: l1.wethBridge,
      wbtcBridge: l1.wbtcBridge,
      timelockDelaySec: TIMELOCK_DELAY_SEC,
      maxTvlUsdc: MAX_TVL_USDC.toString(),
      maxTvlWeth: MAX_TVL_WETH.toString(),
      maxTvlWbtc: MAX_TVL_WBTC.toString(),
    },
  };
  writeFileSync(cfgPath, JSON.stringify(config, null, 2));
  console.log(`\nWrote ${cfgPath}`);
  console.log("\nMaker flow ready. See sub5c-runbook.md (F2) for the maker UX cheatsheet.");
}

main().catch((e) => { console.error(e); process.exit(1); });
