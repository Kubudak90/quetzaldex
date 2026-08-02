#!/usr/bin/env node
//
// Sub-9.2 Phase A: Partial Quetzal protocol redeploy on Aztec testnet.
//
// ── Why this isn't "orderbook only" ──────────────────────────────────────
//
// The Sub-9.2 brief asked for an "orderbook-only redeploy" reusing existing
// tokens + pools + registry + treasury, with a `pool.set_orderbook(new)` rewire.
// In practice that is **impossible** with the current pool + treasury
// contracts:
//
//   1. `LiquidityPool.set_orderbook(...)` is a ONE-SHOT setter (gated by
//      `orderbook_addr == zero address`). The existing pools are permanently
//      pointed at the OLD orderbook 0x218ad28… and cannot be re-pointed.
//   2. `Treasury.orderbook_addr` is `PublicImmutable` — set in the
//      constructor, never mutable. The existing treasury is permanently
//      bound to the OLD orderbook.
//
// So to ship a NEW orderbook that can actually call `apply_clearing` on the
// pools AND `pay_aggregator` on the treasury, we MUST redeploy all three:
// pools + treasury + orderbook. Only the tokens + AggregatorRegistry can be
// reused (registry has no orderbook dependency).
//
// ── What this script does ────────────────────────────────────────────────
//
// Reuses (from quetzal.config.json):
//   - tUSDC, tETH, tBTC token contracts
//   - AggregatorRegistry
//   - admin wallet (from testnet-m1-state.json)
//
// Deploys fresh:
//   - 3 new LiquidityPools (USDC/ETH, USDC/BTC, ETH/BTC) using the
//     u128-canonical token ordering (Sub-9.1 P3 fix).
//   - new Orderbook with u128-canonical pool token slots.
//   - new Treasury bound to the new Orderbook.
//
// Re-wires:
//   - new Orderbook.set_treasury(new Treasury)
//   - new pool.set_orderbook(new Orderbook) x 3
//
// Re-seeds (treasury inline; pools via the operator running seed-lp.ts):
//   - mint TREASURY_SEED tUSDC to new Treasury + Treasury.seed_public
//   - pool re-seeding is OUT OF SCOPE for this script: the operator must
//     `rm seed-lp-state-{0,1,2}.json` (stale; reference the old pool addrs)
//     and then `SEED_LP_POOL=N pnpm tsx scripts/seed-lp.ts` for N=0,1,2.
//     This re-uses the existing seed-lp.ts BelowRange dry-run + bucket math
//     instead of duplicating ~300 LoC of V3-deposit logic here.
//
// State-persisted to redeploy-orderbook-only-state.json so partial runs
// resume safely.
//
// Pre-requisites:
//   - testnet-m1-state.json + quetzal.config.json present
//   - Admin has sufficient fee-juice (~5 FJ for 15-18 txs)
//   - Contracts compiled + transpiled (`pnpm compile && pnpm codegen`)
//   - Clearing circuit compiled (target/vk.bin/vk_hash exists)
//
// Usage:
//   AZTEC_NODE_URL=https://rpc.testnet.aztec-labs.com \
//     pnpm tsx scripts/redeploy-orderbook-only.ts
//
// State file: redeploy-orderbook-only-state.json (gitignored)
//
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { Fr, Fq } from "@aztec/aztec.js/fields";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { createAztecNodeClient, waitForNode } from "@aztec/aztec.js/node";
import { EmbeddedWallet } from "@aztec/wallets/embedded";

import { TokenContract } from "../tests/integration/generated/Token.js";
import { OrderbookContract } from "../tests/integration/generated/Orderbook.js";
import { LiquidityPoolContract } from "../tests/integration/generated/LiquidityPool.js";
import { TreasuryContract } from "../tests/integration/generated/Treasury.js";

// ─── Config ───────────────────────────────────────────────────────────────

const NODE_URL = process.env.AZTEC_NODE_URL ?? "https://rpc.testnet.aztec-labs.com";
// Safety: only allow testnet endpoints. Accept the canonical 'testnet' hosts plus
// the self-hosted node.quetzaldex.xyz (a verified testnet full node — more reliable
// than free drpc for the ~18 proven tx submissions here). The real chain guard is the
// runtime rollupVersion assert below (getNodeInfo), not just this string match.
const TESTNET_HOSTS = ["testnet", "node.quetzaldex.xyz"];
if (!TESTNET_HOSTS.some((h) => NODE_URL.includes(h))) {
  throw new Error(
    `AZTEC_NODE_URL must be a testnet endpoint (safety check). Got: ${NODE_URL}`,
  );
}
// Known Aztec testnet rollup version (Sepolia L1). Asserted after connect.
const EXPECTED_ROLLUP_VERSION = 4127419662n;

const M1_STATE = "testnet-m1-state.json";
const CONFIG   = "quetzal.config.json";
const STATE    = "redeploy-orderbook-only-state.json";
const PXE_DIR  = "./testnet-m4-pxe";

// Sub-2 bucket schema (must match the original deploy).
const P_MIN_SQRT        = 100_000_000_000_000_000n;
const BUCKET_GROWTH_NUM = 1_500_000_000_000_000_000n;

// Sub-3 economic parameters (must match the original deploy).
const TREASURY_SEED   = 1_000_000_000n;       // 1000 tUSDC (covers ~2000 clearings)
const AGGREGATOR_FEE  = 500_000n;             // 0.5 tUSDC per clearing
// EPOCH_LENGTH: number of L2 blocks per epoch. Parameterizable via env so we can
// tune UX without forking the script. Default 10 (post Sub-9.4): testnet block
// rate ~95-110s/block → ~15-min epochs → ~8-min average user wait. Sub-9.2
// originally used 100 (~2.5h epochs) which proved unusable for public UX.
const EPOCH_LENGTH    = (() => {
  const raw = process.env.EPOCH_LENGTH;
  if (raw === undefined || raw === "") return 10;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`EPOCH_LENGTH env must be a positive integer, got: ${raw}`);
  }
  return n;
})();

// M16: clearing grace window (blocks after closes_at_block during which a
// non-empty epoch may only be closed by a verified clearing or a bonded
// aggregator). ~3x the 5-6 min proof pipeline at testnet block cadence.
// Mirrors EPOCH_LENGTH shape; n >= 0 allowed (0 = no grace window).
const CLEAR_GRACE_BLOCKS = (() => {
  const raw = process.env.CLEAR_GRACE_BLOCKS;
  if (raw === undefined || raw === "") return 30;
  const n = Number(raw);
  // Upper bound guards the on-chain `closes_at_block + grace` u32 add: a near-u32
  // grace would overflow-assert and permanently brick close_epoch on the immutable
  // field. 1e6 blocks is far above any sane grace and far below the overflow edge.
  if (!Number.isInteger(n) || n < 0 || n > 1_000_000) {
    throw new Error(`CLEAR_GRACE_BLOCKS env must be an integer in [0, 1000000], got: ${raw}`);
  }
  return n;
})();

// ─── Types ────────────────────────────────────────────────────────────────

interface M1State {
  step: number;
  secret: string;
  salt: string;
  signingKey: string;
  address: string;
}

interface ConfigShape {
  nodeUrl: string;
  admin: string;
  tUSDC: string;
  tETH: string;
  tBTC: string;
  orderbook: string;
  treasury: string;
  aggregatorRegistry: string;
  pools: Array<{ pool_id: number; address: string; token_a: string; token_b: string }>;
}

interface RedeployState {
  step: number;
  pool_usdc_eth?: { address: string; token_a: string; token_b: string };
  pool_usdc_btc?: { address: string; token_a: string; token_b: string };
  pool_eth_btc?:  { address: string; token_a: string; token_b: string };
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
 * Canonical pair ordering — u128 truncation (Sub-9.1 P3 fix).
 * Matches the orderbook's on-chain ordering in
 * contracts/orderbook/src/main.nr (`add_pool`, `_assert_path_pools_registered`,
 * which cast AztecAddress Field → u128 before comparing).
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
  if (!existsSync(CONFIG)) {
    throw new Error(`${CONFIG} not found — run scripts/redeploy-testnet.ts first`);
  }

  const m1     = JSON.parse(readFileSync(M1_STATE, "utf8")) as M1State;
  const config = JSON.parse(readFileSync(CONFIG, "utf8")) as ConfigShape;
  const state  = loadState();

  console.log(`[redeploy-ob] node=${NODE_URL}`);
  console.log(`[redeploy-ob] EPOCH_LENGTH=${EPOCH_LENGTH}`);
  console.log(`[redeploy-ob] CLEAR_GRACE_BLOCKS=${CLEAR_GRACE_BLOCKS}`);
  console.log(`[redeploy-ob] resuming from step ${state.step}`);
  console.log(`[redeploy-ob] reusing tokens:`);
  console.log(`  tUSDC:    ${config.tUSDC}`);
  console.log(`  tETH:     ${config.tETH}`);
  console.log(`  tBTC:     ${config.tBTC}`);
  console.log(`  registry: ${config.aggregatorRegistry}`);
  console.log(`[redeploy-ob] OLD orderbook  (will replace): ${config.orderbook}`);
  console.log(`[redeploy-ob] OLD treasury   (will replace): ${config.treasury}`);
  console.log(`[redeploy-ob] OLD pools[0..2] (will replace):`);
  for (const p of config.pools) {
    console.log(`  pool ${p.pool_id}: ${p.address}`);
  }

  const node = createAztecNodeClient(NODE_URL);
  await waitForNode(node);
  const ni = await node.getNodeInfo();
  console.log(`[redeploy-ob] node OK; rollupVersion=${ni.rollupVersion} l1ChainId=${ni.l1ChainId}`);
  if (BigInt(ni.rollupVersion) !== EXPECTED_ROLLUP_VERSION) {
    throw new Error(
      `refusing to deploy: node rollupVersion ${ni.rollupVersion} != expected testnet ${EXPECTED_ROLLUP_VERSION}`,
    );
  }

  const wallet = await EmbeddedWallet.create(node, {
    ephemeral: false,
    pxe: { proverEnabled: true, dataDirectory: PXE_DIR },
  });

  const secret     = Fr.fromString(m1.secret);
  const salt       = Fr.fromString(m1.salt);
  const signingKey = Fq.fromString(m1.signingKey);
  const adminManager = await wallet.createSchnorrAccount(secret, salt, signingKey);
  const admin = (await adminManager.getAccount()).getAddress();
  console.log(`[redeploy-ob] admin: ${admin.toString()}`);
  if (admin.toString() !== m1.address) {
    throw new Error(`admin mismatch: derived ${admin.toString()} vs M1 ${m1.address}`);
  }

  const tUSDCAddr = AztecAddress.fromStringUnsafe(config.tUSDC);
  const tETHAddr  = AztecAddress.fromStringUnsafe(config.tETH);
  const tBTCAddr  = AztecAddress.fromStringUnsafe(config.tBTC);
  const registryAddr = AztecAddress.fromStringUnsafe(config.aggregatorRegistry);

  const tUSDC = await TokenContract.at(tUSDCAddr, wallet);
  const tETH  = await TokenContract.at(tETHAddr,  wallet);
  const tBTC  = await TokenContract.at(tBTCAddr,  wallet);

  // ── Step 1-3: deploy 3 new pools (u128-canonical token ordering) ────
  const deployPool = async (
    label: string,
    ta: AztecAddress,
    tb: AztecAddress,
  ): Promise<{ address: string; token_a: string; token_b: string }> => {
    const [lo, hi] = canon(ta, tb);
    console.log(`[redeploy-ob]   deploying pool ${label} (lo=${lo.toString().slice(0, 12)}..., hi=${hi.toString().slice(0, 12)}...) ...`);
    const t0 = Date.now();
    const dp = await LiquidityPoolContract.deploy(
      wallet, lo, hi, P_MIN_SQRT, BUCKET_GROWTH_NUM,
      admin, // Audit-#3: deploy-time admin; only this address may call set_orderbook
    ).send({ from: admin });
    const addr = dp.contract.address.toString();
    console.log(`[redeploy-ob]     pool ${label}=${addr} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
    return { address: addr, token_a: lo.toString(), token_b: hi.toString() };
  };

  if (!state.pool_usdc_eth) {
    console.log(`[redeploy-ob] step 1: deploying pool USDC/ETH ...`);
    state.pool_usdc_eth = await deployPool("USDC/ETH", tUSDCAddr, tETHAddr);
    state.step = Math.max(state.step, 1);
    noteAdd(state, `pool_usdc_eth deployed: ${state.pool_usdc_eth.address}`);
    saveState(state);
  } else {
    console.log(`[redeploy-ob] step 1 cached; pool_usdc_eth=${state.pool_usdc_eth.address}`);
  }

  if (!state.pool_usdc_btc) {
    console.log(`[redeploy-ob] step 2: deploying pool USDC/BTC ...`);
    state.pool_usdc_btc = await deployPool("USDC/BTC", tUSDCAddr, tBTCAddr);
    state.step = Math.max(state.step, 2);
    noteAdd(state, `pool_usdc_btc deployed: ${state.pool_usdc_btc.address}`);
    saveState(state);
  } else {
    console.log(`[redeploy-ob] step 2 cached; pool_usdc_btc=${state.pool_usdc_btc.address}`);
  }

  if (!state.pool_eth_btc) {
    console.log(`[redeploy-ob] step 3: deploying pool ETH/BTC ...`);
    state.pool_eth_btc = await deployPool("ETH/BTC", tETHAddr, tBTCAddr);
    state.step = Math.max(state.step, 3);
    noteAdd(state, `pool_eth_btc deployed: ${state.pool_eth_btc.address}`);
    saveState(state);
  } else {
    console.log(`[redeploy-ob] step 3 cached; pool_eth_btc=${state.pool_eth_btc.address}`);
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

  // ── Step 4: Orderbook (with vk_hash from local target) ─────────────
  if (!state.orderbook) {
    console.log(`[redeploy-ob] step 4: deploying Orderbook (3-pool, vk_hash bound) ...`);
    const t0 = Date.now();
    const vkHash = readVkHash();
    state.vkHash = vkHash.toString();
    saveState(state);

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
      admin,              // pool_registry_admin
    ).send({ from: admin });
    state.orderbook = dep.contract.address.toString();
    state.step = Math.max(state.step, 4);
    noteAdd(state, `orderbook deployed: ${state.orderbook}`);
    saveState(state);
    console.log(`[redeploy-ob]   orderbook=${state.orderbook} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  } else {
    console.log(`[redeploy-ob] step 4 cached; orderbook=${state.orderbook}`);
  }
  const orderbookAddr = AztecAddress.fromStringUnsafe(state.orderbook!);

  // ── Step 5: Treasury (bound to the new Orderbook) ──────────────────
  if (!state.treasury) {
    console.log(`[redeploy-ob] step 5: deploying Treasury ...`);
    const t0 = Date.now();
    // R3: Treasury constructor takes the AggregatorRegistry (consume_relayer_claim
    // gates the caller to a bonded aggregator). `as any` until codegen regenerates
    // the 4-arg Treasury binding.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const dep = await (TreasuryContract.deploy as any)(
      wallet, tUSDCAddr, orderbookAddr, registryAddr, admin,
    ).send({ from: admin });
    state.treasury = dep.contract.address.toString();
    state.step = Math.max(state.step, 5);
    noteAdd(state, `treasury deployed: ${state.treasury}`);
    saveState(state);
    console.log(`[redeploy-ob]   treasury=${state.treasury} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  } else {
    console.log(`[redeploy-ob] step 5 cached; treasury=${state.treasury}`);
  }
  const treasuryAddr = AztecAddress.fromStringUnsafe(state.treasury!);

  // ── Step 6: orderbook.set_treasury (one-shot wire) ─────────────────
  if (!state.setTreasuryDone) {
    console.log(`[redeploy-ob] step 6: orderbook.set_treasury(treasury) ...`);
    const t0 = Date.now();
    const orderbook = await OrderbookContract.at(orderbookAddr, wallet);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (orderbook.methods as any)
      .set_treasury(treasuryAddr)
      .send({ from: admin });
    state.setTreasuryDone = true;
    state.step = Math.max(state.step, 6);
    noteAdd(state, `set_treasury wired`);
    saveState(state);
    console.log(`[redeploy-ob]   set_treasury OK (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  } else {
    console.log(`[redeploy-ob] step 6 cached; set_treasury done`);
  }

  // ── Step 7-9: pool.set_orderbook x 3 ─────────────────────────────────
  const setOb = async (label: "p0" | "p1" | "p2", addr: AztecAddress, name: string) => {
    if (state.setOrderbookDone?.[label]) {
      console.log(`[redeploy-ob] set_orderbook(${name}) cached`);
      return;
    }
    console.log(`[redeploy-ob] set_orderbook on pool ${name} (${addr.toString().slice(0, 12)}...) ...`);
    const t0 = Date.now();
    const pool = await LiquidityPoolContract.at(addr, wallet);
    try {
      await pool.methods.set_orderbook(orderbookAddr).send({ from: admin });
    } catch (e) {
      // Idempotency: under retry-after-transient-testnet-error, a prior attempt's
      // set_orderbook tx may have LANDED before the client errored, leaving the
      // one-shot setter already wired (to THIS cascade's orderbookAddr, which is
      // constant across retries). Treat "already set" as success so the resumable
      // deploy can advance instead of looping forever on this step.
      const msg = String((e as { message?: string })?.message ?? e);
      if (/orderbook already set/.test(msg)) {
        console.log(`[redeploy-ob]   set_orderbook(${name}) already set (prior attempt landed) — treating as done`);
      } else {
        throw e;
      }
    }
    state.setOrderbookDone = { ...state.setOrderbookDone, [label]: true };
    saveState(state);
    console.log(`[redeploy-ob]   set_orderbook(${name}) OK (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  };
  await setOb("p0", poolUE, "USDC/ETH");
  await setOb("p1", poolUB, "USDC/BTC");
  await setOb("p2", poolEB, "ETH/BTC");
  state.step = Math.max(state.step, 9);
  saveState(state);

  // ── Step 10: mint TREASURY_SEED tUSDC to treasury (public) ─────────
  if (!state.treasuryMintDone) {
    console.log(`[redeploy-ob] step 10: mint_to_public(treasury, ${TREASURY_SEED}) ...`);
    const t0 = Date.now();
    await tUSDC.methods
      .mint_to_public(treasuryAddr, TREASURY_SEED)
      .send({ from: admin });
    state.treasuryMintDone = true;
    state.step = Math.max(state.step, 10);
    saveState(state);
    console.log(`[redeploy-ob]   mint OK (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  } else {
    console.log(`[redeploy-ob] step 10 cached; treasury mint done`);
  }

  // ── Step 11: treasury.seed_public(amount) ───────────────────────────
  if (!state.treasurySeedDone) {
    console.log(`[redeploy-ob] step 11: treasury.seed_public(${TREASURY_SEED}) ...`);
    const t0 = Date.now();
    const treasury = await TreasuryContract.at(treasuryAddr, wallet);
    await treasury.methods.seed_public(TREASURY_SEED).send({ from: admin });
    state.treasurySeedDone = true;
    state.step = Math.max(state.step, 11);
    saveState(state);
    console.log(`[redeploy-ob]   seed_public OK (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  } else {
    console.log(`[redeploy-ob] step 11 cached; treasury seeded`);
  }

  // ── Pool reseed is OUT OF SCOPE (handled by seed-lp.ts) ────────────
  //
  // The 3 new pools all start at reserve_a=reserve_b=0. The smoke test's
  // placeOrder against pool 0 won't be matched if pool 0 has no liquidity.
  // After this script completes, the operator should:
  //
  //   rm seed-lp-state-0.json seed-lp-state-1.json seed-lp-state-2.json
  //   SEED_LP_POOL=0 pnpm tsx scripts/seed-lp.ts  # 5K tUSDC bucket 8
  //   SEED_LP_POOL=1 pnpm tsx scripts/seed-lp.ts  # 0.1 tBTC bucket 8
  //   SEED_LP_POOL=2 pnpm tsx scripts/seed-lp.ts  # 0.1 tBTC bucket 8
  //
  // seed-lp.ts already handles:
  //   - mint_to_private of the LP seed (idempotent via state file)
  //   - BelowRange dry-run check via computeDeposit()
  //   - pool.deposit submission with hint refresh on retry

  // ── Step 15: update quetzal.config.json ─────────────────────────────
  console.log(`[redeploy-ob] step 15: updating ${CONFIG} ...`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const existing: any = JSON.parse(readFileSync(CONFIG, "utf8"));

  // Snapshot the about-to-be-replaced trio into a versioned legacy key, picking
  // the next unused slot so successive redeploys (9.2 → 9.4 → future) all
  // preserve history without overwriting.
  if (existing.orderbook !== state.orderbook) {
    const legacyKey = ((): string => {
      // Sub-9.4: the brief calls for `m4_postSub92_legacy`. Prefer that if free,
      // otherwise append a timestamp to avoid clobbering.
      if (!existing.m4_postSub92_legacy) return "m4_postSub92_legacy";
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      return `m4_legacy_${stamp}`;
    })();
    existing[legacyKey] = {
      orderbook: existing.orderbook,
      treasury:  existing.treasury,
      pools:     existing.pools,
      epoch_length_when_deployed: existing.epoch_length ?? null,
      notes: `Legacy snapshot (taken ${new Date().toISOString()}; replaced by EPOCH_LENGTH=${EPOCH_LENGTH} redeploy).`,
    };
  }
  existing.epoch_length = EPOCH_LENGTH;
  existing.clear_grace_blocks = CLEAR_GRACE_BLOCKS;

  existing.orderbook = state.orderbook!;
  existing.treasury  = state.treasury!;
  existing.pools = [
    { pool_id: 0, ...state.pool_usdc_eth! },
    { pool_id: 1, ...state.pool_usdc_btc! },
    { pool_id: 2, ...state.pool_eth_btc!  },
  ];

  writeFileSync(CONFIG, JSON.stringify(existing, null, 2));
  console.log(`[redeploy-ob]   ${CONFIG} updated`);

  // ── Verification phase ─────────────────────────────────────────────
  console.log(`[redeploy-ob] verifying new orderbook is correctly wired ...`);
  const orderbook = await OrderbookContract.at(orderbookAddr, wallet);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pcSim: any = await orderbook.methods.get_pool_count().simulate({ from: admin });
  const poolCount = Number(pcSim.result ?? pcSim);
  console.log(`[redeploy-ob]   orderbook.get_pool_count() = ${poolCount} (expected 3)`);
  if (poolCount !== 3) {
    throw new Error(`orderbook pool_count mismatch: got ${poolCount}, expected 3`);
  }

  for (let i = 0; i < 3; i++) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const taSim: any = await orderbook.methods.get_pool_token_a(i).simulate({ from: admin });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tbSim: any = await orderbook.methods.get_pool_token_b(i).simulate({ from: admin });
    const ta = AztecAddress.fromBigIntUnsafe(BigInt((taSim.result ?? taSim).toString())).toString();
    const tb = AztecAddress.fromBigIntUnsafe(BigInt((tbSim.result ?? tbSim).toString())).toString();
    console.log(`[redeploy-ob]   pool ${i}: token_a=${ta.slice(0, 12)}... token_b=${tb.slice(0, 12)}...`);

    // Spot-check u128 ordering.
    const taU = AztecAddress.fromStringUnsafe(ta).toBigInt() & U128_MASK;
    const tbU = AztecAddress.fromStringUnsafe(tb).toBigInt() & U128_MASK;
    if (taU >= tbU) {
      throw new Error(`pool ${i}: token_a u128 (${taU}) >= token_b u128 (${tbU}) — canon FAIL`);
    }
  }
  console.log(`[redeploy-ob]   orderbook canon u128 ordering verified ✓`);

  // ── Summary ──────────────────────────────────────────────────────────
  console.log("");
  console.log("[redeploy-ob] ALL STEPS PASSED.");
  console.log(`  admin:              ${admin.toString()}`);
  console.log(`  tUSDC (reused):     ${config.tUSDC}`);
  console.log(`  tETH  (reused):     ${config.tETH}`);
  console.log(`  tBTC  (reused):     ${config.tBTC}`);
  console.log(`  registry (reused):  ${config.aggregatorRegistry}`);
  console.log(`  orderbook (NEW):    ${state.orderbook}`);
  console.log(`  treasury  (NEW):    ${state.treasury}`);
  console.log(`  pool 0 (NEW):       ${state.pool_usdc_eth!.address}`);
  console.log(`  pool 1 (NEW):       ${state.pool_usdc_btc!.address}`);
  console.log(`  pool 2 (NEW):       ${state.pool_eth_btc!.address}`);
  console.log(`  vk_hash:            ${state.vkHash}`);
  console.log(`  epoch_length:       ${EPOCH_LENGTH}`);
  console.log(`  clear_grace_blocks: ${CLEAR_GRACE_BLOCKS}`);

  await wallet.stop();
}

main().catch((e) => {
  console.error(`[redeploy-ob] FAILED:`, e);
  console.error(`[redeploy-ob] partial state persisted to ${STATE}; re-run to resume.`);
  process.exit(1);
});
