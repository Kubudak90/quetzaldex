// sdk/src/pools.ts
// Sub-8.2b: PoolsApi — LP deposit / read methods for concentrated-liquidity pools.
//
// Mirrors the BridgeApi shape: lazy-loaded, pure SDK concern, wired as
// `client.pools` in QuetzalClient.
//
// Design notes:
// - withdraw() is implemented and ships in this file; it is straightforward
//   because the contract API (position_nonce + fresh hints) is the same shape
//   as deposit.
// - Bucket math (computeDeposit) is re-implemented here inline to avoid the
//   aggregator package dependency from inside the SDK.  The math is identical
//   to aggregator/src/buckets.ts.
// - get_positions() returns up to MAX_NOTES_PER_PAGE positions (16 per PXE
//   page).  Pagination is a follow-up.

import { AztecAddress } from "@aztec/aztec.js/addresses";
import { Fr } from "@aztec/aztec.js/fields";
import type { QuetzalClient } from "./client.js";
import { ConfigError } from "./errors.js";
import { randomField } from "./util/field.js";

// ─── Error type ──────────────────────────────────────────────────────────────

export class PoolError extends Error {
  constructor(
    public readonly code: "INVALID_INPUT" | "CONTRACT_ERROR" | "NOT_FOUND" | "UNKNOWN",
    msg: string,
    public readonly cause?: unknown,
  ) {
    super(msg);
    this.name = "PoolError";
  }
}

// ─── V3 bucket math (inline mirror of aggregator/src/buckets.ts) ─────────────
// Kept here so the SDK stays self-contained without a circular dep on aggregator.

const SCALE = 1_000_000_000_000_000_000n;

interface BucketBounds {
  sqrt_lower: bigint;
  sqrt_upper: bigint;
}

interface DepositMath {
  l_used: bigint;
  used_a: bigint;
  used_b: bigint;
}

/** Determine which regime the current sqrt_price is in for this bucket. */
export type DepositRegime = "below-range" | "in-range" | "above-range";

function mulDiv(a: bigint, b: bigint, c: bigint): bigint {
  if (c === 0n) throw new PoolError("INVALID_INPUT", "mul_div: divisor is zero");
  return (a * b) / c;
}

function depositBelowRange(x_a: bigint, sqrt_lower: bigint, sqrt_upper: bigint): DepositMath {
  const sqrt_lower_x_upper = mulDiv(sqrt_lower, sqrt_upper, SCALE);
  const span = sqrt_upper - sqrt_lower;
  const l_used = mulDiv(x_a, sqrt_lower_x_upper, span);
  return { l_used, used_a: x_a, used_b: 0n };
}

function depositAboveRange(x_b: bigint, sqrt_lower: bigint, sqrt_upper: bigint): DepositMath {
  const span = sqrt_upper - sqrt_lower;
  const l_used = mulDiv(x_b, SCALE, span);
  return { l_used, used_a: 0n, used_b: x_b };
}

function depositInRange(
  x_a: bigint, x_b: bigint,
  sqrt_p: bigint, sqrt_lower: bigint, sqrt_upper: bigint,
): DepositMath {
  const sqrt_p_x_upper = mulDiv(sqrt_p, sqrt_upper, SCALE);
  const span_upper = sqrt_upper - sqrt_p;
  const span_lower = sqrt_p - sqrt_lower;
  const l_a = mulDiv(x_a, sqrt_p_x_upper, span_upper);
  const l_b = mulDiv(x_b, SCALE, span_lower);
  const l_used = l_a < l_b ? l_a : l_b;
  const used_a = mulDiv(l_used, span_upper, sqrt_p_x_upper);
  const used_b = mulDiv(l_used, span_lower, SCALE);
  return { l_used, used_a, used_b };
}

export function computeDeposit(
  x_a: bigint, x_b: bigint,
  sqrt_p: bigint,
  bounds: BucketBounds,
): DepositMath {
  if (sqrt_p <= bounds.sqrt_lower) {
    return depositBelowRange(x_a, bounds.sqrt_lower, bounds.sqrt_upper);
  } else if (sqrt_p >= bounds.sqrt_upper) {
    return depositAboveRange(x_b, bounds.sqrt_lower, bounds.sqrt_upper);
  }
  return depositInRange(x_a, x_b, sqrt_p, bounds.sqrt_lower, bounds.sqrt_upper);
}

export function depositRegime(sqrt_p: bigint, bounds: BucketBounds): DepositRegime {
  if (sqrt_p <= bounds.sqrt_lower) return "below-range";
  if (sqrt_p >= bounds.sqrt_upper) return "above-range";
  return "in-range";
}

/** Compute the sqrt_lower / sqrt_upper for a given bucket, mirroring contracts/pool/src/main.nr::compute_bucket_bounds. */
export function computeBucketBounds(
  pMinSqrt: bigint,
  growthNum: bigint,
  bucketId: number,
): BucketBounds {
  let sqrtLower = pMinSqrt;
  for (let i = 0; i < bucketId; i++) {
    sqrtLower = mulDiv(sqrtLower, growthNum, SCALE);
  }
  const sqrtUpper = mulDiv(sqrtLower, growthNum, SCALE);
  return { sqrt_lower: sqrtLower, sqrt_upper: sqrtUpper };
}

/** All `numBuckets` bucket bounds for a pool, derived from p_min_sqrt + growth. */
export function computeAllBucketBounds(
  pMinSqrt: bigint,
  growthNum: bigint,
  numBuckets: number,
): BucketBounds[] {
  return Array.from({ length: numBuckets }, (_, i) => computeBucketBounds(pMinSqrt, growthNum, i));
}

// ─── Public types ─────────────────────────────────────────────────────────────

export interface PoolState {
  reserveA: bigint;
  reserveB: bigint;
  currentSqrtPrice: bigint;
}

export interface BucketState {
  reserveA: bigint;
  reserveB: bigint;
  liquidity: bigint;
  cumFeeAPerShare: bigint;
  cumFeeBPerShare: bigint;
}

export interface PositionView {
  bucketId: number;
  lpShare: bigint;
  positionNonce: bigint;
  cumFeeAPerShareAtDeposit: bigint;
  cumFeeBPerShareAtDeposit: bigint;
}

export interface DepositInput {
  /** Index into config.contracts.pools (default 0). */
  poolId?: number;
  bucketId: number;
  amountA: bigint;
  amountB: bigint;
}

export interface DepositResult {
  l2TxHash: string;
  positionNonce: bigint;
  lUsed: bigint;
  refundedA: bigint;
  refundedB: bigint;
}

export interface WithdrawInput {
  /** Index into config.contracts.pools (default 0). */
  poolId?: number;
  positionNonce: bigint;
}

export interface WithdrawResult {
  l2TxHash: string;
}

export interface DepositEstimate {
  lUsed: bigint;
  usedA: bigint;
  usedB: bigint;
  refundedA: bigint;
  refundedB: bigint;
  regime: DepositRegime;
}

// ─── Config helper ────────────────────────────────────────────────────────────

function requireContracts(client: QuetzalClient) {
  const c = client.config.contracts;
  if (!c) {
    throw new ConfigError(
      "MISSING_ENV",
      "QuetzalClient.config.contracts not set; pass `contracts` to QuetzalClient.connect()",
    );
  }
  return c;
}

// ─── PoolsApi ─────────────────────────────────────────────────────────────────

export class PoolsApi {
  constructor(private client: QuetzalClient) {}

  private async _poolContract(poolId: number) {
    const contracts = requireContracts(this.client);
    const entry = contracts.pools[poolId];
    if (!entry) {
      throw new PoolError("NOT_FOUND", `pool_id ${poolId} not found in contracts.pools`);
    }
    const { loadLiquidityPoolContract } = await import("./internal/contracts.js");
    const LiquidityPoolContract = await loadLiquidityPoolContract();
    return LiquidityPoolContract.at(AztecAddress.fromStringUnsafe(entry.address), this.client.wallet);
  }

  /** Read the global pool state (reserve totals + current sqrt_price). */
  async getPoolState(poolId = 0): Promise<PoolState> {
    const pool = await this._poolContract(poolId);
    const sim = await (pool as unknown as {
      methods: { get_pool_state: () => { simulate: (a: { from: AztecAddress }) => Promise<unknown> } };
    }).methods.get_pool_state().simulate({ from: this.client.address });
    const r = (sim as { result: Record<string, bigint | number> }).result;
    return {
      reserveA: BigInt(r.reserve_a),
      reserveB: BigInt(r.reserve_b),
      currentSqrtPrice: BigInt(r.current_sqrt_price),
    };
  }

  /** Read the pool's p_min_sqrt PublicImmutable (never changes after deploy). */
  async getPMinSqrt(poolId = 0): Promise<bigint> {
    const pool = await this._poolContract(poolId);
    const sim = await (pool as unknown as {
      methods: { get_p_min_sqrt: () => { simulate: (a: { from: AztecAddress }) => Promise<unknown> } };
    }).methods.get_p_min_sqrt().simulate({ from: this.client.address });
    return BigInt((sim as { result: bigint | number }).result);
  }

  /** Read the pool's bucket_growth_num PublicImmutable (never changes after deploy). */
  async getBucketGrowthNum(poolId = 0): Promise<bigint> {
    const pool = await this._poolContract(poolId);
    const sim = await (pool as unknown as {
      methods: { get_bucket_growth_num: () => { simulate: (a: { from: AztecAddress }) => Promise<unknown> } };
    }).methods.get_bucket_growth_num().simulate({ from: this.client.address });
    return BigInt((sim as { result: bigint | number }).result);
  }

  /** Read the state of one bucket (0..15). */
  async getBucket(bucketId: number, poolId = 0): Promise<BucketState> {
    if (bucketId < 0 || bucketId > 15) {
      throw new PoolError("INVALID_INPUT", "bucketId must be in 0..15");
    }
    const pool = await this._poolContract(poolId);
    const sim = await (pool as unknown as {
      methods: { get_bucket: (id: number) => { simulate: (a: { from: AztecAddress }) => Promise<unknown> } };
    }).methods.get_bucket(bucketId).simulate({ from: this.client.address });
    const r = (sim as { result: Record<string, bigint | number> }).result;
    return {
      reserveA: BigInt(r.reserve_a),
      reserveB: BigInt(r.reserve_b),
      liquidity: BigInt(r.liquidity),
      cumFeeAPerShare: BigInt(r.cum_fee_a_per_share),
      cumFeeBPerShare: BigInt(r.cum_fee_b_per_share),
    };
  }

  /** Read the connected account's LP positions (up to 16 per PXE page). */
  async getPositions(poolId = 0, owner?: AztecAddress): Promise<PositionView[]> {
    const pool = await this._poolContract(poolId);
    const addr = owner ?? this.client.address;
    const sim = await (pool as unknown as {
      methods: { get_positions: (a: AztecAddress) => { simulate: (b: { from: AztecAddress }) => Promise<unknown> } };
    }).methods.get_positions(addr).simulate({ from: this.client.address });
    const bv = (sim as { result: { storage: unknown[]; len: bigint | number } }).result;
    const len = Number(bv.len);
    return bv.storage.slice(0, len).map((o) => {
      const r = o as Record<string, bigint | number>;
      return {
        bucketId: Number(r.bucket_id),
        lpShare: BigInt(r.lp_share),
        positionNonce: BigInt(r.nonce),
        cumFeeAPerShareAtDeposit: BigInt(r.cum_fee_a_per_share_at_deposit),
        cumFeeBPerShareAtDeposit: BigInt(r.cum_fee_b_per_share_at_deposit),
      };
    });
  }

  /**
   * Estimate how a deposit would be split by the V3 math — pure off-chain computation,
   * no PXE call.  Call getPoolState() + getBucket() first to get the hints.
   */
  estimateDeposit(
    amountA: bigint,
    amountB: bigint,
    poolState: PoolState,
    bucketId: number,
    pMinSqrt: bigint,
    growthNum: bigint,
  ): DepositEstimate {
    const bounds = computeBucketBounds(pMinSqrt, growthNum, bucketId);
    const math = computeDeposit(amountA, amountB, poolState.currentSqrtPrice, bounds);
    return {
      lUsed: math.l_used,
      usedA: math.used_a,
      usedB: math.used_b,
      refundedA: amountA - math.used_a,
      refundedB: amountB - math.used_b,
      regime: depositRegime(poolState.currentSqrtPrice, bounds),
    };
  }

  /**
   * Deposit liquidity into a specific bucket.
   *
   * Reads fresh pool + bucket hints from chain before submitting so the hint
   * assertion in the contract is unlikely to fail.  On hint mismatch the
   * contract reverts; the caller can retry (same pattern as seed-lp.ts).
   */
  async deposit(input: DepositInput): Promise<DepositResult> {
    const poolId = input.poolId ?? 0;
    if (input.bucketId < 0 || input.bucketId > 15) {
      throw new PoolError("INVALID_INPUT", "bucketId must be in 0..15");
    }
    if (input.amountA <= 0n && input.amountB <= 0n) {
      throw new PoolError("INVALID_INPUT", "amountA or amountB must be > 0");
    }

    const contracts = requireContracts(this.client);
    const entry = contracts.pools[poolId];
    if (!entry) throw new PoolError("NOT_FOUND", `pool_id ${poolId} not found in contracts.pools`);

    const { loadLiquidityPoolContract } = await import("./internal/contracts.js");
    const LiquidityPoolContract = await loadLiquidityPoolContract();
    const pool = await LiquidityPoolContract.at(
      AztecAddress.fromStringUnsafe(entry.address),
      this.client.wallet,
    );

    // Read fresh hints (avoids hint-mismatch revert on first attempt).
    const poolState = await this.getPoolState(poolId);
    const bucketState = await this.getBucket(input.bucketId, poolId);

    const poolHint = {
      reserve_a: poolState.reserveA,
      reserve_b: poolState.reserveB,
      current_sqrt_price: poolState.currentSqrtPrice,
    };
    const bucketHint = {
      reserve_a: bucketState.reserveA,
      reserve_b: bucketState.reserveB,
      liquidity: bucketState.liquidity,
      cum_fee_a_per_share: bucketState.cumFeeAPerShare,
      cum_fee_b_per_share: bucketState.cumFeeBPerShare,
    };

    const nonceA = new Fr(randomField());
    const nonceB = input.amountB > 0n ? new Fr(randomField()) : new Fr(0n);
    const positionNonceField = new Fr(randomField());

    const poolDyn = pool as unknown as {
      methods: {
        deposit: (
          bucket_id: number,
          amount_a: bigint,
          amount_b: bigint,
          hint_pool: typeof poolHint,
          hint_bucket: typeof bucketHint,
          nonce_a: Fr,
          nonce_b: Fr,
          position_nonce: Fr,
        ) => { send: (a: { from: AztecAddress }) => Promise<{ wait?: () => Promise<{ txHash?: { toString: () => string } }> }> };
      };
    };

    const sent = await poolDyn.methods.deposit(
      input.bucketId,
      input.amountA,
      input.amountB,
      poolHint,
      bucketHint,
      nonceA,
      nonceB,
      positionNonceField,
    ).send({ from: this.client.address });

    // `.send({from})` is awaited (the tx mines); read the real hash from `.receipt`.
    // The prior `.wait?.()` was a no-op (resolved result has no `.wait`). (aztec.js 4.x)
    const receipt = (sent as unknown as { receipt?: { txHash?: { toString: () => string } } }).receipt;
    const l2TxHash = receipt?.txHash?.toString() ?? "";

    // Derive the refund amounts from the V3 math estimate (using the hints we read).
    // We don't have the exact contract's p_min_sqrt / growth_num in the config yet,
    // so we report 0n for refunded amounts — the estimate method on the frontend
    // can compute it client-side before submit.
    return {
      l2TxHash,
      positionNonce: BigInt(positionNonceField.toBigInt()),
      lUsed: 0n,   // not returned by contract; caller can estimate via estimateDeposit()
      refundedA: 0n,
      refundedB: 0n,
    };
  }

  /**
   * Withdraw an LP position.
   *
   * `positionNonce` comes from a PositionView returned by getPositions().
   * Reads fresh hints before submitting.
   */
  async withdraw(input: WithdrawInput): Promise<WithdrawResult> {
    const poolId = input.poolId ?? 0;

    const contracts = requireContracts(this.client);
    const entry = contracts.pools[poolId];
    if (!entry) throw new PoolError("NOT_FOUND", `pool_id ${poolId} not found in contracts.pools`);

    // Find the position to know which bucket it's in.
    const positions = await this.getPositions(poolId);
    const position = positions.find((p) => p.positionNonce === input.positionNonce);
    if (!position) {
      throw new PoolError("NOT_FOUND", `position with nonce ${input.positionNonce} not found`);
    }

    const { loadLiquidityPoolContract } = await import("./internal/contracts.js");
    const LiquidityPoolContract = await loadLiquidityPoolContract();
    const pool = await LiquidityPoolContract.at(
      AztecAddress.fromStringUnsafe(entry.address),
      this.client.wallet,
    );

    const poolState = await this.getPoolState(poolId);
    const bucketState = await this.getBucket(position.bucketId, poolId);

    const poolHint = {
      reserve_a: poolState.reserveA,
      reserve_b: poolState.reserveB,
      current_sqrt_price: poolState.currentSqrtPrice,
    };
    const bucketHint = {
      reserve_a: bucketState.reserveA,
      reserve_b: bucketState.reserveB,
      liquidity: bucketState.liquidity,
      cum_fee_a_per_share: bucketState.cumFeeAPerShare,
      cum_fee_b_per_share: bucketState.cumFeeBPerShare,
    };

    // M17 (fee pot): earned is paid from the bucket's fee pot, capped at its
    // balance; the contract asserts these hints against live state (retry on drift).
    const potDyn = pool as unknown as {
      methods: {
        get_fee_pot_a: (bucket_id: number) => { simulate: (o: { from: AztecAddress }) => Promise<unknown> };
        get_fee_pot_b: (bucket_id: number) => { simulate: (o: { from: AztecAddress }) => Promise<unknown> };
      };
    };
    const hintFeePotA = BigInt(
      ((await potDyn.methods.get_fee_pot_a(position.bucketId).simulate({ from: this.client.address })) as { result: bigint | number }).result,
    );
    const hintFeePotB = BigInt(
      ((await potDyn.methods.get_fee_pot_b(position.bucketId).simulate({ from: this.client.address })) as { result: bigint | number }).result,
    );

    const nonceA = new Fr(randomField());
    const nonceB = new Fr(randomField());
    const positionNonceField = new Fr(input.positionNonce);

    const poolDyn = pool as unknown as {
      methods: {
        withdraw: (
          position_nonce: Fr,
          hint_pool: typeof poolHint,
          hint_bucket: typeof bucketHint,
          hint_fee_pot_a: bigint,
          hint_fee_pot_b: bigint,
          nonce_a: Fr,
          nonce_b: Fr,
        ) => { send: (a: { from: AztecAddress }) => Promise<{ wait?: () => Promise<{ txHash?: { toString: () => string } }> }> };
      };
    };

    const sent = await poolDyn.methods.withdraw(
      positionNonceField,
      poolHint,
      bucketHint,
      hintFeePotA,
      hintFeePotB,
      nonceA,
      nonceB,
    ).send({ from: this.client.address });

    // `.send({from})` is awaited (the tx mines); read the real hash from `.receipt`.
    // The prior `.wait?.()` was a no-op (resolved result has no `.wait`). (aztec.js 4.x)
    const receipt = (sent as unknown as { receipt?: { txHash?: { toString: () => string } } }).receipt;
    return { l2TxHash: receipt?.txHash?.toString() ?? "" };
  }
}
