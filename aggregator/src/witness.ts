/**
 * Build a Prover.toml witness from the aggregator's ClearingResult + on-chain
 * EpochState. The output feeds `nargo execute --prover-name <stem>` for the
 * clearing circuit at circuits/clearing/. The TOML field names + ordering must
 * match circuits/clearing/src/main.nr's fn main parameter list.
 *
 * IMPORTANT: The TS aggregator's ClearingResult.fills use a different fee model than
 * the Noir circuit's `payout()` function. The circuit checks each fill's amount_out
 * against `payout(order, clearing_price)` = amount_in * SCALE/P* * (FEE_DEN-FEE_NUM)/FEE_DEN.
 * The witness builder MUST recompute fills using the circuit's canonical formula.
 */
import { type ClearingResult, deriveAggregateFlows } from "./clearing.js";

export const MAX_ORDERS_PER_EPOCH = 32;

/** Sub-2.5: per-bucket state snapshot (before + after slot in private witness). */
export interface BucketStateForCircuit {
  bucket_id: number;
  reserve_a: bigint;
  reserve_b: bigint;
  liquidity: bigint;
  cum_fee_a_per_share: bigint;
  cum_fee_b_per_share: bigint;
}

/** Sub-2.5: per-bucket delta emitted to the circuit's public input. */
export interface BucketDeltaForCircuit {
  bucket_id: number;
  reserve_a_add: bigint;
  reserve_a_sub: bigint;
  reserve_b_add: bigint;
  reserve_b_sub: bigint;
  cum_fee_a_per_share_increment: bigint;
  cum_fee_b_per_share_increment: bigint;
}

/** Sub-2.5: pre-clearing pool snapshot for the new bucket-aware circuit. */
export interface PoolSnapshotForCircuitSub2 {
  reserve_a: bigint;
  reserve_b: bigint;
  current_sqrt_price_before: bigint;
}

/** Sub-2.5: padding sentinel for unused BucketDelta slots. */
export const INVALID_BUCKET_ID = 0xffff;
export const MAX_ACTIVE_BUCKETS_PER_EPOCH = 4;

/** Mirror of contracts/orderbook/src/main.nr's EpochState (subset the circuit binds to). */
export interface EpochState {
  order_acc: bigint;       // Field
  cancel_acc: bigint;      // Field
  order_count: number;
  cancel_count: number;
}

/** Mirror of contracts/orderbook/src/main.nr's OrderNote. */
export interface OrderNotePreimage {
  side: boolean;
  amount_in: bigint;
  limit_price: bigint;
  order_nonce: bigint;
  submitted_at_block: number;
  owner: bigint;           // AztecAddress.toField().toBigInt()
}

export interface ClearingWitness {
  /** TOML-encoded text to write to circuits/clearing/Prover.toml. */
  proverToml: string;
  /** The Merkle root the circuit will assert against (also the public input). */
  fillsRoot: string;
  /** The 32 leaf hashes (post-padding) — for snapshot.ts consumption. */
  leaves: string[];
  /** Echo of the cap actually used (mirrors arg / fallback). */
  maxOrdersPerEpoch: number;
}

/**
 * Build the Prover.toml witness for the clearing circuit.
 *
 * Sub-2.5 signature: 42 public fields (4 binding + 3 pool aggregate +
 * 1 fills_root + 4 flows + 2 sqrt_p chain endpoints + 28 bucket deltas)
 * and new private inputs (bucket_states_before/after, pool_sqrt_p_before).
 *
 * @param args.epoch                On-chain EpochState (binding inputs).
 * @param args.pool                 Pre-clearing pool snapshot (Sub-2.5 shape).
 * @param args.orders               Submission-order array of OrderNote preimages. Length must
 *                                  equal args.epoch.order_count. The builder pads to MAX_ORDERS_PER_EPOCH.
 * @param args.cancellationIndices  In cancellation order, each entry is the submission
 *                                  index of the cancelled order. Length must equal args.epoch.cancel_count.
 * @param args.clearing             The aggregator's ClearingResult (P*, fills, swap).
 * @param args.bucketStatesBefore   Per-bucket state before clearing (length == bucketDeltas.length).
 * @param args.bucketStatesAfter    Per-bucket state after clearing (length == bucketDeltas.length).
 * @param args.bucketDeltas         Per-bucket deltas (length <= MAX_ACTIVE_BUCKETS_PER_EPOCH).
 * @param args.currentSqrtPriceAfter New sqrt price after clearing.
 */
export async function buildClearingWitness(args: {
  epoch: EpochState;
  pool: PoolSnapshotForCircuitSub2;
  orders: OrderNotePreimage[];
  cancellationIndices: number[];
  clearing: ClearingResult;
  bucketStatesBefore: BucketStateForCircuit[];
  bucketStatesAfter: BucketStateForCircuit[];
  bucketDeltas: BucketDeltaForCircuit[];
  currentSqrtPriceAfter: bigint;
  maxOrders?: number;
}): Promise<ClearingWitness> {
  const {
    epoch, pool, orders, cancellationIndices, clearing,
    bucketStatesBefore, bucketStatesAfter, bucketDeltas, currentSqrtPriceAfter,
  } = args;
  const maxPerEpoch = args.maxOrders ?? MAX_ORDERS_PER_EPOCH;
  if (orders.length !== epoch.order_count) {
    throw new Error(`orders.length (${orders.length}) != epoch.order_count (${epoch.order_count})`);
  }
  if (cancellationIndices.length !== epoch.cancel_count) {
    throw new Error(`cancellationIndices.length (${cancellationIndices.length}) != epoch.cancel_count (${epoch.cancel_count})`);
  }
  if (bucketDeltas.length > MAX_ACTIVE_BUCKETS_PER_EPOCH) {
    throw new Error(`bucketDeltas.length (${bucketDeltas.length}) > cap ${MAX_ACTIVE_BUCKETS_PER_EPOCH}`);
  }
  if (bucketStatesBefore.length !== bucketDeltas.length) {
    throw new Error(`bucketStatesBefore.length (${bucketStatesBefore.length}) != bucketDeltas.length (${bucketDeltas.length})`);
  }
  if (bucketStatesAfter.length !== bucketDeltas.length) {
    throw new Error(`bucketStatesAfter.length (${bucketStatesAfter.length}) != bucketDeltas.length (${bucketDeltas.length})`);
  }

  // Pad orders + cancellationIndices like Sub-1.
  const ordersPadded: OrderNotePreimage[] = orders.slice();
  while (ordersPadded.length < maxPerEpoch) {
    ordersPadded.push({
      side: false, amount_in: 0n, limit_price: 0n,
      order_nonce: 0n, submitted_at_block: 0, owner: 0n,
    });
  }
  const cancelledPadded: number[] = cancellationIndices.slice();
  while (cancelledPadded.length < maxPerEpoch) cancelledPadded.push(0);

  // Reuse Sub-1 canonical-fills derivation.
  const SCALE_FE = 1_000_000_000_000_000_000n;
  const FEE_NUM_CIRCUIT = 30n, FEE_DEN_CIRCUIT = 10_000n;
  function circuitPayout(order: OrderNotePreimage, p: bigint): bigint {
    const gross = order.side
      ? (order.amount_in * p) / SCALE_FE
      : (order.amount_in * SCALE_FE) / p;
    return (gross * (FEE_DEN_CIRCUIT - FEE_NUM_CIRCUIT)) / FEE_DEN_CIRCUIT;
  }
  const orderNonceSet = new Set(orders.map((o) => o.order_nonce));
  for (const fill of clearing.fills) {
    if (!orderNonceSet.has(fill.orderNonce)) {
      throw new Error(`fill order_nonce ${fill.orderNonce} not in orders[]`);
    }
  }
  const filledNonces = new Set(clearing.fills.map((f) => f.orderNonce));
  const canonicalFills: { orderNonce: bigint; amountOut: bigint }[] = [];
  const fillToOrderIndex: number[] = [];
  for (let i = 0; i < orders.length; i++) {
    const o = orders[i]!;
    if (filledNonces.has(o.order_nonce)) {
      canonicalFills.push({
        orderNonce: o.order_nonce,
        amountOut: circuitPayout(o, clearing.clearingPrice),
      });
      fillToOrderIndex.push(i);
    }
  }
  while (fillToOrderIndex.length < maxPerEpoch) fillToOrderIndex.push(0);

  // Derive aggregate flows from canonical fills.
  let grossBuyInA = 0n, grossSellInB = 0n, buyerPayoutsB = 0n, sellerPayoutsA = 0n;
  for (const cf of canonicalFills) {
    const order = orders.find((o) => o.order_nonce === cf.orderNonce);
    if (!order) continue;
    if (order.side) { grossSellInB += order.amount_in; sellerPayoutsA += cf.amountOut; }
    else            { grossBuyInA  += order.amount_in; buyerPayoutsB  += cf.amountOut; }
  }
  const sat = (x: bigint, y: bigint) => (x > y ? x - y : 0n);
  const aToPool   = sat(grossBuyInA,  sellerPayoutsA);
  const aFromPool = sat(sellerPayoutsA, grossBuyInA);
  const bToPool   = sat(grossSellInB, buyerPayoutsB);
  const bFromPool = sat(buyerPayoutsB, grossSellInB);

  // Pad bucket arrays to MAX_ACTIVE_BUCKETS_PER_EPOCH with INVALID sentinels.
  const padBucketDelta = (d: BucketDeltaForCircuit | null): BucketDeltaForCircuit =>
    d ?? {
      bucket_id: INVALID_BUCKET_ID,
      reserve_a_add: 0n, reserve_a_sub: 0n,
      reserve_b_add: 0n, reserve_b_sub: 0n,
      cum_fee_a_per_share_increment: 0n,
      cum_fee_b_per_share_increment: 0n,
    };
  const padBucketState = (s: BucketStateForCircuit | null): BucketStateForCircuit =>
    s ?? { bucket_id: INVALID_BUCKET_ID, reserve_a: 0n, reserve_b: 0n, liquidity: 0n, cum_fee_a_per_share: 0n, cum_fee_b_per_share: 0n };

  const deltasPadded: BucketDeltaForCircuit[] = [];
  const beforePadded: BucketStateForCircuit[] = [];
  const afterPadded: BucketStateForCircuit[] = [];
  for (let i = 0; i < MAX_ACTIVE_BUCKETS_PER_EPOCH; i++) {
    deltasPadded.push(padBucketDelta(bucketDeltas[i] ?? null));
    beforePadded.push(padBucketState(bucketStatesBefore[i] ?? null));
    afterPadded.push(padBucketState(bucketStatesAfter[i] ?? null));
  }

  // Merkle root (unchanged from Sub-1).
  const { buildFillsTree } = await import("./merkle.js");
  const { Fr } = await import("@aztec/aztec.js/fields");
  const tree = await buildFillsTree(
    canonicalFills.map((cf) => ({ order_nonce: new Fr(cf.orderNonce), amount_out: cf.amountOut })),
  );

  // Emit TOML in 42-field public layout order.
  const lines: string[] = [];
  lines.push(`order_acc = "0x${epoch.order_acc.toString(16)}"`);
  lines.push(`cancel_acc = "0x${epoch.cancel_acc.toString(16)}"`);
  lines.push(`order_count = ${epoch.order_count}`);
  lines.push(`cancel_count = ${epoch.cancel_count}`);
  lines.push(`reserve_a = "${pool.reserve_a}"`);
  lines.push(`reserve_b = "${pool.reserve_b}"`);
  lines.push(`clearing_price = "${clearing.clearingPrice}"`);
  lines.push(`fills_root = "${tree.root.toString()}"`);
  lines.push(`a_to_pool = "${aToPool}"`);
  lines.push(`b_to_pool = "${bToPool}"`);
  lines.push(`a_from_pool = "${aFromPool}"`);
  lines.push(`b_from_pool = "${bFromPool}"`);
  lines.push(`current_sqrt_price_after = "${currentSqrtPriceAfter}"`);
  lines.push(`active_bucket_count = ${bucketDeltas.length}`);
  lines.push(`active_bucket_deltas = [`);
  for (const d of deltasPadded) {
    lines.push(
      `  { bucket_id = ${d.bucket_id}, ` +
      `reserve_a_add = "${d.reserve_a_add}", reserve_a_sub = "${d.reserve_a_sub}", ` +
      `reserve_b_add = "${d.reserve_b_add}", reserve_b_sub = "${d.reserve_b_sub}", ` +
      `cum_fee_a_per_share_increment = "${d.cum_fee_a_per_share_increment}", ` +
      `cum_fee_b_per_share_increment = "${d.cum_fee_b_per_share_increment}" },`,
    );
  }
  lines.push(`]`);

  // Private witnesses.
  lines.push(`orders = [`);
  for (const o of ordersPadded) {
    lines.push(`  { side = ${o.side}, amount_in = "${o.amount_in}", limit_price = "${o.limit_price}", ` +
      `order_nonce = "0x${o.order_nonce.toString(16)}", submitted_at_block = ${o.submitted_at_block}, ` +
      `owner = "0x${o.owner.toString(16)}" },`);
  }
  lines.push(`]`);
  lines.push(`cancelled_indices = [${cancelledPadded.join(", ")}]`);
  lines.push(`fills = [`);
  for (let i = 0; i < maxPerEpoch; i++) {
    const f = i < canonicalFills.length ? canonicalFills[i] : null;
    const nonce = f ? `"0x${f.orderNonce.toString(16)}"` : `"0x0"`;
    const out = f ? `"${f.amountOut}"` : `"0"`;
    lines.push(`  { order_nonce = ${nonce}, amount_out = ${out} },`);
  }
  lines.push(`]`);
  lines.push(`fills_len = ${canonicalFills.length}`);
  lines.push(`fill_to_order_index = [${fillToOrderIndex.join(", ")}]`);

  lines.push(`bucket_states_before = [`);
  for (const s of beforePadded) {
    lines.push(`  { reserve_a = "${s.reserve_a}", reserve_b = "${s.reserve_b}", ` +
      `liquidity = "${s.liquidity}", cum_fee_a_per_share = "${s.cum_fee_a_per_share}", ` +
      `cum_fee_b_per_share = "${s.cum_fee_b_per_share}" },`);
  }
  lines.push(`]`);
  lines.push(`bucket_states_after = [`);
  for (const s of afterPadded) {
    lines.push(`  { reserve_a = "${s.reserve_a}", reserve_b = "${s.reserve_b}", ` +
      `liquidity = "${s.liquidity}", cum_fee_a_per_share = "${s.cum_fee_a_per_share}", ` +
      `cum_fee_b_per_share = "${s.cum_fee_b_per_share}" },`);
  }
  lines.push(`]`);
  lines.push(`pool_sqrt_p_before = "${pool.current_sqrt_price_before}"`);

  return {
    proverToml: lines.join("\n") + "\n",
    fillsRoot: tree.root.toString(),
    leaves: tree.leaves.map((l) => l.toString()),
    maxOrdersPerEpoch: maxPerEpoch,
  };
}

// ============================================================================
// Sub-4 Task C3: multi-pair circuit witness builder
// ============================================================================
import type { HopFill, PoolClearingResult } from "./clearing.js";

export const MAX_ACTIVE_POOLS_PER_EPOCH = 3;
export const INVALID_POOL_ID = 0xffffffff;

/**
 * Build the Prover.toml witness for the Sub-4 multi-pair circuit.
 *
 * Public input shape (123 fields after audit #1 + #3 additions):
 *   order_acc, cancel_acc, order_count, cancel_count  (4)
 *   fills_root                                         (1)
 *   active_pool_count                                  (1)
 *   active_pool_clearings[3] of PoolClearing:
 *     per pool: pool_id, clearing_price, token_lo, token_hi,
 *       swap{a_to_pool, b_to_pool, a_from_pool, b_from_pool,
 *         current_sqrt_price_after, pool_state_commitment,
 *         active_bucket_count, active_bucket_deltas[4]{7 fields each}}
 *     = 2 + 2 + 7 + 4*7 = 39 fields per pool * 3 pools = 117
 *   Total = 4 + 1 + 1 + 117 = 123 fields.
 *
 * Private witnesses: orders (padded to maxOrders, now with path_len + path),
 *   cancelled_indices, fills (2 * maxOrders with hop_index + pool_id), fills_len,
 *   fill_to_order_index (64), pool_bucket_states_before/after ([4][3]),
 *   pool_sqrt_p_before ([3]), pool_token_pairs ([[Field;2];3]).
 *
 * NOTE: Aggregate flow scalars (a_to_pool etc.) are PUBLIC inputs to the circuit.
 * The circuit does NOT re-derive them from per-bucket deltas — they must be identical
 * in this Prover.toml and the on-chain calldata. Both paths call deriveAggregateFlows
 * from clearing.ts (single source of truth). Any mismatch causes verify_proof to fail.
 *
 * NOTE: Uses Sub-4's buildHopFillsTree (64-leaf, 4-field-per-leaf) wired in Task C4.
 */
export async function buildClearingWitnessMultiPair(args: {
  epoch: EpochState;
  orders: OrderNotePreimage[];
  cancellationIndices: number[];
  perPoolClearings: PoolClearingResult[];
  fills: HopFill[];
  maxOrders?: number;
  // F2 additions: optional per-pool sqrt price + canonical token pairs
  poolSqrtPBefore?: bigint[];
  poolTokenPairs?: [bigint, bigint][];
  // Audit #1 + #3 additions: per-pool state commitments + token pairs for public fields.
  // Index i corresponds to the i-th pool slot in sortedPools (sorted by pool_id).
  // Must be computed ONCE and reused for both witness and calldata (byte-identical).
  poolStateCommitments?: bigint[];
}): Promise<ClearingWitness> {
  const maxPerEpoch = args.maxOrders ?? MAX_ORDERS_PER_EPOCH;
  const { epoch, orders, cancellationIndices, perPoolClearings, fills } = args;

  if (perPoolClearings.length > MAX_ACTIVE_POOLS_PER_EPOCH) {
    throw new Error(`perPoolClearings.length (${perPoolClearings.length}) > cap ${MAX_ACTIVE_POOLS_PER_EPOCH}`);
  }
  if (fills.length > 2 * maxPerEpoch) {
    throw new Error(`fills.length (${fills.length}) > 2 * maxOrders (${2 * maxPerEpoch})`);
  }
  // L2: port the single-pool builder's input validations.
  if (orders.length !== epoch.order_count) {
    throw new Error(`orders.length (${orders.length}) !== epoch.order_count (${epoch.order_count})`);
  }
  if (orders.length > maxPerEpoch) {
    throw new Error(`orders.length (${orders.length}) > maxPerEpoch (${maxPerEpoch})`);
  }
  if (cancellationIndices.length !== epoch.cancel_count) {
    throw new Error(`cancellationIndices.length (${cancellationIndices.length}) !== epoch.cancel_count (${epoch.cancel_count})`);
  }

  // Pad orders + cancellationIndices (Sub-1 pattern). OrderNotePreimage may or
  // may not carry path_len + path (Sub-4 extension); defaults applied below.
  const ordersPadded: OrderNotePreimage[] = orders.slice();
  while (ordersPadded.length < maxPerEpoch) {
    ordersPadded.push({
      side: false, amount_in: 0n, limit_price: 0n,
      order_nonce: 0n, submitted_at_block: 0, owner: 0n,
    });
  }
  const cancelledPadded: number[] = cancellationIndices.slice();
  while (cancelledPadded.length < maxPerEpoch) cancelledPadded.push(0);

  // Build fills Merkle tree: Sub-4's 4-field-per-leaf scheme (64 leaves).
  // Each leaf = poseidon2([order_nonce, hop_index, amount_out, pool_id]).
  // Correctly distinguishes 2-hop orders with the same nonce via hop_index.
  const { buildHopFillsTree } = await import("./merkle.js");
  const { Fr } = await import("@aztec/aztec.js/fields");
  const fillsForTree = fills.map((f) => ({
    owner: new Fr(f.owner), // R1: owner-bound leaf (matches circuit hop_fill_leaf)
    order_nonce: new Fr(f.orderNonce),
    hop_index: f.hop_index,
    amount_out: f.amountOut,
    pool_id: f.pool_id,
  }));
  const tree = await buildHopFillsTree(fillsForTree, 2 * maxPerEpoch);

  // Pad active_pools to MAX_ACTIVE_POOLS_PER_EPOCH with INVALID_POOL_ID sentinels.
  const sentinelPool: PoolClearingResult = {
    pool_id: INVALID_POOL_ID,
    clearingPrice: 0n,
    bucketDeltas: [],
    currentSqrtPriceAfter: 0n,
    bucketStatesBefore: [],
    bucketStatesAfter: [],
  };
  const sortedPools = perPoolClearings.slice().sort((a, b) => a.pool_id - b.pool_id);
  while (sortedPools.length < MAX_ACTIVE_POOLS_PER_EPOCH) sortedPools.push(sentinelPool);

  const lines: string[] = [];

  // ===== Top-level public inputs =====
  lines.push(`order_acc = "0x${epoch.order_acc.toString(16)}"`);
  lines.push(`cancel_acc = "0x${epoch.cancel_acc.toString(16)}"`);
  lines.push(`order_count = ${epoch.order_count}`);
  lines.push(`cancel_count = ${epoch.cancel_count}`);
  lines.push(`fills_root = "${tree.root.toString()}"`);
  lines.push(`active_pool_count = ${perPoolClearings.length}`);

  // ===== active_pool_clearings[3] =====
  const poolStateCommitments = args.poolStateCommitments ?? [];
  lines.push(`active_pool_clearings = [`);
  for (let pi = 0; pi < sortedPools.length; pi++) {
    const pc = sortedPools[pi]!;
    // Pad bucket deltas to MAX_ACTIVE_BUCKETS_PER_EPOCH with INVALID_BUCKET_ID sentinels.
    const padsDelta = pc.bucketDeltas.slice() as Array<{
      bucket_id: number;
      reserve_a_add: bigint; reserve_a_sub: bigint;
      reserve_b_add: bigint; reserve_b_sub: bigint;
      cum_fee_a_per_share_increment: bigint;
      cum_fee_b_per_share_increment: bigint;
    }>;
    while (padsDelta.length < MAX_ACTIVE_BUCKETS_PER_EPOCH) {
      padsDelta.push({
        bucket_id: INVALID_BUCKET_ID,
        reserve_a_add: 0n, reserve_a_sub: 0n,
        reserve_b_add: 0n, reserve_b_sub: 0n,
        cum_fee_a_per_share_increment: 0n,
        cum_fee_b_per_share_increment: 0n,
      });
    }

    // Derive aggregate swap flows via the shared helper (single source of truth).
    // These are PUBLIC inputs to the circuit and MUST match the calldata values
    // produced by clearing-cycle.ts — both call deriveAggregateFlows(bucketDeltas, beforeLiquidity).
    // The circuit does NOT re-derive them; any mismatch causes verify_proof to fail.
    const { aToPool, bToPool, aFromPool, bFromPool } = deriveAggregateFlows(
      pc.bucketDeltas,
      (pc.bucketStatesBefore ?? []).map((s) => s.liquidity),
    );

    // Audit #3: token_lo/token_hi from poolTokenPairs (index-aligned with sortedPools).
    const pair = (args.poolTokenPairs ?? [])[pi] ?? [0n, 0n];
    const tokenLo = pair[0];
    const tokenHi = pair[1];

    // Audit #1: pool_state_commitment from poolStateCommitments (index-aligned).
    // Sentinel pools (pool_id == INVALID_POOL_ID) carry 0n; the circuit only
    // checks active slots (i < active_pool_count).
    const poolStateCommitment = poolStateCommitments[pi] ?? 0n;

    // TOML inline tables ({...}) MUST be single-line (the `swap` struct + each pool
    // clearing element). Multi-line inline tables are invalid TOML and nargo rejects
    // them ("invalid inline table, expected }"). Emit the whole element on one line.
    const deltasInline = padsDelta
      .map((d) =>
        `{ bucket_id = ${d.bucket_id}, ` +
        `reserve_a_add = "${d.reserve_a_add}", reserve_a_sub = "${d.reserve_a_sub}", ` +
        `reserve_b_add = "${d.reserve_b_add}", reserve_b_sub = "${d.reserve_b_sub}", ` +
        `cum_fee_a_per_share_increment = "${d.cum_fee_a_per_share_increment}", ` +
        `cum_fee_b_per_share_increment = "${d.cum_fee_b_per_share_increment}" }`,
      )
      .join(", ");
    lines.push(
      `  { pool_id = ${pc.pool_id}, clearing_price = "${pc.clearingPrice}", ` +
      `token_lo = "0x${tokenLo.toString(16)}", token_hi = "0x${tokenHi.toString(16)}", ` +
      `swap = { a_to_pool = "${aToPool}", b_to_pool = "${bToPool}", ` +
      `a_from_pool = "${aFromPool}", b_from_pool = "${bFromPool}", ` +
      `current_sqrt_price_after = "${pc.currentSqrtPriceAfter}", ` +
      `pool_state_commitment = "${poolStateCommitment}", ` +
      `active_bucket_count = ${pc.bucketDeltas.length}, ` +
      `active_bucket_deltas = [${deltasInline}] } },`,
    );
  }
  lines.push(`]`);

  // ===== Private witnesses =====
  // orders: Sub-4 adds path_len + path; fall back to defaults if not present on preimage.
  lines.push(`orders = [`);
  for (const o of ordersPadded) {
    const path_len: number = (o as any).path_len ?? 2;
    const path: bigint[] = (o as any).path ?? [0n, 0n, 0n];
    lines.push(
      `  { side = ${o.side}, amount_in = "${o.amount_in}", limit_price = "${o.limit_price}", ` +
      `order_nonce = "0x${o.order_nonce.toString(16)}", submitted_at_block = ${o.submitted_at_block}, ` +
      `owner = "0x${o.owner.toString(16)}", path_len = ${path_len}, ` +
      `path = ["0x${BigInt(path[0] ?? 0n).toString(16)}", "0x${BigInt(path[1] ?? 0n).toString(16)}", "0x${BigInt(path[2] ?? 0n).toString(16)}"] },`,
    );
  }
  lines.push(`]`);
  lines.push(`cancelled_indices = [${cancelledPadded.join(", ")}]`);

  // fills: 2 * MAX_ORDERS_PER_EPOCH slots; each has nonce, hop_index, amount_out, pool_id.
  const fillsPadded: HopFill[] = fills.slice();
  while (fillsPadded.length < 2 * maxPerEpoch) {
    fillsPadded.push({ orderNonce: 0n, hop_index: 0, amountOut: 0n, pool_id: 0, owner: 0n });
  }
  lines.push(`fills = [`);
  for (const f of fillsPadded) {
    lines.push(
      `  { order_nonce = "0x${f.orderNonce.toString(16)}", hop_index = ${f.hop_index}, ` +
      `amount_out = "${f.amountOut}", pool_id = ${f.pool_id} },`,
    );
  }
  lines.push(`]`);
  lines.push(`fills_len = ${fills.length}`);

  // fill_to_order_index: 2*maxPerEpoch u32s — maps fill slot i to its order index.
  const fillToOrderIndex: number[] = [];
  for (let i = 0; i < 2 * maxPerEpoch; i++) {
    const f = i < fills.length ? fills[i] : null;
    if (f) {
      const idx = orders.findIndex((o) => o.order_nonce === f.orderNonce);
      // L2: unknown fill nonce must throw rather than silently mapping to order index 0.
      if (idx < 0) {
        throw new Error(`fill orderNonce 0x${f.orderNonce.toString(16)} not found in orders`);
      }
      fillToOrderIndex.push(idx);
    } else {
      fillToOrderIndex.push(0);
    }
  }
  lines.push(`fill_to_order_index = [${fillToOrderIndex.join(", ")}]`);

  // Sentinel BucketState used when padding pool bucket arrays.
  const SENTINEL_BUCKET = {
    reserve_a: 0n, reserve_b: 0n, liquidity: 0n,
    cum_fee_a_per_share: 0n, cum_fee_b_per_share: 0n,
  };
  function fmtBucketState(s: { reserve_a: bigint; reserve_b: bigint; liquidity: bigint; cum_fee_a_per_share: bigint; cum_fee_b_per_share: bigint }): string {
    return `      { reserve_a = "${s.reserve_a}", reserve_b = "${s.reserve_b}", liquidity = "${s.liquidity}", cum_fee_a_per_share = "${s.cum_fee_a_per_share}", cum_fee_b_per_share = "${s.cum_fee_b_per_share}" },`;
  }

  // pool_bucket_states_before: [[BucketState; 4]; 3]
  lines.push(`pool_bucket_states_before = [`);
  for (const pc of sortedPools) {
    const raw = pc.bucketStatesBefore ?? [];
    const states = raw.slice() as Array<{ reserve_a: bigint; reserve_b: bigint; liquidity: bigint; cum_fee_a_per_share: bigint; cum_fee_b_per_share: bigint }>;
    while (states.length < MAX_ACTIVE_BUCKETS_PER_EPOCH) states.push({ ...SENTINEL_BUCKET });
    lines.push(`  [`);
    for (const s of states) lines.push(fmtBucketState(s));
    lines.push(`  ],`);
  }
  lines.push(`]`);

  // pool_bucket_states_after: [[BucketState; 4]; 3]
  lines.push(`pool_bucket_states_after = [`);
  for (const pc of sortedPools) {
    const raw = pc.bucketStatesAfter ?? [];
    const states = raw.slice() as Array<{ reserve_a: bigint; reserve_b: bigint; liquidity: bigint; cum_fee_a_per_share: bigint; cum_fee_b_per_share: bigint }>;
    while (states.length < MAX_ACTIVE_BUCKETS_PER_EPOCH) states.push({ ...SENTINEL_BUCKET });
    lines.push(`  [`);
    for (const s of states) lines.push(fmtBucketState(s));
    lines.push(`  ],`);
  }
  lines.push(`]`);

  // pool_sqrt_p_before: [u128; 3] — pre-clearing sqrt price per pool.
  const poolSqrtPBefore = args.poolSqrtPBefore ?? [];
  lines.push(`pool_sqrt_p_before = [`);
  for (let i = 0; i < MAX_ACTIVE_POOLS_PER_EPOCH; i++) {
    lines.push(`  "${poolSqrtPBefore[i] ?? 0n}",`);
  }
  lines.push(`]`);

  // pool_token_pairs: [[Field; 2]; 3] — canonical (token_a, token_b) per pool slot.
  const poolTokenPairs = args.poolTokenPairs ?? [];
  lines.push(`pool_token_pairs = [`);
  for (let i = 0; i < MAX_ACTIVE_POOLS_PER_EPOCH; i++) {
    const pair = poolTokenPairs[i] ?? [0n, 0n];
    lines.push(`  ["0x${pair[0].toString(16)}", "0x${pair[1].toString(16)}"],`);
  }
  lines.push(`]`);

  return {
    proverToml: lines.join("\n") + "\n",
    fillsRoot: tree.root.toString(),
    leaves: tree.leaves.map((l) => l.toString()),
    maxOrdersPerEpoch: maxPerEpoch,
  };
}
