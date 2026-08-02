/**
 * Clearing daemon. Polls on-chain state; at epoch close, drains the queue,
 * validates reveals, computes clearing, runs bb prove (shelled out), submits
 * to Orderbook.close_epoch_and_clear_verified. Race losers see a clean revert
 * and proceed to the next epoch.
 *
 * The single-cycle entrypoint `runOneClearingCycle` is exported for tests; the
 * long-running loop `runDaemon` invokes it on a polling interval.
 */
import { pathToFileURL } from "node:url";
import { Fr } from "@aztec/aztec.js/fields";
import type { RevealQueue } from "./queue.js";
import { validateReveals } from "./validate.js";
import {
  computeClearingV2,
  type ClearingOrder,
  type PoolWithBuckets,
  type BucketDeltaResult,
} from "./clearing.js";
import { buildClearingWitness, type OrderNotePreimage, type BucketStateForCircuit, type BucketDeltaForCircuit } from "./witness.js";
import { buildFillsTree } from "./merkle.js";
import { writeSnapshot } from "./snapshot.js";
import type { BucketBounds, BucketState } from "./buckets.js";

export interface DaemonContext {
  queue: RevealQueue;
  snapshotsDir: string;
  /** Read the orderbook's current epoch state. */
  getEpoch: () => Promise<{
    epoch_id: number; closes_at_block: number;
    order_acc: Fr; order_count: number;
    cancel_acc: Fr; cancel_count: number;
  }>;
  /**
   * Read the pool's reserves + lp_supply.
   * Sub-2.5: also returns current_sqrt_price for bucket-aware clearing.
   * Bucket-state reading (bucketBounds, bucketStates) is wired by the testnet
   * operator — see TODO below.
   */
  getPool: () => Promise<{
    reserve_a: bigint;
    reserve_b: bigint;
    lp_supply: bigint;
    /** Sub-2.5: current pool sqrt price (Q64.64 fixed-point). 0n if not wired. */
    current_sqrt_price?: bigint;
    /**
     * Concentrated buckets (Phase F2). When supplied, clearing routes through the
     * V3 bucket engine; the operator wires these from the on-chain pool contract.
     * Omitted => no funded buckets => the concentrated path cannot clear.
     */
    bucketBounds?: BucketBounds[];
    bucketStates?: BucketState[];
  }>;
  /** Read current L2 block height. */
  getBlockNumber: () => Promise<number>;
  /** Shell out: nargo execute on the witness, return path to clearing.gz. */
  runNargoExecute: (proverToml: string) => Promise<void>;
  /** Shell out: bb prove and return the binary proof. */
  runBbProve: () => Promise<Buffer>;
  /** Read the pre-computed vk binary. */
  getVkBytes: () => Promise<Buffer>;
  /** Submit the clearing tx to the orderbook. */
  submitClearing: (args: {
    publicInputs: unknown;
    proof: Fr[];
    vk: Fr[];
  }) => Promise<void>;
}

const HONK_PROOF_FIELDS = 458; // v5 bb ZK UltraHonk proof size (was 500 on 4.3)
const HONK_VK_FIELDS = 115;
// Audit #1: orderbook verify consumes the full bb `-t noir-recursive` shapes
// (proof 458, vk 115). Equal to HONK_*_FIELDS so the bridge fns are pass-through;
// the old 456/127 truncation corrupted the proof and broke recursive verify.
const CONTRACT_PROOF_SIZE = 458; // v5 bb ZK UltraHonk proof size (was 500 on 4.3)
const CONTRACT_VK_SIZE = 115;

function bridgeProof(buf: Buffer): Fr[] {
  if (buf.length % 32 !== 0) {
    throw new Error(`proof buffer length ${buf.length} is not a multiple of 32 — malformed bb output`);
  }
  const numFields = buf.length / 32;
  if (numFields !== CONTRACT_PROOF_SIZE) {
    throw new Error(`proof has ${numFields} fields, expected ${CONTRACT_PROOF_SIZE} — bb output shape drift`);
  }
  const fields: Fr[] = [];
  for (let i = 0; i < numFields; i++) {
    fields.push(Fr.fromBuffer(buf.subarray(i * 32, (i + 1) * 32)));
  }
  return fields;
}

function bridgeVk(buf: Buffer): Fr[] {
  if (buf.length % 32 !== 0) {
    throw new Error(`vk buffer length ${buf.length} is not a multiple of 32 — malformed bb output`);
  }
  const numFields = buf.length / 32;
  if (numFields !== CONTRACT_VK_SIZE) {
    throw new Error(`vk has ${numFields} fields, expected ${CONTRACT_VK_SIZE} — bb output shape drift`);
  }
  const fields: Fr[] = [];
  for (let i = 0; i < numFields; i++) {
    fields.push(Fr.fromBuffer(buf.subarray(i * 32, (i + 1) * 32)));
  }
  return fields;
}

export async function runOneClearingCycle(ctx: DaemonContext): Promise<void> {
  const epoch = await ctx.getEpoch();
  const blockNow = await ctx.getBlockNumber();

  if (blockNow < epoch.closes_at_block) return;

  const reveals = ctx.queue.drainEpoch(epoch.epoch_id);
  const validated = await validateReveals(reveals, epoch.order_acc);
  if (validated.length === 0 && epoch.order_count > 0) {
    // Don't have all reveals (or tampering detected). Skip - another aggregator
    // who DOES have the complete set can win this round.
    return;
  }

  const clearingOrders: ClearingOrder[] = validated.map((v) => ({
    side: v.side,
    amountIn: v.amount_in,
    limitPrice: v.limit_price,
    submittedAtBlock: v.submitted_at_block,
    orderNonce: v.order_nonce.toBigInt(),
    owner: v.owner.toBigInt(), // R1: thread owner into the hop-fill leaf
  }));
  const orderPreimages: OrderNotePreimage[] = validated.map((v) => ({
    side: v.side,
    amount_in: v.amount_in,
    limit_price: v.limit_price,
    order_nonce: v.order_nonce.toBigInt(),
    submitted_at_block: v.submitted_at_block,
    owner: v.owner.toBigInt(),
  }));

  const pool = await ctx.getPool();

  // Construct a PoolWithBuckets for computeClearingV2. The concentrated engine
  // requires funded buckets; the operator wires bucketBounds/bucketStates from
  // the on-chain pool contract (Phase F2). When omitted the pool has no funded
  // bucket and the concentrated path cannot clear (computeClearingV2 returns
  // cleared:false), which the loop below handles as a no-clear epoch advance.
  const poolWithBuckets: PoolWithBuckets = {
    reserveA: pool.reserve_a,
    reserveB: pool.reserve_b,
    lpSupply: pool.lp_supply,
    currentSqrtPrice: pool.current_sqrt_price ?? 0n,
    bucketBounds: pool.bucketBounds ?? [],
    bucketStates: pool.bucketStates ?? [],
  };

  const clearing = computeClearingV2(poolWithBuckets, clearingOrders);
  if (!clearing.cleared && clearingOrders.length > 0) {
    // No convergence - let close_epoch's no-clear path advance the epoch.
    return;
  }

  // Map ClearingResultV2 bucket arrays to the witness builder types.
  const toCircuitBucketState = (s: BucketState, id: number): BucketStateForCircuit => ({
    bucket_id: id,
    reserve_a: s.reserve_a,
    reserve_b: s.reserve_b,
    liquidity: s.liquidity,
    cum_fee_a_per_share: s.cum_fee_a_per_share,
    cum_fee_b_per_share: s.cum_fee_b_per_share,
  });
  const toCircuitBucketDelta = (d: BucketDeltaResult): BucketDeltaForCircuit => ({
    bucket_id: d.bucket_id,
    reserve_a_add: d.reserve_a_add,
    reserve_a_sub: d.reserve_a_sub,
    reserve_b_add: d.reserve_b_add,
    reserve_b_sub: d.reserve_b_sub,
    cum_fee_a_per_share_increment: d.cum_fee_a_per_share_increment,
    cum_fee_b_per_share_increment: d.cum_fee_b_per_share_increment,
  });

  const bucketDeltasV2 = (clearing.bucketDeltas ?? []).map(toCircuitBucketDelta);
  const bucketStatesBeforeV2 = (clearing.bucketStatesBefore ?? []).map((s, i) =>
    toCircuitBucketState(s, (clearing.bucketDeltas ?? [])[i]?.bucket_id ?? i),
  );
  const bucketStatesAfterV2 = (clearing.bucketStatesAfter ?? []).map((s, i) =>
    toCircuitBucketState(s, (clearing.bucketDeltas ?? [])[i]?.bucket_id ?? i),
  );
  const currentSqrtPriceAfter = clearing.currentSqrtPriceAfter ?? 0n;
  const currentSqrtPriceBefore = pool.current_sqrt_price ?? 0n;

  const witness = await buildClearingWitness({
    epoch: {
      order_acc: epoch.order_acc.toBigInt(),
      cancel_acc: epoch.cancel_acc.toBigInt(),
      order_count: epoch.order_count,
      cancel_count: epoch.cancel_count,
    },
    pool: { reserve_a: pool.reserve_a, reserve_b: pool.reserve_b, current_sqrt_price_before: currentSqrtPriceBefore },
    orders: orderPreimages,
    cancellationIndices: [],  // Sub-3 daemon does not collect cancel reveals yet
    clearing,
    bucketStatesBefore: bucketStatesBeforeV2,
    bucketStatesAfter: bucketStatesAfterV2,
    bucketDeltas: bucketDeltasV2,
    currentSqrtPriceAfter,
  });

  await ctx.runNargoExecute(witness.proverToml);
  const proofBuf = await ctx.runBbProve();
  const vkBuf = await ctx.getVkBytes();

  const tree = await buildFillsTree(
    clearing.fills.map((f) => ({ order_nonce: new Fr(f.orderNonce), amount_out: f.amountOut })),
  );
  writeSnapshot(ctx.snapshotsDir, {
    epoch_id: epoch.epoch_id,
    fills: clearing.fills.map((f) => ({ order_nonce: new Fr(f.orderNonce), amount_out: f.amountOut })),
    tree,
  });

  // Build the on-chain ClearingPublic struct shape (Sub-2.5: 42-field layout).
  // The swap field uses the new Sub-2.5 shape: aggregate flows + sqrt_p chain
  // endpoint + sparse per-bucket deltas. The Sub-1 fields (reserve_a_add/sub,
  // fee_a/b_per_share_increment, lp_supply) are replaced by the bucket-delta
  // array and current_sqrt_price_after.
  const paddedBucketDeltas = Array.from({ length: 4 }, (_, i) => {
    const d = bucketDeltasV2[i];
    return d
      ? {
          bucket_id: d.bucket_id,
          reserve_a_add: d.reserve_a_add,
          reserve_a_sub: d.reserve_a_sub,
          reserve_b_add: d.reserve_b_add,
          reserve_b_sub: d.reserve_b_sub,
          cum_fee_a_per_share_increment: d.cum_fee_a_per_share_increment,
          cum_fee_b_per_share_increment: d.cum_fee_b_per_share_increment,
        }
      : {
          bucket_id: 0xffff,
          reserve_a_add: 0n, reserve_a_sub: 0n,
          reserve_b_add: 0n, reserve_b_sub: 0n,
          cum_fee_a_per_share_increment: 0n,
          cum_fee_b_per_share_increment: 0n,
        };
  });

  // Derive aggregate a_to_pool / b_to_pool flows from clearing fills.
  let grossBuyInA = 0n, grossSellInB = 0n, buyerPayoutsB = 0n, sellerPayoutsA = 0n;
  for (const f of clearing.fills) {
    const o = orderPreimages.find((x) => x.order_nonce === f.orderNonce);
    if (!o) continue;
    if (o.side) { grossSellInB += o.amount_in; sellerPayoutsA += f.amountOut; }
    else        { grossBuyInA  += o.amount_in; buyerPayoutsB  += f.amountOut; }
  }
  const sat = (x: bigint, y: bigint) => (x > y ? x - y : 0n);

  const publicInputs = {
    order_acc: epoch.order_acc.toBigInt(),
    cancel_acc: epoch.cancel_acc.toBigInt(),
    order_count: epoch.order_count,
    cancel_count: epoch.cancel_count,
    reserve_a: pool.reserve_a,
    reserve_b: pool.reserve_b,
    pool_sqrt_p_before: currentSqrtPriceBefore,
    clearing_price: clearing.clearingPrice,
    fills_root: tree.root.toBigInt(),
    swap: {
      a_to_pool:   sat(grossBuyInA,    sellerPayoutsA),
      b_to_pool:   sat(grossSellInB,   buyerPayoutsB),
      a_from_pool: sat(sellerPayoutsA, grossBuyInA),
      b_from_pool: sat(buyerPayoutsB,  grossSellInB),
      current_sqrt_price_after: currentSqrtPriceAfter,
      active_bucket_count: bucketDeltasV2.length,
      active_bucket_deltas: paddedBucketDeltas,
    },
  };

  // Shape assertions must propagate before the submit try/catch so that a bb
  // output shape drift (wrong field count) fails loudly rather than being
  // silently swallowed as a "likely race-loss" warning.
  const proof = bridgeProof(proofBuf);
  const vk = bridgeVk(vkBuf);

  try {
    await ctx.submitClearing({ publicInputs, proof, vk });
  } catch (e) {
    // Race lost or freshness mismatch. Log + continue.
    console.warn("clearing submit failed (likely race-loss):", (e as Error).message);
  }
}

export async function runDaemon(ctx: DaemonContext, intervalMs = 2000): Promise<void> {
  while (true) {
    try {
      await runOneClearingCycle(ctx);
    } catch (e) {
      console.error("daemon cycle error:", e);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

// ── Optional relayer mode ──────────────────────────────────────────────────
// Activated by RELAYER_MODE=1 env var. The daemon file is typically imported
// as a library; this block runs only when daemon.ts IS the main entry point,
// verified via import.meta.url === pathToFileURL(process.argv[1]).href, so
// importing daemon.ts from tests or other modules does NOT trigger the relayer.
// The clearing loop (runDaemon) is NOT started here — the host binary is
// responsible for calling runDaemon; this block only spawns the relayer loop
// as a parallel side-effect.
if (process.env.RELAYER_MODE === "1" && import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  // Use an async IIFE so we can await imports inside a module-level context.
  (async () => {
    console.log("daemon: RELAYER_MODE=1 → starting relayer loop");

    const { runRelayerLoop } = await import("./relayer-mode.js");
    const { loadConfig } = await import("../../cli/src/config.js");

    if (!process.env.L1_RPC_URL) throw new Error("RELAYER_MODE requires L1_RPC_URL");
    if (!process.env.L1_PRIVATE_KEY) throw new Error("RELAYER_MODE requires L1_PRIVATE_KEY");

    const config = loadConfig();
    if (!config.treasury) throw new Error("RELAYER_MODE requires config.treasury");

    // Build bridgesByAddress from config.l1.{usdcBridge, wethBridge, wbtcBridge}.
    // Keys are lowercased for case-insensitive matching at runtime.
    const bridgesByAddress: Record<string, "USDC" | "WETH" | "wBTC"> = {};
    if (config.l1?.usdcBridge) bridgesByAddress[config.l1.usdcBridge.toLowerCase()] = "USDC";
    if (config.l1?.wethBridge) bridgesByAddress[config.l1.wethBridge.toLowerCase()] = "WETH";
    if (config.l1?.wbtcBridge) bridgesByAddress[config.l1.wbtcBridge.toLowerCase()] = "wBTC";

    // L22/v5: bridge → L2 token address (bytes32 l2Sender for withdraw calls).
    const l2SendersByBridge: Record<string, string> = {};
    if (config.l1?.usdcBridge && config.tUSDC)
      l2SendersByBridge[config.l1.usdcBridge.toLowerCase()] = config.tUSDC;
    if (config.l1?.wethBridge && config.tETH)
      l2SendersByBridge[config.l1.wethBridge.toLowerCase()] = config.tETH;
    if (config.l1?.wbtcBridge && config.tBTC)
      l2SendersByBridge[config.l1.wbtcBridge.toLowerCase()] = config.tBTC;

    runRelayerLoop({
      aztecNodeUrl: config.nodeUrl,
      l1RpcUrl: process.env.L1_RPC_URL,
      l1PrivateKey: process.env.L1_PRIVATE_KEY as `0x${string}`,
      treasuryAddr: config.treasury,
      bridgesByAddress,
      l2SendersByBridge,
    }).catch((e: unknown) => {
      console.error("relayer-mode crashed:", e);
      process.exit(1);
    });
  })().catch((e: unknown) => {
    console.error("relayer-mode init failed:", e);
    process.exit(1);
  });
}
