#!/usr/bin/env node
//
// Sub-9: Clean-slate Quetzal protocol redeploy on Aztec testnet.
//
// Mirrors scripts/deploy-tokens.ts (3-pool deployment) but adapted for
// testnet:
//   - Loads admin from testnet-m1-state.json (NOT the local-network test
//     accounts that deploy-tokens.ts uses on the devnet).
//   - Real Aztec node, real ClientIVC proving.
//   - Non-ephemeral PXE so contract registrations persist across resumes.
//   - State-persisted (idempotent) so partial runs can be resumed.
//
// Sub-4 deploys (3-pool):
//   - tUSDC (Token, 6 decimals) + tETH (Token, 18 decimals) + tBTC (Token, 8 decimals)
//   - 3 LiquidityPools for canonical pairs: USDC/ETH, USDC/BTC, ETH/BTC
//   - AggregatorRegistry (bonded race + tUSDC bond escrow)
//   - Orderbook with multi-pool constructor
//   - Treasury via Sub-5a 3-deploy fallback ceremony
//   - pool.set_orderbook wiring for all 3 pools
//   - Treasury.seed_public(initial_balance)
//
// Pre-requisites:
//   - testnet-m1-state.json present (admin wallet bootstrapped via testnet-m1-hello.ts)
//   - Admin has sufficient fee-juice (~3 FJ for the ceremony; the deploy
//     script does NOT auto-drip; do `scripts/check-bal-tmp.ts <addr>` to confirm)
//   - Contracts compiled + transpiled (`pnpm compile`)
//   - Bindings generated (tests/integration/generated/*.ts)
//   - Clearing circuit compiled (`circuits/clearing/target/vk.bin/vk_hash` exists)
//
// Usage:
//   AZTEC_NODE_URL=https://rpc.testnet.aztec-labs.com pnpm tsx scripts/redeploy-testnet.ts
//
// State file: redeploy-testnet-state.json (gitignored)
//
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { Fr, Fq } from "@aztec/aztec.js/fields";
import { AztecAddress, EthAddress } from "@aztec/aztec.js/addresses";
import { createAztecNodeClient, waitForNode } from "@aztec/aztec.js/node";
import { EmbeddedWallet } from "@aztec/wallets/embedded";
import { GasFees } from "@aztec/stdlib/gas";

import { TokenContract } from "../tests/integration/generated/Token.js";
import { OrderbookContract } from "../tests/integration/generated/Orderbook.js";
import { LiquidityPoolContract } from "../tests/integration/generated/LiquidityPool.js";
import { AggregatorRegistryContract } from "../tests/integration/generated/AggregatorRegistry.js";
import { TreasuryContract } from "../tests/integration/generated/Treasury.js";

// ─── Config ───────────────────────────────────────────────────────────────

const NODE_URL = process.env.AZTEC_NODE_URL ?? "https://rpc.testnet.aztec-labs.com";
if (!NODE_URL.includes("testnet")) {
  throw new Error(
    `AZTEC_NODE_URL must contain 'testnet' (safety check). Got: ${NODE_URL}`,
  );
}

const M1_STATE = "testnet-m1-state.json";
const CONFIG   = "quetzal.config.json";
const STATE    = "redeploy-testnet-state.json";
const PXE_DIR  = "./testnet-m4-pxe";

// Sub-2 bucket schema (concentrated liquidity, 16 buckets, geometric 1.5x spacing).
const P_MIN_SQRT        = 100_000_000_000_000_000n;          // 0.1e18
const BUCKET_GROWTH_NUM = 1_500_000_000_000_000_000n;        // 1.5e18

// Sub-3 economic parameters.
const AGGREGATOR_BOND = 1_000_000_000n;       // 1000 tUSDC (6 decimals)
const TREASURY_SEED   = 1_000_000_000n;       // 1000 tUSDC (covers ~2000 clearings)
const AGGREGATOR_FEE  = 500_000n;             // 0.5 tUSDC per clearing
const EPOCH_LENGTH    = Number(process.env.EPOCH_LENGTH ?? 100); // ~40min @ ~24s/block (testnet)
const CLEAR_GRACE_BLOCKS = Number(process.env.CLEAR_GRACE_BLOCKS ?? 30); // M16: grace window after epoch close

// Token metadata (must fit 31-byte field-encoded strings).
const TUSDC_NAME    = "tUSDC".padEnd(31, "\0");
const TUSDC_SYMBOL  = "tUSDC".padEnd(31, "\0");
const TUSDC_DEC     = 6;
const TETH_NAME     = "tETH".padEnd(31, "\0");
const TETH_SYMBOL   = "tETH".padEnd(31, "\0");
const TETH_DEC      = 18;
const TBTC_NAME     = "tBTC".padEnd(31, "\0");
const TBTC_SYMBOL   = "tBTC".padEnd(31, "\0");
const TBTC_DEC      = 8;

// ─── Types ────────────────────────────────────────────────────────────────

interface M1State {
  step: number;
  secret: string;
  salt: string;
  signingKey: string;
  address: string;
}

interface RedeployState {
  step: number;
  // Phase A: tokens
  tUSDC?: string;
  tETH?: string;
  tBTC?: string;
  // Phase B: pools (canonical-ordered token_a/token_b stored too).
  pool_usdc_eth?: { address: string; token_a: string; token_b: string };
  pool_usdc_btc?: { address: string; token_a: string; token_b: string };
  pool_eth_btc?:  { address: string; token_a: string; token_b: string };
  // Phase C: registry + orderbook + treasury + wiring
  aggregatorRegistry?: string;
  orderbook?: string;
  treasury?: string;
  setTreasuryDone?: boolean;
  setOrderbookDone?: { p0?: boolean; p1?: boolean; p2?: boolean };
  treasuryMintDone?: boolean;
  treasurySeedDone?: boolean;
  vkHash?: string;
  notes?: string[];
}

function loadState(): RedeployState {
  if (existsSync(STATE)) return JSON.parse(readFileSync(STATE, "utf8")) as RedeployState;
  return { step: 0, notes: [], setOrderbookDone: {} };
}
function saveState(s: RedeployState): void {
  writeFileSync(STATE, JSON.stringify(s, null, 2));
}
function noteAdd(s: RedeployState, msg: string): void {
  s.notes = s.notes ?? [];
  s.notes.push(`${new Date().toISOString()} ${msg}`);
}

function readVkHash(): Fr {
  const buf = readFileSync("circuits/clearing/target/vk.bin/vk_hash");
  if (buf.length !== 32) throw new Error(`expected 32-byte vk_hash, got ${buf.length}`);
  return Fr.fromBuffer(buf as Buffer);
}

/**
 * Canonical pair ordering — returns [lo, hi] sorted by the **u128 truncation**
 * of the AztecAddress Field. This matches the orderbook's on-chain ordering
 * (see contracts/orderbook/src/main.nr `add_pool` / `resolve_pool_id_by_pair`
 * / `_assert_path_pools_registered`, which cast the address Field to `u128`
 * before comparing).
 *
 * Sub-9.1 discovery: an earlier version of this function used full-bigint
 * comparison (`a.toBigInt() < b.toBigInt()`), which disagrees with the on-chain
 * u128 ordering whenever the upper 128 bits of one address sort opposite to
 * its lower 128 bits. On Sub-9's freshly-deployed tokens that mismatch
 * silently caused the orderbook constructor to register pool_token_a/b in the
 * wrong slots — every later `submit_order` failed with "pool not found for
 * path[0..2]" because the path's canonical ordering (correct u128) didn't
 * match the registry's stored ordering (wrong full-bigint).
 *
 * Fix forward (already applied here): use the u128 truncation. Any redeploy
 * after 2026-05-29 produces a correctly-registered orderbook on first try.
 */
const U128_MASK = (1n << 128n) - 1n;
function canon(a: AztecAddress, b: AztecAddress): [AztecAddress, AztecAddress] {
  const aU = a.toBigInt() & U128_MASK;
  const bU = b.toBigInt() & U128_MASK;
  return aU < bU ? [a, b] : [b, a];
}

// ─── Main ─────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  if (!existsSync(M1_STATE)) {
    throw new Error(`${M1_STATE} not found — bootstrap admin first via testnet-m1-hello.ts`);
  }

  const m1 = JSON.parse(readFileSync(M1_STATE, "utf8")) as M1State;
  const state = loadState();

  console.log(`[redeploy] node=${NODE_URL}`);
  console.log(`[redeploy] resuming from step ${state.step}`);

  const rawNode = createAztecNodeClient(NODE_URL);
  await waitForNode(rawNode);
  // STATIC fee override: aztec-labs' node.getCurrentMinFees() does an L1 read that
  // is rate-limited (429), which would 429 every deploy's fee computation. When
  // STATIC_MAX_FEE_PER_L2_GAS is set we wrap the node so getCurrentMinFees returns
  // a fixed min-fee, letting all deploys skip the 429'd call. Ceiling only — the
  // network still charges the real base fee, so a generous value never overpays.
  const _sL2 = process.env.STATIC_MAX_FEE_PER_L2_GAS;
  const _sDa = process.env.STATIC_MAX_FEE_PER_DA_GAS ?? "0";
  const node: any = _sL2
    ? new Proxy(rawNode as any, {
        get(t, p, r) {
          if (p === "getCurrentMinFees") {
            return async () => new GasFees(BigInt(_sDa), BigInt(_sL2));
          }
          const v = Reflect.get(t, p, r);
          return typeof v === "function" ? v.bind(t) : v;
        },
      })
    : rawNode;
  if (_sL2) console.log(`[redeploy] STATIC maxFeesPerGas override active: daGas=${_sDa} l2Gas=${_sL2}`);
  const ni = await node.getNodeInfo();
  console.log(`[redeploy] node OK; rollupVersion=${ni.rollupVersion} l1ChainId=${ni.l1ChainId}`);

  // Non-ephemeral PXE so contract instances persist across resumed runs.
  const wallet = await EmbeddedWallet.create(node, {
    ephemeral: false,
    pxe: {
      proverEnabled: true,
      dataDirectory: PXE_DIR,
    },
  });

  // Recreate admin from M1 state.
  const secret     = Fr.fromString(m1.secret);
  const salt       = Fr.fromString(m1.salt);
  const signingKey = Fq.fromString(m1.signingKey);
  const adminManager = await wallet.createSchnorrAccount(secret, salt, signingKey);
  const admin = (await adminManager.getAccount()).getAddress();
  console.log(`[redeploy] admin: ${admin.toString()}`);
  if (admin.toString() !== m1.address) {
    throw new Error(`admin mismatch: derived ${admin.toString()} vs M1 ${m1.address}`);
  }

  // Bridge portals — the new DEX tokens are deployed as HYBRID (mintable AND
  // bridge-claimable), with portal_addr = the EXISTING L1 bridge for each asset.
  // Option A: the bridges are repointed at these tokens via setL2TokenAddress
  // after deploy, so bridged funds claim into the same token the DEX trades.
  const cfgL1 = (JSON.parse(readFileSync(CONFIG, "utf8")).l1 ?? {}) as Record<string, string>;
  const USDC_BRIDGE_L1 = EthAddress.fromString(cfgL1.usdcBridge);
  const WETH_BRIDGE_L1 = EthAddress.fromString(cfgL1.wethBridge);
  const WBTC_BRIDGE_L1 = EthAddress.fromString(cfgL1.wbtcBridge);
  console.log(`[redeploy] hybrid portals: USDC=${USDC_BRIDGE_L1} WETH=${WETH_BRIDGE_L1} WBTC=${WBTC_BRIDGE_L1}`);

  // ── Step 1: deploy tUSDC ─────────────────────────────────────────────
  if (!state.tUSDC) {
    console.log(`[redeploy] step 1: deploying tUSDC ...`);
    const t0 = Date.now();
    const dep = await TokenContract.deployWithOpts(
      { wallet, method: "constructor_with_minter_and_portal" },
      TUSDC_NAME, TUSDC_SYMBOL, TUSDC_DEC, admin, USDC_BRIDGE_L1,
    ).send({ from: admin });
    state.tUSDC = dep.contract.address.toString();
    state.step = 1;
    noteAdd(state, `tUSDC deployed: ${state.tUSDC}`);
    saveState(state);
    console.log(`[redeploy]   tUSDC=${state.tUSDC} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  } else {
    console.log(`[redeploy] step 1 cached; tUSDC=${state.tUSDC}`);
  }
  const tUSDCAddr = AztecAddress.fromStringUnsafe(state.tUSDC!);
  const tUSDC = await TokenContract.at(tUSDCAddr, wallet);

  // ── Step 2: deploy tETH ──────────────────────────────────────────────
  if (!state.tETH) {
    console.log(`[redeploy] step 2: deploying tETH ...`);
    const t0 = Date.now();
    const dep = await TokenContract.deployWithOpts(
      { wallet, method: "constructor_with_minter_and_portal" },
      TETH_NAME, TETH_SYMBOL, TETH_DEC, admin, WETH_BRIDGE_L1,
    ).send({ from: admin });
    state.tETH = dep.contract.address.toString();
    state.step = Math.max(state.step, 2);
    noteAdd(state, `tETH deployed: ${state.tETH}`);
    saveState(state);
    console.log(`[redeploy]   tETH=${state.tETH} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  } else {
    console.log(`[redeploy] step 2 cached; tETH=${state.tETH}`);
  }
  const tETHAddr = AztecAddress.fromStringUnsafe(state.tETH!);

  // ── Step 3: deploy tBTC ──────────────────────────────────────────────
  if (!state.tBTC) {
    console.log(`[redeploy] step 3: deploying tBTC ...`);
    const t0 = Date.now();
    const dep = await TokenContract.deployWithOpts(
      { wallet, method: "constructor_with_minter_and_portal" },
      TBTC_NAME, TBTC_SYMBOL, TBTC_DEC, admin, WBTC_BRIDGE_L1,
    ).send({ from: admin });
    state.tBTC = dep.contract.address.toString();
    state.step = Math.max(state.step, 3);
    noteAdd(state, `tBTC deployed: ${state.tBTC}`);
    saveState(state);
    console.log(`[redeploy]   tBTC=${state.tBTC} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  } else {
    console.log(`[redeploy] step 3 cached; tBTC=${state.tBTC}`);
  }
  const tBTCAddr = AztecAddress.fromStringUnsafe(state.tBTC!);

  // ── Step 4-6: deploy 3 pools (USDC/ETH, USDC/BTC, ETH/BTC) ───────────
  const deployPool = async (
    label: string,
    ta: AztecAddress,
    tb: AztecAddress,
  ): Promise<{ address: string; token_a: string; token_b: string }> => {
    const [lo, hi] = canon(ta, tb);
    console.log(`[redeploy]   deploying pool ${label} (lo=${lo.toString().slice(0, 12)}..., hi=${hi.toString().slice(0, 12)}...) ...`);
    const t0 = Date.now();
    const dp = await LiquidityPoolContract.deploy(
      wallet, lo, hi, P_MIN_SQRT, BUCKET_GROWTH_NUM,
      admin, // Audit-#3: deploy-time admin; only this address may call set_orderbook
    ).send({ from: admin });
    const addr = dp.contract.address.toString();
    console.log(`[redeploy]     pool ${label}=${addr} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
    return { address: addr, token_a: lo.toString(), token_b: hi.toString() };
  };

  if (!state.pool_usdc_eth) {
    console.log(`[redeploy] step 4: deploying pool USDC/ETH ...`);
    state.pool_usdc_eth = await deployPool("USDC/ETH", tUSDCAddr, tETHAddr);
    state.step = Math.max(state.step, 4);
    noteAdd(state, `pool_usdc_eth deployed: ${state.pool_usdc_eth.address}`);
    saveState(state);
  } else {
    console.log(`[redeploy] step 4 cached; pool_usdc_eth=${state.pool_usdc_eth.address}`);
  }

  if (!state.pool_usdc_btc) {
    console.log(`[redeploy] step 5: deploying pool USDC/BTC ...`);
    state.pool_usdc_btc = await deployPool("USDC/BTC", tUSDCAddr, tBTCAddr);
    state.step = Math.max(state.step, 5);
    noteAdd(state, `pool_usdc_btc deployed: ${state.pool_usdc_btc.address}`);
    saveState(state);
  } else {
    console.log(`[redeploy] step 5 cached; pool_usdc_btc=${state.pool_usdc_btc.address}`);
  }

  if (!state.pool_eth_btc) {
    console.log(`[redeploy] step 6: deploying pool ETH/BTC ...`);
    state.pool_eth_btc = await deployPool("ETH/BTC", tETHAddr, tBTCAddr);
    state.step = Math.max(state.step, 6);
    noteAdd(state, `pool_eth_btc deployed: ${state.pool_eth_btc.address}`);
    saveState(state);
  } else {
    console.log(`[redeploy] step 6 cached; pool_eth_btc=${state.pool_eth_btc.address}`);
  }

  const poolUE = AztecAddress.fromStringUnsafe(state.pool_usdc_eth!.address);
  const poolUB = AztecAddress.fromStringUnsafe(state.pool_usdc_btc!.address);
  const poolEB = AztecAddress.fromStringUnsafe(state.pool_eth_btc!.address);
  const ue_lo  = AztecAddress.fromStringUnsafe(state.pool_usdc_eth!.token_a);
  const ue_hi  = AztecAddress.fromStringUnsafe(state.pool_usdc_eth!.token_b);
  const ub_lo  = AztecAddress.fromStringUnsafe(state.pool_usdc_btc!.token_a);
  const ub_hi  = AztecAddress.fromStringUnsafe(state.pool_usdc_btc!.token_b);
  const eb_lo  = AztecAddress.fromStringUnsafe(state.pool_eth_btc!.token_a);
  const eb_hi  = AztecAddress.fromStringUnsafe(state.pool_eth_btc!.token_b);

  // ── Step 7: AggregatorRegistry ──────────────────────────────────────
  if (!state.aggregatorRegistry) {
    console.log(`[redeploy] step 7: deploying AggregatorRegistry ...`);
    const t0 = Date.now();
    const dep = await AggregatorRegistryContract.deploy(
      wallet, tUSDCAddr, AGGREGATOR_BOND,
    ).send({ from: admin });
    state.aggregatorRegistry = dep.contract.address.toString();
    state.step = Math.max(state.step, 7);
    noteAdd(state, `aggregatorRegistry deployed: ${state.aggregatorRegistry}`);
    saveState(state);
    console.log(`[redeploy]   registry=${state.aggregatorRegistry} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  } else {
    console.log(`[redeploy] step 7 cached; registry=${state.aggregatorRegistry}`);
  }
  const registryAddr = AztecAddress.fromStringUnsafe(state.aggregatorRegistry!);

  // ── Step 8: Orderbook (with vk_hash from local target) ──────────────
  if (!state.orderbook) {
    console.log(`[redeploy] step 8: deploying Orderbook (3-pool, vk_hash bound) ...`);
    const t0 = Date.now();
    const vkHash = readVkHash();
    state.vkHash = vkHash.toString();
    saveState(state);

    // Padding sentinel: slot 3 (unused) — fill with admin to satisfy Noir's
    // fixed-length [AztecAddress; 4] arrays.
    const pool_addrs      = [poolUE, poolUB, poolEB, admin];
    const pool_token_a_ar = [ue_lo, ub_lo, eb_lo, admin];
    const pool_token_b_ar = [ue_hi, ub_hi, eb_hi, admin];

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const dep = await (OrderbookContract.deploy as any)(
      wallet,
      EPOCH_LENGTH,
      CLEAR_GRACE_BLOCKS,
      vkHash,
      registryAddr,
      AGGREGATOR_FEE,
      3,                  // pool_count
      pool_addrs,
      pool_token_a_ar,
      pool_token_b_ar,
      admin,              // pool_registry_admin (also gates set_treasury)
    ).send({ from: admin });
    state.orderbook = dep.contract.address.toString();
    state.step = Math.max(state.step, 8);
    noteAdd(state, `orderbook deployed: ${state.orderbook}`);
    saveState(state);
    console.log(`[redeploy]   orderbook=${state.orderbook} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  } else {
    console.log(`[redeploy] step 8 cached; orderbook=${state.orderbook}`);
  }
  const orderbookAddr = AztecAddress.fromStringUnsafe(state.orderbook!);

  // ── Step 9: Treasury (with real Orderbook address) ──────────────────
  if (!state.treasury) {
    console.log(`[redeploy] step 9: deploying Treasury ...`);
    const t0 = Date.now();
    // R3: Treasury constructor takes the AggregatorRegistry (consume_relayer_claim
    // gates the caller to a bonded aggregator). `as any` until codegen regenerates
    // the 4-arg Treasury binding.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const dep = await (TreasuryContract.deploy as any)(
      wallet, tUSDCAddr, orderbookAddr, registryAddr, admin,
    ).send({ from: admin });
    state.treasury = dep.contract.address.toString();
    state.step = Math.max(state.step, 9);
    noteAdd(state, `treasury deployed: ${state.treasury}`);
    saveState(state);
    console.log(`[redeploy]   treasury=${state.treasury} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  } else {
    console.log(`[redeploy] step 9 cached; treasury=${state.treasury}`);
  }
  const treasuryAddr = AztecAddress.fromStringUnsafe(state.treasury!);

  // ── Step 10: orderbook.set_treasury (one-shot wire) ─────────────────
  if (!state.setTreasuryDone) {
    console.log(`[redeploy] step 10: orderbook.set_treasury(treasury) ...`);
    const t0 = Date.now();
    const orderbook = await OrderbookContract.at(orderbookAddr, wallet);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (orderbook.methods as any)
      .set_treasury(treasuryAddr)
      .send({ from: admin });
    state.setTreasuryDone = true;
    state.step = Math.max(state.step, 10);
    noteAdd(state, `set_treasury wired`);
    saveState(state);
    console.log(`[redeploy]   set_treasury OK (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  } else {
    console.log(`[redeploy] step 10 cached; set_treasury already done`);
  }

  // ── Step 11-13: pool.set_orderbook x 3 ──────────────────────────────
  const setOb = async (label: "p0" | "p1" | "p2", addr: AztecAddress, name: string) => {
    if (state.setOrderbookDone?.[label]) {
      console.log(`[redeploy] set_orderbook(${name}) cached`);
      return;
    }
    console.log(`[redeploy] set_orderbook on pool ${name} (${addr.toString().slice(0, 12)}...) ...`);
    const t0 = Date.now();
    const pool = await LiquidityPoolContract.at(addr, wallet);
    await pool.methods.set_orderbook(orderbookAddr).send({ from: admin });
    state.setOrderbookDone = { ...state.setOrderbookDone, [label]: true };
    saveState(state);
    console.log(`[redeploy]   set_orderbook(${name}) OK (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  };
  await setOb("p0", poolUE, "USDC/ETH");
  await setOb("p1", poolUB, "USDC/BTC");
  await setOb("p2", poolEB, "ETH/BTC");
  state.step = Math.max(state.step, 13);
  saveState(state);

  // ── Step 14: mint TREASURY_SEED tUSDC to treasury (public) ──────────
  if (!state.treasuryMintDone) {
    console.log(`[redeploy] step 14: mint_to_public(treasury, ${TREASURY_SEED}) ...`);
    const t0 = Date.now();
    await tUSDC.methods
      .mint_to_public(treasuryAddr, TREASURY_SEED)
      .send({ from: admin });
    state.treasuryMintDone = true;
    state.step = Math.max(state.step, 14);
    saveState(state);
    console.log(`[redeploy]   mint OK (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  } else {
    console.log(`[redeploy] step 14 cached; treasury mint done`);
  }

  // ── Step 15: treasury.seed_public(amount) ───────────────────────────
  if (!state.treasurySeedDone) {
    console.log(`[redeploy] step 15: treasury.seed_public(${TREASURY_SEED}) ...`);
    const t0 = Date.now();
    const treasury = await TreasuryContract.at(treasuryAddr, wallet);
    await treasury.methods.seed_public(TREASURY_SEED).send({ from: admin });
    state.treasurySeedDone = true;
    state.step = Math.max(state.step, 15);
    saveState(state);
    console.log(`[redeploy]   seed_public OK (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  } else {
    console.log(`[redeploy] step 15 cached; treasury seeded`);
  }

  // ── Step 16: write quetzal.config.json ──────────────────────────────
  console.log(`[redeploy] step 16: updating ${CONFIG} ...`);
  // Preserve l1 + bridge + legacy sections; replace L2 protocol section.
  const existing: Record<string, unknown> = existsSync(CONFIG)
    ? JSON.parse(readFileSync(CONFIG, "utf8")) as Record<string, unknown>
    : {};

  // Move the current (pre-redeploy) snapshot into m3_legacy if it's not already preserved.
  // Compare addresses: if existing.orderbook !== state.orderbook AND no m4_legacy yet, snapshot.
  if (existing.orderbook && existing.orderbook !== state.orderbook && !existing.m4_legacy) {
    existing.m4_legacy = {
      admin: existing.admin,
      tUSDC: existing.tUSDC,
      tETH:  existing.tETH,
      tBTC:  existing.tBTC,
      orderbook: existing.orderbook,
      treasury:  existing.treasury,
      aggregatorRegistry: existing.aggregatorRegistry,
      pools: existing.pools,
      notes: `Pre Sub-9 redeploy snapshot (taken ${new Date().toISOString()}; replaced due to aztec.js 4.2.1 transpile incompatibility).`,
    };
  }

  const next = {
    ...existing,
    nodeUrl: NODE_URL,
    admin: admin.toString(),
    tUSDC: state.tUSDC!,
    tETH:  state.tETH!,
    tBTC:  state.tBTC!,
    orderbook: state.orderbook!,
    treasury:  state.treasury!,
    aggregatorRegistry: state.aggregatorRegistry!,
    pools: [
      { pool_id: 0, ...state.pool_usdc_eth! },
      { pool_id: 1, ...state.pool_usdc_btc! },
      { pool_id: 2, ...state.pool_eth_btc!  },
    ],
    bucketPMinSqrt:  P_MIN_SQRT.toString(),
    bucketGrowthNum: BUCKET_GROWTH_NUM.toString(),
  };
  writeFileSync(CONFIG, JSON.stringify(next, null, 2));
  console.log(`[redeploy]   ${CONFIG} updated`);

  // ── Summary ──────────────────────────────────────────────────────────
  console.log("");
  console.log("[redeploy] ALL STEPS PASSED.");
  console.log(`  admin:              ${admin.toString()}`);
  console.log(`  tUSDC:              ${state.tUSDC}`);
  console.log(`  tETH:               ${state.tETH}`);
  console.log(`  tBTC:               ${state.tBTC}`);
  console.log(`  aggregatorRegistry: ${state.aggregatorRegistry}`);
  console.log(`  orderbook:          ${state.orderbook}`);
  console.log(`  treasury:           ${state.treasury}`);
  console.log(`  pool USDC/ETH (0):  ${state.pool_usdc_eth!.address}`);
  console.log(`  pool USDC/BTC (1):  ${state.pool_usdc_btc!.address}`);
  console.log(`  pool ETH/BTC  (2):  ${state.pool_eth_btc!.address}`);
  console.log(`  vk_hash:            ${state.vkHash}`);

  await wallet.stop();
}

main().catch((e) => {
  console.error(`[redeploy] FAILED:`, e);
  console.error(`[redeploy] partial state persisted to ${STATE}; re-run to resume.`);
  process.exit(1);
});
