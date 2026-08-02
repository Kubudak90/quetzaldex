#!/usr/bin/env node
//
// deepen-pools.ts — add ADDITIONAL liquidity into each pool's bucket 0 to raise
// the bucket liquidity L (and the two-sided reserves) to a usable testnet depth.
//
// Why a SEPARATE script from seed-lp.ts
// ─────────────────────────────────────
// seed-lp.ts only handles the BelowRange regime: a fresh pool sits at p_min, so
// for ANY bucket >= 0 the price is below the bucket's sqrt_lower → only token A
// is deposited (it pre-zeros amount_b to skip a futile escrow + refund). After
// warm-up clears, each pool's price has moved INTO bucket 0's interior (in-range),
// so a deposit there must supply BOTH tokens — the V3 contract takes the
// proportional amount per the current price and refunds the excess.
//
// deepen-pools.ts is therefore REGIME-AGNOSTIC: it over-provides BOTH tokens
// generously and lets the contract take the proportional amount + refund the
// rest. It works whether bucket 0 is below-range, in-range, or above-range.
//
// What it does, per selected pool:
//   1. Load admin wallet + node (STATIC fee Proxy). Verify admin == config.admin.
//   2. Read live get_pool_state() + get_bucket(0) for the deposit hints.
//   3. Determine the deposit regime from current_sqrt_price vs bucket-0 bounds.
//   4. PREFLIGHT with computeDeposit (offline): predict used_a/used_b and the
//      RESULTING bucket-0 L (= current L + added L). Print them.
//      HARD GUARD: if resulting L >= 2^64, reduce amount_a (logged) so L stays
//      safely < 2^64 — the circuit's mul_div asserts divisor < 2^64, otherwise
//      a clearing against this bucket can never verify.
//   5. Ensure admin PRIVATE balances of BOTH tokens >= the amounts; mint the
//      shortfall via mint_to_private (admin is minter, no authwit).
//   6. Call pool.deposit(0, amount_a, amount_b, hint_pool, hint_bucket, ...)
//      with BOTH amounts non-zero (do NOT zero amount_b).
//   7. Re-read pool + bucket 0; print before/after; assert L grew (and, for
//      in-range pools, reserve_b grew).
//   8. Per-pool state file deepen-pools-state-<id>.json (records txHash +
//      amounts + resulting L). Re-run skips a deposited pool unless --force.
//
// Pool selection: --pool=<id>, or env DEEPEN_POOLS="0,1,2" (default ALL).
// Amount overrides: DEEPEN_AMOUNT_A_<id> / DEEPEN_AMOUNT_B_<id> (atomic units).
//
// SAFETY: refuses to run unless AZTEC_NODE_URL contains 'testnet'.
//
// Usage:
//   AZTEC_NODE_URL=https://rpc.testnet.aztec-labs.com \
//   STATIC_MAX_FEE_PER_L2_GAS=200000000 \
//   pnpm tsx scripts/deepen-pools.ts --pool=0
//
//   DEEPEN_POOLS="0,1,2" pnpm tsx scripts/deepen-pools.ts
//   DEEPEN_POOLS="0" DEEPEN_AMOUNT_A_0=40000000000000000000 pnpm tsx scripts/deepen-pools.ts
//   pnpm tsx scripts/deepen-pools.ts --pool=0 --force   # re-deposit even if done
//
// State files: deepen-pools-state-<id>.json (one per pool).
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
import { computeDeposit, SCALE, type BucketBounds } from "../aggregator/src/buckets.js";

// ─── Config ───────────────────────────────────────────────────────────────

const NODE_URL = process.env.AZTEC_NODE_URL ?? "https://rpc.testnet.aztec-labs.com";
if (!NODE_URL.includes("testnet")) {
  throw new Error(
    `AZTEC_NODE_URL must contain 'testnet' (safety check). Got: ${NODE_URL}`,
  );
}

const M1_STATE = "testnet-m1-state.json";
const CONFIG = "quetzal.config.json";
// PXE dir. Defaults to Sub-9 testnet-m4-pxe (post-clean-slate redeploy), matching
// seed-lp.ts. Override via SEED_LP_PXE_DIR to re-use a different PXE.
const PXE_DIR = process.env.SEED_LP_PXE_DIR ?? "./testnet-m4-pxe";

// We always deepen bucket 0 — the bucket the pool price lives in after warm-up.
const TARGET_BUCKET = 0;

// Circuit invariant: mul_div asserts divisor < 2^64, so a bucket's liquidity L
// must stay strictly below 2^64 or a clearing against it can never verify.
const TWO_64 = 18446744073709551616n; // 2^64

// Force re-deposit even if a pool's state file records a prior deposit.
const FORCE = process.argv.includes("--force") || process.env.DEEPEN_FORCE === "1";

// Atomic units.
const ONE_TUSDC = 10n ** 6n;
const ONE_TETH = 10n ** 18n;
const ONE_TBTC = 10n ** 8n;

// Token decimals lookup (logging only).
const DECIMALS_BY_TOKEN_KEY: Record<string, number> = {
  tUSDC: 6, tETH: 18, tBTC: 8,
};

// Default deepen amounts per pool (atomic units). Provide BOTH tokens generously
// and let the contract take the proportional amount + refund the excess.
//   pool 0 (token_a=tETH 18dec, token_b=tUSDC 6dec): 20 tETH + 2000 tUSDC
//   pool 1 (token_a=tBTC  8dec, token_b=tUSDC 6dec):  5 tBTC + 2000 tUSDC
//   pool 2 (token_a=tBTC  8dec, token_b=tETH 18dec):  5 tBTC + 20  tETH
// Override per pool via DEEPEN_AMOUNT_A_<id> / DEEPEN_AMOUNT_B_<id>.
const DEFAULT_AMOUNTS: Record<number, { amountA: bigint; amountB: bigint }> = {
  0: { amountA: 20n * ONE_TETH, amountB: 2000n * ONE_TUSDC },
  1: { amountA: 5n * ONE_TBTC, amountB: 2000n * ONE_TUSDC },
  2: { amountA: 5n * ONE_TBTC, amountB: 20n * ONE_TETH },
};

// ─── Pool selection (--pool=<id> | DEEPEN_POOLS="0,1,2" | default ALL) ───────
function parsePoolIds(allIds: number[]): number[] {
  const flagArg = process.argv.find((a) => a.startsWith("--pool="));
  if (flagArg) {
    const raw = flagArg.slice("--pool=".length);
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0) {
      throw new Error(`invalid --pool=${raw}; must be a non-negative integer`);
    }
    return [n];
  }
  if (process.env.DEEPEN_POOLS) {
    const ids = process.env.DEEPEN_POOLS.split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .map((s) => {
        const n = Number(s);
        if (!Number.isInteger(n) || n < 0) {
          throw new Error(`invalid DEEPEN_POOLS entry '${s}'`);
        }
        return n;
      });
    if (ids.length === 0) throw new Error(`DEEPEN_POOLS is empty`);
    return ids;
  }
  return allIds;
}

// Per-pool amount overrides (atomic units, decimal string).
function amountOverride(envName: string): bigint | undefined {
  const v = process.env[envName];
  if (v === undefined) return undefined;
  let n: bigint;
  try {
    n = BigInt(v);
  } catch {
    throw new Error(`invalid ${envName}=${v}; must be an integer (atomic units)`);
  }
  if (n <= 0n) throw new Error(`invalid ${envName}=${v}; must be > 0`);
  return n;
}

// ─── Types ────────────────────────────────────────────────────────────────

interface DeepenState {
  poolId: number;
  done: boolean;
  txHash?: string;
  bucketId?: number;
  regime?: "below" | "in-range" | "above";
  amountARequested?: string;     // bigint as decimal string (what we passed)
  amountBRequested?: string;
  amountAReduced?: boolean;      // whether the 2^64 guard reduced amount_a
  lAddedExpected?: string;       // math-predicted l added by THIS deposit
  lResultingExpected?: string;   // current L + added L (predicted)
  positionNonce?: string;        // 0x-hex
  poolStateBefore?: PoolStateRecord;
  bucketStateBefore?: BucketStateRecord;
  poolStateAfter?: PoolStateRecord;
  bucketStateAfter?: BucketStateRecord;
  notes?: string[];
}

interface PoolStateRecord {
  reserve_a: string;
  reserve_b: string;
  current_sqrt_price: string;
}
interface BucketStateRecord {
  reserve_a: string;
  reserve_b: string;
  liquidity: string;
  cum_fee_a_per_share: string;
  cum_fee_b_per_share: string;
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

// ─── State helpers ──────────────────────────────────────────────────────────

function stateFile(poolId: number): string {
  return `deepen-pools-state-${poolId}.json`;
}
function loadState(poolId: number): DeepenState {
  const f = stateFile(poolId);
  if (existsSync(f)) return JSON.parse(readFileSync(f, "utf8")) as DeepenState;
  return { poolId, done: false, notes: [] };
}
function saveState(s: DeepenState): void {
  writeFileSync(stateFile(s.poolId), JSON.stringify(s, null, 2));
}
function noteAdd(s: DeepenState, msg: string): void {
  s.notes = s.notes ?? [];
  s.notes.push(`${new Date().toISOString()} ${msg}`);
}

// ─── Pool / bucket helpers (copied from seed-lp.ts / read-pools.ts) ─────────

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

// Mirrors contracts/pool/src/main.nr::compute_bucket_bounds (and read-pools.ts).
function computeBucketBounds(
  pMinSqrt: bigint, growthNum: bigint, bucketId: number,
): BucketBounds {
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

function regimeOf(sqrtP: bigint, bounds: BucketBounds): "below" | "in-range" | "above" {
  if (sqrtP <= bounds.sqrt_lower) return "below";
  if (sqrtP >= bounds.sqrt_upper) return "above";
  return "in-range";
}

// Predict the bucket-0 L that THIS deposit would add. The 2^64 guard scales
// amount_a down (keeping amount_b fixed) until current_L + added_L < 2^64, then
// returns the (possibly reduced) amount_a. L is monotonic in amount_a for every
// regime (below/in-range/above), so a simple proportional shrink + verify loop
// converges immediately.
function applyL64Guard(
  amountA: bigint, amountB: bigint, sqrtP: bigint, bounds: BucketBounds, currentL: bigint,
): { amountA: bigint; addedL: bigint; resultingL: bigint; reduced: boolean } {
  let a = amountA;
  let reduced = false;
  for (let i = 0; i < 64; i++) {
    const m = computeDeposit(a, amountB, sqrtP, bounds);
    const resultingL = currentL + m.l_used;
    if (resultingL < TWO_64) {
      return { amountA: a, addedL: m.l_used, resultingL, reduced };
    }
    // Need added_L < (2^64 - currentL). Scale amount_a by the ratio (leave
    // headroom via /10*9). If currentL already >= 2^64 we cannot help — but
    // that is a pre-existing on-chain problem, not something a deposit caused.
    const budget = TWO_64 > currentL ? TWO_64 - currentL : 0n;
    if (budget === 0n || m.l_used === 0n) {
      // Can't reduce further usefully; return whatever we have (caller asserts).
      return { amountA: a, addedL: m.l_used, resultingL, reduced };
    }
    // target addedL ~= 90% of budget; scale a proportionally to its L.
    const target = (budget * 9n) / 10n;
    const next = (a * target) / m.l_used;
    a = next > 0n ? next : a / 2n;
    reduced = true;
    if (a === 0n) return { amountA: 0n, addedL: 0n, resultingL: currentL, reduced };
  }
  // Fallback after max iterations: recompute final.
  const m = computeDeposit(a, amountB, sqrtP, bounds);
  return { amountA: a, addedL: m.l_used, resultingL: currentL + m.l_used, reduced };
}

function txHashString(sent: unknown): string {
  // txHash is exposed on the mined result at runtime even though the public
  // type doesn't declare it; mirrors seed-lp.ts.
  const s = sent as { txHash?: { toString(): string } | string };
  return typeof s.txHash === "object"
    ? (s.txHash?.toString() ?? String(s.txHash))
    : String(s.txHash);
}

// ─── Per-pool deepen ─────────────────────────────────────────────────────────

interface DeepenResult {
  poolId: number;
  tokenAKey: string;
  tokenBKey: string;
  skipped: boolean;
  before?: { L: bigint; rA: bigint; rB: bigint };
  after?: { L: bigint; rA: bigint; rB: bigint };
  txHash?: string;
}

async function deepenPool(
  poolEntry: QuetzalConfig["pools"][number],
  config: QuetzalConfig,
  wallet: EmbeddedWallet,
  admin: AztecAddress,
  tokenAddrToKey: Record<string, string>,
): Promise<DeepenResult> {
  const poolId = poolEntry.pool_id;
  const tokenAKey = tokenAddrToKey[poolEntry.token_a.toLowerCase()];
  const tokenBKey = tokenAddrToKey[poolEntry.token_b.toLowerCase()];
  if (!tokenAKey || !tokenBKey) {
    throw new Error(
      `pool ${poolId} references unknown token (a=${poolEntry.token_a} b=${poolEntry.token_b}); ` +
      `config.tUSDC/tETH/tBTC must enumerate all pool tokens.`,
    );
  }
  const decA = DECIMALS_BY_TOKEN_KEY[tokenAKey]!;
  const decB = DECIMALS_BY_TOKEN_KEY[tokenBKey]!;

  // Resolve target amounts (defaults + per-pool overrides).
  const defaults = DEFAULT_AMOUNTS[poolId];
  if (!defaults) {
    throw new Error(
      `no default deepen amounts for pool ${poolId}; ` +
      `set DEEPEN_AMOUNT_A_${poolId} and DEEPEN_AMOUNT_B_${poolId}`,
    );
  }
  const amountA0 = amountOverride(`DEEPEN_AMOUNT_A_${poolId}`) ?? defaults.amountA;
  const amountB = amountOverride(`DEEPEN_AMOUNT_B_${poolId}`) ?? defaults.amountB;

  const state = loadState(poolId);
  console.log(`\n========================================================`);
  console.log(`[deepen] pool ${poolId}  (token_a=${tokenAKey} dec${decA}, token_b=${tokenBKey} dec${decB})`);
  console.log(`[deepen]   address: ${poolEntry.address}`);
  console.log(`[deepen]   target amount_a=${amountA0} ${tokenAKey} + amount_b=${amountB} ${tokenBKey}`);
  console.log(`[deepen]   state file: ${stateFile(poolId)}`);

  if (state.done && state.txHash && !FORCE) {
    console.log(`[deepen]   ALREADY DEEPENED at txHash=${state.txHash}; use --force to deposit again.`);
    return { poolId, tokenAKey, tokenBKey, skipped: true, txHash: state.txHash };
  }

  // Contract handles.
  const tokenAAddr = AztecAddress.fromStringUnsafe(poolEntry.token_a);
  const tokenBAddr = AztecAddress.fromStringUnsafe(poolEntry.token_b);
  const poolAddr = AztecAddress.fromStringUnsafe(poolEntry.address);
  const tokenA = await TokenContract.at(tokenAAddr, wallet);
  const tokenB = await TokenContract.at(tokenBAddr, wallet);
  const pool = await LiquidityPoolContract.at(poolAddr, wallet);

  // ── Read live pool + bucket-0 state (for hints + regime + preflight) ──────
  console.log(`[deepen]   reading live pool + bucket ${TARGET_BUCKET} state ...`);
  const poolHint = await readPoolHint(pool, admin);
  const bucketHint = await readBucketHint(pool, TARGET_BUCKET, admin);
  console.log(`[deepen]   pool.current_sqrt_price : ${poolHint.current_sqrt_price}`);
  console.log(`[deepen]   pool.reserve_a / _b     : ${poolHint.reserve_a} / ${poolHint.reserve_b}`);
  console.log(`[deepen]   bucket[0].liquidity     : ${bucketHint.liquidity}`);
  console.log(`[deepen]   bucket[0].reserve_a / _b: ${bucketHint.reserve_a} / ${bucketHint.reserve_b}`);

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

  // ── Determine regime ──────────────────────────────────────────────────────
  const pMinSqrt = BigInt(config.bucketPMinSqrt);
  const growthNum = BigInt(config.bucketGrowthNum);
  const bounds = computeBucketBounds(pMinSqrt, growthNum, TARGET_BUCKET);
  const regime = regimeOf(poolHint.current_sqrt_price, bounds);
  console.log(`[deepen]   bucket[0] bounds: sqrt_lower=${bounds.sqrt_lower} sqrt_upper=${bounds.sqrt_upper}`);
  console.log(`[deepen]   REGIME: ${regime}`);
  if (regime === "below") {
    console.log(`[deepen]     (below-range — contract takes token A only; token B refunded)`);
  } else if (regime === "above") {
    console.log(`[deepen]     (above-range — contract takes token B only; token A refunded)`);
  } else {
    console.log(`[deepen]     (in-range — contract takes BOTH proportionally; excess refunded)`);
  }
  state.regime = regime;

  // ── PREFLIGHT with computeDeposit + 2^64 guard ────────────────────────────
  const preview = computeDeposit(amountA0, amountB, poolHint.current_sqrt_price, bounds);
  console.log(`[deepen]   preflight computeDeposit: l_used=${preview.l_used} used_a=${preview.used_a} used_b=${preview.used_b}`);
  const guard = applyL64Guard(amountA0, amountB, poolHint.current_sqrt_price, bounds, bucketHint.liquidity);
  let amountA = guard.amountA;
  if (guard.reduced) {
    console.log(`[deepen]   *** L<2^64 GUARD: reduced amount_a ${amountA0} → ${amountA} ` +
      `(current L=${bucketHint.liquidity}, would-be resulting L exceeded 2^64) ***`);
    noteAdd(state, `2^64 guard reduced amount_a ${amountA0} → ${amountA}`);
  }
  console.log(`[deepen]   predicted added L=${guard.addedL}  resulting bucket-0 L=${guard.resultingL}`);
  console.log(`[deepen]   2^64 = ${TWO_64}`);
  if (guard.resultingL >= TWO_64) {
    throw new Error(
      `pool ${poolId}: resulting bucket-0 L=${guard.resultingL} still >= 2^64 even after guard ` +
      `(current L=${bucketHint.liquidity}). Cannot safely deposit; reduce amounts or skip this pool.`,
    );
  }
  if (amountA === 0n) {
    throw new Error(`pool ${poolId}: 2^64 guard reduced amount_a to 0; nothing to deposit.`);
  }

  const finalPreview = computeDeposit(amountA, amountB, poolHint.current_sqrt_price, bounds);
  if (finalPreview.l_used === 0n) {
    throw new Error(
      `pool ${poolId}: preflight l_used == 0 (deposit would revert). ` +
      `regime=${regime} amount_a=${amountA} amount_b=${amountB}. Adjust amounts.`,
    );
  }
  state.amountARequested = amountA.toString();
  state.amountBRequested = amountB.toString();
  state.amountAReduced = guard.reduced;
  state.lAddedExpected = guard.addedL.toString();
  state.lResultingExpected = guard.resultingL.toString();
  state.bucketId = TARGET_BUCKET;
  saveState(state);

  // ── Ensure admin PRIVATE balances of BOTH tokens >= the amounts ───────────
  console.log(`[deepen]   checking admin private balance of ${tokenAKey} (>= ${amountA}) ...`);
  const balA = await readPrivateBalance(tokenA, admin);
  console.log(`[deepen]     admin ${tokenAKey} private balance: ${balA}`);
  if (balA < amountA) {
    const shortfall = amountA - balA;
    console.log(`[deepen]     shortfall ${shortfall} ${tokenAKey} → mint_to_private(admin, shortfall) ...`);
    const t0 = Date.now();
    await tokenA.methods.mint_to_private(admin, shortfall).send({ from: admin });
    console.log(`[deepen]     mint OK (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
    noteAdd(state, `minted ${shortfall} ${tokenAKey} to admin private (had ${balA})`);
    saveState(state);
  } else {
    console.log(`[deepen]     sufficient; no mint needed`);
  }

  console.log(`[deepen]   checking admin private balance of ${tokenBKey} (>= ${amountB}) ...`);
  const balB = await readPrivateBalance(tokenB, admin);
  console.log(`[deepen]     admin ${tokenBKey} private balance: ${balB}`);
  if (balB < amountB) {
    const shortfall = amountB - balB;
    console.log(`[deepen]     shortfall ${shortfall} ${tokenBKey} → mint_to_private(admin, shortfall) ...`);
    const t0 = Date.now();
    await tokenB.methods.mint_to_private(admin, shortfall).send({ from: admin });
    console.log(`[deepen]     mint OK (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
    noteAdd(state, `minted ${shortfall} ${tokenBKey} to admin private (had ${balB})`);
    saveState(state);
  } else {
    console.log(`[deepen]     sufficient; no mint needed`);
  }

  // ── Submit pool.deposit (BOTH amounts non-zero) ───────────────────────────
  const positionNonce = Fr.random();
  state.positionNonce = positionNonce.toString();
  saveState(state);

  console.log(`[deepen]   pool.deposit(0, amount_a=${amountA}, amount_b=${amountB}, ...) ...`);
  const t0 = Date.now();
  let lastErr: unknown;
  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      console.log(`[deepen]     attempt ${attempt}/${maxAttempts} ...`);
      // Re-read hints on every attempt — a clearing may have shifted state
      // between preflight and submit.
      const ph = await readPoolHint(pool, admin);
      const bh = await readBucketHint(pool, TARGET_BUCKET, admin);

      const tx = pool.methods.deposit(
        TARGET_BUCKET,
        amountA,
        amountB,
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
        Fr.random(), // nonce_a — both amounts > 0, so both transfers run
        Fr.random(), // nonce_b
        positionNonce,
      );
      const sent = await tx.send({ from: admin });
      const txHashStr = txHashString(sent);
      console.log(`[deepen]     deposit submitted; txHash=${txHashStr} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
      state.txHash = txHashStr;
      saveState(state);
      break;
    } catch (e) {
      lastErr = e;
      const msg = e instanceof Error ? e.message : String(e);
      console.log(`[deepen]     attempt ${attempt} failed: ${msg.slice(0, 400)}`);
      const isRetryable = /pool_state changed|bucket_state changed|hint|retry|tag|nonce|sequencer/i.test(msg);
      if (!isRetryable || attempt === maxAttempts) {
        noteAdd(state, `deposit failed after ${attempt} attempts: ${msg.slice(0, 200)}`);
        saveState(state);
        throw e;
      }
      console.log(`[deepen]     retryable; sleeping 20s + re-reading hints ...`);
      await sleep(20_000);
    }
  }
  if (!state.txHash) {
    throw new Error(`deposit never succeeded; last error: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`);
  }

  // ── Re-read + verify ──────────────────────────────────────────────────────
  console.log(`[deepen]   verifying on-chain state ...`);
  const phAfter = await readPoolHint(pool, admin);
  const bhAfter = await readBucketHint(pool, TARGET_BUCKET, admin);
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

  console.log(`[deepen]   bucket[0].liquidity: ${bucketHint.liquidity} → ${bhAfter.liquidity}`);
  console.log(`[deepen]   bucket[0].reserve_a: ${bucketHint.reserve_a} → ${bhAfter.reserve_a}`);
  console.log(`[deepen]   bucket[0].reserve_b: ${bucketHint.reserve_b} → ${bhAfter.reserve_b}`);
  console.log(`[deepen]   pool.reserve_a:      ${poolHint.reserve_a} → ${phAfter.reserve_a}`);
  console.log(`[deepen]   pool.reserve_b:      ${poolHint.reserve_b} → ${phAfter.reserve_b}`);

  if (bhAfter.liquidity <= bucketHint.liquidity) {
    throw new Error(
      `verify failed: pool ${poolId} bucket[0].liquidity did not grow ` +
      `(${bucketHint.liquidity} → ${bhAfter.liquidity}). On-chain state did not update as expected.`,
    );
  }
  if (regime === "in-range" && bhAfter.reserve_b <= bucketHint.reserve_b) {
    throw new Error(
      `verify failed: pool ${poolId} is in-range but bucket[0].reserve_b did not grow ` +
      `(${bucketHint.reserve_b} → ${bhAfter.reserve_b}). Expected both-sided deposit.`,
    );
  }
  if (bhAfter.liquidity >= TWO_64) {
    throw new Error(
      `POST-CHECK: pool ${poolId} bucket[0].liquidity=${bhAfter.liquidity} >= 2^64 after deposit ` +
      `(guard miscomputed). Clearing against this bucket will fail to verify.`,
    );
  }

  state.done = true;
  saveState(state);
  console.log(`[deepen]   pool ${poolId} DEEPENED ✓ txHash=${state.txHash}`);

  return {
    poolId,
    tokenAKey,
    tokenBKey,
    skipped: false,
    before: { L: bucketHint.liquidity, rA: poolHint.reserve_a, rB: poolHint.reserve_b },
    after: { L: bhAfter.liquidity, rA: phAfter.reserve_a, rB: phAfter.reserve_b },
    txHash: state.txHash,
  };
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
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

  const allIds = config.pools.map((p) => p.pool_id);
  const poolIds = parsePoolIds(allIds);
  for (const id of poolIds) {
    if (!config.pools.some((p) => p.pool_id === id)) {
      throw new Error(`pool_id ${id} not in config.pools (available: ${allIds.join(", ")})`);
    }
  }

  // Token address → key.
  const tokenAddrToKey: Record<string, string> = {
    [config.tUSDC.toLowerCase()]: "tUSDC",
    [config.tETH.toLowerCase()]: "tETH",
  };
  if (config.tBTC) tokenAddrToKey[config.tBTC.toLowerCase()] = "tBTC";

  console.log(`[deepen] node=${NODE_URL}`);
  console.log(`[deepen] pools to deepen: ${poolIds.join(", ")}${FORCE ? "  (FORCE)" : ""}`);

  // ── Connect node + STATIC fee Proxy (copied from seed-lp.ts) ──────────────
  const _rawNode = createAztecNodeClient(NODE_URL);
  console.log(`[deepen] connecting to node @ ${NODE_URL} ...`);
  await waitForNode(_rawNode);
  const _sL2 = process.env.STATIC_MAX_FEE_PER_L2_GAS;
  const _sDa = process.env.STATIC_MAX_FEE_PER_DA_GAS ?? "0";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
  if (_sL2) console.log(`[deepen] STATIC maxFeesPerGas override active: daGas=${_sDa} l2Gas=${_sL2}`);
  const nodeInfo = await node.getNodeInfo();
  console.log(`[deepen]   node OK; rollupVersion=${nodeInfo.rollupVersion} l1ChainId=${nodeInfo.l1ChainId}`);

  const wallet = await EmbeddedWallet.create(node, {
    ephemeral: false,
    pxe: {
      proverEnabled: true,
      dataDirectory: PXE_DIR,
    },
  });

  const secret = Fr.fromString(m1.secret);
  const salt = Fr.fromString(m1.salt);
  const signingKey = Fq.fromString(m1.signingKey);
  const adminManager = await wallet.createSchnorrAccount(secret, salt, signingKey);
  const admin = (await adminManager.getAccount()).getAddress();
  console.log(`[deepen]   admin recreated: ${admin.toString()}`);
  if (admin.toString() !== m1.address) {
    throw new Error(`admin address mismatch vs M1: ${admin.toString()} vs ${m1.address}`);
  }
  if (admin.toString().toLowerCase() !== config.admin.toLowerCase()) {
    throw new Error(`admin address mismatch vs config: ${admin.toString()} vs ${config.admin}`);
  }
  console.log(`[deepen]   admin matches config.admin ✓`);

  // ── Deepen each selected pool ─────────────────────────────────────────────
  const results: DeepenResult[] = [];
  const failures: Array<{ poolId: number; error: string }> = [];
  for (const id of poolIds) {
    const poolEntry = config.pools.find((p) => p.pool_id === id)!;
    try {
      results.push(await deepenPool(poolEntry, config, wallet, admin, tokenAddrToKey));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[deepen] pool ${id} FAILED: ${msg}`);
      failures.push({ poolId: id, error: msg });
    }
  }

  // ── Final summary table ───────────────────────────────────────────────────
  console.log(`\n========================================================`);
  console.log(`[deepen] SUMMARY`);
  console.log(`--------------------------------------------------------`);
  for (const r of results) {
    if (r.skipped) {
      console.log(`  pool ${r.poolId} (${r.tokenAKey}/${r.tokenBKey}): SKIPPED (already deepened; txHash=${r.txHash})`);
      continue;
    }
    const b = r.before!;
    const a = r.after!;
    console.log(`  pool ${r.poolId} (${r.tokenAKey}/${r.tokenBKey}):`);
    console.log(`     L : ${b.L} → ${a.L}`);
    console.log(`     rA: ${b.rA} → ${a.rA}`);
    console.log(`     rB: ${b.rB} → ${a.rB}`);
    console.log(`     txHash: ${r.txHash}`);
  }
  for (const f of failures) {
    console.log(`  pool ${f.poolId}: FAILED — ${f.error.slice(0, 200)}`);
  }
  console.log(`--------------------------------------------------------`);

  await wallet.stop();

  if (failures.length > 0) {
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(`[deepen] FATAL:`, e);
  process.exit(1);
});
