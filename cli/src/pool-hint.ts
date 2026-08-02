import type { AztecAddress } from "@aztec/aztec.js/addresses";
import type { LiquidityPoolContract } from "../../tests/integration/generated/LiquidityPool.js";

/** Sub-2 PoolState: aggregate cache + global sqrt_p (lp_supply + cum_fee_* dropped). */
export interface PoolStateHint {
  reserve_a: bigint;
  reserve_b: bigint;
  current_sqrt_price: bigint;
}

/** Sub-2 per-bucket state hint, used in deposit/withdraw. */
export interface BucketStateHint {
  reserve_a: bigint;
  reserve_b: bigint;
  liquidity: bigint;
  cum_fee_a_per_share: bigint;
  cum_fee_b_per_share: bigint;
}

/** Read the live pool state for the optimistic hint pattern. */
export async function readPoolHint(
  pool: LiquidityPoolContract,
  from: AztecAddress,
): Promise<PoolStateHint> {
  const sim = await pool.methods.get_pool_state().simulate({ from });
  return (sim as { result: PoolStateHint }).result;
}

/** Sub-2: read a specific bucket's state. */
export async function readBucketHint(
  pool: LiquidityPoolContract,
  bucketId: number,
  from: AztecAddress,
): Promise<BucketStateHint> {
  const sim = await pool.methods.get_bucket(bucketId).simulate({ from });
  return (sim as { result: BucketStateHint }).result;
}
