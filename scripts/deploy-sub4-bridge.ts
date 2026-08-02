#!/usr/bin/env node
//
// Sub-6b Phase 1 follow-up: Sub-4 ceremony redeploy wired against the
// bridge-mode tokens (aUSDC/aWETH/aWBTC). Uses the bridge wallet
// (0x0a6288dc...) which already has ~99 fee-juice from the 2026-05-24
// bridge deploy.
//
// Skips token deploy (uses existing aUSDC/aWETH/aWBTC from
// quetzal.config.json.bridge.*); deploys 3 pools + AggregatorRegistry +
// Orderbook + Treasury + wires everything.
//
// State: testnet-sub6b-sub4-state.json (gitignored).
//
// Usage:
//   dotenv -e .env.testnet -- pnpm tsx scripts/deploy-sub4-bridge.ts

import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { Fr } from "@aztec/aztec.js/fields";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { bootstrapAztecWallet } from "./lib/aztec-wallet-bootstrap.js";

import { TokenContract } from "../tests/integration/generated/Token.js";
import { OrderbookContract } from "../tests/integration/generated/Orderbook.js";
import { LiquidityPoolContract } from "../tests/integration/generated/LiquidityPool.js";
import { AggregatorRegistryContract } from "../tests/integration/generated/AggregatorRegistry.js";
import { TreasuryContract } from "../tests/integration/generated/Treasury.js";

const NODE_URL = process.env.AZTEC_NODE_URL ?? process.env.AZTEC_RPC_URL ?? "";
if (!NODE_URL.includes("testnet")) throw new Error(`AZTEC_NODE_URL must include 'testnet'`);

const STATE_PATH = "testnet-sub6b-sub4-state.json";

const P_MIN_SQRT        = 100_000_000_000_000_000n;
const BUCKET_GROWTH_NUM = 1_500_000_000_000_000_000n;

const AGGREGATOR_BOND = 1_000_000_000n;
const TREASURY_SEED   = 1_000_000_000n;
const AGGREGATOR_FEE  = 500_000n;
const EPOCH_LENGTH    = 100;

interface State {
  step: number;
  notes: Record<string, string>;
}

function loadState(): State {
  if (existsSync(STATE_PATH)) return JSON.parse(readFileSync(STATE_PATH, "utf8")) as State;
  return { step: 0, notes: {} };
}
function saveState(s: State): void { writeFileSync(STATE_PATH, JSON.stringify(s, null, 2)); }

function readVkHash(): Fr {
  const hashBuf = readFileSync("circuits/clearing/target/vk.bin/vk_hash");
  if (hashBuf.length !== 32) throw new Error(`expected 32-byte vk_hash, got ${hashBuf.length}`);
  return Fr.fromBuffer(hashBuf as Buffer);
}

function canon(a: AztecAddress, b: AztecAddress): [AztecAddress, AztecAddress] {
  return a.toBigInt() < b.toBigInt() ? [a, b] : [b, a];
}

async function main(): Promise<void> {
  const state = loadState();
  const cfg = JSON.parse(readFileSync("quetzal.config.json", "utf8")) as {
    bridge?: { aUSDC: string; aWETH: string; aWBTC: string };
  } & Record<string, unknown>;
  if (!cfg.bridge?.aUSDC || !cfg.bridge.aWETH || !cfg.bridge.aWBTC) {
    throw new Error("quetzal.config.json missing .bridge.{aUSDC,aWETH,aWBTC} -- run bridge deploy first");
  }

  console.log("Sub-4 bridge-token ceremony redeploy");
  console.log(`  aUSDC: ${cfg.bridge.aUSDC}`);
  console.log(`  aWETH: ${cfg.bridge.aWETH}`);
  console.log(`  aWBTC: ${cfg.bridge.aWBTC}`);

  // Reuse bridge wallet (has ~99 fee-juice from prior deploy)
  const { wallet, account: admin } = await bootstrapAztecWallet(NODE_URL, "deploy-bridge-state.json");

  const aUSDC = AztecAddress.fromStringUnsafe(cfg.bridge.aUSDC);
  const aWETH = AztecAddress.fromStringUnsafe(cfg.bridge.aWETH);
  const aWBTC = AztecAddress.fromStringUnsafe(cfg.bridge.aWBTC);

  // Register pre-existing bridge token contracts with the wallet's PXE so we can
  // call their methods (mint + seed_public). The contracts were deployed in an
  // EARLIER session so this PXE doesn't know their instance yet.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const walletAny = wallet as any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const nodeForReg = (await import("@aztec/aztec.js/node")).createAztecNodeClient(NODE_URL) as any;
  for (const addr of [aUSDC, aWETH, aWBTC]) {
    const instance = await nodeForReg.getContract(addr);
    if (typeof walletAny.registerContract === "function") {
      await walletAny.registerContract(instance, TokenContract.artifact);
    }
  }
  const aUSDCContract = await TokenContract.at(aUSDC, wallet);

  try {
    // ===== 1. Pools (3 canonical pairs) =====
    let usdc_eth: { pool: import("@aztec/aztec.js").Contract; lo: AztecAddress; hi: AztecAddress };
    let usdc_btc: { pool: import("@aztec/aztec.js").Contract; lo: AztecAddress; hi: AztecAddress };
    let eth_btc:  { pool: import("@aztec/aztec.js").Contract; lo: AztecAddress; hi: AztecAddress };

    const deployPool = async (ta: AztecAddress, tb: AztecAddress) => {
      const [lo, hi] = canon(ta, tb);
      const dp = await LiquidityPoolContract.deploy(
        wallet, lo, hi, P_MIN_SQRT, BUCKET_GROWTH_NUM,
        admin, // Audit-#3: deploy-time admin; only this address may call set_orderbook
      ).send({ from: admin });
      return { pool: dp.contract, lo, hi };
    };

    if (state.step < 1) {
      console.log("step 1: deploy USDC/ETH pool ...");
      usdc_eth = await deployPool(aUSDC, aWETH);
      state.notes.pool_usdc_eth = usdc_eth.pool.address.toString();
      state.step = 1; saveState(state);
    } else {
      const [lo, hi] = canon(aUSDC, aWETH);
      usdc_eth = { pool: await LiquidityPoolContract.at(AztecAddress.fromStringUnsafe(state.notes.pool_usdc_eth), wallet), lo, hi };
    }

    if (state.step < 2) {
      console.log("step 2: deploy USDC/BTC pool ...");
      usdc_btc = await deployPool(aUSDC, aWBTC);
      state.notes.pool_usdc_btc = usdc_btc.pool.address.toString();
      state.step = 2; saveState(state);
    } else {
      const [lo, hi] = canon(aUSDC, aWBTC);
      usdc_btc = { pool: await LiquidityPoolContract.at(AztecAddress.fromStringUnsafe(state.notes.pool_usdc_btc), wallet), lo, hi };
    }

    if (state.step < 3) {
      console.log("step 3: deploy ETH/BTC pool ...");
      eth_btc = await deployPool(aWETH, aWBTC);
      state.notes.pool_eth_btc = eth_btc.pool.address.toString();
      state.step = 3; saveState(state);
    } else {
      const [lo, hi] = canon(aWETH, aWBTC);
      eth_btc = { pool: await LiquidityPoolContract.at(AztecAddress.fromStringUnsafe(state.notes.pool_eth_btc), wallet), lo, hi };
    }

    // ===== 2. AggregatorRegistry =====
    let registry: import("@aztec/aztec.js").Contract;
    if (state.step < 4) {
      console.log("step 4: deploy AggregatorRegistry ...");
      const dep = await AggregatorRegistryContract.deploy(wallet, aUSDC, AGGREGATOR_BOND).send({ from: admin });
      registry = dep.contract;
      state.notes.registry = registry.address.toString();
      state.step = 4; saveState(state);
    } else {
      registry = await AggregatorRegistryContract.at(AztecAddress.fromStringUnsafe(state.notes.registry), wallet);
    }

    // ===== 3. Orderbook (multi-pool ctor with ZERO treasury placeholder) =====
    const vkHash = readVkHash();
    const pool_addrs      = [usdc_eth.pool.address, usdc_btc.pool.address, eth_btc.pool.address, admin];
    const pool_token_a_ar = [usdc_eth.lo,           usdc_btc.lo,           eth_btc.lo,           admin];
    const pool_token_b_ar = [usdc_eth.hi,           usdc_btc.hi,           eth_btc.hi,           admin];

    let orderbook: import("@aztec/aztec.js").Contract;
    if (state.step < 5) {
      console.log("step 5: deploy Orderbook (10-arg ctor, ZERO treasury) ...");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const dep = await (OrderbookContract.deploy as any)(
        wallet, EPOCH_LENGTH, vkHash, registry.address, AGGREGATOR_FEE,
        3, pool_addrs, pool_token_a_ar, pool_token_b_ar, admin,
      ).send({ from: admin });
      orderbook = dep.contract;
      state.notes.orderbook = orderbook.address.toString();
      state.step = 5; saveState(state);
    } else {
      orderbook = await OrderbookContract.at(AztecAddress.fromStringUnsafe(state.notes.orderbook), wallet);
    }

    // ===== 4. Treasury (with real Orderbook addr) =====
    let treasury: import("@aztec/aztec.js").Contract;
    if (state.step < 6) {
      console.log("step 6: deploy Treasury ...");
      const dep = await TreasuryContract.deploy(wallet, aUSDC, orderbook.address, admin).send({ from: admin });
      treasury = dep.contract;
      state.notes.treasury = treasury.address.toString();
      state.step = 6; saveState(state);
    } else {
      treasury = await TreasuryContract.at(AztecAddress.fromStringUnsafe(state.notes.treasury), wallet);
    }

    // ===== 5. Orderbook.set_treasury =====
    if (state.step < 7) {
      console.log("step 7: orderbook.set_treasury ...");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (orderbook.methods as any).set_treasury(treasury.address).send({ from: admin });
      state.step = 7; saveState(state);
    }

    // ===== 6. Pool.set_orderbook for all 3 =====
    if (state.step < 8) {
      console.log("step 8: pool.set_orderbook for 3 pools ...");
      for (const pool of [usdc_eth.pool, usdc_btc.pool, eth_btc.pool]) {
        await pool.methods.set_orderbook(orderbook.address).send({ from: admin });
      }
      state.step = 8; saveState(state);
    }

    // ===== 7. Mint aUSDC to admin so they can seed treasury =====
    // aUSDC is bridge-mode; minter (admin) can call mint_to_public.
    if (state.step < 9) {
      console.log("step 9: mint aUSDC to admin (for treasury seed) ...");
      await aUSDCContract.methods.mint_to_public(admin, TREASURY_SEED).send({ from: admin });
      state.step = 9; saveState(state);
    }

    // ===== 8. Treasury seed_public =====
    if (state.step < 10) {
      console.log("step 10: treasury.seed_public ...");
      // First transfer aUSDC -> treasury via mint_to_public (already covered) then seed_public
      // The seed_public function takes the amount + reads from caller's public balance.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await aUSDCContract.methods.mint_to_public(treasury.address, TREASURY_SEED).send({ from: admin });
      await treasury.methods.seed_public(TREASURY_SEED).send({ from: admin });
      state.step = 10; saveState(state);
    }

    // ===== 9. Update quetzal.config.json with new bridge-wired stack =====
    const merged: Record<string, unknown> = {
      ...cfg,
      // OVERWRITE top-level with bridge-token-wired stack
      tUSDC: cfg.bridge!.aUSDC,
      tETH:  cfg.bridge!.aWETH,
      tBTC:  cfg.bridge!.aWBTC,
      admin: admin.toString(),
      orderbook: state.notes.orderbook,
      treasury:  state.notes.treasury,
      aggregatorRegistry: state.notes.registry,
      pools: [
        { pool_id: 0, token_a: usdc_eth.lo.toString(), token_b: usdc_eth.hi.toString(), address: state.notes.pool_usdc_eth },
        { pool_id: 1, token_a: usdc_btc.lo.toString(), token_b: usdc_btc.hi.toString(), address: state.notes.pool_usdc_btc },
        { pool_id: 2, token_a: eth_btc.lo.toString(),  token_b: eth_btc.hi.toString(),  address: state.notes.pool_eth_btc  },
      ],
      bucketPMinSqrt:  P_MIN_SQRT.toString(),
      bucketGrowthNum: BUCKET_GROWTH_NUM.toString(),
      m3_legacy: {
        admin: "0x0524b493a6766243d07f655a26ceb5e71c44af9cf0060c670f49ee7699c92a00",
        tUSDC: "0x09075988b52dec9c83c7da73ca3f746c14431a7974ccd8fb899e6476ef6b6b22",
        tETH:  "0x1c839479228a2cf9304a61ea4d0b3b2d3c319f3e72c8f4d87c3ade3a5809a198",
        orderbook: "0x2486ac705f0e7b509256dc96c8310a3abdf6465faa4a24e406a10fbcc17e5184",
        treasury:  "0x1b2c36d0b7f5da9ccb7888eee7785111f4a5c35778097bb79957ac031a6606e6",
        aggregatorRegistry: "0x00e43e816cdc85de14b31c02450b06890f0ebca5c19023d2fdb511fd16ece8e0",
        pool_usdc_eth: "0x1c06506878d782e8060557bc0ac73a4ff38cfda00083035103058b73be2def75",
        notes: "m3 era deploy (2026-05-22); m1-admin wallet; preserved here for reference.",
      },
    };
    writeFileSync("quetzal.config.json", JSON.stringify(merged, null, 2));
    console.log("");
    console.log("Sub-4 bridge-tokens stack deployed; quetzal.config.json updated.");
    console.log("Top-level tUSDC/tETH/tBTC now point to bridge-mode tokens (aUSDC/aWETH/aWBTC).");
    console.log("m3 legacy stack preserved under .m3_legacy for reference.");
  } finally {
    await wallet.stop();
  }
}

main().catch((e) => {
  const msg = (e instanceof Error ? e.message : String(e)).replace(/0x[0-9a-fA-F]{64,}/g, "0x<REDACTED>");
  console.error(msg);
  process.exit(1);
});
