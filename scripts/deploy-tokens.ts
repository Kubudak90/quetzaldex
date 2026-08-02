#!/usr/bin/env node
//
// Deploy Quetzal stack to a running Aztec local-network and write
// resulting contract addresses to quetzal.config.json.
//
// Sub-4 deploys (3-pool):
//   - tUSDC (Token, 6 decimals) + tETH (Token, 18 decimals) + tBTC (Token, 8 decimals)
//   - 3 LiquidityPools for canonical pairs: USDC/ETH, USDC/BTC, ETH/BTC
//   - AggregatorRegistry (bonded race + tUSDC bond escrow)
//   - Orderbook with multi-pool constructor (pool_count=3, pool_addrs/token_a/token_b
//     arrays of length 4 with admin as padding sentinel for slot 3)
//   - Treasury via the Sub-5a 3-deploy fallback ceremony (Orderbook.treasury is
//     PublicMutable; Orderbook deploys with ZERO treasury, Treasury deploys with
//     real Orderbook addr, then orderbook.set_treasury() wires them one-shot)
//   - pool.set_orderbook wiring for all 3 pools
//   - Treasury.seed_public(initial_balance)
//
// Pre-requisites:
//   - dev stack is up: `scripts/dev.sh` (anvil + aztec start --local-network)
//   - contracts are compiled: `pnpm compile`
//   - bindings are generated under tests/integration/generated/
//
// Usage:
//   pnpm tsx scripts/deploy-tokens.ts
//
import { writeFileSync, readFileSync } from "node:fs";
import { Fr } from "@aztec/aztec.js/fields";
import { AztecAddress } from "@aztec/aztec.js/aztec_address";
import { createAztecNodeClient, waitForNode } from "@aztec/aztec.js/node";
import { EmbeddedWallet } from "@aztec/wallets/embedded";
import { registerInitialLocalNetworkAccountsInWallet } from "@aztec/wallets/testing";

import { TokenContract } from "../tests/integration/generated/Token.js";
import { OrderbookContract } from "../tests/integration/generated/Orderbook.js";
import { LiquidityPoolContract } from "../tests/integration/generated/LiquidityPool.js";
import { AggregatorRegistryContract } from "../tests/integration/generated/AggregatorRegistry.js";
import { TreasuryContract } from "../tests/integration/generated/Treasury.js";

/** Read the clearing-circuit VK hash from the compiled artifact. */
function readVkHash(): Fr {
  const hashBuf = readFileSync("circuits/clearing/target/vk.bin/vk_hash");
  if (hashBuf.length !== 32) {
    throw new Error(`expected 32-byte vk_hash, got ${hashBuf.length}`);
  }
  return Fr.fromBuffer(hashBuf as Buffer);
}

const NODE_URL = process.env.PXE_URL ?? process.env.AZTEC_NODE_URL ?? "http://localhost:8080";

// Sub-2 bucket schema (concentrated liquidity, 16 buckets, geometric 1.5x spacing).
// p_min_sqrt = sqrt(0.01) = 0.1e18; growth_num = 1.5e18.
const P_MIN_SQRT        = 100_000_000_000_000_000n;          // 0.1e18
const BUCKET_GROWTH_NUM = 1_500_000_000_000_000_000n;        // 1.5e18

// Sub-3 economic parameters.
const AGGREGATOR_BOND = 1_000_000_000n;       // 1000 tUSDC (6 decimals)
const TREASURY_SEED   = 1_000_000_000n;       // 1000 tUSDC (covers ~2000 clearings)
const AGGREGATOR_FEE  = 500_000n;             // 0.5 tUSDC per clearing
const EPOCH_LENGTH    = 100;
const CLEAR_GRACE_BLOCKS = 30;               // M16: grace window after epoch close

/** Return [lo, hi] where lo.toBigInt() < hi.toBigInt() (canonical pair ordering). */
function canon(a: AztecAddress, b: AztecAddress): [AztecAddress, AztecAddress] {
  return a.toBigInt() < b.toBigInt() ? [a, b] : [b, a];
}

async function main() {
  const node = createAztecNodeClient(NODE_URL);
  await waitForNode(node);

  const wallet = await EmbeddedWallet.create(node, {
    ephemeral: true,
    pxe: { proverEnabled: false },
  });

  const accounts = await registerInitialLocalNetworkAccountsInWallet(wallet);
  const admin = accounts[0];
  if (!admin) throw new Error("no test wallets available");

  // ===== 1. Tokens (3) =====
  const deployToken = async (name: string, sym: string, decimals: number) => {
    const padded_name = name.padEnd(31, "\0");
    const padded_sym  = sym.padEnd(31, "\0");
    const dep = await TokenContract.deployWithOpts(
      { wallet, method: "constructor_with_minter" },
      padded_name, padded_sym, decimals, admin,
    ).send({ from: admin });
    return dep.contract;
  };

  const tUSDC = await deployToken("tUSDC", "tUSDC", 6);
  const tETH  = await deployToken("tETH",  "tETH",  18);
  const tBTC  = await deployToken("tBTC",  "tBTC",  8);

  // ===== 2. Pools (3 canonical pairs: USDC/ETH, USDC/BTC, ETH/BTC) =====
  const deployPool = async (ta: AztecAddress, tb: AztecAddress) => {
    const [lo, hi] = canon(ta, tb);
    const dp = await LiquidityPoolContract.deploy(
      wallet, lo, hi, P_MIN_SQRT, BUCKET_GROWTH_NUM,
      admin, // Audit-#3: deploy-time admin; only this address may call set_orderbook
    ).send({ from: admin });
    return { pool: dp.contract, lo, hi };
  };

  const p_usdc_eth = await deployPool(tUSDC.address, tETH.address);
  const p_usdc_btc = await deployPool(tUSDC.address, tBTC.address);
  const p_eth_btc  = await deployPool(tETH.address,  tBTC.address);

  // ===== 3. AggregatorRegistry =====
  const deployedRegistry = await AggregatorRegistryContract.deploy(
    wallet, tUSDC.address, AGGREGATOR_BOND,
  ).send({ from: admin });

  // ===== 4. Orderbook + Treasury 3-deploy ceremony (Sub-5a fallback) =====
  // contractAddressSalt is args-dependent (Sub-5a A1), so we can't precompute
  // Orderbook's address. Instead: deploy Orderbook with ZERO placeholder
  // treasury, deploy Treasury with real Orderbook addr, then orderbook.set_treasury.
  const vkHash = readVkHash();

  // Padding sentinel: slot 3 (index 3) is unused — fill with admin to satisfy Noir's
  // fixed-length [AztecAddress; 4] arrays.
  const pool_addrs      = [p_usdc_eth.pool.address, p_usdc_btc.pool.address, p_eth_btc.pool.address, admin];
  const pool_token_a_ar = [p_usdc_eth.lo,           p_usdc_btc.lo,           p_eth_btc.lo,           admin];
  const pool_token_b_ar = [p_usdc_eth.hi,           p_usdc_btc.hi,           p_eth_btc.hi,           admin];

  // Step 4a: deploy Orderbook with treasury = ZERO placeholder.
  // NOTE: generated Orderbook.ts binding may not yet reflect the updated 10-arg
  // constructor (treasury arg removed, pool_registry_admin arg appended); the
  // TypeScript cast below is intentional — codegen will regenerate the binding
  // on next `pnpm codegen`.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const orderbook = await (OrderbookContract.deploy as any)(
    wallet,
    EPOCH_LENGTH,
    CLEAR_GRACE_BLOCKS,
    vkHash,
    deployedRegistry.contract.address,
    AGGREGATOR_FEE,
    3,                  // pool_count
    pool_addrs,
    pool_token_a_ar,
    pool_token_b_ar,
    admin,              // pool_registry_admin (also gates set_treasury per Sub-5a A2)
    // (NOTE: treasury arg removed from constructor — Orderbook starts with treasury = ZERO)
  ).send({ from: admin });

  // Step 4b: deploy Treasury with the real Orderbook address + the AggregatorRegistry
  // (R3: consume_relayer_claim gates the caller to a bonded aggregator, so the
  // Treasury must know the registry). Cast `as any`: the generated Treasury binding
  // may still reflect the old 3-arg constructor until `pnpm codegen` regenerates it.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const finalTreasury = await (TreasuryContract.deploy as any)(
    wallet, tUSDC.address, orderbook.contract.address, deployedRegistry.contract.address, admin,
  ).send({ from: admin });

  // Step 4c: one-shot wire Orderbook -> Treasury.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (orderbook.contract.methods as any)
    .set_treasury(finalTreasury.contract.address)
    .send({ from: admin });
  console.log("Sub-5a fallback 3-deploy ceremony OK; Orderbook.treasury set once");

  // ===== 5. Wire all 3 pools to the orderbook =====
  for (const pp of [p_usdc_eth.pool, p_usdc_btc.pool, p_eth_btc.pool]) {
    await pp.methods
      .set_orderbook(orderbook.contract.address)
      .send({ from: admin });
  }

  // ===== 6. Treasury seed =====
  await tUSDC.methods
    .mint_to_public(finalTreasury.contract.address, TREASURY_SEED)
    .send({ from: admin });
  await finalTreasury.contract.methods
    .seed_public(TREASURY_SEED)
    .send({ from: admin });

  // ===== 7. Write quetzal.config.json =====
  const result = {
    nodeUrl: NODE_URL,
    tUSDC: tUSDC.address.toString(),
    tETH:  tETH.address.toString(),
    tBTC:  tBTC.address.toString(),
    pools: [
      {
        pool_id: 0,
        token_a: p_usdc_eth.lo.toString(),
        token_b: p_usdc_eth.hi.toString(),
        address: p_usdc_eth.pool.address.toString(),
      },
      {
        pool_id: 1,
        token_a: p_usdc_btc.lo.toString(),
        token_b: p_usdc_btc.hi.toString(),
        address: p_usdc_btc.pool.address.toString(),
      },
      {
        pool_id: 2,
        token_a: p_eth_btc.lo.toString(),
        token_b: p_eth_btc.hi.toString(),
        address: p_eth_btc.pool.address.toString(),
      },
    ],
    orderbook: orderbook.contract.address.toString(),
    admin: admin.toString(),
    aggregatorRegistry: deployedRegistry.contract.address.toString(),
    treasury: finalTreasury.contract.address.toString(),
    bucketPMinSqrt:  P_MIN_SQRT.toString(),
    bucketGrowthNum: BUCKET_GROWTH_NUM.toString(),
  };

  writeFileSync("quetzal.config.json", JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));

  await wallet.stop();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
