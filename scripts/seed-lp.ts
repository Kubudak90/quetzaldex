#!/usr/bin/env node
//
// Sub-8.2a / Sub-9.1: LP seed script — bootstrap initial liquidity into a
// Quetzal testnet pool so user orders have something to match against.
//
// Pool selection via --pool=<id> flag (or env SEED_LP_POOL). Defaults to 0.
//   --pool=0  USDC/ETH (token_a=tUSDC, token_b=tETH)  -> seed 5K tUSDC
//   --pool=1  USDC/BTC (token_a=tBTC,  token_b=tUSDC) -> seed 0.1 tBTC
//   --pool=2  ETH/BTC  (token_a=tBTC,  token_b=tETH)  -> seed 0.1 tBTC
// In all cases the fresh pool (sqrt_p == p_min_sqrt) lives in the BelowRange
// regime for any bucket >= 0 → only token A is actually deposited; token B
// is refunded entirely. We pre-set amount_b = 0 to skip the futile round-trip.
//
// State-persisted (idempotent): per-pool state files (seed-lp-state-<id>.json)
// so re-runs see "already seeded; skipping". The legacy file
// "seed-lp-state.json" maps to pool 0 for backwards compatibility.
//
// Steps:
//   1. Load admin wallet from testnet-m1-state.json
//   2. Re-create admin Schnorr account; verify it matches quetzal.config.json
//      → admin (and that admin IS the minter for tUSDC + tETH + tBTC).
//   3. Sanity-check admin's PRIVATE balance of token A vs SEED_AMOUNT_A; if
//      short, mint the shortfall via mint_to_private (admin is minter, no
//      authwit needed).
//   4. Read pool's get_pool_state() + get_bucket(TARGET_BUCKET) for hints.
//   5. Pre-compute the V3 deposit math via aggregator/src/buckets.ts so the
//      operator can see what'll happen BEFORE the on-chain submit. For a
//      fresh pool, `sqrt_p <= sqrt_lower` holds for ANY bucket id ≥ 0 → math
//      falls into `computeDepositBelowRange` → used_a = amount_a, used_b = 0.
//   6. Call pool.deposit(...) with the prepared args.
//   7. Verify: re-read pool/bucket state + admin's PositionNote count.
//   8. Persist state.txHash + amounts + position_nonce + l_used.
//
// SAFETY: refuses to run unless AZTEC_NODE_URL contains 'testnet'.
//
// Usage:
//   AZTEC_NODE_URL=https://rpc.testnet.aztec-labs.com pnpm tsx scripts/seed-lp.ts --pool=1
//   SEED_LP_POOL=2 pnpm tsx scripts/seed-lp.ts
//
// State files: seed-lp-state-<id>.json (gitignored); pool 0 also writes
// the legacy seed-lp-state.json for backwards compatibility.
//
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { Fr, Fq } from "@aztec/aztec.js/fields";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { createAztecNodeClient, waitForNode } from "@aztec/aztec.js/node";
import { EmbeddedWallet } from "@aztec/wallets/embedded";
import { GasFees } from "@aztec/stdlib/gas";
import { TokenContract } from "../tests/integration/generated/Token.js";
import { LiquidityPoolContract } from "../tests/integration/generated/LiquidityPool.js";
import { computeDeposit, SCALE } from "../aggregator/src/buckets.js";

// ─── Config ───────────────────────────────────────────────────────────────

const NODE_URL = process.env.AZTEC_NODE_URL ?? "https://rpc.testnet.aztec-labs.com";
// Safety: only testnet endpoints. Accept canonical 'testnet' hosts + the verified
// self-hosted node.quetzaldex.xyz (more reliable than free drpc for proven txs).
if (!["testnet", "node.quetzaldex.xyz"].some((h) => NODE_URL.includes(h))) {
  throw new Error(
    `AZTEC_NODE_URL must be a testnet endpoint (safety check). Got: ${NODE_URL}`,
  );
}

const M1_STATE  = "testnet-m1-state.json";
const CONFIG    = "quetzal.config.json";
// PXE dir. Defaults to Sub-9 testnet-m4-pxe (post-clean-slate redeploy).
// Override via SEED_LP_PXE_DIR to re-use a different PXE (e.g. testnet-m3-pxe).
const PXE_DIR   = process.env.SEED_LP_PXE_DIR ?? "./testnet-m4-pxe";

// ─── Pool selection (--pool=<id> or SEED_LP_POOL=<id>; default 0) ─────────
function parsePoolId(): number {
  const flagArg = process.argv.find((a) => a.startsWith("--pool="));
  if (flagArg) {
    const raw = flagArg.slice("--pool=".length);
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0) {
      throw new Error(`invalid --pool=${raw}; must be a non-negative integer`);
    }
    return n;
  }
  if (process.env.SEED_LP_POOL) {
    const n = Number(process.env.SEED_LP_POOL);
    if (!Number.isInteger(n) || n < 0) {
      throw new Error(`invalid SEED_LP_POOL=${process.env.SEED_LP_POOL}`);
    }
    return n;
  }
  return 0;
}
const POOL_ID = parsePoolId();
// Pool 0 also writes seed-lp-state.json (legacy), pool>0 writes only -<id>.json.
const STATE   = `seed-lp-state-${POOL_ID}.json`;
const LEGACY_STATE_POOL_0 = "seed-lp-state.json";

// Atomic units.
const ONE_TUSDC = 10n ** 6n;
const ONE_TETH  = 10n ** 18n;
const ONE_TBTC  = 10n ** 8n;

// Token decimals lookup (used for logging only).
const DECIMALS_BY_TOKEN_KEY: Record<string, number> = {
  tUSDC: 6, tETH: 18, tBTC: 8,
};

// Per-pool seed plan. We MUST honour the on-chain canonical (token_a, token_b)
// ordering — read from quetzal.config.json. For BelowRange (every bucket ≥ 0
// at fresh pool), only token A is deposited; token B is refunded.
// Strategy: provide a healthy chunk of token A.
//   pool 0 (tUSDC/tETH): 5K tUSDC as token A
//   pool 1 (tBTC/tUSDC): 0.1 tBTC as token A
//   pool 2 (tBTC/tETH ): 0.1 tBTC as token A
// (We pass a non-zero amount_b for spec completeness, but step 5 zeros it
// after the regime check so we don't burn an escrow round-trip.)
interface PoolSeedPlan {
  amountA: bigint;
  amountB: bigint;
}
function buildSeedPlan(tokenAKey: string, tokenBKey: string): PoolSeedPlan {
  function amountFor(key: string, kind: "primary" | "companion"): bigint {
    // Primary = token A (BelowRange — actually deposited).
    // Companion = token B (refunded; sized only so the math input matches spec).
    if (key === "tUSDC") return kind === "primary" ? 5_000n * ONE_TUSDC : 5_000n * ONE_TUSDC;
    if (key === "tETH")  return kind === "primary" ?     2n * ONE_TETH  :     2n * ONE_TETH;
    if (key === "tBTC")  return kind === "primary" ?     1n * (ONE_TBTC / 10n) /* 0.1 */ : ONE_TBTC / 10n;
    throw new Error(`unknown token key: ${key}`);
  }
  return {
    amountA: amountFor(tokenAKey, "primary"),
    amountB: amountFor(tokenBKey, "companion"),
  };
}

// V3 bucket target. MUST be bucket 0, whose sqrt_lower == p_min_sqrt == the fresh
// pool's currentSqrtPrice. Seeding any higher bucket (e.g. the old default 8) leaves
// an EMPTY price gap between the live price (p_min) and the only liquidity, so the
// first swap's traceBucketSwap jumps across the gap to the funded bucket's lower edge
// while the clearing circuit chains sqrt_p from pool_sqrt_p_before (p_min) — they
// disagree and the circuit's `assert(dust<=1, "bucket out_a deviates")` fails
// (buckets.nr:171). Bucket 0 puts liquidity exactly where the price lives, so the
// aggregator and circuit agree with zero empty skips. This matches warm-up-pools.ts /
// deepen-pools.ts, which already target bucket 0. (Mid-range/stranded holes remain a
// deferred circuit empty-gap-awareness fix.)
const TARGET_BUCKET = Number(process.env.SEED_LP_BUCKET ?? 0);

// ─── Types ────────────────────────────────────────────────────────────────

interface SeedState {
  step: number;
  txHash?: string;
  bucketId?: number;
  amountADeposited?: string;     // bigint as decimal string
  amountBDeposited?: string;
  lUsedExpected?: string;        // math-predicted l_used (bigint)
  positionNonce?: string;        // 0x-hex
  poolStateBefore?: {
    reserve_a: string;
    reserve_b: string;
    current_sqrt_price: string;
  };
  bucketStateBefore?: {
    reserve_a: string;
    reserve_b: string;
    liquidity: string;
    cum_fee_a_per_share: string;
    cum_fee_b_per_share: string;
  };
  poolStateAfter?: SeedState["poolStateBefore"];
  bucketStateAfter?: SeedState["bucketStateBefore"];
  positionCountAfter?: number;
  notes?: string[];
}

interface M1State {
  step: number;
  secret: string;
  salt: string;
  signingKey: string;
  address: string;
}

interface QuetzalConfig {
  nodeUrl: string;
  admin: string;
  tUSDC: string;
  tETH: string;
  tBTC?: string;
  pools: Array<{ pool_id: number; token_a: string; token_b: string; address: string }>;
  bucketPMinSqrt: string;
  bucketGrowthNum: string;
}

// ─── State helpers ────────────────────────────────────────────────────────

function loadState(): SeedState {
  if (existsSync(STATE)) return JSON.parse(readFileSync(STATE, "utf8")) as SeedState;
  // Backwards-compat: if the per-pool file doesn't exist but the legacy one
  // does, and we're seeding pool 0, migrate it.
  if (POOL_ID === 0 && existsSync(LEGACY_STATE_POOL_0)) {
    const legacy = JSON.parse(readFileSync(LEGACY_STATE_POOL_0, "utf8")) as SeedState;
    writeFileSync(STATE, JSON.stringify(legacy, null, 2));
    return legacy;
  }
  return { step: 0, notes: [] };
}
function saveState(s: SeedState): void {
  writeFileSync(STATE, JSON.stringify(s, null, 2));
  if (POOL_ID === 0) writeFileSync(LEGACY_STATE_POOL_0, JSON.stringify(s, null, 2));
}
function noteAdd(s: SeedState, msg: string): void {
  s.notes = s.notes ?? [];
  s.notes.push(`${new Date().toISOString()} ${msg}`);
}

// ─── Pool / bucket helpers ────────────────────────────────────────────────

interface PoolStateHint {
  reserve_a: bigint;
  reserve_b: bigint;
  current_sqrt_price: bigint;
}
interface BucketStateHint {
  reserve_a: bigint;
  reserve_b: bigint;
  liquidity: bigint;
  cum_fee_a_per_share: bigint;
  cum_fee_b_per_share: bigint;
}

async function readPoolHint(
  pool: LiquidityPoolContract, from: AztecAddress,
): Promise<PoolStateHint> {
  const sim = await pool.methods.get_pool_state().simulate({ from });
  const r = (sim as { result: Record<string, bigint | number | undefined> }).result;
  return {
    reserve_a: BigInt(r.reserve_a as bigint | number),
    reserve_b: BigInt(r.reserve_b as bigint | number),
    current_sqrt_price: BigInt(r.current_sqrt_price as bigint | number),
  };
}

async function readBucketHint(
  pool: LiquidityPoolContract, bucketId: number, from: AztecAddress,
): Promise<BucketStateHint> {
  const sim = await pool.methods.get_bucket(bucketId).simulate({ from });
  const r = (sim as { result: Record<string, bigint | number | undefined> }).result;
  return {
    reserve_a: BigInt(r.reserve_a as bigint | number),
    reserve_b: BigInt(r.reserve_b as bigint | number),
    liquidity: BigInt(r.liquidity as bigint | number),
    cum_fee_a_per_share: BigInt(r.cum_fee_a_per_share as bigint | number),
    cum_fee_b_per_share: BigInt(r.cum_fee_b_per_share as bigint | number),
  };
}

// Mirrors contracts/pool/src/main.nr::compute_bucket_bounds.
function computeBucketBounds(
  pMinSqrt: bigint, growthNum: bigint, bucketId: number,
): { sqrt_lower: bigint; sqrt_upper: bigint } {
  let sqrtLower = pMinSqrt;
  for (let i = 0; i < bucketId; i++) {
    sqrtLower = (sqrtLower * growthNum) / SCALE;
  }
  const sqrtUpper = (sqrtLower * growthNum) / SCALE;
  return { sqrt_lower: sqrtLower, sqrt_upper: sqrtUpper };
}

async function readPrivateBalance(
  token: TokenContract, owner: AztecAddress,
): Promise<bigint> {
  const sim = await token.methods.balance_of_private(owner).simulate({ from: owner });
  return BigInt((sim as { result: bigint | number }).result);
}

// ─── Main ────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // ── Preconditions ──────────────────────────────────────────────────────
  if (!existsSync(M1_STATE)) {
    throw new Error(`${M1_STATE} not found — bootstrap admin wallet first (testnet-m1-hello.ts)`);
  }
  if (!existsSync(CONFIG)) {
    throw new Error(`${CONFIG} not found — deploy core contracts first`);
  }

  const m1 = JSON.parse(readFileSync(M1_STATE, "utf8")) as M1State;
  if (m1.step < 5) {
    throw new Error(`M1 not complete (step=${m1.step}); admin wallet not deployed`);
  }
  const config = JSON.parse(readFileSync(CONFIG, "utf8")) as QuetzalConfig;
  const poolEntry = config.pools.find((p) => p.pool_id === POOL_ID);
  if (!poolEntry) {
    throw new Error(
      `config.pools[].pool_id == ${POOL_ID} missing (available: ${config.pools.map((p) => p.pool_id).join(", ")})`,
    );
  }

  // Resolve token address → key (tUSDC / tETH / tBTC) for the pool.
  const tokenAddrToKey: Record<string, string> = {
    [config.tUSDC.toLowerCase()]: "tUSDC",
    [config.tETH.toLowerCase()]: "tETH",
  };
  if (config.tBTC) tokenAddrToKey[config.tBTC.toLowerCase()] = "tBTC";
  const tokenAKey = tokenAddrToKey[poolEntry.token_a.toLowerCase()];
  const tokenBKey = tokenAddrToKey[poolEntry.token_b.toLowerCase()];
  if (!tokenAKey || !tokenBKey) {
    throw new Error(
      `pool ${POOL_ID} references unknown token (a=${poolEntry.token_a} b=${poolEntry.token_b}); ` +
      `config.tUSDC/tETH/tBTC must enumerate all pool tokens.`,
    );
  }
  const plan = buildSeedPlan(tokenAKey, tokenBKey);
  const decA = DECIMALS_BY_TOKEN_KEY[tokenAKey]!;
  const decB = DECIMALS_BY_TOKEN_KEY[tokenBKey]!;

  const state = loadState();
  console.log(`[seed-lp] starting; pool_id=${POOL_ID}; resuming from step ${state.step}`);
  console.log(`[seed-lp] node=${NODE_URL}`);
  console.log(`[seed-lp] pool=${poolEntry.address}`);
  console.log(`[seed-lp] token_a=${tokenAKey} (${poolEntry.token_a}, dec ${decA})`);
  console.log(`[seed-lp] token_b=${tokenBKey} (${poolEntry.token_b}, dec ${decB})`);
  console.log(`[seed-lp] seed plan: amount_a=${plan.amountA} ${tokenAKey} atomic + amount_b=${plan.amountB} ${tokenBKey} atomic → bucket ${TARGET_BUCKET}`);
  console.log(`[seed-lp] state file: ${STATE}`);

  if (state.step >= 7 && state.txHash) {
    console.log(`[seed-lp] ALREADY SEEDED at txHash=${state.txHash}; bucket=${state.bucketId} amountA=${state.amountADeposited} amountB=${state.amountBDeposited}`);
    console.log(`[seed-lp] delete ${STATE} to re-seed.`);
    return;
  }

  // ── Step 1: connect node + load admin wallet (non-ephemeral PXE) ──────
  const _rawNode = createAztecNodeClient(NODE_URL);
  console.log(`[seed-lp] step 1: connecting to node @ ${NODE_URL} ...`);
  await waitForNode(_rawNode);
  // STATIC fee override (see redeploy-testnet.ts): aztec-labs' getCurrentMinFees()
  // does an L1 read that 429s. Wrap the node so it returns a fixed min-fee, letting
  // every .send() skip that call. Ceiling only — real base fee still charged.
  const _sL2 = process.env.STATIC_MAX_FEE_PER_L2_GAS;
  const _sDa = process.env.STATIC_MAX_FEE_PER_DA_GAS ?? "0";
  const node: any = _sL2
    ? new Proxy(_rawNode as any, {
        get(t, p, r) {
          if (p === "getCurrentMinFees") {
            return async () => new GasFees(BigInt(_sDa), BigInt(_sL2));
          }
          const v = Reflect.get(t, p, r);
          return typeof v === "function" ? v.bind(t) : v;
        },
      })
    : _rawNode;
  if (_sL2) console.log(`[seed-lp] STATIC maxFeesPerGas override active: daGas=${_sDa} l2Gas=${_sL2}`);
  const nodeInfo = await node.getNodeInfo();
  console.log(`[seed-lp]   node OK; rollupVersion=${nodeInfo.rollupVersion} l1ChainId=${nodeInfo.l1ChainId}`);

  // Re-use the M3 PXE so contract classes/instances (tUSDC, tETH, pool) are
  // already registered. M3 deployed all three through this same PXE store.
  const wallet = await EmbeddedWallet.create(node, {
    ephemeral: false,
    pxe: {
      proverEnabled: true,
      dataDirectory: PXE_DIR,
    },
  });

  const secret    = Fr.fromString(m1.secret);
  const salt      = Fr.fromString(m1.salt);
  const signingKey = Fq.fromString(m1.signingKey);
  const adminManager = await wallet.createSchnorrAccount(secret, salt, signingKey);
  const admin = (await adminManager.getAccount()).getAddress();
  console.log(`[seed-lp]   admin recreated: ${admin.toString()}`);

  // Verify admin matches config.
  if (admin.toString() !== m1.address) {
    throw new Error(`admin address mismatch vs M1: ${admin.toString()} vs ${m1.address}`);
  }
  if (admin.toString().toLowerCase() !== config.admin.toLowerCase()) {
    throw new Error(
      `admin address mismatch vs config: ${admin.toString()} vs ${config.admin}`,
    );
  }
  console.log(`[seed-lp]   admin matches config.admin ✓`);

  // Construct contract handles. Use AztecAddress (strict type) for the
  // ContractClass.at() bindings.
  const tokenAAddr = AztecAddress.fromStringUnsafe(poolEntry.token_a);
  const tokenBAddr = AztecAddress.fromStringUnsafe(poolEntry.token_b);
  const poolAddr   = AztecAddress.fromStringUnsafe(poolEntry.address);

  const tokenA = await TokenContract.at(tokenAAddr, wallet);
  const tokenB = await TokenContract.at(tokenBAddr, wallet);
  const pool   = await LiquidityPoolContract.at(poolAddr, wallet);

  // ── Step 2: check + top up admin's token-A PRIVATE balance ─────────────
  if (state.step < 2) {
    console.log(`[seed-lp] step 2: checking admin's ${tokenAKey} (token A) PRIVATE balance ...`);
    const balA = await readPrivateBalance(tokenA, admin);
    console.log(`[seed-lp]   admin ${tokenAKey} private balance: ${balA}`);
    if (balA < plan.amountA) {
      const shortfall = plan.amountA - balA;
      console.log(`[seed-lp]   shortfall ${shortfall} ${tokenAKey} atomic → mint_to_private(admin, shortfall) ...`);
      const t0 = Date.now();
      await tokenA.methods.mint_to_private(admin, shortfall).send({ from: admin });
      console.log(`[seed-lp]   mint OK (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
      noteAdd(state, `minted ${shortfall} ${tokenAKey} to admin private (had ${balA})`);
    } else {
      console.log(`[seed-lp]   sufficient balance; no mint needed`);
    }
    state.step = 2;
    saveState(state);
  } else {
    console.log(`[seed-lp] step 2 cached`);
  }

  // ── Step 3: same for token B (only if we elect to send amount_b > 0) ──
  // For a fresh pool the math discards amount_b. We still expose this step
  // because a re-seed at a non-fresh pool (sqrt_p moved) may need token B.
  if (state.step < 3) {
    if (plan.amountB > 0n) {
      console.log(`[seed-lp] step 3: checking admin's ${tokenBKey} (token B) PRIVATE balance ...`);
      const balB = await readPrivateBalance(tokenB, admin);
      console.log(`[seed-lp]   admin ${tokenBKey} private balance: ${balB}`);
      if (balB < plan.amountB) {
        const shortfall = plan.amountB - balB;
        console.log(`[seed-lp]   shortfall ${shortfall} ${tokenBKey} atomic → mint_to_private(admin, shortfall) ...`);
        const t0 = Date.now();
        await tokenB.methods.mint_to_private(admin, shortfall).send({ from: admin });
        console.log(`[seed-lp]   mint OK (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
        noteAdd(state, `minted ${shortfall} ${tokenBKey} to admin private (had ${balB})`);
      } else {
        console.log(`[seed-lp]   sufficient balance; no mint needed`);
      }
    } else {
      console.log(`[seed-lp] step 3 skipped (amountB=0)`);
    }
    state.step = 3;
    saveState(state);
  } else {
    console.log(`[seed-lp] step 3 cached`);
  }

  // ── Step 4: read pool + bucket state (hints) ──────────────────────────
  console.log(`[seed-lp] step 4: reading pool + bucket ${TARGET_BUCKET} state for hints ...`);
  const poolHint   = await readPoolHint(pool, admin);
  const bucketHint = await readBucketHint(pool, TARGET_BUCKET, admin);
  console.log(`[seed-lp]   pool.current_sqrt_price: ${poolHint.current_sqrt_price}`);
  console.log(`[seed-lp]   pool.reserve_a: ${poolHint.reserve_a}`);
  console.log(`[seed-lp]   pool.reserve_b: ${poolHint.reserve_b}`);
  console.log(`[seed-lp]   bucket[${TARGET_BUCKET}].liquidity: ${bucketHint.liquidity}`);
  state.poolStateBefore = {
    reserve_a: poolHint.reserve_a.toString(),
    reserve_b: poolHint.reserve_b.toString(),
    current_sqrt_price: poolHint.current_sqrt_price.toString(),
  };
  state.bucketStateBefore = {
    reserve_a: bucketHint.reserve_a.toString(),
    reserve_b: bucketHint.reserve_b.toString(),
    liquidity: bucketHint.liquidity.toString(),
    cum_fee_a_per_share: bucketHint.cum_fee_a_per_share.toString(),
    cum_fee_b_per_share: bucketHint.cum_fee_b_per_share.toString(),
  };
  saveState(state);

  // ── Step 5: pre-compute V3 deposit math (off-chain dry-run) ───────────
  const pMinSqrt = BigInt(config.bucketPMinSqrt);
  const growthNum = BigInt(config.bucketGrowthNum);
  const bounds = computeBucketBounds(pMinSqrt, growthNum, TARGET_BUCKET);
  console.log(`[seed-lp] step 5: dry-running deposit math ...`);
  console.log(`[seed-lp]   bucket[${TARGET_BUCKET}].sqrt_lower: ${bounds.sqrt_lower}`);
  console.log(`[seed-lp]   bucket[${TARGET_BUCKET}].sqrt_upper: ${bounds.sqrt_upper}`);
  console.log(`[seed-lp]   pool.current_sqrt_price        : ${poolHint.current_sqrt_price}`);

  let depositAmountB = plan.amountB;
  let regime: "below" | "in-range" | "above";
  if (poolHint.current_sqrt_price <= bounds.sqrt_lower) {
    regime = "below";
    console.log(`[seed-lp]   regime: BelowRange — only token A counts; ${tokenBKey} would be fully refunded`);
    console.log(`[seed-lp]   ⇒ setting amount_b=0 to skip a futile escrow + refund round-trip`);
    depositAmountB = 0n;
  } else if (poolHint.current_sqrt_price >= bounds.sqrt_upper) {
    regime = "above";
    console.log(`[seed-lp]   regime: AboveRange — only token B counts; ${tokenAKey} would be fully refunded`);
    // Not the seed-script's expected path, but handle for correctness:
    // we don't override amounts here because operator was explicit about both.
  } else {
    regime = "in-range";
    console.log(`[seed-lp]   regime: InRange — both tokens deposited proportionally`);
  }

  const math = computeDeposit(plan.amountA, depositAmountB, poolHint.current_sqrt_price, bounds);
  console.log(`[seed-lp]   math.l_used: ${math.l_used}`);
  console.log(`[seed-lp]   math.used_a: ${math.used_a}`);
  console.log(`[seed-lp]   math.used_b: ${math.used_b}`);
  if (math.l_used === 0n) {
    throw new Error(
      `dry-run computed l_used == 0; the deposit would revert. ` +
      `regime=${regime} amount_a=${plan.amountA} amount_b=${depositAmountB}. ` +
      `Pick a different bucket or amount.`,
    );
  }
  state.lUsedExpected = math.l_used.toString();
  saveState(state);

  // ── Step 6: submit pool.deposit ───────────────────────────────────────
  if (state.step < 6) {
    console.log(`[seed-lp] step 6: pool.deposit(${TARGET_BUCKET}, ${plan.amountA}, ${depositAmountB}, ...) ...`);
    const nonceA = Fr.random();
    // Use Fr.ZERO for the unused nonce — the contract's
    // `if amount_b > 0` guard skips the transfer when amount_b == 0.
    const nonceB = depositAmountB > 0n ? Fr.random() : Fr.ZERO;
    const positionNonce = Fr.random();
    state.positionNonce = positionNonce.toString();
    state.bucketId = TARGET_BUCKET;
    state.amountADeposited = plan.amountA.toString();
    state.amountBDeposited = depositAmountB.toString();
    saveState(state);

    const t0 = Date.now();
    let lastErr: unknown;
    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        console.log(`[seed-lp]   attempt ${attempt}/${maxAttempts} ...`);
        // Re-read hints on retry — sequencer may have applied a clearing
        // between dry-run and submit, which would shift pool/bucket state.
        const ph = await readPoolHint(pool, admin);
        const bh = await readBucketHint(pool, TARGET_BUCKET, admin);

        const tx = pool.methods.deposit(
          TARGET_BUCKET,
          plan.amountA,
          depositAmountB,
          {
            reserve_a: ph.reserve_a,
            reserve_b: ph.reserve_b,
            current_sqrt_price: ph.current_sqrt_price,
          },
          {
            reserve_a: bh.reserve_a,
            reserve_b: bh.reserve_b,
            liquidity: bh.liquidity,
            cum_fee_a_per_share: bh.cum_fee_a_per_share,
            cum_fee_b_per_share: bh.cum_fee_b_per_share,
          },
          nonceA,
          nonceB,
          positionNonce,
        );
        const sent = await tx.send({ from: admin });
        // txHash is exposed on the mined result at runtime even though
        // TxSendResultMined's public type doesn't declare it; mirrors the
        // pattern in scripts/lib/aztec-wallet-bootstrap.ts.
        const sentAny = sent as unknown as { txHash?: { toString(): string } | string };
        const txHashStr = typeof sentAny.txHash === "object"
          ? (sentAny.txHash?.toString() ?? String(sentAny.txHash))
          : String(sentAny.txHash);
        console.log(`[seed-lp]   deposit submitted; txHash=${txHashStr} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
        state.txHash = txHashStr;
        state.step = 6;
        saveState(state);
        break;
      } catch (e) {
        lastErr = e;
        const msg = e instanceof Error ? e.message : String(e);
        console.log(`[seed-lp]   attempt ${attempt} failed: ${msg.slice(0, 400)}`);
        const isRetryable = /pool_state changed|bucket_state changed|hint|retry|tag|nonce|sequencer/i.test(msg);
        if (!isRetryable || attempt === maxAttempts) {
          noteAdd(state, `deposit failed after ${attempt} attempts: ${msg.slice(0, 200)}`);
          saveState(state);
          throw e;
        }
        console.log(`[seed-lp]   retryable; sleeping 20s + re-reading hints ...`);
        await sleep(20_000);
      }
    }
    if (!state.txHash) {
      throw new Error(`deposit never succeeded; last error: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`);
    }
  } else {
    console.log(`[seed-lp] step 6 cached; txHash=${state.txHash}`);
  }

  // ── Step 7: verify ────────────────────────────────────────────────────
  if (state.step < 7) {
    console.log(`[seed-lp] step 7: verifying on-chain state ...`);
    const phAfter = await readPoolHint(pool, admin);
    const bhAfter = await readBucketHint(pool, TARGET_BUCKET, admin);

    // PositionNote count — guarded since some PXE versions return slightly
    // different shapes. We tolerate missing data.
    let positionCount = -1;
    try {
      const posSim = await pool.methods.get_positions(admin).simulate({ from: admin });
      const bv = (posSim as { result: { storage: unknown[]; len: bigint | number } }).result;
      positionCount = Number(bv.len);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.log(`[seed-lp]   WARN: get_positions failed (${msg.slice(0, 120)}); skipping count check`);
    }

    state.poolStateAfter = {
      reserve_a: phAfter.reserve_a.toString(),
      reserve_b: phAfter.reserve_b.toString(),
      current_sqrt_price: phAfter.current_sqrt_price.toString(),
    };
    state.bucketStateAfter = {
      reserve_a: bhAfter.reserve_a.toString(),
      reserve_b: bhAfter.reserve_b.toString(),
      liquidity: bhAfter.liquidity.toString(),
      cum_fee_a_per_share: bhAfter.cum_fee_a_per_share.toString(),
      cum_fee_b_per_share: bhAfter.cum_fee_b_per_share.toString(),
    };
    state.positionCountAfter = positionCount;
    state.step = 7;
    saveState(state);

    console.log(`SEED VERIFIED:`);
    console.log(`  pool.current_sqrt_price: ${phAfter.current_sqrt_price}`);
    console.log(`  pool.reserve_a (total):  ${phAfter.reserve_a}`);
    console.log(`  pool.reserve_b (total):  ${phAfter.reserve_b}`);
    console.log(`  bucket[${TARGET_BUCKET}].liquidity:    ${bhAfter.liquidity}`);
    console.log(`  bucket[${TARGET_BUCKET}].reserve_a:    ${bhAfter.reserve_a}`);
    console.log(`  bucket[${TARGET_BUCKET}].reserve_b:    ${bhAfter.reserve_b}`);
    if (positionCount >= 0) {
      console.log(`  admin.position_count:    ${positionCount}`);
    }

    if (bhAfter.liquidity === 0n) {
      throw new Error(
        `verify failed: bucket[${TARGET_BUCKET}].liquidity is still 0 after deposit ` +
        `(expected ~${state.lUsedExpected}). On-chain state did not update.`,
      );
    }
  } else {
    console.log(`[seed-lp] step 7 cached`);
  }

  // ── Summary ───────────────────────────────────────────────────────────
  console.log("");
  console.log(`[seed-lp] ALL STEPS PASSED.`);
  console.log(`[seed-lp]   pool_id:     ${POOL_ID}`);
  console.log(`[seed-lp]   pool:        ${poolEntry.address}`);
  console.log(`[seed-lp]   bucket:      ${state.bucketId}`);
  console.log(`[seed-lp]   amount_a:    ${state.amountADeposited} ${tokenAKey} atomic`);
  console.log(`[seed-lp]   amount_b:    ${state.amountBDeposited} ${tokenBKey} atomic`);
  console.log(`[seed-lp]   l_used:      ${state.lUsedExpected} (expected, math)`);
  console.log(`[seed-lp]   position:    ${state.positionNonce}`);
  console.log(`[seed-lp]   txHash:      ${state.txHash}`);
  console.log(`[seed-lp]   explorer:    https://aztecscan.xyz/tx-effects/${state.txHash}`);

  await wallet.stop();
}

main().catch((e) => {
  console.error(`[seed-lp] FAILED:`, e);
  console.error(`[seed-lp] partial state persisted to ${STATE}; re-run to resume.`);
  process.exit(1);
});
