/**
 * Task 11 §6 acceptance-criterion tests — adversarial clearing validation.
 *
 * PURPOSE: Verify that the clearing-soundness fixes (#1 pool_state_commitment,
 * #3 pool_id pair-binding, #7 flow-binding) REJECT malicious on-chain
 * submissions on a live Aztec rollup. Every case fabricates a VALID ZK proof
 * that the recursive verifier accepts, then asserts that the CONTRACT's own
 * asserts (not proof verification) are what causes the revert. This is the
 * correct threat model: a bonded aggregator who can produce valid proofs over
 * fabricated witnesses.
 *
 * CONCENTRATED-MODEL MIGRATION (one-sided bootstrap clear):
 *   Phase 1-2 of clearing-soundness replaced the old aggregate pricing
 *   (spot = reserveA/reserveB) with concentrated-liquidity bucket pricing.
 *   `computeClearing` now takes a full `PoolWithBuckets` and the witness needs
 *   per-bucket deltas + before/after states. These tests therefore drive a
 *   ONE-SIDED SELL clear: the pool is born at current_sqrt_price = p_min (bottom
 *   of bucket 0); a single-sided token-A deposit funds bucket 0 (reserve_a>0,
 *   reserve_b=0, liquidity L>0); ONE sell order (token B in -> buys token A out,
 *   price moves up) produces a valid concentrated clear with REAL bucket deltas.
 *   This mirrors the bootstrap clear T11 settled live.
 *
 *   Economics may need live tuning under RUN_LIVE; the suite is structurally
 *   validated here (correct-by-construction + tsc-clean). Full live green is
 *   tracked separately (see clearing-soundness plan T11 / stub-mode blocker).
 *
 * WHY SKIPPED BY DEFAULT: TXE (Test Execution Environment) does NOT execute
 * `std::verify_proof_with_type` — it no-ops the recursive verifier. Tests that
 * only run in TXE will always "pass" regardless of proof validity. These tests
 * require a live Aztec rollup (sandbox or testnet) where the prover/sequencer
 * actually kernel-proves the recursion. See E2/E3 in clearing.test.ts for the
 * same reasoning.
 *
 * HOW TO RUN: set env var RUN_LIVE=1 against a live rollup:
 *   RUN_LIVE=1 node --import tsx --test tests/integration/clearing-adversarial.test.ts
 *
 * CIRCUIT SHAPE: uses the Sub-4 multi-pair witness builder
 * (buildClearingWitnessMultiPair) which targets the CURRENT circuit that
 * includes pool_state_commitment + token_lo/hi + the 4 aggregate flow fields
 * (Tasks 3/4/7 of the clearing-soundness plan).
 *
 * CASES:
 *   A1 — fabricated pool before-state (bumped cum_fee) → "pool state commitment mismatch"
 *   A3 — mis-pointed pool_id (points at the wrong registered pair) → "pool_id pair mismatch"
 *   A4 — mismatched aggregate flow field (a_from_pool := honest+1) → "a_from_pool != sum reserve_a_sub"
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { spawnSync } from "node:child_process";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import type { AztecAddress } from "@aztec/aztec.js/addresses";
import type { AztecNode } from "@aztec/aztec.js/node";
import type { EmbeddedWallet } from "@aztec/wallets/embedded";
import { Fr } from "@aztec/aztec.js/fields";

import { connectToSandbox } from "./helpers/sandbox.js";
import { getTestWallets } from "./helpers/wallets.js";
import {
  readProofAsFields,
  readVkAsFields,
  readVkHash,
} from "./helpers/proof.js";
import { TokenContract } from "./generated/Token.js";
import { OrderbookContract } from "./generated/Orderbook.js";
import { LiquidityPoolContract } from "./generated/LiquidityPool.js";

import {
  computeClearingV2,
  computePoolStateCommitment,
  deriveAggregateFlows,
  type ClearingOrder,
  type PoolWithBuckets,
  type PoolClearingResult,
  type BucketState,
} from "../../aggregator/src/clearing.js";
import {
  buildClearingWitnessMultiPair,
  type OrderNotePreimage,
  type EpochState,
  type BucketStateForCircuit,
  INVALID_POOL_ID,
} from "../../aggregator/src/witness.js";
// mulDiv/SCALE for the inlined bucket-bounds math (below). Imported from the
// aggregator's fixed-point (already in this test's import neighbourhood) rather
// than pulling SDK source into the tests typecheck.
import { mulDiv, SCALE } from "../../aggregator/src/fixed-point.js";

// VERBATIM copy of sdk/src/pools.ts::computeAllBucketBounds (which mirrors
// contracts/pool/src/main.nr::compute_bucket_bounds). The tests package does NOT
// depend on @quetzal/sdk and @quetzal/sdk's exports map to TS source, so a real
// import would pull the whole SDK source into the tests typecheck. Inlined here
// to keep the test self-contained. KEEP IN SYNC with the SDK if the bound math
// ever changes (it has been stable since Sub-2).
function computeAllBucketBounds(
  pMinSqrt: bigint,
  growthNum: bigint,
  numBuckets: number,
): Array<{ sqrt_lower: bigint; sqrt_upper: bigint }> {
  return Array.from({ length: numBuckets }, (_, bucketId) => {
    let sqrtLower = pMinSqrt;
    for (let i = 0; i < bucketId; i++) sqrtLower = mulDiv(sqrtLower, growthNum, SCALE);
    return { sqrt_lower: sqrtLower, sqrt_upper: mulDiv(sqrtLower, growthNum, SCALE) };
  });
}

// ---------------------------------------------------------------------------
// Guards: skip the entire suite unless RUN_LIVE=1 (a live rollup is needed).
// TXE no-ops std::verify_proof_with_type (see clearing.test.ts E2 skip note).
// ---------------------------------------------------------------------------
const RUN_LIVE = process.env["RUN_LIVE"] === "1";

// ---------------------------------------------------------------------------
// Constants (mirror clearing.test.ts).
// ---------------------------------------------------------------------------

// Production circuit (MAX_ORDERS_PER_EPOCH = 32, set by Task 1).
const CIRCUIT_DIR = process.env.CIRCUIT_DIR ?? "/root/quetzal/circuits/clearing";
const CIRCUIT_MAX_ORDERS = 32;
const BB_BIN =
  process.env.BB_BIN ??
  "/root/.aztec/versions/4.2.1/node_modules/@aztec/bb.js/build/amd64-linux/bb";
// nargo binary for the `nargo execute` shellout. On the original author box this
// came from `source /root/.quetzal-env`; override with NARGO_BIN (e.g. aztec-nargo).
const NARGO_BIN = process.env.NARGO_BIN ?? "nargo";

// Contract array sizes (same as clearing.test.ts).
const CONTRACT_PROOF_SIZE = 456;
const CONTRACT_VK_SIZE = 127;

const ONE_USDC = 10n ** 6n;
const ONE_ETH  = 10n ** 18n;

// Pool 0 bucket-0 bootstrap parameters (concentrated, one-sided).
//
// Pool is born at current_sqrt_price = p_min_sqrt = bucket-0 sqrt_lower. A deposit
// of token A (the canonical-lo token) into bucket 0 is `below-range`, so it funds
// the bucket single-sided: reserve_a>0, reserve_b=0, liquidity L>0.
//
// CRITICAL: per-bucket liquidity L MUST be < 2^64 (~1.8447e19) or the circuit's
// mul_div divisor assert fails. With p_min_sqrt=0.1e18 and growth=1.5e18:
//   bucket 0: sqrt_lower=0.1e18, sqrt_upper=0.15e18
//   l_used = mulDiv(amount_a, sqrt_lower*sqrt_upper/SCALE, span)
//          = mulDiv(amount_a, 1.5e16, 5e16) = amount_a * 0.3
// So amount_a = 2_000 * 1e6 (token A has 6 decimals) gives L = 6e8 < 2^64.
// (The prior live seed used L ~= 6e17 < 2^64 with larger amounts; we stay well
// under the bound here.) See the live-tuning note in submitAndReadOrders().
const P_MIN_SQRT        = 100_000_000_000_000_000n;   // 0.1e18  (= bucket-0 sqrt_lower)
const BUCKET_GROWTH_NUM = 1_500_000_000_000_000_000n; // 1.5e18
const BOOTSTRAP_DEPOSIT_A = 2_000n * ONE_USDC;        // token A (lo); funds bucket 0 single-sided -> L = 6e8

// The single sell order: token B in. Sized so it does NOT saturate bucket 0
// (a small fraction of the bucket's liquidity). See live-tuning note.
const SELL_AMOUNT_B = 1n * ONE_ETH;                   // token B (hi) sold into bucket 0
// Sell is eligible iff limit <= P*; pick a very low limit so it always clears.
const SELL_LIMIT    = 1n;

const EPOCH_LEN = 20;

// Number of buckets the pool contract maintains (NUM_BUCKETS in pool/src/main.nr).
const NUM_BUCKETS = 16;

// A3 fixture: pool 2 (tUSDC/tBTC, a SEPARATE registered pair) to mis-point pool_id to.
const POOL2_DEPOSIT_A = 2_000n * ONE_USDC;

// ---------------------------------------------------------------------------
// Local helpers (mirrors clearing.test.ts).
// ---------------------------------------------------------------------------

function randomField(): bigint {
  const buf = new Uint8Array(31);
  webcrypto.getRandomValues(buf);
  let n = 0n;
  for (const b of buf) n = (n << 8n) | BigInt(b);
  return n;
}

async function currentBlock(node: AztecNode): Promise<number> {
  return Number(await node.getBlockNumber());
}

function bridgeProofToContractSize(fileFields: Fr[]): Fr[] {
  if (fileFields.length === CONTRACT_PROOF_SIZE) return fileFields;
  if (fileFields.length > CONTRACT_PROOF_SIZE) return fileFields.slice(0, CONTRACT_PROOF_SIZE);
  const padded = [...fileFields];
  while (padded.length < CONTRACT_PROOF_SIZE) padded.push(Fr.ZERO);
  return padded;
}

function bridgeVkToContractSize(fileFields: Fr[]): Fr[] {
  if (fileFields.length === CONTRACT_VK_SIZE) return fileFields;
  if (fileFields.length > CONTRACT_VK_SIZE) return fileFields.slice(0, CONTRACT_VK_SIZE);
  const padded = [...fileFields];
  while (padded.length < CONTRACT_VK_SIZE) padded.push(Fr.ZERO);
  return padded;
}

// ---------------------------------------------------------------------------
// OrderNote field shape returned by get_orders.
// ---------------------------------------------------------------------------
interface OrderNoteFields {
  side: boolean;
  amount_in: bigint | number;
  limit_price: bigint | number;
  nonce: bigint | number;
  submitted_at_block: bigint | number;
  owner: bigint | number;
}

// Raw shapes returned by the pool view methods (cat -n format -> .result).
interface RawPoolState {
  reserve_a: bigint | number;
  reserve_b: bigint | number;
  current_sqrt_price: bigint | number;
}
interface RawBucketState {
  reserve_a: bigint | number;
  reserve_b: bigint | number;
  liquidity: bigint | number;
  cum_fee_a_per_share: bigint | number;
  cum_fee_b_per_share: bigint | number;
}

// ---------------------------------------------------------------------------
// Adversarial override knobs.
// ---------------------------------------------------------------------------

/**
 * A flow-field override for Case A4. The circuit does NOT constrain the 4
 * aggregate flow public inputs (they are pass-through); the pool's apply_clearing
 * re-derives them from the bucket deltas and asserts equality (Task 7
 * flow-binding). Overriding ONE flow value in BOTH the Prover.toml and the
 * calldata (so flatten(calldata)==proof public inputs -> verify passes) reaches
 * the pool's assert and reverts.
 */
export interface FlowOverride {
  field: "a_to_pool" | "b_to_pool" | "a_from_pool" | "b_from_pool";
  value: bigint;
}

/**
 * Override options for adversarial fabrication.
 *
 * poolStateCommitmentOverride: if set, replaces the honestly-computed
 *   pool_state_commitment in active_pools[0].swap (Case A1). The proof is valid
 *   because the circuit recomputes the commitment from the (fabricated) private
 *   before-state and asserts it EQUALS this public input — the fabrication bumps
 *   both the before-state in the witness AND this commitment together. The
 *   pool-side LIVE recompute then diverges from the proof-bound value.
 *
 * poolIdOverride: if set, replaces active_pools[0].pool_id (Case A3). The circuit
 *   does NOT constrain pool_id against the priced pair (it is a pass-through
 *   public input), so the proof stays valid; the orderbook's registry pair assert
 *   then rejects it.
 *
 * flowOverride: if set, replaces ONE of the 4 aggregate flow fields in the
 *   calldata swap (Case A4). The corresponding proverTomlMutator MUST rewrite the
 *   SAME flow line in the TOML to the same value so the proof's public-input
 *   vector still equals flatten(calldata).
 */
export interface AdversarialOverrides {
  poolStateCommitmentOverride?: bigint;
  poolIdOverride?: bigint;
  flowOverride?: FlowOverride;
}

// ---------------------------------------------------------------------------
// buildAdversarialPublicInputsStruct — construct the ClearingPublic calldata
// for the multi-pair circuit (Task 7 / 123-field layout). Parameterized to
// allow overriding pool_state_commitment (A1), pool_id (A3), and a flow (A4).
// ---------------------------------------------------------------------------
async function buildAdversarialPublicInputsStruct(
  epoch: {
    order_acc: bigint;
    cancel_acc: bigint;
    order_count: bigint | number;
    cancel_count: bigint | number;
  },
  perPoolClearing: PoolClearingResult,
  tokenLo: bigint,   // canonical (lo, hi) for the priced pool
  tokenHi: bigint,
  poolStateCommitment: bigint,
  fills: { orderNonce: bigint; amountOut: bigint }[],
  overrides: AdversarialOverrides = {},
) {
  const { buildHopFillsTree } = await import("../../aggregator/src/merkle.js");

  // Build the fills Merkle root (64-leaf hop-fills tree).
  const fillsForTree = fills.map((f, i) => ({
    order_nonce: new Fr(f.orderNonce),
    hop_index: 0 as 0 | 1,
    amount_out: f.amountOut,
    pool_id: i, // pool_id in fill leaf = slot index (0 for 1-hop)
  }));
  const tree = await buildHopFillsTree(fillsForTree, 2 * CIRCUIT_MAX_ORDERS);

  // Honest flows (single source of truth: derived from the bucket deltas).
  const honest = deriveAggregateFlows(perPoolClearing.bucketDeltas);
  let { aToPool, bToPool, aFromPool, bFromPool } = honest;

  // Apply the A4 flow override (one field only).
  if (overrides.flowOverride) {
    const { field, value } = overrides.flowOverride;
    if (field === "a_to_pool")   aToPool   = value;
    if (field === "b_to_pool")   bToPool   = value;
    if (field === "a_from_pool") aFromPool = value;
    if (field === "b_from_pool") bFromPool = value;
  }

  // Apply the A1 / A3 overrides.
  const appliedCommitment =
    overrides.poolStateCommitmentOverride ?? poolStateCommitment;
  const appliedPoolId =
    overrides.poolIdOverride ?? BigInt(perPoolClearing.pool_id);

  const INVALID_POOL_BIGINT = BigInt(INVALID_POOL_ID);

  // Sentinel BucketDelta with all-zero fields — padding for inactive bucket slots.
  const SENTINEL_BD = {
    bucket_id: 0n,
    reserve_a_add: 0n, reserve_a_sub: 0n,
    reserve_b_add: 0n, reserve_b_sub: 0n,
    cum_fee_a_per_share_increment: 0n,
    cum_fee_b_per_share_increment: 0n,
  };
  const sentinelSwap = {
    a_to_pool: 0n,
    b_to_pool: 0n,
    a_from_pool: 0n,
    b_from_pool: 0n,
    current_sqrt_price_after: 0n,
    pool_state_commitment: 0n,
    active_bucket_count: 0n,
    active_bucket_deltas: [SENTINEL_BD, SENTINEL_BD, SENTINEL_BD, SENTINEL_BD],
  };

  // Real active bucket deltas, padded to 4 with all-zero sentinels.
  const activeBucketDeltas = perPoolClearing.bucketDeltas.map((d) => ({
    bucket_id: BigInt(d.bucket_id),
    reserve_a_add: d.reserve_a_add,
    reserve_a_sub: d.reserve_a_sub,
    reserve_b_add: d.reserve_b_add,
    reserve_b_sub: d.reserve_b_sub,
    cum_fee_a_per_share_increment: d.cum_fee_a_per_share_increment,
    cum_fee_b_per_share_increment: d.cum_fee_b_per_share_increment,
  }));
  while (activeBucketDeltas.length < 4) activeBucketDeltas.push({ ...SENTINEL_BD });

  return {
    order_acc: epoch.order_acc,
    cancel_acc: epoch.cancel_acc,
    order_count: Number(epoch.order_count),
    cancel_count: Number(epoch.cancel_count),
    fills_root: tree.root.toBigInt(),
    active_pool_count: 1n,
    active_pools: [
      {
        pool_id: appliedPoolId,
        clearing_price: perPoolClearing.clearingPrice,
        token_lo: tokenLo,
        token_hi: tokenHi,
        swap: {
          a_to_pool: aToPool,
          b_to_pool: bToPool,
          a_from_pool: aFromPool,
          b_from_pool: bFromPool,
          current_sqrt_price_after: perPoolClearing.currentSqrtPriceAfter,
          pool_state_commitment: appliedCommitment,
          active_bucket_count: BigInt(perPoolClearing.bucketDeltas.length),
          active_bucket_deltas: activeBucketDeltas,
        },
      },
      // Sentinel slots 1 and 2.
      {
        pool_id: INVALID_POOL_BIGINT,
        clearing_price: 0n,
        token_lo: 0n,
        token_hi: 0n,
        swap: sentinelSwap,
      },
      {
        pool_id: INVALID_POOL_BIGINT,
        clearing_price: 0n,
        token_lo: 0n,
        token_hi: 0n,
        swap: sentinelSwap,
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Core proof-pipeline helper — shared by all adversarial cases.
//
// Accepts a `proverTomlMutator` callback that receives the honest Prover.toml
// string and returns a (possibly modified) string. This is the seam where each
// case injects its fabrication into the witness before nargo execute runs. Its
// mutation MUST be consistent with `calldataOverrides` so the proof's public-input
// vector equals flatten(calldata) (otherwise verify_proof rejects at the wrong
// layer instead of reaching the contract assert under test).
// ---------------------------------------------------------------------------
async function produceAdversarialProof(args: {
  /** Honest ordersForWitness already sorted by (block, nonce). */
  ordersForWitness: OrderNotePreimage[];
  epochResult: {
    order_acc: bigint;
    cancel_acc: bigint;
    order_count: bigint | number;
    cancel_count: bigint | number;
    closes_at_block: bigint;
  };
  tokenAAddr: bigint;   // pool's token_a (constructor arg 0) = canonical lo
  tokenBAddr: bigint;   // pool's token_b (constructor arg 1) = canonical hi
  poolId: number;
  /** Full concentrated pool state (bucket 0 funded single-sided). */
  pool: PoolWithBuckets;
  /** Optional: mutate the honest Prover.toml string before writing it (A1, A4). */
  proverTomlMutator?: (toml: string) => string;
  /** Overrides for the on-chain calldata (pool_state_commitment / pool_id / flow). */
  calldataOverrides?: AdversarialOverrides;
}): Promise<{
  publicInputsStruct: Awaited<ReturnType<typeof buildAdversarialPublicInputsStruct>>;
  proofFields: Fr[];
  vkFields: Fr[];
  epochResult: typeof args.epochResult;
}> {
  const {
    ordersForWitness, epochResult, tokenAAddr, tokenBAddr, poolId,
    pool, proverTomlMutator, calldataOverrides,
  } = args;

  // Run off-chain aggregator over the concentrated pool. computeClearingV2 gives
  // us the per-bucket deltas + before/after states the witness needs.
  const clearingOrders: ClearingOrder[] = ordersForWitness.map((o) => ({
    side: o.side,
    amountIn: o.amount_in,
    limitPrice: o.limit_price,
    submittedAtBlock: o.submitted_at_block,
    orderNonce: o.order_nonce,
  }));
  const clearingResult = computeClearingV2(pool, clearingOrders);
  assert.ok(
    clearingResult.cleared,
    "aggregator must find a concentrated clearing price (one-sided sell). " +
      "If this fails under RUN_LIVE, retune BOOTSTRAP_DEPOSIT_A / SELL_AMOUNT_B " +
      "so the sell does not saturate bucket 0 (see live-tuning note).",
  );
  // NOTE: a one-sided clear produces exactly ONE fill (no CoW counterparty).

  // Canonical (lo, hi) token pair for the priced pool. We deploy the pool with its
  // tokens already in u128-canonical order (token_a = lo, token_b = hi), so the
  // clearing convention (token A in/out) lines up with the registry + escrow rule.
  const tokenLo = tokenAAddr;
  const tokenHi = tokenBAddr;

  // Build the per-pool clearing result from the V2 output. The witness +
  // commitment need BucketStateForCircuit (which carries bucket_id); map the V2
  // before/after BucketState[] by attaching the index-aligned delta's bucket_id.
  const bucketDeltas = clearingResult.bucketDeltas ?? [];
  const v2Before = clearingResult.bucketStatesBefore ?? [];
  const v2After  = clearingResult.bucketStatesAfter  ?? [];

  const beforeForCircuit: BucketStateForCircuit[] = v2Before.map((s, i) => ({
    bucket_id: bucketDeltas[i]?.bucket_id ?? 0,
    reserve_a: s.reserve_a,
    reserve_b: s.reserve_b,
    liquidity: s.liquidity,
    cum_fee_a_per_share: s.cum_fee_a_per_share,
    cum_fee_b_per_share: s.cum_fee_b_per_share,
  }));

  // PoolClearingResult uses the bare BucketState[] (no bucket_id); the witness
  // builder pulls bucket_id from the deltas it is given.
  const perPoolClearing: PoolClearingResult = {
    pool_id: poolId,
    clearingPrice: clearingResult.clearingPrice,
    bucketDeltas,
    currentSqrtPriceAfter: clearingResult.currentSqrtPriceAfter ?? pool.currentSqrtPrice,
    bucketStatesBefore: clearingResult.bucketStatesBefore ?? [],
    bucketStatesAfter: clearingResult.bucketStatesAfter ?? [],
  };

  // Honest pool_state_commitment over the REAL before-state (sqrtPBefore =
  // pool.currentSqrtPrice, NOT 0n). beforeForCircuit is index-aligned with the
  // deltas; activeCount = deltas.length.
  const honestCommitment = await computePoolStateCommitment(
    pool.currentSqrtPrice,
    beforeForCircuit,
    bucketDeltas,
    bucketDeltas.length,
  );

  const epoch: EpochState = {
    order_acc: epochResult.order_acc,
    cancel_acc: epochResult.cancel_acc,
    order_count: Number(epochResult.order_count),
    cancel_count: Number(epochResult.cancel_count),
  };

  const { proverToml } = await buildClearingWitnessMultiPair({
    epoch,
    orders: ordersForWitness,
    cancellationIndices: [],
    perPoolClearings: [perPoolClearing],
    fills: (clearingResult.fills ?? []).map((f) => ({
      orderNonce: f.orderNonce,
      hop_index: 0 as 0 | 1,
      amountOut: f.amountOut,
      pool_id: poolId,
    })),
    maxOrders: CIRCUIT_MAX_ORDERS,
    poolSqrtPBefore: [pool.currentSqrtPrice, 0n, 0n],
    poolTokenPairs: [[tokenLo, tokenHi], [0n, 0n], [0n, 0n]],
    poolStateCommitments: [honestCommitment, 0n, 0n],
  });

  // Apply the adversarial TOML mutation (A1 bumps cum_fee; A4 rewrites a flow line).
  const finalToml = proverTomlMutator ? proverTomlMutator(proverToml) : proverToml;

  // Write Prover.toml.
  const proverTomlPath = `${CIRCUIT_DIR}/Prover.toml`;
  writeFileSync(proverTomlPath, finalToml, "utf8");

  // nargo execute.
  const execResult = spawnSync(
    "/bin/bash",
    [
      "-c",
      `${process.env.QUETZAL_ENV ? `source ${process.env.QUETZAL_ENV} && ` : ""}cd ${CIRCUIT_DIR} && ${NARGO_BIN} execute --silence-warnings`,
    ],
    { encoding: "utf8", timeout: 5 * 60 * 1_000 },
  );
  if (execResult.status !== 0) {
    assert.fail([
      "nargo execute failed (witness/constraint mismatch):",
      "stdout:", execResult.stdout ?? "",
      "stderr:", execResult.stderr ?? "",
    ].join("\n"));
  }

  // bb write_vk.
  const vkDir    = `${CIRCUIT_DIR}/target/adv-vk`;
  const proofDir = `${CIRCUIT_DIR}/target/adv-proofdir`;
  rmSync(vkDir,    { recursive: true, force: true });
  mkdirSync(vkDir, { recursive: true });
  rmSync(proofDir, { recursive: true, force: true });
  mkdirSync(proofDir, { recursive: true });

  const vkResult = spawnSync(
    BB_BIN,
    [
      "write_vk",
      "-b", `${CIRCUIT_DIR}/target/clearing.json`,
      "-o", vkDir,
      "-t", "noir-recursive",
    ],
    { encoding: "utf8", timeout: 10 * 60 * 1_000 },
  );
  if (vkResult.status !== 0) {
    assert.fail(["bb write_vk failed:", vkResult.stdout, vkResult.stderr].join("\n"));
  }
  const vkFile = `${vkDir}/vk`;

  // bb prove.
  const proveResult = spawnSync(
    BB_BIN,
    [
      "prove",
      "-b", `${CIRCUIT_DIR}/target/clearing.json`,
      "-w", `${CIRCUIT_DIR}/target/clearing.gz`,
      "-o", proofDir,
      "-k", vkFile,
    ],
    { encoding: "utf8", timeout: 40 * 60 * 1_000 },
  );
  if (proveResult.status !== 0) {
    assert.fail([
      "bb prove failed:",
      `exit=${proveResult.status}`,
      "stdout:", proveResult.stdout ?? "",
      "stderr:", proveResult.stderr ?? "",
    ].join("\n"));
  }

  // Parse proof + vk.
  const proofFieldsFile = readProofAsFields(`${proofDir}/proof`);
  const vkFieldsFile    = readVkAsFields(vkFile);
  const proofFields = bridgeProofToContractSize(proofFieldsFile);
  const vkFields    = bridgeVkToContractSize(vkFieldsFile);
  assert.equal(proofFields.length, CONTRACT_PROOF_SIZE, "bridged proof length");
  assert.equal(vkFields.length,    CONTRACT_VK_SIZE,    "bridged vk length");

  // Build the on-chain calldata struct using overrides. For A1/A4 the override
  // must mirror the TOML mutation so flatten(calldata) == proof's public inputs.
  const fills = (clearingResult.fills ?? []).map((f) => ({
    orderNonce: f.orderNonce,
    amountOut: f.amountOut,
  }));
  const publicInputsStruct = await buildAdversarialPublicInputsStruct(
    epochResult,
    perPoolClearing,
    tokenLo,
    tokenHi,
    honestCommitment,
    fills,
    calldataOverrides ?? {},
  );

  return { publicInputsStruct, proofFields, vkFields, epochResult };
}

// ---------------------------------------------------------------------------
// Suite.
// ---------------------------------------------------------------------------

describe(
  "clearing adversarial validation — Task 11 §6 acceptance criterion",
  {
    timeout: 120 * 60 * 1_000, // 2 h: multiple full bb prove runs at N=32
    skip: !RUN_LIVE,
  },
  () => {
    let node: AztecNode;
    let wallet: EmbeddedWallet;
    let admin: AztecAddress;
    let alice: AztecAddress;  // the single seller (holds token B)
    let tUSDC: TokenContract;
    let tETH: TokenContract;
    let tBTC: TokenContract;             // for the A3 mis-pointed pool
    let pool: LiquidityPoolContract;     // pool 0: canonical (lo, hi) of {tUSDC, tETH} (priced)
    let pool2: LiquidityPoolContract;    // pool 1: tUSDC/tBTC (the wrong pool A3 points to)
    let orderbook: OrderbookContract;

    // Pool 0 token roles (resolved at deploy time so token_a = canonical lo).
    let pool0TokenA: TokenContract;      // canonical lo  -> clearing "token A"
    let pool0TokenB: TokenContract;      // canonical hi  -> clearing "token B"

    before(async () => {
      node = await connectToSandbox();
      const env = await getTestWallets(node, 2);
      wallet = env.wallet;
      admin  = env.accounts[0]!;
      alice  = env.accounts[1]!;

      // Deploy tokens.
      tUSDC = (await TokenContract.deployWithOpts(
        { wallet, method: "constructor_with_minter" },
        "tUSDC".padEnd(31, "\0"), "tUSDC".padEnd(31, "\0"), 6, admin,
      ).send({ from: admin })).contract;

      tETH = (await TokenContract.deployWithOpts(
        { wallet, method: "constructor_with_minter" },
        "tETH".padEnd(31, "\0"), "tETH".padEnd(31, "\0"), 18, admin,
      ).send({ from: admin })).contract;

      // tBTC only needed for the A3 fixture (its actual reserves are nominal).
      tBTC = (await TokenContract.deployWithOpts(
        { wallet, method: "constructor_with_minter" },
        "tBTC".padEnd(31, "\0"), "tBTC".padEnd(31, "\0"), 8, admin,
      ).send({ from: admin })).contract;

      // Canonicalize the pool-0 pair by u128 truncation (matches the contract
      // registry's `(token.to_field() as u128) <` ordering, NOT full-Fr). We
      // deploy pool 0 with token_a = canonical lo, token_b = canonical hi so the
      // clearing convention (side=true sells token B = hi) lines up exactly with
      // the orderbook escrow rule (side=true escrows path[hi]) AND the registry.
      const U128_MASK = (1n << 128n) - 1n;
      const usdcF = BigInt(tUSDC.address.toString()) & U128_MASK;
      const ethF  = BigInt(tETH.address.toString()) & U128_MASK;
      const btcF  = BigInt(tBTC.address.toString()) & U128_MASK;
      if (usdcF < ethF) {
        pool0TokenA = tUSDC; pool0TokenB = tETH;
      } else {
        pool0TokenA = tETH;  pool0TokenB = tUSDC;
      }
      const [p0lo, p0hi] = [pool0TokenA.address, pool0TokenB.address];
      const [p1lo, p1hi] = usdcF < btcF ? [tUSDC.address, tBTC.address] : [tBTC.address, tUSDC.address];

      const ZERO_ADDR = { address: 0n } as const;

      // pool 0: canonical (lo, hi) of {tUSDC, tETH} — the pool whose circuit PRICED the clearing.
      pool = (await LiquidityPoolContract.deploy(
        wallet, pool0TokenA.address, pool0TokenB.address, P_MIN_SQRT, BUCKET_GROWTH_NUM, admin,
      ).send({ from: admin })).contract;

      // pool 1: tUSDC/tBTC (the pool A3 will mis-point pool_id to). Deployed in
      // canonical order so it registers cleanly.
      pool2 = (await LiquidityPoolContract.deploy(
        wallet, p1lo, p1hi, P_MIN_SQRT, BUCKET_GROWTH_NUM, admin,
      ).send({ from: admin })).contract;

      // Read vk_hash from the compiled circuit.
      const vkHash = readVkHash(`${CIRCUIT_DIR}/target/vk.bin/vk_hash`);

      // Deploy orderbook with BOTH pools registered (pool_count = 2).
      orderbook = (await OrderbookContract.deploy(
        wallet, EPOCH_LEN, vkHash, ZERO_ADDR, 0n, 2,
        [pool.address, pool2.address, ZERO_ADDR, ZERO_ADDR],
        [p0lo, p1lo, ZERO_ADDR, ZERO_ADDR],
        [p0hi, p1hi, ZERO_ADDR, ZERO_ADDR],
        admin,
      ).send({ from: admin })).contract;

      // Wire both pools to the orderbook.
      await pool.methods.set_orderbook(orderbook.address).send({ from: admin });
      await pool2.methods.set_orderbook(orderbook.address).send({ from: admin });

      // Seed balances.
      //   admin: enough of token A (lo) to bootstrap both pools' bucket 0.
      //   alice: enough of token B (hi of pool 0) to place the sell order.
      await pool0TokenA.methods
        .mint_to_private(admin, BOOTSTRAP_DEPOSIT_A + POOL2_DEPOSIT_A + 1_000n * ONE_USDC)
        .send({ from: admin });
      await pool0TokenB.methods
        .mint_to_private(alice, SELL_AMOUNT_B * 4n + ONE_ETH)
        .send({ from: admin });
      // pool 2 needs its own token-A (lo) seed for the bootstrap deposit.
      const pool1lo = usdcF < btcF ? tUSDC : tBTC;
      await pool1lo.methods
        .mint_to_private(admin, POOL2_DEPOSIT_A + 1_000n * ONE_USDC)
        .send({ from: admin });

      const zeroBucketHint = {
        reserve_a: 0n, reserve_b: 0n, liquidity: 0n,
        cum_fee_a_per_share: 0n, cum_fee_b_per_share: 0n,
      };

      // Bootstrap pool 0: deposit token A into bucket 0 at p_min (below-range ->
      // single-sided fund; reserve_a>0, reserve_b=0, L = amount_a * 0.3 < 2^64).
      const hint0Raw = (await pool.methods.get_pool_state().simulate({ from: admin })).result as RawPoolState;
      const hint0PoolHint = {
        reserve_a: BigInt(hint0Raw.reserve_a),
        reserve_b: BigInt(hint0Raw.reserve_b),
        current_sqrt_price: BigInt(hint0Raw.current_sqrt_price),
      };
      await pool.methods
        .deposit(0n, BOOTSTRAP_DEPOSIT_A, 0n, hint0PoolHint, zeroBucketHint, randomField(), randomField(), randomField())
        .send({ from: admin });

      // DIAGNOSTIC: empirical post-deposit bucket-0 state + canonical ordering.
      {
        const dbgPool = (await pool.methods.get_pool_state().simulate({ from: admin })).result as RawPoolState;
        const dbgB0   = (await pool.methods.get_bucket(0n).simulate({ from: admin })).result as RawBucketState;
        console.log(`[adv-diag] pool0 reserve_a=${dbgPool.reserve_a} reserve_b=${dbgPool.reserve_b} sqrt_p=${dbgPool.current_sqrt_price}`);
        console.log(`[adv-diag] pool0 bucket0 reserve_a=${dbgB0.reserve_a} reserve_b=${dbgB0.reserve_b} liquidity=${dbgB0.liquidity} (L<2^64? ${BigInt(dbgB0.liquidity) < (1n << 64n)})`);
        console.log(`[adv-diag] tokenA(lo)=${pool0TokenA.address.toString().slice(0, 14)} tokenB(hi)=${pool0TokenB.address.toString().slice(0, 14)}`);
      }

      // Bootstrap pool 2 (single-sided too) so its pool_id resolves for A3.
      const hint2Raw = (await pool2.methods.get_pool_state().simulate({ from: admin })).result as RawPoolState;
      const hint2PoolHint = {
        reserve_a: BigInt(hint2Raw.reserve_a),
        reserve_b: BigInt(hint2Raw.reserve_b),
        current_sqrt_price: BigInt(hint2Raw.current_sqrt_price),
      };
      await pool2.methods
        .deposit(0n, POOL2_DEPOSIT_A, 0n, hint2PoolHint, zeroBucketHint, randomField(), randomField(), randomField())
        .send({ from: admin });
    });

    after(async () => {
      const stop = (wallet as unknown as { stop?: () => Promise<void> }).stop;
      if (typeof stop === "function") await stop.call(wallet);
    });

    // -----------------------------------------------------------------------
    // Shared order-submission + pool-read helper.
    //
    // Submits ONE sell order (alice sells token B = canonical hi into pool 0),
    // reads its note back, reads the epoch state, and reads the full concentrated
    // pool-0 state (all 16 buckets + bounds) into a PoolWithBuckets.
    //
    // LIVE-TUNING NOTE: the clearing-price search band is derived from bucket 0's
    // sqrt bounds (lo = bandLo/PRICE_BAND, hi = bandHi*PRICE_BAND), which is wide.
    // A sell that does NOT saturate bucket 0 should clear. If computeClearingV2
    // returns !cleared at runtime (e.g. SELL_AMOUNT_B exhausts bucket 0's
    // liquidity, or the realized price falls outside the band), the live-run
    // operator should retune BOOTSTRAP_DEPOSIT_A (more liquidity) and/or
    // SELL_AMOUNT_B (smaller sell) and re-run. Keep L = amount_a * 0.3 < 2^64.
    // -----------------------------------------------------------------------
    async function submitAndReadOrders(): Promise<{
      ordersForWitness: OrderNotePreimage[];
      epochResult: {
        order_acc: bigint;
        cancel_acc: bigint;
        order_count: bigint | number;
        cancel_count: bigint | number;
        closes_at_block: bigint;
      };
      pool: PoolWithBuckets;
      tokenAAddr: bigint;
      tokenBAddr: bigint;
    }> {
      const sellNonce = randomField();

      // Canonical path for pool 0: [lo, hi, 0]. token_a = lo, token_b = hi.
      // Contract escrow rule (orderbook/main.nr:471-479):
      //   side=false (bid) → escrow path[0]    (canonical lo)
      //   side=true  (ask) → escrow path[last] (canonical hi)
      // We submit a SELL (clearing convention side=true = sell token B). Alice
      // escrows path[last] = canonical hi = token B (which she holds). The SAME
      // side bool is read back into the witness, so clearing sees side=true =
      // sell token B in — fully consistent with the escrow.
      const canonicalPath = [pool0TokenA.address, pool0TokenB.address, Fr.ZERO];
      const sellSide = true; // ask -> escrows path[hi] = token B = tokenB(hi)

      await orderbook.methods
        .submit_order(sellSide, SELL_AMOUNT_B, SELL_LIMIT, randomField(), sellNonce,
          2n, canonicalPath)
        .send({ from: alice });

      // Read alice's sell order note.
      const aliceRaw = await orderbook.methods.get_orders(alice).simulate({ from: alice });
      const aliceBv = (aliceRaw as {
        result: { storage: OrderNoteFields[]; len: bigint | number };
      }).result;
      const aliceLen = Number(aliceBv.len);
      assert.ok(aliceLen >= 1, "alice must have at least 1 order note");
      const sellNote = aliceBv.storage.slice(0, aliceLen)
        .find((n) => BigInt(n.nonce) === sellNonce);
      assert.ok(sellNote, "alice's sell order note not found by nonce");

      // Single order — no sort needed, but keep the OrderNotePreimage shape.
      const ordersForWitness: OrderNotePreimage[] = [
        {
          side: true,
          amount_in: BigInt(sellNote.amount_in),
          limit_price: BigInt(sellNote.limit_price),
          order_nonce: sellNonce,
          submitted_at_block: Number(sellNote.submitted_at_block),
          owner: BigInt(sellNote.owner),
        },
      ];

      // Read epoch state.
      const epochRaw = await orderbook.methods.get_epoch().simulate({ from: admin });
      const epochResult = (epochRaw as {
        result: {
          epoch_id: bigint | number;
          order_acc: bigint;
          cancel_acc: bigint;
          order_count: bigint | number;
          cancel_count: bigint | number;
          closes_at_block: bigint;
        };
      }).result;

      // Read the full concentrated pool-0 state: aggregate + 16 buckets + bounds.
      const psRaw = (await pool.methods.get_pool_state().simulate({ from: admin })).result as RawPoolState;
      const pMinSqrt   = BigInt((await pool.methods.get_p_min_sqrt().simulate({ from: admin })).result as bigint | number);
      const growthNum  = BigInt((await pool.methods.get_bucket_growth_num().simulate({ from: admin })).result as bigint | number);
      const bucketStates: BucketState[] = [];
      for (let i = 0; i < NUM_BUCKETS; i++) {
        const bRaw = (await pool.methods.get_bucket(BigInt(i)).simulate({ from: admin })).result as RawBucketState;
        bucketStates.push({
          reserve_a: BigInt(bRaw.reserve_a),
          reserve_b: BigInt(bRaw.reserve_b),
          liquidity: BigInt(bRaw.liquidity),
          cum_fee_a_per_share: BigInt(bRaw.cum_fee_a_per_share),
          cum_fee_b_per_share: BigInt(bRaw.cum_fee_b_per_share),
        });
      }
      const bucketBounds = computeAllBucketBounds(pMinSqrt, growthNum, NUM_BUCKETS);

      const poolWithBuckets: PoolWithBuckets = {
        reserveA: BigInt(psRaw.reserve_a),
        reserveB: BigInt(psRaw.reserve_b),
        lpSupply: 0n, // unused by computeClearingV2 in the Sub-2.5+ V3 path
        currentSqrtPrice: BigInt(psRaw.current_sqrt_price),
        bucketBounds,
        bucketStates,
      };

      return {
        ordersForWitness,
        epochResult,
        pool: poolWithBuckets,
        tokenAAddr: BigInt(pool0TokenA.address.toString()),
        tokenBAddr: BigInt(pool0TokenB.address.toString()),
      };
    }

    // -----------------------------------------------------------------------
    // A1: fabricated pool before-state → "pool state commitment mismatch"
    //
    // FABRICATION MECHANISM:
    //   The honest clear has a REAL active bucket 0 (funded single-sided). The
    //   circuit's block D' recomputes pool_state_commitment from the PRIVATE
    //   before-state (pool_bucket_states_before[0][0]) and asserts it equals the
    //   public pool_state_commitment input. We fabricate by BUMPING bucket-0's
    //   cum_fee_a_per_share by +CUM_FEE_BUMP in BOTH the before AND after state
    //   (so assert_bucket_step's after = before + increment still holds; cum_fee
    //   does NOT enter the V3 swap/sqrt math, so the proof stays valid). We set
    //   the calldata pool_state_commitment to poseidon over the BUMPED before-
    //   state, so flatten(calldata) == proof public inputs and verify passes.
    //
    //   On-chain the pool's LIVE bucket 0 has the HONEST cum_fee (unchanged), so
    //   apply_clearing's recompute at pool/src/main.nr:249-250 produces a
    //   DIFFERENT digest → revert "pool state commitment mismatch".
    //
    //   OPERATOR NOTE: the TOML mutator find+replaces the REAL bucket-0 before/
    //   after state LINES (matched on the witness-emitted reserve_a value). This
    //   depends on buildClearingWitnessMultiPair's single-line inline-table TOML
    //   layout for pool_bucket_states_before/after (witness.ts:504-530). If that
    //   layout changes, update the regex.
    // -----------------------------------------------------------------------
    it(
      "A1: fabricated before-state commitment → revert 'pool state commitment mismatch'",
      { timeout: 60 * 60 * 1_000 },
      async () => {
        const { ordersForWitness, epochResult, pool: poolWB, tokenAAddr, tokenBAddr } =
          await submitAndReadOrders();

        // Re-derive the honest clear so we know the REAL bucket-0 before/after
        // states the witness will emit (to target the regex + recompute the
        // fabricated commitment).
        const clearingOrders: ClearingOrder[] = ordersForWitness.map((o) => ({
          side: o.side, amountIn: o.amount_in, limitPrice: o.limit_price,
          submittedAtBlock: o.submitted_at_block, orderNonce: o.order_nonce,
        }));
        const cr = computeClearingV2(poolWB, clearingOrders);
        assert.ok(cr.cleared, "A1: honest one-sided sell must clear (else retune amounts)");
        const deltas = cr.bucketDeltas ?? [];
        const before = cr.bucketStatesBefore ?? [];
        const after  = cr.bucketStatesAfter  ?? [];
        assert.ok(deltas.length >= 1 && before.length >= 1 && after.length >= 1,
          "A1: one-sided clear must touch >=1 bucket");

        // The bump constant: +1_000_000 on cum_fee_a_per_share of bucket-0's before+after state.
        const CUM_FEE_BUMP = 1_000_000n;

        const realBefore0 = before[0]!;
        const realAfter0  = after[0]!;

        // Map the REAL before-state to BucketStateForCircuit (bucket_id from the
        // index-aligned delta) so we can recompute BOTH the honest commitment (to
        // find+swap it in the TOML) and the fabricated commitment (the bumped one).
        const realBeforeForCircuit: BucketStateForCircuit[] = before.map((s, i) => ({
          bucket_id: deltas[i]?.bucket_id ?? 0,
          reserve_a: s.reserve_a,
          reserve_b: s.reserve_b,
          liquidity: s.liquidity,
          cum_fee_a_per_share: s.cum_fee_a_per_share,
          cum_fee_b_per_share: s.cum_fee_b_per_share,
        }));
        // produceAdversarialProof computes + emits THIS commitment into the TOML.
        const honestCommitment = await computePoolStateCommitment(
          poolWB.currentSqrtPrice, realBeforeForCircuit, deltas, deltas.length,
        );

        // Fabricated before-state (bump cum_fee_a_per_share on bucket 0).
        const fabBeforeForCircuit: BucketStateForCircuit[] = realBeforeForCircuit.map((s, i) =>
          i === 0 ? { ...s, cum_fee_a_per_share: s.cum_fee_a_per_share + CUM_FEE_BUMP } : s,
        );
        const fabricatedCommitment = await computePoolStateCommitment(
          poolWB.currentSqrtPrice, fabBeforeForCircuit, deltas, deltas.length,
        );

        // TOML mutator: (1) bump bucket-0 before+after cum_fee_a_per_share lines so
        // the circuit's D' recompute yields the FABRICATED commitment AND the step
        // assert (after = before + increment) still holds; (2) swap the public
        // pool_state_commitment from honest -> fabricated so the circuit's D'
        // equality check passes AND flatten(calldata) == proof public inputs.
        function fabricateA1(toml: string): string {
          const fmt = (s: { reserve_a: bigint; reserve_b: bigint; liquidity: bigint; cum_fee_a_per_share: bigint; cum_fee_b_per_share: bigint }) =>
            `{ reserve_a = "${s.reserve_a}", reserve_b = "${s.reserve_b}", ` +
            `liquidity = "${s.liquidity}", cum_fee_a_per_share = "${s.cum_fee_a_per_share}", ` +
            `cum_fee_b_per_share = "${s.cum_fee_b_per_share}" }`;

          // BEFORE line (real -> bumped).
          const beforeReal = fmt(realBefore0);
          const beforeBumped = fmt({ ...realBefore0, cum_fee_a_per_share: realBefore0.cum_fee_a_per_share + CUM_FEE_BUMP });
          assert.ok(toml.includes(beforeReal),
            "A1: could not find real bucket-0 BEFORE state line in TOML (layout changed — update regex)");
          let mutated = toml.replace(beforeReal, beforeBumped);

          // AFTER line (real -> bumped by the same constant, so step assert holds).
          const afterReal = fmt(realAfter0);
          const afterBumped = fmt({ ...realAfter0, cum_fee_a_per_share: realAfter0.cum_fee_a_per_share + CUM_FEE_BUMP });
          assert.ok(mutated.includes(afterReal),
            "A1: could not find real bucket-0 AFTER state line in TOML (layout changed — update regex)");
          mutated = mutated.replace(afterReal, afterBumped);

          // Swap the public pool_state_commitment (honest -> fabricated) in the swap struct.
          const commTok    = `pool_state_commitment = "${honestCommitment}"`;
          const commFabTok  = `pool_state_commitment = "${fabricatedCommitment}"`;
          assert.ok(mutated.includes(commTok),
            "A1: could not find honest pool_state_commitment token in TOML (layout changed — update regex)");
          mutated = mutated.replace(commTok, commFabTok);

          return mutated;
        }

        const { publicInputsStruct, proofFields, vkFields, epochResult: er } =
          await produceAdversarialProof({
            ordersForWitness,
            epochResult,
            tokenAAddr,
            tokenBAddr,
            poolId: 0,
            pool: poolWB,
            proverTomlMutator: fabricateA1,
            calldataOverrides: {
              // calldata commitment MUST equal the fabricated commitment so
              // flatten(calldata) == proof public inputs (else verify rejects at
              // the wrong layer). The TOML commitment is bumped to match in fabricateA1.
              poolStateCommitmentOverride: fabricatedCommitment,
            },
          });

        // Mine past epoch expiry.
        while ((await currentBlock(node)) < Number(er.closes_at_block)) {
          await tUSDC.methods.mint_to_public(admin, 1n).send({ from: admin });
        }

        // The proof is VALID (recursive verifier accepts it) but the pool's live
        // recompute produces the HONEST commitment (cum_fee unchanged) while the
        // proof encodes the FABRICATED commitment → revert.
        //
        // NOTE: cast to any — the generated Orderbook.ts bindings may predate the
        // Task 7 ABI fields; the contract runtime accepts them.
        await assert.rejects(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (orderbook.methods as any)
            .close_epoch_and_clear_verified(publicInputsStruct, proofFields, vkFields)
            .send({ from: admin }),
          /pool state commitment mismatch/i,
          "A1: fabricated before-state must be rejected by pool-side live recompute",
        );
      },
    );

    // -----------------------------------------------------------------------
    // A3: mis-pointed pool_id → "pool_id pair mismatch"
    //
    // FABRICATION MECHANISM:
    //   The circuit priced the clearing for pool 0. We set
    //   active_pools[0].pool_id = 1 (the tUSDC/tBTC pool) in BOTH the witness
    //   (via poolId:1) and the calldata (poolIdOverride:1n). The circuit does NOT
    //   constrain pool_id against the priced pair (block D'' binds only
    //   token_lo/hi to pool_token_pairs[p], not pool_id), so the proof is valid.
    //   On-chain the orderbook reads the registry pair for pool_id=1 (tUSDC/tBTC)
    //   and asserts it equals token_lo/hi (pool-0's pair) → revert at
    //   orderbook/src/main.nr:904 "pool_id pair mismatch".
    //
    //   OPERATOR NOTE: pool_id=1 MUST be a real registered pool (pool2 is deployed
    //   + bootstrapped in before() for this reason). token_lo/hi stay as pool-0's
    //   canonical pair (the priced pair).
    // -----------------------------------------------------------------------
    it(
      "A3: mis-pointed pool_id → revert 'pool_id pair mismatch'",
      { timeout: 60 * 60 * 1_000 },
      async () => {
        const { ordersForWitness, epochResult, pool: poolWB, tokenAAddr, tokenBAddr } =
          await submitAndReadOrders();

        const { publicInputsStruct, proofFields, vkFields, epochResult: er } =
          await produceAdversarialProof({
            ordersForWitness,
            epochResult,
            tokenAAddr,
            tokenBAddr,
            poolId: 1, // <<< witness uses pool_id=1 (tUSDC/tBTC) though the priced pair is pool-0's
            pool: poolWB,
            // No TOML mutation: the witness builder emits pool_id=1 from perPoolClearing.pool_id.
            calldataOverrides: {
              poolIdOverride: 1n, // calldata pool_id must match the proof's pool_id (1).
            },
          });

        // Mine past epoch expiry.
        while ((await currentBlock(node)) < Number(er.closes_at_block)) {
          await tUSDC.methods.mint_to_public(admin, 1n).send({ from: admin });
        }

        await assert.rejects(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (orderbook.methods as any)
            .close_epoch_and_clear_verified(publicInputsStruct, proofFields, vkFields)
            .send({ from: admin }),
          /pool_id pair mismatch/i,
          "A3: mis-pointed pool_id must be rejected by the orderbook's registry pair assert",
        );
      },
    );

    // -----------------------------------------------------------------------
    // A4: mismatched aggregate flows → "a_from_pool != sum reserve_a_sub"
    //
    // FABRICATION MECHANISM:
    //   The honest one-sided SELL pulls token A OUT of the pool, so a_from_pool =
    //   Σ reserve_a_sub > 0. We override a_from_pool := honest + 1 in BOTH the
    //   Prover.toml and the calldata (everything else honest). The circuit does
    //   NOT constrain the 4 flow public inputs (pass-through), so the proof stays
    //   valid AND flatten(calldata) == proof public inputs (verify passes). The
    //   pool's apply_clearing re-derives the flows from the bucket deltas and
    //   asserts equality (Task 7 flow-binding) at pool/src/main.nr:269 →
    //   revert "a_from_pool != sum reserve_a_sub".
    //
    //   OPERATOR NOTE: the TOML mutator rewrites the `a_from_pool = "<honest>"`
    //   token inside the swap inline-table. This depends on the witness's
    //   single-line swap layout (witness.ts:442-451). If that changes, update the
    //   regex. We pick a_from_pool because it is the non-zero flow for a one-sided
    //   sell (the seller pulls token A out).
    // -----------------------------------------------------------------------
    it(
      "A4: mismatched aggregate flow → revert 'a_from_pool != sum reserve_a_sub'",
      { timeout: 60 * 60 * 1_000 },
      async () => {
        const { ordersForWitness, epochResult, pool: poolWB, tokenAAddr, tokenBAddr } =
          await submitAndReadOrders();

        // Re-derive the honest flows so we know the value to bump.
        const clearingOrders: ClearingOrder[] = ordersForWitness.map((o) => ({
          side: o.side, amountIn: o.amount_in, limitPrice: o.limit_price,
          submittedAtBlock: o.submitted_at_block, orderNonce: o.order_nonce,
        }));
        const cr = computeClearingV2(poolWB, clearingOrders);
        assert.ok(cr.cleared, "A4: honest one-sided sell must clear (else retune amounts)");
        const honestFlows = deriveAggregateFlows(cr.bucketDeltas ?? []);
        assert.ok(honestFlows.aFromPool > 0n,
          "A4: a_from_pool must be > 0 for a one-sided sell (seller pulls token A out)");
        const fabricatedAFromPool = honestFlows.aFromPool + 1n;

        // TOML mutator: rewrite the honest a_from_pool value to fabricated inside
        // the swap inline-table. The witness emits `a_from_pool = "<value>"`.
        function bumpAFromPool(toml: string): string {
          const honestTok = `a_from_pool = "${honestFlows.aFromPool}"`;
          const fabTok     = `a_from_pool = "${fabricatedAFromPool}"`;
          assert.ok(toml.includes(honestTok),
            "A4: could not find honest a_from_pool token in TOML (layout changed — update regex)");
          // Replace only the FIRST occurrence (pool slot 0); sentinel slots use 0.
          return toml.replace(honestTok, fabTok);
        }

        const { publicInputsStruct, proofFields, vkFields, epochResult: er } =
          await produceAdversarialProof({
            ordersForWitness,
            epochResult,
            tokenAAddr,
            tokenBAddr,
            poolId: 0,
            pool: poolWB,
            proverTomlMutator: bumpAFromPool,
            calldataOverrides: {
              flowOverride: { field: "a_from_pool", value: fabricatedAFromPool },
            },
          });

        // Mine past epoch expiry.
        while ((await currentBlock(node)) < Number(er.closes_at_block)) {
          await tUSDC.methods.mint_to_public(admin, 1n).send({ from: admin });
        }

        await assert.rejects(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (orderbook.methods as any)
            .close_epoch_and_clear_verified(publicInputsStruct, proofFields, vkFields)
            .send({ from: admin }),
          /a_from_pool != sum reserve_a_sub/i,
          "A4: mismatched aggregate flow must be rejected by the pool's flow-binding assert",
        );
      },
    );
  },
);
