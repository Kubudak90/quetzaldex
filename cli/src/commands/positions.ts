import type { Command } from "commander";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { LiquidityPoolContract } from "../../../tests/integration/generated/LiquidityPool.js";
import { loadConfig } from "../config.js";
import { openCli } from "../wallet.js";
import { readPoolHint, readBucketHint } from "../pool-hint.js";

export function registerPositions(program: Command): void {
  program
    .command("positions")
    .description("list the account's LP positions (Sub-2: includes bucket info)")
    .option("--pool-id <n>", "Pool ID from quetzal pools list", "0")
    .action(async (_opts, cmd: Command) => {
      const opts = cmd.optsWithGlobals();
      const config = loadConfig(opts.config);
      const poolId = Number(opts.poolId ?? 0);
      const poolEntry = config.pools[poolId];
      if (!poolEntry) throw new Error(`pool_id ${poolId} not found in config.pools`);
      const poolAddress = poolEntry.address;
      const { client } = await openCli(config, Number(opts.account));
      try {
        const rows = await client.reads.getPositions({ poolId });
        if (rows.length === 0) {
          console.log("no LP positions");
          return;
        }
        // Bucket bound formatting is CLI-specific (Sub-2 visualization) — uses
        // direct pool-hint helpers rather than going through the SDK reads API.
        const pool = await LiquidityPoolContract.at(
          AztecAddress.fromStringUnsafe(poolAddress),
          client.wallet,
        );
        const poolHint = await readPoolHint(pool, client.address);
        console.log(`LP positions for account ${opts.account}:`);
        for (const r of rows) {
          const bucket = await readBucketHint(pool, r.bucket_id, client.address);
          const pMin = await pool.methods.get_p_min_sqrt().simulate({ from: client.address });
          const growth = await pool.methods
            .get_bucket_growth_num()
            .simulate({ from: client.address });
          const pMinV = (pMin as { result: bigint }).result;
          const growthV = (growth as { result: bigint }).result;
          const SCALE = 1_000_000_000_000_000_000n;
          let sqrtLower = pMinV;
          for (let i = 0; i < r.bucket_id; i++) sqrtLower = (sqrtLower * growthV) / SCALE;
          const sqrtUpper = (sqrtLower * growthV) / SCALE;
          const inRange =
            poolHint.current_sqrt_price >= sqrtLower &&
            poolHint.current_sqrt_price < sqrtUpper;
          const status =
            bucket.liquidity === 0n
              ? "(empty bucket)"
              : inRange
                ? "(in-range)"
                : "(out-of-range)";
          console.log(
            `  bucket=${r.bucket_id} ${status}  nonce=0x${r.nonce.toString(16)}  ` +
              `lp_share=${r.lp_share}  fee_snapshot=(${r.cum_fee_a_per_share_at_deposit}, ${r.cum_fee_b_per_share_at_deposit})`,
          );
        }
      } finally {
        await client.stop();
      }
    });
}
