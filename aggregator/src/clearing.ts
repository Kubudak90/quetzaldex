/**
 * Frequent-batch-auction clearing for Quetzal. Pure computation - given a pool
 * snapshot and a set of orders, `computeClearing` produces the uniform clearing
 * price, the per-order fills, the post-clearing reserves, and the LP fee accrual.
 *
 * See docs/superpowers/specs/2026-05-19-zswap-aztec-week-05b-clearing-aggregator-design.md
 */
import { mulDiv, SCALE, FEE_NUM, FEE_DEN } from "./fixed-point.js";

/** Maximum orders cleared in one epoch; the rest carry over. */
export const MAX_ORDERS_PER_EPOCH = 32;
/** Clearing-price search band: [spot / PRICE_BAND, spot * PRICE_BAND]. */
export const PRICE_BAND = 100n;
/** Bisection stops when |realizedP - P| <= TOLERANCE (1e-9 of a price unit). */
export const TOLERANCE = 1_000_000_000n;
/** Bisection iteration cap. */
export const MAX_ITERS = 128;
/**
 * SETTLE-INV v1 dust-guard. The on-chain anti-grief floor (clearing circuit
 * main.nr block C2) can brick an honest single-maker clear when a receive
 * group's total is dust (<~5000 raw units): `floor(escrow*0.3%)` under-rounds
 * the AMM-fee overcount, pushing `avail_floor` above the honest payout. We
 * never EMIT a fill below this threshold, so the circuit never sees a dust
 * group and cannot brick. Sub-threshold orders are carried forward (still
 * cancellable) — they simply don't fill. 1e5 raw units = ~200x the brick zone;
 * 0.1 tUSDC at 6dp, negligible for higher-precision tokens. The residual ±1
 * rounding knife-edge at larger scales is left to the deferred circuit floor
 * fix (see the conservation-gap memory).
 */
export const MIN_FILL_AMOUNT_IN = 100_000n;

/** One submitted order, as the aggregator sees it. */
export interface ClearingOrder {
  /** false = buy (pays token A, wants token B); true = sell (pays token B, wants token A). */
  side: boolean;
  /** Input amount in base units (token A for a buy, token B for a sell). */
  amountIn: bigint;
  /** Limit price, quote-per-base, 1e18-scaled. Buy: max it will pay. Sell: min it accepts. */
  limitPrice: bigint;
  /** L2 block of submission - the FIFO ordering key. */
  submittedAtBlock: number;
  /** The OrderNote identity nonce. */
  orderNonce: bigint;
  /** R1: the maker's address as a Field. Threaded into the hop-fill leaf
   * (poseidon2([owner, nonce, hop, amount, pool])) so claim_fill binds the payout
   * to the real owner. Equals the order's owner from the reveal / order_acc. */
  owner: bigint;
}

/** Pool reserves + LP supply at clearing time. */
export interface PoolSnapshot {
  reserveA: bigint;
  reserveB: bigint;
  lpSupply: bigint;
}

/** One filled order. */
export interface OrderFill {
  orderNonce: bigint;
  /** Amount of `amountIn` consumed - always == amountIn in this slice (full fills). */
  filledIn: bigint;
  /** Output token received (token B for a buy, token A for a sell). */
  amountOut: bigint;
}

/** The result of clearing one epoch. */
export interface ClearingResult {
  /** false => epoch skipped (no eligible orders / no convergence / degenerate pool). */
  cleared: boolean;
  /** Uniform clearing price P*, 1e18-scaled (0n when cleared == false). */
  clearingPrice: bigint;
  /** One entry per filled order; empty when cleared == false. */
  fills: OrderFill[];
  newReserveA: bigint;
  newReserveB: bigint;
  /** cum_fee_a_per_share delta, 1e18-scaled. */
  feeAPerShareIncrement: bigint;
  /** cum_fee_b_per_share delta, 1e18-scaled. */
  feeBPerShareIncrement: bigint;
  /**
   * The bucket-trace at P* that produced the fills + reserves (concentrated path).
   * computeClearingV2 reuses THIS trace verbatim for its per-bucket deltas; tracing
   * a second time would re-withhold the fee. Undefined for a pure-CoW clear whose
   * net AMM flow is zero (bucketNetSwap netA == 0 path) — V2 then touches no buckets.
   */
  bucketTrace?: BucketTraceOutput;
}

/**
 * Step 1: the epoch's batch - the <= MAX_ORDERS_PER_EPOCH oldest orders by
 * `submittedAtBlock`, ties broken by `orderNonce` ascending (total order, for
 * determinism). The input array is not mutated.
 */
export function selectBatch(orders: ClearingOrder[]): ClearingOrder[] {
  return [...orders]
    .sort((x, y) => {
      if (x.submittedAtBlock !== y.submittedAtBlock) {
        return x.submittedAtBlock - y.submittedAtBlock;
      }
      if (x.orderNonce < y.orderNonce) return -1;
      if (x.orderNonce > y.orderNonce) return 1;
      return 0;
    })
    .slice(0, MAX_ORDERS_PER_EPOCH);
}

/** The constant-product swap of the net imbalance. */
export interface NetSwap {
  newReserveA: bigint;
  newReserveB: bigint;
  /** Price the net swap executed at, quote-per-base 1e18-scaled. Equals `p` when netA == 0. */
  realizedP: bigint;
  /** LP fee withheld, in token A (non-zero only when token A flows in). */
  feeAmountA: bigint;
  /** LP fee withheld, in token B (non-zero only when token B flows in). */
  feeAmountB: bigint;
  /** Gross token A into the AMM (netA > 0 only). */
  ammAIn: bigint;
  /** Gross token A out of the AMM (netA < 0 only). */
  ammAOut: bigint;
  /** Gross token B into the AMM (netA < 0 only). */
  ammBIn: bigint;
  /** Gross token B out of the AMM (netA > 0 only). */
  ammBOut: bigint;
  /** true when the requested net imbalance exceeds available bucket liquidity. */
  saturated?: boolean;
  /**
   * The single bucket-trace that produced this swap (concentrated path only).
   * Set in both non-saturated `bucketNetSwap` branches so downstream consumers
   * (computeClearingV2) can reuse the SAME trace instead of re-tracing — re-tracing
   * would withhold the 0.3% fee a second time and under-collateralize the pool.
   * Unset for the netA == 0 no-op and the saturated catch.
   */
  trace?: BucketTraceOutput;
}

/**
 * Swap the signed net imbalance through the constant-product pool.
 * `netA > 0`: token A flows in. `netA < 0`: token B flows in (sized via `p`).
 * `netA == 0`: no swap. The 0.3% fee is WITHHELD from the swap input and reported
 * in `feeAmount*` - it is NOT added to the reserves (Quetzal tracks fees in a
 * separate per-share counter; see the spec, Step 4).
 */
export function simulateNet(
  reserveA: bigint,
  reserveB: bigint,
  netA: bigint,
  p: bigint,
): NetSwap {
  if (netA === 0n) {
    return {
      newReserveA: reserveA,
      newReserveB: reserveB,
      realizedP: p,
      feeAmountA: 0n,
      feeAmountB: 0n,
      ammAIn: 0n,
      ammAOut: 0n,
      ammBIn: 0n,
      ammBOut: 0n,
    };
  }
  if (netA > 0n) {
    const afterFee = (netA * FEE_NUM) / FEE_DEN;
    const feeAmountA = netA - afterFee;
    const outB = reserveB - mulDiv(reserveA, reserveB, reserveA + afterFee);
    return {
      newReserveA: reserveA + afterFee,
      newReserveB: reserveB - outB,
      realizedP: outB === 0n ? 0n : mulDiv(netA, SCALE, outB),
      feeAmountA,
      feeAmountB: 0n,
      ammAIn: netA,
      ammAOut: 0n,
      ammBIn: 0n,
      ammBOut: outB,
    };
  }
  // netA < 0: token B flows in. Its size is the token-A deficit valued at p.
  const inB = mulDiv(-netA, SCALE, p);
  const afterFee = (inB * FEE_NUM) / FEE_DEN;
  const feeAmountB = inB - afterFee;
  const outA = reserveA - mulDiv(reserveA, reserveB, reserveB + afterFee);
  return {
    newReserveA: reserveA - outA,
    newReserveB: reserveB + afterFee,
    realizedP: inB === 0n ? 0n : mulDiv(outA, SCALE, inB),
    feeAmountA: 0n,
    feeAmountB,
    ammAIn: 0n,
    ammAOut: outA,
    ammBIn: inB,
    ammBOut: 0n,
  };
}

/** The batch evaluated at one candidate clearing price. */
export interface PriceEval {
  netA: bigint;
  swap: NetSwap;
  eligibleBuys: ClearingOrder[];
  eligibleSells: ClearingOrder[];
}

/**
 * Evaluate `batch` at candidate price `p`: who is eligible, the net imbalance,
 * and the resulting AMM swap. A buy is eligible when `limitPrice >= p`; a sell
 * when `limitPrice <= p`.
 */
export function clearingAt(pool: PoolWithBuckets, batch: ClearingOrder[], p: bigint): PriceEval {
  const eligibleBuys = batch.filter((o) => !o.side && o.limitPrice >= p);
  const eligibleSells = batch.filter((o) => o.side && o.limitPrice <= p);
  let sumAIn = 0n;
  for (const o of eligibleBuys) sumAIn += o.amountIn;
  let sumBIn = 0n;
  for (const o of eligibleSells) sumBIn += o.amountIn;
  const netA = sumAIn - mulDiv(sumBIn, p, SCALE);
  const swap = bucketNetSwap(pool, netA, p);
  return { netA, swap, eligibleBuys, eligibleSells };
}

/**
 * Step 3: binary-search the uniform clearing price P* where the net flow's AMM
 * execution price equals P* itself. Returns null when the pool is degenerate,
 * when the search band does not bracket a root, when the book cannot cross, or
 * on non-convergence - the caller treats null as "epoch skipped".
 *
 * On the region where orders are eligible the residual `realizedP(P) - P` is
 * monotonically decreasing. Outside it (every order gated out) the residual
 * would be a spurious 0; `probe` instead reports a direction so the search is
 * steered back onto the eligible region.
 */
export function findClearingPrice(pool: PoolWithBuckets, batch: ClearingOrder[]): bigint | null {
  // Concentrated guard: need at least one funded bucket (was reserveB===0 div-guard).
  const funded = pool.bucketStates.filter((b, i) => b.liquidity > 0n && pool.bucketBounds[i]);
  if (funded.length === 0) return null;

  // Search band from funded bucket price ranges. price = sqrt^2 / SCALE (token-A-per-token-B).
  const priceAt = (s: bigint): bigint => mulDiv(s, s, SCALE);
  let bandLo = -1n, bandHi = -1n;
  pool.bucketStates.forEach((b, i) => {
    if (b.liquidity <= 0n) return;
    const bounds = pool.bucketBounds[i]!;
    const pl = priceAt(bounds.sqrt_lower);
    const ph = priceAt(bounds.sqrt_upper);
    if (bandLo < 0n || pl < bandLo) bandLo = pl;
    if (bandHi < 0n || ph > bandHi) bandHi = ph;
  });
  let lo = bandLo / PRICE_BAND;
  if (lo < 1n) lo = 1n;
  let hi = bandHi * PRICE_BAND;

  const hasBuys = batch.some((o) => !o.side);
  const hasSells = batch.some((o) => o.side);

  // BUG-2 fix: one-sided books (only sells OR only buys) have NO crossing — the pool
  // is the sole counterparty, so P* is the *realized AMM price* of routing the eligible
  // volume, NOT a bisection root on the order's limit. Bisecting against the limit lets
  // an order "clear" at a price the AMM can't actually realize, which makes Σ hopPayout
  // diverge from the pool's a_from_pool/b_from_pool and drains/under-collateralizes it.
  //
  // We return P* on the SAME scale hopPayout consumes: hopPayout applies the 0.3% fee
  // itself, so P* must be sized on the AFTER-fee input (inAfterFee), making
  //   hopPayout(amountIn, P*, side) == the pool's actual *_from_pool flow (conservation).
  // The eligibility refinement drops exactly the orders whose limit the AMM can't meet
  // at that P*, so clearingAt(pool, batch, P*) — which filters sells by limit<=P* and
  // buys by limit>=P* — selects the identical set.
  if (hasBuys !== hasSells) {
    return oneSidedClearingPrice(pool, batch, hasSells);
  }

  // Probe a price: a residual when orders are eligible, else a direction
  // ("tooHigh" / "tooLow") or "gap" (a mixed book whose sides never overlap).
  type Probe = { residual: bigint } | { dir: "tooHigh" | "tooLow" | "gap" };
  const probe = (p: bigint): Probe => {
    const ev = clearingAt(pool, batch, p);
    if (ev.eligibleBuys.length === 0 && ev.eligibleSells.length === 0) {
      if (hasBuys && hasSells) return { dir: "gap" };
      if (hasBuys) return { dir: "tooHigh" }; // buys-only: every buy limit < p
      return { dir: "tooLow" }; // sells-only: every sell limit > p
    }
    if (ev.swap.saturated) {
      // Net imbalance exceeds bucket liquidity at this price: steer the search
      // the same direction the non-saturated residual would. A buy-heavy net
      // (token A in, netA>0) means the book over-demands token A at this price,
      // so the clearing price is HIGHER -> this p is "tooLow" (raise lo). A
      // sell-heavy net (token B in, netA<0) means the clearing price is LOWER ->
      // this p is "tooHigh" (lower hi). This matches the residual convention
      // (residual>0 => lo=mid; residual<0 => hi=mid).
      return { dir: ev.netA > 0n ? "tooLow" : "tooHigh" };
    }
    return { residual: ev.swap.realizedP - p };
  };

  const loP = probe(lo);
  const hiP = probe(hi);
  if (("dir" in loP && loP.dir === "gap") || ("dir" in hiP && hiP.dir === "gap")) return null;
  // lo must sit at-or-below the root; hi at-or-above.
  const loOk = "dir" in loP ? loP.dir === "tooLow" : loP.residual >= 0n;
  const hiOk = "dir" in hiP ? hiP.dir === "tooHigh" : hiP.residual <= 0n;
  if (!loOk || !hiOk) return null;

  for (let i = 0; i < MAX_ITERS; i++) {
    const mid = (lo + hi) / 2n;
    const m = probe(mid);
    if ("dir" in m) {
      if (m.dir === "gap") return null;
      if (m.dir === "tooLow") lo = mid;
      else hi = mid;
    } else {
      if (m.residual >= -TOLERANCE && m.residual <= TOLERANCE) return mid;
      if (m.residual > 0n) lo = mid;
      else hi = mid;
    }
    if (hi - lo <= 1n) {
      // Settle on an endpoint that actually has eligible orders.
      if ("residual" in probe(lo)) return lo;
      if ("residual" in probe(hi)) return hi;
      return null;
    }
  }
  return null; // did not converge within MAX_ITERS
}

/**
 * BUG-2: clearing price for a ONE-SIDED book (all sells, or all buys). There is no
 * crossing order to bisect against — the pool is the only counterparty — so P* is the
 * realized AMM price of routing the eligible volume through `bucketNetSwap`.
 *
 * The 0.3% LP fee is withheld inside traceBucketSwap from the INPUT side, and hopPayout
 * (the multi-pair fill builder) withholds the same 0.3% from `amountIn * P*`. To make
 * `hopPayout(amountIn, P*, side)` reproduce the pool's actual `*_from_pool` flow exactly
 * (conservation), P* is sized on the AFTER-fee input:
 *   sell (B in):  P* = ammAOut * SCALE / inAfterFee   (inAfterFee = 0.997 * Σ amountIn_B)
 *   buy  (A in):  P* = inAfterFee * SCALE / ammBOut   (inAfterFee = 0.997 * Σ amountIn_A)
 *
 * Eligibility refinement: an order is eligible iff the AMM can meet its limit at P* —
 *   sell: limit <= P*   (min A-per-B the seller accepts)
 *   buy:  limit >= P*   (max A-per-B the buyer pays)
 * We re-filter the FULL candidate set at the realized price each pass (orders may
 * re-enter, not just drop), and converge to a fixed point: the set eligible at P*
 * equals the set P* was computed over. Returns null (skip the epoch) when that set is
 * empty, the routed volume saturates the buckets, or the set size oscillates without
 * converging — so an unsatisfiable order drains nothing and none is filled below limit.
 *
 * The filter direction here is identical to clearingAt's (sells: limit<=p, buys: limit>=p),
 * and because P* is a fixed point, clearingAt(pool, batch, P*) selects the same eligible set.
 */
function oneSidedClearingPrice(
  pool: PoolWithBuckets,
  batch: ClearingOrder[],
  isSellBook: boolean,
): bigint | null {
  // traceBucketSwap withholds 30/10_000; size P* on the SAME after-fee input.
  const FEE_NUM_HOP = 30n;
  const FEE_DEN_HOP = 10_000n;
  const afterFee = (x: bigint): bigint => (x * (FEE_DEN_HOP - FEE_NUM_HOP)) / FEE_DEN_HOP;

  // Candidate set, sorted by limit so the refinement converges monotonically:
  //   sell book: drop the HIGHEST limits first (limit > P*) -> sort ascending
  //   buy  book: drop the LOWEST  limits first (limit < P*) -> sort descending
  let candidates = batch
    .filter((o) => o.side === isSellBook)
    .sort((a, b) => (isSellBook
      ? (a.limitPrice < b.limitPrice ? -1 : a.limitPrice > b.limitPrice ? 1 : 0)
      : (a.limitPrice > b.limitPrice ? -1 : a.limitPrice < b.limitPrice ? 1 : 0)));
  if (candidates.length === 0) return null;

  // H1: the refinement must find a FIXED POINT of the full-batch filter, not just
  // drop orders. The old code shrank the candidate set monotonically and returned
  // a P* sized on that smaller set; computeClearing then re-filtered the FULL batch
  // at P* (clearingAt) and RE-INCLUDED any order whose limit sat between the
  // full-set and refined-set realized prices — then executed it in the full-volume
  // swap at a price BELOW its limit. Re-filter from the ORIGINAL list each pass
  // (allowing re-inclusion). The set is always a prefix of `original` (sorted so the
  // satisfiable orders lead), so its length identifies it. Converge when the
  // re-filtered set is unchanged; if the set size repeats without converging the
  // book oscillates — there is no uniform price that fills exactly its own eligible
  // set within limits, so skip the epoch (an unsatisfiable order fills nothing).
  const original = candidates;
  let current = original;
  const seenSizes = new Set<number>([original.length]);
  for (let pass = 0; pass < original.length + 2; pass++) {
    if (current.length === 0) return null;

    let sumIn = 0n;
    for (const o of current) sumIn += o.amountIn;
    const inAfterFee = afterFee(sumIn);
    if (inAfterFee <= 0n) return null;

    let realizedP: bigint;
    if (isSellBook) {
      // Token B in (size at any price; bucketNetSwap's inB works out to sumIn). Use p=SCALE.
      const netA = -sumIn; // -mulDiv(sumIn, SCALE, SCALE) == -sumIn
      const swap = bucketNetSwap(pool, netA, SCALE);
      if (swap.saturated || swap.ammAOut === 0n) return null;
      realizedP = mulDiv(swap.ammAOut, SCALE, inAfterFee);
    } else {
      // Token A in -> price DOWN. Net is +sumIn (token A surplus).
      const swap = bucketNetSwap(pool, sumIn, SCALE);
      if (swap.saturated || swap.ammBOut === 0n) return null;
      realizedP = mulDiv(inAfterFee, SCALE, swap.ammBOut);
    }

    // Re-filter from the ORIGINAL list at realizedP (orders may re-enter).
    const next = original.filter((o) => (isSellBook
      ? o.limitPrice <= realizedP
      : o.limitPrice >= realizedP));
    if (next.length === current.length) return realizedP; // fixed point (prefix ⇒ length ⇒ set)
    if (seenSizes.has(next.length)) return null;           // oscillation — no clean uniform price
    seenSizes.add(next.length);
    current = next;
  }
  return null;
}

/** The "epoch skipped" result - reserves unchanged, nothing cleared. */
function skipped(pool: PoolWithBuckets): ClearingResult {
  return {
    cleared: false,
    clearingPrice: 0n,
    fills: [],
    newReserveA: pool.reserveA,
    newReserveB: pool.reserveB,
    feeAPerShareIncrement: 0n,
    feeBPerShareIncrement: 0n,
  };
}

/**
 * Clear one epoch: select the FIFO batch, discover the uniform clearing price,
 * cross every eligible order fully at that price, route the net imbalance through
 * the AMM, and accrue the 0.3% fee to LPs.
 *
 * Returns `{ cleared: false, ... }` (a safe no-op) when the batch is empty, the
 * price search does not converge, or no order is eligible at P*.
 */
export function computeClearing(pool: PoolWithBuckets, orders: ClearingOrder[]): ClearingResult {
  const batch = selectBatch(orders);
  if (batch.length === 0) return skipped(pool);

  const pStar = findClearingPrice(pool, batch);
  if (pStar === null) return skipped(pool);

  const ev = clearingAt(pool, batch, pStar);
  if (ev.eligibleBuys.length === 0 && ev.eligibleSells.length === 0) return skipped(pool);
  // H1 defense in depth: never settle a swap that saturated the buckets (the
  // routed volume ran past available liquidity — the fills wouldn't conserve).
  if (ev.swap.saturated) return skipped(pool);

  // Sum the eligible amounts on each side.
  let sumAIn = 0n;
  for (const o of ev.eligibleBuys) sumAIn += o.amountIn;
  let sumBIn = 0n;
  for (const o of ev.eligibleSells) sumBIn += o.amountIn;

  // Exact aggregate token totals the crossing + AMM swap actually move:
  //   xTotal = total token A paid to sellers, yTotal = total token B paid to buyers.
  const xTotal = sumAIn - ev.swap.ammAIn + ev.swap.ammAOut;
  const yTotal = sumBIn - ev.swap.ammBIn + ev.swap.ammBOut;

  const fills: OrderFill[] = [];
  // Buyers receive token B: distribute yTotal pro-rata by amountIn / sumAIn,
  // the LAST buy absorbs the rounding remainder so the sum is exact.
  let buyAcc = 0n;
  ev.eligibleBuys.forEach((o, i) => {
    const isLast = i === ev.eligibleBuys.length - 1;
    const amountOut = isLast ? yTotal - buyAcc : mulDiv(yTotal, o.amountIn, sumAIn);
    buyAcc += amountOut;
    fills.push({ orderNonce: o.orderNonce, filledIn: o.amountIn, amountOut });
  });
  // Sellers receive token A: distribute xTotal pro-rata by amountIn / sumBIn.
  let sellAcc = 0n;
  ev.eligibleSells.forEach((o, i) => {
    const isLast = i === ev.eligibleSells.length - 1;
    const amountOut = isLast ? xTotal - sellAcc : mulDiv(xTotal, o.amountIn, sumBIn);
    sellAcc += amountOut;
    fills.push({ orderNonce: o.orderNonce, filledIn: o.amountIn, amountOut });
  });

  // Per-bucket fees are carried in the bucket deltas (cum_fee_*_per_share_increment),
  // applied on-chain by apply_clearing. The pool-wide aggregate fee-per-share is unused
  // in the concentrated path; zero it so fees are not double-counted.
  const feeAPerShareIncrement = 0n;
  const feeBPerShareIncrement = 0n;

  return {
    cleared: true,
    clearingPrice: pStar,
    fills,
    newReserveA: ev.swap.newReserveA,
    newReserveB: ev.swap.newReserveB,
    feeAPerShareIncrement,
    feeBPerShareIncrement,
    // Carry the single bucket-trace forward so computeClearingV2 reuses it (no re-trace).
    bucketTrace: ev.swap.trace,
  };
}

// ============================================================================
// Sub-2: bucket-tracing swap (V3-style concentrated liquidity).
// ============================================================================
import type { BucketBounds, BucketState } from "./buckets.js";
export type { BucketState, BucketBounds };
import {
  SCALE as BUCKET_SCALE,
  nextSqrtPUp,
  nextSqrtPDown,
  swapStepOutA,
  swapStepOutB,
} from "./buckets.js";

export interface PoolWithBuckets {
  reserveA: bigint;
  reserveB: bigint;
  lpSupply: bigint;
  currentSqrtPrice: bigint;
  bucketBounds: BucketBounds[];
  bucketStates: BucketState[];
}

export interface BucketDeltaResult {
  bucket_id: number;
  reserve_a_add: bigint;
  reserve_a_sub: bigint;
  reserve_b_add: bigint;
  reserve_b_sub: bigint;
  cum_fee_a_per_share_increment: bigint;
  cum_fee_b_per_share_increment: bigint;
}

export interface BucketTraceOutput {
  newSqrtPrice: bigint;
  bucketDeltas: BucketDeltaResult[];
  newReserveA: bigint;
  newReserveB: bigint;
}

/**
 * Sub-2: full V3 multi-bucket state machine. Traces a swap through one or
 * more concentrated-liquidity buckets starting from currentSqrtPrice.
 *
 * - Withholds 0.3% LP fee from the gross input before routing.
 * - M17: the withheld fee is NOT added to reserve_*_add (price math stays
 *   post-fee); deriveAggregateFlows forwards it to the pool separately via
 *   the gross to_pool. Only the floor round-trip dust stays in the orderbook.
 * - Crosses bucket boundaries: when the remaining after-fee input exhausts
 *   the current bucket it steps to the next bucket (UP or DOWN) and
 *   continues, accumulating per-bucket reserve deltas and fee shares.
 * - Empty buckets (liquidity == 0) are skipped.
 * - Pro-rated fee shares are distributed across touched buckets; the final
 *   touched bucket absorbs any truncation residual so sum(stepFee) ==
 *   feeWithheld exactly.
 * - Throws if the input exceeds all available buckets in the chosen
 *   direction, or if more than MAX_BUCKET_HOPS distinct buckets are touched.
 *
 * Inputs:
 *   netA > 0: token A flows in (pool moves DOWN as A becomes plentiful)
 *   netB > 0: token B flows in (pool moves UP)
 *
 * Returns: per-bucket reserve deltas, fee increments, and the new sqrt_p.
 */
export function traceBucketSwap(
  pool: PoolWithBuckets,
  netA: bigint,
  netB: bigint,
): BucketTraceOutput {
  if (netA === 0n && netB === 0n) {
    return {
      newSqrtPrice: pool.currentSqrtPrice,
      bucketDeltas: [],
      newReserveA: pool.reserveA,
      newReserveB: pool.reserveB,
    };
  }

  const BUCKET_FEE_BPS = 30n;
  const BUCKET_FEE_SCALE = 10_000n;
  const MAX_BUCKET_HOPS = 4;

  let bucketId = pool.bucketBounds.findIndex(
    (b) => pool.currentSqrtPrice >= b.sqrt_lower && pool.currentSqrtPrice < b.sqrt_upper,
  );
  if (bucketId < 0) {
    // L1: direction-aware fallback — price is outside every bucket's [sqrt_lower, sqrt_upper).
    // Below grid (price < first bucket's lower bound) → start at bucket 0.
    // At or above grid top (price >= last bucket's upper bound) → start at last bucket.
    // The containment assert inside the loop will then throw for a truly out-of-grid price.
    const firstLo = pool.bucketBounds[0]?.sqrt_lower ?? 0n;
    bucketId = pool.currentSqrtPrice < firstLo ? 0 : pool.bucketBounds.length - 1;
  }

  const direction = netB > 0n;
  let remaining = direction ? netB : netA;
  const inAfterFeeTotal = (remaining * (BUCKET_FEE_SCALE - BUCKET_FEE_BPS)) / BUCKET_FEE_SCALE;
  let inAfterFee = inAfterFeeTotal;
  let feeWithheld = remaining - inAfterFeeTotal;

  const deltas = new Map<number, BucketDeltaResult>();
  let sqrtP = pool.currentSqrtPrice;
  let feeDistributed = 0n;

  while (inAfterFee > 0n && bucketId >= 0 && bucketId < pool.bucketBounds.length) {
    const bucket = pool.bucketStates[bucketId]!;
    const bounds = pool.bucketBounds[bucketId]!;

    // L1: containment guard — sqrtP must be within [sqrt_lower, sqrt_upper] of the chosen bucket.
    if (sqrtP < bounds.sqrt_lower || sqrtP > bounds.sqrt_upper) {
      throw new Error("currentSqrtPrice outside bucket grid");
    }

    if (bucket.liquidity === 0n) {
      sqrtP = direction ? bounds.sqrt_upper : bounds.sqrt_lower;
      bucketId = direction ? bucketId + 1 : bucketId - 1;
      continue;
    }

    let stepInMax: bigint;
    if (direction) {
      stepInMax = (bucket.liquidity * (bounds.sqrt_upper - sqrtP)) / BUCKET_SCALE;
    } else {
      const denom = (sqrtP * bounds.sqrt_lower) / BUCKET_SCALE;
      stepInMax = (bucket.liquidity * (sqrtP - bounds.sqrt_lower)) / denom;
    }
    // L1: stepInMax must be non-negative; a negative value signals a containment violation.
    if (stepInMax < 0n) {
      throw new Error(`stepInMax ${stepInMax} < 0 in bucket ${bucketId} — containment violation`);
    }

    let stepIn: bigint;
    let stepOut: bigint;
    let sqrtPNew: bigint;

    if (inAfterFee <= stepInMax) {
      stepIn = inAfterFee;
      if (direction) {
        sqrtPNew = nextSqrtPUp(bucket.liquidity, sqrtP, stepIn);
        stepOut = swapStepOutA(bucket.liquidity, sqrtP, sqrtPNew);
      } else {
        sqrtPNew = nextSqrtPDown(bucket.liquidity, sqrtP, stepIn);
        stepOut = swapStepOutB(bucket.liquidity, sqrtP, sqrtPNew);
      }
      inAfterFee = 0n;
    } else {
      stepIn = stepInMax;
      sqrtPNew = direction ? bounds.sqrt_upper : bounds.sqrt_lower;
      if (direction) {
        stepOut = swapStepOutA(bucket.liquidity, sqrtP, sqrtPNew);
      } else {
        stepOut = swapStepOutB(bucket.liquidity, sqrtP, sqrtPNew);
      }
      inAfterFee -= stepIn;
    }

    // I1: last-bucket residual pattern — guarantees sum(stepFee) == feeWithheld.
    let stepFee: bigint;
    if (inAfterFee === 0n) {
      // This is the final touched bucket; assign the remainder to avoid truncation loss.
      stepFee = feeWithheld - feeDistributed;
    } else {
      stepFee = (feeWithheld * stepIn) / inAfterFeeTotal;
    }
    feeDistributed += stepFee;
    const cumFeeAInc = direction ? 0n : (stepFee * BUCKET_SCALE) / bucket.liquidity;
    const cumFeeBInc = direction ? (stepFee * BUCKET_SCALE) / bucket.liquidity : 0n;

    const prev = deltas.get(bucketId);
    const delta: BucketDeltaResult = {
      bucket_id: bucketId,
      reserve_a_add: (prev?.reserve_a_add ?? 0n) + (direction ? 0n : stepIn),
      reserve_a_sub: (prev?.reserve_a_sub ?? 0n) + (direction ? stepOut : 0n),
      reserve_b_add: (prev?.reserve_b_add ?? 0n) + (direction ? stepIn : 0n),
      reserve_b_sub: (prev?.reserve_b_sub ?? 0n) + (direction ? 0n : stepOut),
      cum_fee_a_per_share_increment:
        (prev?.cum_fee_a_per_share_increment ?? 0n) + cumFeeAInc,
      cum_fee_b_per_share_increment:
        (prev?.cum_fee_b_per_share_increment ?? 0n) + cumFeeBInc,
    };
    deltas.set(bucketId, delta);

    sqrtP = sqrtPNew;
    if (inAfterFee > 0n) {
      bucketId = direction ? bucketId + 1 : bucketId - 1;
    }
  }

  if (inAfterFee > 0n) {
    throw new Error("swap exceeded all buckets in the chosen direction");
  }
  if (deltas.size > MAX_BUCKET_HOPS) {
    throw new Error(`traceBucketSwap touched ${deltas.size} buckets (cap ${MAX_BUCKET_HOPS})`);
  }

  let aggA = 0n;
  let aggB = 0n;
  for (const d of deltas.values()) {
    aggA += d.reserve_a_add - d.reserve_a_sub;
    aggB += d.reserve_b_add - d.reserve_b_sub;
  }

  return {
    newSqrtPrice: sqrtP,
    bucketDeltas: Array.from(deltas.values()).sort((a, b) => a.bucket_id - b.bucket_id),
    newReserveA: pool.reserveA + aggA,
    newReserveB: pool.reserveB + aggB,
  };
}

/**
 * Concentrated analogue of `simulateNet`: route the signed net imbalance `netA`
 * through the pool's buckets via `traceBucketSwap`, at candidate price `p`.
 * Returns the same `NetSwap` shape so `clearingAt`/`findClearingPrice` keep their
 * structure. `realizedP` uses the same token-A-per-token-B ratio as `simulateNet`
 * so the bisection residual semantics are preserved. On insufficient bucket
 * liquidity it returns `{ saturated: true }` instead of throwing.
 */
export function bucketNetSwap(pool: PoolWithBuckets, netA: bigint, p: bigint): NetSwap {
  if (netA === 0n) {
    return {
      newReserveA: pool.reserveA, newReserveB: pool.reserveB, realizedP: p,
      feeAmountA: 0n, feeAmountB: 0n,
      ammAIn: 0n, ammAOut: 0n, ammBIn: 0n, ammBOut: 0n,
    };
  }
  try {
    if (netA > 0n) {
      // token A flows in -> price DOWN. traceBucketSwap withholds the fee internally.
      const trace = traceBucketSwap(pool, netA, 0n);
      let ammBOut = 0n;
      for (const d of trace.bucketDeltas) ammBOut += d.reserve_b_sub;
      // Fees are tracked per-bucket inside traceBucketSwap (cum_fee_*_per_share); not surfaced here.
      return {
        newReserveA: trace.newReserveA, newReserveB: trace.newReserveB,
        realizedP: ammBOut === 0n ? 0n : mulDiv(netA, SCALE, ammBOut),
        feeAmountA: 0n, feeAmountB: 0n,
        ammAIn: netA, ammAOut: 0n, ammBIn: 0n, ammBOut,
        trace,
      };
    }
    // netA < 0: token B flows in -> price UP. Size the B input at price p.
    const inB = mulDiv(-netA, SCALE, p);
    const trace = traceBucketSwap(pool, 0n, inB);
    let ammAOut = 0n;
    for (const d of trace.bucketDeltas) ammAOut += d.reserve_a_sub;
    // Fees are tracked per-bucket inside traceBucketSwap (cum_fee_*_per_share); not surfaced here.
    return {
      newReserveA: trace.newReserveA, newReserveB: trace.newReserveB,
      realizedP: inB === 0n ? 0n : mulDiv(ammAOut, SCALE, inB),
      feeAmountA: 0n, feeAmountB: 0n,
      ammAIn: 0n, ammAOut, ammBIn: inB, ammBOut: 0n,
      trace,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : "";
    const infeasible = msg.includes("swap exceeded all buckets") || msg.includes("buckets (cap");
    if (!infeasible) throw e;
    return {
      newReserveA: pool.reserveA, newReserveB: pool.reserveB, realizedP: 0n,
      feeAmountA: 0n, feeAmountB: 0n,
      ammAIn: 0n, ammAOut: 0n, ammBIn: 0n, ammBOut: 0n,
      saturated: true,
    };
  }
}

// ============================================================================
// Sub-2.5: bucket-aware clearing (computeClearingV2).
// ============================================================================

export interface ClearingResultV2 extends ClearingResult {
  bucketDeltas?: BucketDeltaResult[];
  currentSqrtPriceAfter?: bigint;
  bucketStatesBefore?: BucketState[];
  bucketStatesAfter?: BucketState[];
}

/**
 * Sub-2.5: bucket-aware clearing. Calls computeClearing for fills + P*,
 * then routes the net imbalance through traceBucketSwap to produce
 * per-bucket deltas + the new sqrt_p_after + bucket states before/after.
 *
 * Output shape feeds buildClearingWitness directly.
 */
export function computeClearingV2(
  pool: PoolWithBuckets,
  orders: ClearingOrder[],
): ClearingResultV2 {
  const base: ClearingResult = computeClearing(pool, orders);
  if (!base.cleared) {
    return {
      ...base,
      bucketDeltas: [],
      currentSqrtPriceAfter: pool.currentSqrtPrice,
      bucketStatesBefore: [],
      bucketStatesAfter: [],
    };
  }
  // BUG-1 fix: reuse the SINGLE bucket-trace that computeClearing already ran at P*.
  // Re-tracing here (the old code) withheld the 0.3% fee a SECOND time, so V2's deltas
  // reflected a 0.997x-smaller swap than the fills + P* were derived from, leaving the
  // pool under-collateralized by ~0.3% of volume per clearing.
  const trace = base.bucketTrace;
  if (!trace) {
    // Pure-CoW clear: net AMM flow was zero (bucketNetSwap netA == 0 path). No buckets
    // are touched; reserves and sqrt_p are unchanged. This is a valid no-AMM-flow clear.
    return {
      ...base,
      newReserveA: pool.reserveA,
      newReserveB: pool.reserveB,
      bucketDeltas: [],
      currentSqrtPriceAfter: pool.currentSqrtPrice,
      bucketStatesBefore: [],
      bucketStatesAfter: [],
    };
  }

  // Snapshot bucket states before + after for the witness, from the reused trace's deltas.
  const touchedIds = trace.bucketDeltas.map((d) => d.bucket_id);
  const before: BucketState[] = touchedIds.map((id) => ({ ...pool.bucketStates[id]! }));
  const after: BucketState[] = touchedIds.map((id) => {
    const d = trace.bucketDeltas.find((x) => x.bucket_id === id)!;
    const s = pool.bucketStates[id]!;
    return {
      reserve_a: s.reserve_a + d.reserve_a_add - d.reserve_a_sub,
      reserve_b: s.reserve_b + d.reserve_b_add - d.reserve_b_sub,
      liquidity: s.liquidity,
      cum_fee_a_per_share: s.cum_fee_a_per_share + d.cum_fee_a_per_share_increment,
      cum_fee_b_per_share: s.cum_fee_b_per_share + d.cum_fee_b_per_share_increment,
    };
  });

  return {
    ...base,
    newReserveA: trace.newReserveA,
    newReserveB: trace.newReserveB,
    bucketDeltas: trace.bucketDeltas,
    currentSqrtPriceAfter: trace.newSqrtPrice,
    bucketStatesBefore: before,
    bucketStatesAfter: after,
  };
}

// ---------------------------------------------------------------------------
// Sub-4: Multi-pair clearing router
// ---------------------------------------------------------------------------

import { resolvePoolId, type PoolRegistry } from "./path.js";

/** Sub-4: order shape with explicit path. path[2] = 0n for 1-hop orders. */
export interface ClearingOrderMultiPair extends ClearingOrder {
  path: [bigint, bigint, bigint];   // path[2] = 0n for 1-hop
  path_len: 2 | 3;
}

/** Sub-4: per-pool state needed by the router (alias of PoolWithBuckets). */
export type PoolStateForRouting = PoolWithBuckets;

/** Sub-4: one per-hop fill. A 2-hop order produces two of these. */
export interface HopFill {
  orderNonce: bigint;
  hop_index: 0 | 1;
  amountOut: bigint;
  pool_id: number;
  /** R1: the filled maker's address as a Field (carried into the leaf). */
  owner: bigint;
}

/** Sub-4: per-pool clearing result. */
export interface PoolClearingResult {
  pool_id: number;
  clearingPrice: bigint;
  bucketDeltas: BucketDeltaResult[];
  currentSqrtPriceAfter: bigint;
  bucketStatesBefore: BucketState[];
  bucketStatesAfter: BucketState[];
  /** SETTLE-INV: the per-pool kernel's conservation-exact fills (xTotal/yTotal
   *  distributed pro-rata, last-absorbs-residual). The emitter reuses these so
   *  Σ amountOut per side == the pool's true side-total exactly. */
  fills: OrderFill[];
}

/** Sub-4: multi-pair clearing output. */
export interface ClearingResultMultiPair {
  cleared: boolean;
  activePoolCount: number;
  perPoolClearings: PoolClearingResult[];
  fills: HopFill[];
}

const MULTI_PAIR_MAX_ITERS = 8;
const HOP_FEE_NUM = 30n;
const HOP_FEE_DEN = 10_000n;

/**
 * Sub-4: top-level multi-pair clearing router.
 *
 * Each order's path is resolved to per-hop pool_ids via the registry.
 * Fixed-point iteration drops 2-hop orders whose composite clearing price
 * (mul_div(P_hop0, P_hop1, SCALE)) doesn't cross their limit_price.
 * Per-pool computeClearingV2 (Sub-2.5) is the inner kernel.
 *
 * Output ClearingResultMultiPair carries:
 *   - perPoolClearings[]: per-pool clearing state (sorted by pool_id)
 *   - fills[]: one HopFill per hop per order (2-hop orders emit hop=0 + hop=1)
 *     with chained amount_in: hop[1].amountIn = hop[0].amountOut
 */
export function computeClearingMultiPair(args: {
  orders: ClearingOrderMultiPair[];
  pools: Map<number, PoolStateForRouting>;
  registry: PoolRegistry;
}): ClearingResultMultiPair {
  const { orders, pools, registry } = args;

  // Resolve hop pool_ids per order at the start (static; doesn't change across iterations).
  type Routed = { order: ClearingOrderMultiPair; hops: number[] };
  const routed: Routed[] = orders.map((o) => {
    const pathArr: bigint[] = o.path_len === 2
      ? [o.path[0], o.path[1]]
      : [o.path[0], o.path[1], o.path[2]];
    const hops: number[] = [];
    for (let i = 0; i + 1 < pathArr.length; i++) {
      const pid = resolvePoolId(registry, pathArr[i]!, pathArr[i + 1]!);
      if (pid < 0) {
        throw new Error(
          `order ${o.orderNonce}: no pool for hop ${i}: ` +
          `0x${pathArr[i]!.toString(16)}->0x${pathArr[i + 1]!.toString(16)}`
        );
      }
      hops.push(pid);
    }
    return { order: o, hops };
  });

  // Fixed-point iteration: re-run per-pool clearings after dropping ineligible 2-hop orders.
  let dropped = new Set<bigint>();
  // SETTLE-INV v1: 2-hop orders are DISABLED. claim_fill pays both legs of a 2-hop
  // order while the intermediate is also pushed to pool1 as *_to_pool, an unfixable
  // double-spend without a claim_fill redesign (the intermediate must flow internally
  // to pool1, never to the maker). Drop every 2-hop order up front so only 1-hop fills
  // are emitted; the circuit asserts path_len==2 for any fill (main.nr STEP 0).
  for (const { order } of routed) {
    if (order.path_len === 3) dropped.add(order.orderNonce);
  }
  // SETTLE-INV v1 dust-guard: drop sub-MIN_FILL_AMOUNT_IN orders so no dust fill
  // is emitted (carried forward, still cancellable). Keeps every emitted receive
  // group above the floor's dust-brick zone — neutralizes the brick DoS without a
  // circuit change. See MIN_FILL_AMOUNT_IN.
  for (const { order } of routed) {
    if (order.amountIn < MIN_FILL_AMOUNT_IN) dropped.add(order.orderNonce);
  }
  let prevDroppedSize = -1;
  let perPool: Map<number, PoolClearingResult> = new Map();

  for (let iter = 0; iter < MULTI_PAIR_MAX_ITERS; iter++) {
    if (iter > 0 && dropped.size === prevDroppedSize) break;
    prevDroppedSize = dropped.size;

    // Bucket alive orders into per-pool sub-batches.
    const perPoolOrders: Map<number, ClearingOrder[]> = new Map();
    for (const { order, hops } of routed) {
      if (dropped.has(order.orderNonce)) continue;
      for (const pid of hops) {
        const arr = perPoolOrders.get(pid) ?? [];
        // Strip path fields; per-pool kernel only needs base ClearingOrder.
        arr.push({
          side: order.side,
          amountIn: order.amountIn,
          limitPrice: order.limitPrice,
          submittedAtBlock: order.submittedAtBlock,
          orderNonce: order.orderNonce,
          owner: order.owner, // R1: preserve owner so the hop-fill leaf can bind it
        });
        perPoolOrders.set(pid, arr);
      }
    }

    // Run per-pool computeClearingV2 (Sub-2.5) independently.
    perPool = new Map();
    for (const [pid, subOrders] of perPoolOrders) {
      const pool = pools.get(pid);
      if (!pool) continue;
      const r = computeClearingV2(pool, subOrders);
      if (!r.cleared) continue;
      perPool.set(pid, {
        pool_id: pid,
        clearingPrice: r.clearingPrice,
        bucketDeltas: r.bucketDeltas ?? [],
        currentSqrtPriceAfter: r.currentSqrtPriceAfter ?? pool.currentSqrtPrice,
        bucketStatesBefore: r.bucketStatesBefore ?? [],
        bucketStatesAfter: r.bucketStatesAfter ?? [],
        fills: r.fills,
      });
    }

    // Composite-eligibility pass: drop 2-hop orders that can't execute at composite price.
    let newDrops = false;
    for (const { order, hops } of routed) {
      if (order.path_len !== 3) continue;
      if (dropped.has(order.orderNonce)) continue;
      const p0 = perPool.get(hops[0]!);
      const p1 = perPool.get(hops[1]!);
      if (!p0 || !p1) {
        // One or both hop pools didn't clear; 2-hop can't execute.
        dropped.add(order.orderNonce);
        newDrops = true;
        continue;
      }
      // Composite price: P_hop0 * P_hop1 / SCALE (both prices are quote-per-base 1e18).
      const composite = mulDiv(p0.clearingPrice, p1.clearingPrice, SCALE);
      // Buy (side=false): buyer pays token_a, receives token_b via both hops.
      //   Eligible if limitPrice (max willing to pay) >= composite (actual cost).
      // Sell (side=true): seller receives token_a at composite.
      //   Eligible if limitPrice (min willing to accept) <= composite.
      const eligible = order.side === false
        ? order.limitPrice >= composite
        : order.limitPrice <= composite;
      if (!eligible) {
        dropped.add(order.orderNonce);
        newDrops = true;
      }
    }
    if (!newDrops && iter > 0) break;
  }

  if (perPool.size === 0) {
    return { cleared: false, activePoolCount: 0, perPoolClearings: [], fills: [] };
  }

  // SETTLE-INV v1: emit ONE conservation-exact 1-hop fill per surviving order.
  //
  // amountOut is the per-pool kernel's conservation-exact payout: computeClearing
  // distributes the pool's true side-total (xTotal/yTotal = escrow + from_pool −
  // to_pool) pro-rata by amount_in with the LAST fill absorbing the rounding
  // remainder, so Σ amountOut per (pool, receive-side) == the side-total EXACTLY.
  // The clearing circuit (main.nr STEP 2) recomputes the same split and asserts
  // equality, so the orderbook's claim_fill payouts can never exceed its holdings
  // (no float, no underflow). The old hopPayout recompute overshot by the rounding/
  // CoW gap — that WAS the conservation bug. 2-hop orders are dropped above.
  const fills: HopFill[] = [];
  for (const { order, hops } of routed) {
    if (dropped.has(order.orderNonce)) continue;
    const pid = hops[0]!;            // 1-hop only: exactly one pool
    const pr = perPool.get(pid);
    if (!pr) continue;               // pool didn't clear
    const kf = pr.fills.find((f) => f.orderNonce === order.orderNonce);
    if (!kf) continue;               // order ineligible at P* (not in the cleared set)
    fills.push({
      orderNonce: order.orderNonce,
      hop_index: 0,
      amountOut: kf.amountOut,
      pool_id: pid,
      owner: order.owner,
    });
  }

  return {
    cleared: true,
    activePoolCount: perPool.size,
    perPoolClearings: Array.from(perPool.values()).sort((a, b) => a.pool_id - b.pool_id),
    fills,
  };
}

/**
 * Compute payout for one hop at the uniform clearing price, after the 0.3% LP fee.
 *
 * Pricing convention (same as Sub-1 computeClearing):
 *   price P = token_b per token_a (quote-per-base, 1e18-scaled).
 *   buy  (side=false): amountIn is token_a => amountOut = amountIn * SCALE / P (in token_b).
 *   sell (side=true):  amountIn is token_b => amountOut = amountIn * P / SCALE (in token_a).
 *
 * Note: The 0.3% fee used here (30/10_000) matches the circuit constant rather
 * than the 0.997 fee-multiplier used in simulateNet, keeping the payout consistent
 * with on-chain witness generation.
 */
function hopPayout(amountIn: bigint, p: bigint, side: boolean): bigint {
  const gross = side === false
    ? mulDiv(amountIn, SCALE, p)   // buy: token_a -> token_b
    : mulDiv(amountIn, p, SCALE);  // sell: token_b -> token_a
  return (gross * (HOP_FEE_DEN - HOP_FEE_NUM)) / HOP_FEE_DEN;
}

// ---------------------------------------------------------------------------
// Single source of truth: aggregate swap flow helper (used by witness + calldata)
// ---------------------------------------------------------------------------

/**
 * Aggregate the per-bucket deltas into the four public swap-flow fields.
 *
 *   aToPool   = Σ reserve_a_add + Σ fee_rec_a  (GROSS token A into the pool)
 *   aFromPool = Σ reserve_a_sub                (token A out of the pool)
 *   bToPool   = Σ reserve_b_add + Σ fee_rec_b  (GROSS token B into the pool)
 *   bFromPool = Σ reserve_b_sub                (token B out of the pool)
 *
 * M17: to_pool is GROSS -- the post-fee reserve adds PLUS the LP fee derived from
 * the cum_fee increments (recoverForwardedFee), so the orderbook's to_pool
 * transfer actually funds the pool's cum_fee_per_share credit. The pool contract
 * asserts this same equation on-chain; the circuit re-bases its fee bounds on
 * net = to_pool - fee_rec.
 */
export function deriveAggregateFlows(
  bucketDeltas: Array<{
    reserve_a_add: bigint;
    reserve_a_sub: bigint;
    reserve_b_add: bigint;
    reserve_b_sub: bigint;
    cum_fee_a_per_share_increment: bigint;
    cum_fee_b_per_share_increment: bigint;
  }>,
  beforeLiquidity: bigint[],
): { aToPool: bigint; bToPool: bigint; aFromPool: bigint; bFromPool: bigint } {
  const { feeA, feeB } = recoverForwardedFee(bucketDeltas, beforeLiquidity);
  let aToPool = 0n, bToPool = 0n, aFromPool = 0n, bFromPool = 0n;
  for (const d of bucketDeltas) {
    aToPool += d.reserve_a_add;
    aFromPool += d.reserve_a_sub;
    bToPool += d.reserve_b_add;
    bFromPool += d.reserve_b_sub;
  }
  return { aToPool: aToPool + feeA, bToPool: bToPool + feeB, aFromPool, bFromPool };
}

/**
 * M17: the LP fee actually forwarded to the pool for a set of bucket deltas.
 * Per bucket k, token T: fee_rec_T[k] = floor(cum_fee_T_inc[k] * L_before[k] / SCALE),
 * bit-identical to the Noir side (circuits/clearing/src/buckets.nr::recovered_fee)
 * and to the pool contract's binding assert. Floor subadditivity guarantees that
 * the sum of all LP claims on an increment never exceeds fee_rec, so a pool whose
 * reserves grow by fee_rec is solvent for every future withdrawal pattern.
 * beforeLiquidity[i] must be the before-clearing liquidity of bucketDeltas[i]'s
 * bucket (same index alignment as the pool_state_commitment).
 * A zero beforeLiquidity[i] is valid (empty bucket): its increments recover to 0.
 */
export function recoverForwardedFee(
  bucketDeltas: Array<{
    cum_fee_a_per_share_increment: bigint;
    cum_fee_b_per_share_increment: bigint;
  }>,
  beforeLiquidity: bigint[],
): { feeA: bigint; feeB: bigint } {
  if (bucketDeltas.length !== beforeLiquidity.length) {
    throw new Error(
      `recoverForwardedFee: bucketDeltas (${bucketDeltas.length}) != beforeLiquidity (${beforeLiquidity.length})`,
    );
  }
  let feeA = 0n;
  let feeB = 0n;
  for (let i = 0; i < bucketDeltas.length; i++) {
    const liq = beforeLiquidity[i]!;
    feeA += mulDiv(bucketDeltas[i]!.cum_fee_a_per_share_increment, liq, SCALE);
    feeB += mulDiv(bucketDeltas[i]!.cum_fee_b_per_share_increment, liq, SCALE);
  }
  return { feeA, feeB };
}

// ---------------------------------------------------------------------------
// Audit #1: pool_state_commitment helper
// ---------------------------------------------------------------------------

/**
 * JS parity of circuits/clearing/src/buckets.nr::pool_state_commitment.
 *
 * Field order contract (MUST be byte-identical to the Noir function):
 *   input[0]        = sqrtPBefore
 *   for i in 0..4 (base = 1 + i*6):
 *     input[base+0] = (i < activeCount) ? deltas[i].bucket_id          : 0
 *     input[base+1] = (i < activeCount) ? beforeStates[i].reserve_a    : 0
 *     input[base+2] = (i < activeCount) ? beforeStates[i].reserve_b    : 0
 *     input[base+3] = (i < activeCount) ? beforeStates[i].liquidity     : 0
 *     input[base+4] = (i < activeCount) ? beforeStates[i].cum_fee_a_per_share : 0
 *     input[base+5] = (i < activeCount) ? beforeStates[i].cum_fee_b_per_share : 0
 *   Total: 1 + 6 * 4 = 25 elements.
 *
 * Notes:
 * - bucket_id comes from the DELTA at slot i; reserves/liquidity/fees from
 *   beforeStates at slot i. The caller must ensure index alignment (same i =
 *   same bucket in both arrays).
 * - Slots with i >= activeCount are ZERO-PADDED; the full 25-element array
 *   is always hashed so the digest is unambiguous.
 * - Inactive sentinel pools: pass sqrtPBefore=0n, empty arrays, activeCount=0
 *   to get a deterministic 0-commitment (= hash of [0;25]).
 *
 * @param sqrtPBefore  Pool's sqrt price before clearing (u128, 1e18-scaled).
 * @param beforeStates Per-bucket state snapshot before clearing (index-aligned with deltas).
 * @param deltas       Per-bucket deltas (index-aligned with beforeStates).
 * @param activeCount  Number of real active buckets (= deltas.length for real pools).
 * @returns            Poseidon2 digest as bigint (Field).
 */
export async function computePoolStateCommitment(
  sqrtPBefore: bigint,
  beforeStates: Array<{
    reserve_a: bigint;
    reserve_b: bigint;
    liquidity: bigint;
    cum_fee_a_per_share: bigint;
    cum_fee_b_per_share: bigint;
  }>,
  deltas: Array<{ bucket_id: number }>,
  activeCount: number,
): Promise<bigint> {
  const { poseidon2Hash } = await import("@aztec/foundation/crypto/poseidon");
  // 1 (sqrt_p) + 6 * MAX_ACTIVE_BUCKETS_PER_EPOCH(=4) = 25 elements.
  const MAX_BUCKETS = 4;
  const input: bigint[] = new Array(25).fill(0n);
  input[0] = sqrtPBefore;
  for (let i = 0; i < MAX_BUCKETS; i++) {
    const base = 1 + i * 6;
    if (i < activeCount) {
      const d = deltas[i]!;
      const s = beforeStates[i]!;
      input[base + 0] = BigInt(d.bucket_id);
      input[base + 1] = s.reserve_a;
      input[base + 2] = s.reserve_b;
      input[base + 3] = s.liquidity;
      input[base + 4] = s.cum_fee_a_per_share;
      input[base + 5] = s.cum_fee_b_per_share;
    } else {
      input[base + 0] = 0n;
      input[base + 1] = 0n;
      input[base + 2] = 0n;
      input[base + 3] = 0n;
      input[base + 4] = 0n;
      input[base + 5] = 0n;
    }
  }
  return (await poseidon2Hash(input)).toBigInt();
}
