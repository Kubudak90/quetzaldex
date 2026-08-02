#!/usr/bin/env node
//
// warm-up-pools.ts — make each single-sided Quetzal pool TWO-sided.
//
// Fresh pools are born at sqrt_p == p_min (every bucket >= 0 is BelowRange →
// only token A was deposited). The aggregate clearing engine cannot price a
// single-sided pool (reserve_b == 0 guard), and the concentrated V3 engine is
// the only thing that can lift sqrt_p off p_min. So the pool stays single-sided
// forever (chicken-and-egg) unless someone INJECTS token B.
//
// This script places ONE small "inject token B" order PER pool against the live
// testnet orderbook (admin acts as the maker) and broadcasts the matching
// reveal to the aggregator daemon, so a SUBSEQUENT epoch clear (rolled by the
// operator) prices token_b → token_a, lifts sqrt_p into bucket 0's interior,
// and leaves the pool with both reserves > 0.
//
// "Inject token B" mechanics (confirmed against aggregator/src/buckets.ts):
//   - Paying token B in moves the pool price UP (nextSqrtPUp) and pays out
//     token A (swapStepOutA). So pay token_b, receive token_a.
//   - The orderbook escrows the input token via Token.transfer_private_to_public
//     → the maker (admin) needs a PRIVATE balance of token_b >= amount_b.
//   - placeOrder input: side="buy", path=[token_b, token_a] (pay-first). The SDK
//     canonicalizes the path (u128-truncated address compare) and flips `side`.
//     For ALL THREE of Sub-9's hybrid-token pools the canonical compare flips
//     "buy" → "sell" → realSide=true (ASK). An ask is eligible at the clearing
//     price p when limit_price <= p; realized p ≈ p_min²/SCALE ≈ 1e16, so we use
//     a permissive SMALL limit (1e15) — exactly what sub9-e2e-smoke.ts used for
//     its pool-0 inject. (See the per-pool realSide derivation below — mirrors
//     the noFlip/sideAfterCanon/realSide logic in sub9's step 6.)
//
// SAFETY: refuses to run unless AZTEC_NODE_URL contains 'testnet'.
// DO NOT run this until the pools are seeded AND the operator is ready to roll
// the epoch — the orders are real on-chain escrows.
//
// Usage:
//   AZTEC_NODE_URL=https://rpc.testnet.aztec-labs.com \
//   STATIC_MAX_FEE_PER_L2_GAS=<n> pnpm tsx scripts/warm-up-pools.ts
//   # subset: --pool=1   OR   WARMUP_POOLS="0,2"
//   # per-pool amount override (atomic units of token_b):
//   #   WARMUP_AMOUNT_B_0=2500000 WARMUP_AMOUNT_B_1=30000 WARMUP_AMOUNT_B_2=30000
//
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { Fr, Fq } from "@aztec/aztec.js/fields";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { createAztecNodeClient, waitForNode } from "@aztec/aztec.js/node";
import { EmbeddedWallet } from "@aztec/wallets/embedded";
import { GasFees } from "@aztec/stdlib/gas";
import { TokenContract } from "../tests/integration/generated/Token.js";
import { LiquidityPoolContract } from "../tests/integration/generated/LiquidityPool.js";
import { QuetzalClient } from "../sdk/src/index.js";
import { SCALE } from "../aggregator/src/buckets.js";

// ─── Config ───────────────────────────────────────────────────────────────

const NODE_URL = process.env.AZTEC_NODE_URL ?? "https://rpc.testnet.aztec-labs.com";
if (!NODE_URL.includes("testnet")) {
  throw new Error(
    `AZTEC_NODE_URL must contain 'testnet' (safety check). Got: ${NODE_URL}`,
  );
}

const AGG_URL  = process.env.AGG_URL ?? "http://194.163.136.1:3001";
const M1_STATE = "testnet-m1-state.json";
const CONFIG   = "quetzal.config.json";
const STATE    = "warm-up-state.json";
// Re-use the Sub-9 testnet-m4-pxe PXE so contract classes/instances (tUSDC,
// tETH, tBTC, pools, orderbook) are already registered (same as seed-lp.ts).
const PXE_DIR  = process.env.WARMUP_PXE_DIR ?? "./testnet-m4-pxe";

// ─── Permissive limit price (ALL pools resolve to realSide=true / ASK) ──────
// An ask is eligible when limit_price <= clearing_price p. Realized p for a
// token-B-in swap on a fresh pool is ≈ p_min² / SCALE = (1e17)²/1e18 = 1e16
// (Q-format, 18 dp). A small limit (1e15) is guaranteed <= p, so the order
// always crosses. Mirrors sub9-e2e-smoke.ts ORDER_LIMIT_PRICE (lean permissive).
// OPERATOR-TUNABLE: if a pool's canonical side ever resolves to a BID
// (realSide=false) — it does NOT for Sub-9's current addresses, see the
// per-pool realSide log — eligibility would instead need a LARGE limit. The
// script picks the direction from the computed realSide (ASK vs BID below).
const ASK_PERMISSIVE_LIMIT = 1_000_000_000_000_000n; // 1e15 (ask: <= p ≈ 1e16)
const BID_PERMISSIVE_LIMIT = 1n << 120n;             // huge (bid: >= p)

// ─── Per-pool default amount_b (atomic units of token_b), no-saturation sized ─
//
// Bucket 0 bounds (p_min_sqrt=1e17, growth=1.5): sqrt_lower=1e17, sqrt_upper=1.5e17.
// A token-B-in swap lifts sqrt_p toward sqrt_upper; the bucket SATURATES (price
// clamps at sqrt_upper) when deltaB >= L*(sqrt_upper-sqrt_lower)/SCALE.
//   pool 0: L=6e17 → saturation deltaB = 3e16 (huge headroom). reserve_a (tETH)
//           is large; 2.5 tUSDC realises ~2.5e8 token_a out — a small, interior
//           price nudge that leaves the pool comfortably two-sided.
//   pools 1 & 2: L=3e6 → saturation deltaB = 150_000 (tiny!). amount_b MUST stay
//           well under that. 30_000 atomic units realises ~27% of bucket-0
//           reserve_a (=1e7) out and lifts sqrt_p to ~1.1e17 (interior, no clamp).
//
// These are TUNABLE defaults; the operator may adjust per pool via
// WARMUP_AMOUNT_B_<id>. Step "preflight" below reads the LIVE bucket-0 state and
// WARNS if the chosen amount would saturate or take > ~30% of reserve_a, so the
// operator can retune before rolling the epoch. **OPERATOR-VERIFY-ON-FIRST-RUN.**
const DEFAULT_AMOUNT_B: Record<number, bigint> = {
  0: 2_500_000n, // 2.5 tUSDC (token_b of pool0; tUSDC has 6 dp)
  1: 30_000n,    // tUSDC atomic (token_b of pool1); ~27% of bucket-0 reserve_a
  2: 30_000n,    // tETH atomic  (token_b of pool2); ~27% of bucket-0 reserve_a
};

// Bucket-0 model constants for the offline no-saturation preflight.
const PREFLIGHT_BUCKET = 0;

// ─── Pool selection (--pool=<id> / WARMUP_POOLS="0,1,2"; default = all) ──────
function parsePoolSelection(allIds: number[]): number[] {
  const flagArg = process.argv.find((a) => a.startsWith("--pool="));
  if (flagArg) {
    const n = Number(flagArg.slice("--pool=".length));
    if (!Number.isInteger(n) || n < 0) throw new Error(`invalid --pool=${flagArg}`);
    return [n];
  }
  if (process.env.WARMUP_POOLS) {
    const ids = process.env.WARMUP_POOLS.split(",")
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isInteger(n) && n >= 0);
    if (ids.length === 0) throw new Error(`invalid WARMUP_POOLS=${process.env.WARMUP_POOLS}`);
    return ids;
  }
  return allIds;
}

function amountBFor(poolId: number): bigint {
  const override = process.env[`WARMUP_AMOUNT_B_${poolId}`];
  if (override) {
    const n = BigInt(override);
    if (n <= 0n) throw new Error(`WARMUP_AMOUNT_B_${poolId} must be > 0; got ${override}`);
    return n;
  }
  const def = DEFAULT_AMOUNT_B[poolId];
  if (def === undefined) {
    throw new Error(
      `no default amount_b for pool ${poolId}; set WARMUP_AMOUNT_B_${poolId}=<atomic units>`,
    );
  }
  return def;
}

// ─── Types ──────────────────────────────────────────────────────────────────

interface M1State {
  step: number;
  secret: string;
  salt: string;
  signingKey: string;
  address: string;
}

interface QuetzalConfigJSON {
  nodeUrl: string;
  admin: string;
  tUSDC: string;
  tETH: string;
  tBTC?: string;
  orderbook: string;
  treasury?: string;
  aggregatorRegistry?: string;
  pools: Array<{ pool_id: number; address: string; token_a: string; token_b: string }>;
  bucketPMinSqrt?: string;
  bucketGrowthNum?: string;
  l1?: unknown;
}

interface PerPoolResult {
  pool_id: number;
  token_b_key: string;
  token_a_key: string;
  amount_b: string;
  limit_price: string;
  real_side_ask: boolean;
  placed: boolean;
  revealed: boolean;
  epoch_id?: number;
  order_nonce?: string;
  tx_hash?: string;
  reveal_http_status?: number;
  preflight_warn?: string;
  error?: string;
}

interface WarmUpState {
  startedAt: string;
  node: string;
  aggregator: string;
  results: PerPoolResult[];
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

// best-effort bigint → 0x-padded-32 hex (mirrors sub9 nonceToHex).
function nonceToHex(n: bigint): string {
  let hex = n.toString(16);
  if (hex.length < 64) hex = hex.padStart(64, "0");
  return "0x" + hex;
}

const U128_MASK = (1n << 128n) - 1n;

// Mirror the SDK's u128-truncated canonicalization to derive the contract side
// bool the order will carry. Input side is "buy", pay-first path [token_b, token_a]
// (we inject token B). Returns realSide (false=bid, true=ask). This is the SAME
// noFlip/sideAfterCanon/realSide computation used by sub9-e2e-smoke.ts step 6 —
// generalized to per-pool token_a/token_b instead of hardcoded tUSDC/tETH.
function deriveRealSide(tokenBHex: string, tokenAHex: string): { realSide: boolean; noFlip: boolean } {
  const lo = BigInt(tokenBHex) & U128_MASK; // path[0] = token_b (pay-first)
  const hi = BigInt(tokenAHex) & U128_MASK; // path[last] = token_a
  const noFlip = lo < hi;
  const inputSide: "buy" | "sell" = "buy";
  const sideAfterCanon: "buy" | "sell" = noFlip
    ? inputSide
    : (inputSide === "buy" ? "sell" : "buy");
  return { realSide: sideAfterCanon === "sell", noFlip };
}

interface PoolStateHint {
  reserve_a: bigint;
  reserve_b: bigint;
  current_sqrt_price: bigint;
}
interface BucketStateHint {
  reserve_a: bigint;
  reserve_b: bigint;
  liquidity: bigint;
}

async function readPoolHint(pool: LiquidityPoolContract, from: AztecAddress): Promise<PoolStateHint> {
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
  };
}

async function readPrivateBalance(token: TokenContract, owner: AztecAddress): Promise<bigint> {
  const sim = await token.methods.balance_of_private(owner).simulate({ from: owner });
  return BigInt((sim as { result: bigint | number }).result);
}

async function readPublicBalance(token: TokenContract, owner: AztecAddress): Promise<bigint> {
  const sim = await token.methods.balance_of_public(owner).simulate({ from: owner });
  return BigInt((sim as { result: bigint | number }).result);
}

// Mirrors contracts/pool/src/main.nr::compute_bucket_bounds (+ seed-lp.ts).
function computeBucketBounds(
  pMinSqrt: bigint, growthNum: bigint, bucketId: number,
): { sqrt_lower: bigint; sqrt_upper: bigint } {
  let sqrtLower = pMinSqrt;
  for (let i = 0; i < bucketId; i++) sqrtLower = (sqrtLower * growthNum) / SCALE;
  const sqrtUpper = (sqrtLower * growthNum) / SCALE;
  return { sqrt_lower: sqrtLower, sqrt_upper: sqrtUpper };
}

// Offline no-saturation check (V3 token-B-in step math, mirrors buckets.ts).
// Returns the predicted token_a-out + whether the swap would saturate bucket 0.
function predictInjectB(
  L: bigint, sqrtP: bigint, sqrtUpper: bigint, deltaB: bigint,
): { outA: bigint; saturates: boolean; sqrtPNew: bigint } {
  if (L === 0n) return { outA: 0n, saturates: false, sqrtPNew: sqrtP };
  let sqrtPNew = sqrtP + (deltaB * SCALE) / L; // nextSqrtPUp
  const saturates = sqrtPNew >= sqrtUpper;
  if (sqrtPNew > sqrtUpper) sqrtPNew = sqrtUpper;
  const denom = (sqrtP * sqrtPNew) / SCALE;
  const outA = denom === 0n ? 0n : (L * (sqrtPNew - sqrtP)) / denom; // swapStepOutA
  return { outA, saturates, sqrtPNew };
}

// ─── State ────────────────────────────────────────────────────────────────

function loadState(): WarmUpState {
  if (existsSync(STATE)) {
    try { return JSON.parse(readFileSync(STATE, "utf8")) as WarmUpState; } catch { /* fall through */ }
  }
  return { startedAt: new Date().toISOString(), node: NODE_URL, aggregator: AGG_URL, results: [] };
}
function saveState(s: WarmUpState): void {
  writeFileSync(STATE, JSON.stringify(s, null, 2));
}

// ─── Main ────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  if (!existsSync(M1_STATE)) {
    throw new Error(`${M1_STATE} not found — bootstrap admin wallet first (testnet-m1-hello.ts)`);
  }
  if (!existsSync(CONFIG)) throw new Error(`${CONFIG} not found — deploy core contracts first`);

  const m1 = JSON.parse(readFileSync(M1_STATE, "utf8")) as M1State;
  if (m1.step < 5) throw new Error(`M1 not complete (step=${m1.step}); admin wallet not deployed`);
  const config = JSON.parse(readFileSync(CONFIG, "utf8")) as QuetzalConfigJSON;

  // Token address → key for logging + amount selection.
  const addrToKey: Record<string, string> = {
    [config.tUSDC.toLowerCase()]: "tUSDC",
    [config.tETH.toLowerCase()]: "tETH",
  };
  if (config.tBTC) addrToKey[config.tBTC.toLowerCase()] = "tBTC";

  const allIds = config.pools.map((p) => p.pool_id);
  const selected = parsePoolSelection(allIds);
  console.log(`[warm-up] node=${NODE_URL}`);
  console.log(`[warm-up] aggregator=${AGG_URL}`);
  console.log(`[warm-up] pools selected: ${selected.join(", ")} (of ${allIds.join(", ")})`);

  // ── Connect node + STATIC-fee Proxy (mirrors seed-lp.ts) ────────────────
  const _rawNode = createAztecNodeClient(NODE_URL);
  console.log(`[warm-up] waiting for node ...`);
  await waitForNode(_rawNode);
  // aztec-labs' getCurrentMinFees() does an L1 read that 429s. Wrap the node so
  // it returns a fixed min-fee, letting every .send() skip that call. Ceiling
  // only — real base fee still charged.
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
  if (_sL2) console.log(`[warm-up] STATIC maxFeesPerGas override active: daGas=${_sDa} l2Gas=${_sL2}`);
  const nodeInfo = await node.getNodeInfo();
  console.log(`[warm-up] node OK; rollupVersion=${nodeInfo.rollupVersion} l1ChainId=${nodeInfo.l1ChainId}`);

  // ── Load admin wallet (testnet-m1-state.json + testnet-m4-pxe) ──────────
  const wallet = await EmbeddedWallet.create(node, {
    ephemeral: false,
    pxe: { proverEnabled: true, dataDirectory: PXE_DIR },
  });
  const secret     = Fr.fromString(m1.secret);
  const salt       = Fr.fromString(m1.salt);
  const signingKey = Fq.fromString(m1.signingKey);
  const adminManager = await wallet.createSchnorrAccount(secret, salt, signingKey);
  const admin = (await adminManager.getAccount()).getAddress();
  console.log(`[warm-up] admin recreated: ${admin.toString()}`);
  if (admin.toString() !== m1.address) {
    throw new Error(`admin address mismatch vs M1: ${admin.toString()} vs ${m1.address}`);
  }
  if (admin.toString().toLowerCase() !== config.admin.toLowerCase()) {
    throw new Error(`admin address mismatch vs config.admin: ${admin.toString()} vs ${config.admin}`);
  }
  console.log(`[warm-up] admin matches config.admin ✓`);

  // ── Build QuetzalClient around the ADMIN wallet (external-pxe, shared) ───
  // Same class + external-pxe pattern sub9-e2e-smoke.ts uses, but the wallet
  // here is the admin (minter) wallet rather than a faucet-onboarded child.
  // Sharing the wallet keeps the already-registered contract classes + PXE
  // state, so placeOrder can resolve aliases + canonicalize + escrow.
  const client = await QuetzalClient.connect({
    network: "alpha-testnet",
    nodeUrl: NODE_URL,
    account: { type: "external-pxe", wallet, address: admin },
    l1: config.l1 as never,
    contracts: {
      orderbook: config.orderbook,
      tUSDC: config.tUSDC,
      tETH: config.tETH,
      tBTC: config.tBTC,
      pools: config.pools,
      treasury: config.treasury,
      aggregatorRegistry: config.aggregatorRegistry,
    },
  });
  console.log(`[warm-up] QuetzalClient connected; address=${client.address.toString()}`);

  const pMinSqrt  = config.bucketPMinSqrt  ? BigInt(config.bucketPMinSqrt)  : 100000000000000000n;
  const growthNum = config.bucketGrowthNum ? BigInt(config.bucketGrowthNum) : 1500000000000000000n;

  const state = loadState();

  // ── Per-pool warm-up ────────────────────────────────────────────────────
  for (const poolId of selected) {
    const poolEntry = config.pools.find((p) => p.pool_id === poolId);
    if (!poolEntry) {
      console.error(`[warm-up] pool_id ${poolId} not in config; skipping`);
      continue;
    }
    const tokenAKey = addrToKey[poolEntry.token_a.toLowerCase()] ?? poolEntry.token_a;
    const tokenBKey = addrToKey[poolEntry.token_b.toLowerCase()] ?? poolEntry.token_b;
    const amountB = amountBFor(poolId);
    const { realSide, noFlip } = deriveRealSide(poolEntry.token_b, poolEntry.token_a);
    // Permissive limit IN THE ELIGIBILITY DIRECTION of the realized side:
    //   ask (realSide=true):  eligible if limit <= p → small limit.
    //   bid (realSide=false): eligible if limit >= p → huge limit.
    const limitPrice = realSide ? ASK_PERMISSIVE_LIMIT : BID_PERMISSIVE_LIMIT;

    const result: PerPoolResult = {
      pool_id: poolId,
      token_b_key: tokenBKey,
      token_a_key: tokenAKey,
      amount_b: amountB.toString(),
      limit_price: limitPrice.toString(),
      real_side_ask: realSide,
      placed: false,
      revealed: false,
    };
    // Replace any prior entry for this pool (idempotent-ish re-run).
    state.results = state.results.filter((r) => r.pool_id !== poolId);
    state.results.push(result);

    console.log("");
    console.log(`[warm-up] ===== pool ${poolId} (${poolEntry.address}) =====`);
    console.log(`[warm-up]   token_a=${tokenAKey} (${poolEntry.token_a})`);
    console.log(`[warm-up]   token_b=${tokenBKey} (${poolEntry.token_b})  <- INJECT (pay) this`);
    console.log(`[warm-up]   placeOrder: side="buy" path=[${tokenBKey}, ${tokenAKey}] amount_b=${amountB} limit=${limitPrice}`);
    console.log(`[warm-up]   canon: u128(token_b) ${noFlip ? "<" : ">="} u128(token_a) → SDK ${noFlip ? "keeps" : "flips"} side → realSide=${realSide ? "ask (eligible if limit<=p)" : "bid (eligible if limit>=p)"}`);

    try {
      const poolAddr  = AztecAddress.fromStringUnsafe(poolEntry.address);
      const tokenBAddr = AztecAddress.fromStringUnsafe(poolEntry.token_b);
      const pool   = await LiquidityPoolContract.at(poolAddr, wallet);
      const tokenB = await TokenContract.at(tokenBAddr, wallet);

      // ── Preflight: read live pool + bucket-0, predict no-saturation ──────
      try {
        const ph = await readPoolHint(pool, admin);
        const bh = await readBucketHint(pool, PREFLIGHT_BUCKET, admin);
        const bounds = computeBucketBounds(pMinSqrt, growthNum, PREFLIGHT_BUCKET);
        const sqrtP = ph.current_sqrt_price === 0n ? bounds.sqrt_lower : ph.current_sqrt_price;
        const pred = predictInjectB(bh.liquidity, sqrtP, bounds.sqrt_upper, amountB);
        const pctOfReserveA = bh.reserve_a > 0n
          ? Number((pred.outA * 10000n) / bh.reserve_a) / 100
          : (bh.liquidity > 0n ? -1 : 0); // -1 = reserve_a 0 but L>0 (interior); 0 = empty bucket
        console.log(`[warm-up]   preflight: pool.sqrt_p=${ph.current_sqrt_price} reserve_a=${ph.reserve_a} reserve_b=${ph.reserve_b}`);
        console.log(`[warm-up]   preflight: bucket0 L=${bh.liquidity} reserve_a=${bh.reserve_a} reserve_b=${bh.reserve_b}`);
        console.log(`[warm-up]   preflight: predicted token_a-out=${pred.outA} (~${pctOfReserveA}% of bucket0 reserve_a) sqrt_p ${sqrtP}→${pred.sqrtPNew} saturates=${pred.saturates}`);
        if (pred.saturates) {
          result.preflight_warn = `amount_b=${amountB} SATURATES bucket0 (sqrt_p clamps at upper=${bounds.sqrt_upper}); reduce WARMUP_AMOUNT_B_${poolId}`;
          console.warn(`[warm-up]   WARN: ${result.preflight_warn}`);
        } else if (pctOfReserveA > 30) {
          result.preflight_warn = `predicted out is ~${pctOfReserveA}% of bucket0 reserve_a (> 30% target); consider reducing WARMUP_AMOUNT_B_${poolId}`;
          console.warn(`[warm-up]   WARN: ${result.preflight_warn}`);
        } else if (bh.liquidity === 0n) {
          result.preflight_warn = `bucket0 has L=0 (pool not seeded?); the inject won't move price`;
          console.warn(`[warm-up]   WARN: ${result.preflight_warn}`);
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.warn(`[warm-up]   preflight read failed (non-fatal): ${msg.slice(0, 200)}`);
      }

      // ── Ensure admin PRIVATE balance of token_b >= amount_b ─────────────
      // The orderbook escrows the input token via transfer_private_to_public,
      // so a PRIVATE balance of token_b is required. Admin is the minter for
      // all three tokens (mint_to_private needs no authwit; seed-lp pattern).
      // If short, mint the shortfall straight to private. (We also tolerate a
      // public-only balance by sweeping it private first, like sub9 step 5a.)
      const balPrivB = await readPrivateBalance(tokenB, admin);
      console.log(`[warm-up]   admin ${tokenBKey} private balance: ${balPrivB}`);
      if (balPrivB < amountB) {
        let shortfall = amountB - balPrivB;
        // Prefer sweeping existing public balance into private (cheaper than
        // a fresh mint if the admin already holds public token_b).
        const balPubB = await readPublicBalance(tokenB, admin);
        if (balPubB > 0n) {
          const sweep = balPubB >= shortfall ? shortfall : balPubB;
          console.log(`[warm-up]   transfer_public_to_private(${tokenBKey}, ${sweep}) ...`);
          // Token asserts _nonce == 0 when from == msg_sender (self-call).
          await tokenB.methods
            .transfer_public_to_private(admin, admin, sweep, Fr.ZERO)
            .send({ from: admin });
          shortfall -= sweep;
        }
        if (shortfall > 0n) {
          console.log(`[warm-up]   mint_to_private(${tokenBKey}, ${shortfall}) (admin is minter) ...`);
          await tokenB.methods.mint_to_private(admin, shortfall).send({ from: admin });
        }
        console.log(`[warm-up]   token_b private balance topped up by ${amountB - balPrivB}`);
      } else {
        console.log(`[warm-up]   sufficient private ${tokenBKey}; no top-up`);
      }

      // ── placeOrder: inject token B (pay token_b → receive token_a) ──────
      console.log(`[warm-up]   placeOrder ...`);
      const placed = await client.orders.placeOrder({
        side: "buy",                       // canonicalized → realSide (ask) per pool
        path: [poolEntry.token_b, poolEntry.token_a], // pay-first: token_b then token_a
        amount: amountB,
        limitPrice,
      });
      result.placed = true;
      result.epoch_id = placed.epoch;
      result.order_nonce = nonceToHex(placed.orderNonce);
      result.tx_hash = placed.txHash;
      console.log(`[warm-up]   order placed: tx=${placed.txHash} epoch=${placed.epoch} block=${placed.blockNumber} submittedAtBlock=${placed.submittedAtBlock}`);
      console.log(`[warm-up]   orderNonce=${result.order_nonce} path_len=${placed.path_len}`);
      saveState(state);

      // ── Broadcast reveal to the aggregator daemon ───────────────────────
      // realSide already computed via the SAME u128-canon logic the SDK used
      // (deriveRealSide above; mirrors sub9 step-6 noFlip/sideAfterCanon).
      // submitted_at_block MUST be the OrderNote anchor block (placed.submittedAtBlock),
      // not the mined block — else order_acc replay mismatches and never settles.
      const payload = {
        epoch_id: placed.epoch,
        order_nonce: result.order_nonce,
        side: realSide,
        amount_in: amountB.toString(),
        limit_price: limitPrice.toString(),
        submitted_at_block: placed.submittedAtBlock ?? placed.blockNumber,
        owner: admin.toString(),
        submission_tx_hash: placed.txHash,
        // Audit #11: forward the canonical path so the aggregator recomputes c_i
        // against the SAME path the contract folded (required for non-pool-0 /
        // multi-hop; harmless for pool-0).
        path_len: placed.path_len,
        path: placed.path,
      };
      console.log(`[warm-up]   reveal payload: ${JSON.stringify(payload)}`);
      const res = await fetch(`${AGG_URL}/reveal`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const text = await res.text();
      result.reveal_http_status = res.status;
      result.revealed = res.ok;
      console.log(`[warm-up]   reveal HTTP ${res.status}${res.ok ? " OK" : " FAILED"}: ${text.slice(0, 300)}`);
      if (!res.ok) {
        result.error = `reveal HTTP ${res.status}: ${text.slice(0, 200)}`;
      }
      saveState(state);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      result.error = msg.slice(0, 400);
      console.error(`[warm-up]   pool ${poolId} FAILED: ${msg}`);
      saveState(state);
      // continue to the next pool rather than aborting the whole batch
    }
  }

  // ── Final summary ───────────────────────────────────────────────────────
  console.log("");
  console.log(`[warm-up] ===== SUMMARY =====`);
  for (const r of state.results) {
    const tag = r.placed && r.revealed ? "OK" : r.placed ? "PLACED-NO-REVEAL" : "NOT-PLACED";
    console.log(
      `[warm-up]   pool ${r.pool_id}: ${tag} | placed=${r.placed} revealed=${r.revealed} epoch_id=${r.epoch_id ?? "?"} ` +
        `side=${r.real_side_ask ? "ask" : "bid"} amount_b=${r.amount_b} (${r.token_b_key}) limit=${r.limit_price}` +
        (r.preflight_warn ? ` | WARN: ${r.preflight_warn}` : "") +
        (r.error ? ` | ERROR: ${r.error}` : ""),
    );
  }
  saveState(state);
  console.log(`[warm-up] state persisted to ${STATE}`);
  console.log(`[warm-up] NEXT: operator rolls the epoch; the subsequent clear prices token_b→token_a per pool.`);

  await client.stop();
  await wallet.stop();
}

main().catch((e) => {
  console.error(`[warm-up] FAILED:`, e);
  process.exit(1);
});
