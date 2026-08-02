import type { Command } from "commander";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { Fr } from "@aztec/aztec.js/fields";
import { LiquidityPoolContract } from "../../../tests/integration/generated/LiquidityPool.js";
import { loadConfig } from "../config.js";
import { openCli } from "../wallet.js";
import { parseField } from "@quetzal/sdk";
import { readPoolHint, readBucketHint } from "../pool-hint.js";

export function registerWithdraw(program: Command): void {
  program
    .command("withdraw")
    .description("burn an LP position and reclaim its liquidity (Sub-2: per-bucket)")
    .requiredOption("--nonce <field>", "position nonce")
    .requiredOption("--bucket <id>", "bucket id the position belongs to (0..15)")
    .option("--pool-id <n>", "Pool ID from quetzal pools list", "0")
    .action(async (_opts, cmd: Command) => {
      const opts = cmd.optsWithGlobals();
      const positionNonce = new Fr(parseField(String(opts.nonce)));
      const bucketId = Number(opts.bucket);
      if (!Number.isInteger(bucketId) || bucketId < 0 || bucketId > 15) {
        throw new Error("--bucket must be an integer in 0..15");
      }

      const config = loadConfig(opts.config);
      const poolId = Number(opts.poolId ?? 0);
      const poolEntry = config.pools[poolId];
      if (!poolEntry) throw new Error(`pool_id ${poolId} not found in config.pools`);
      const poolAddress = poolEntry.address;
      const { client } = await openCli(config, Number(opts.account));
      try {
        const pool = await LiquidityPoolContract.at(
          AztecAddress.fromStringUnsafe(poolAddress),
          client.wallet,
        );
        const poolHint = await readPoolHint(pool, client.address);
        const bucketHint = await readBucketHint(pool, bucketId, client.address);
        // M17: withdraw takes per-bucket fee-pot hints (earned fees are paid
        // from the pot, not bucket reserves). Same optimistic-hint pattern.
        const potASim = await pool.methods
          .get_fee_pot_a(bucketId)
          .simulate({ from: client.address });
        const potBSim = await pool.methods
          .get_fee_pot_b(bucketId)
          .simulate({ from: client.address });
        const hintFeePotA = (potASim as { result: bigint }).result;
        const hintFeePotB = (potBSim as { result: bigint }).result;

        await pool.methods
          .withdraw(
            positionNonce,
            poolHint,
            bucketHint,
            hintFeePotA,
            hintFeePotB,
            new Fr(0n),
            new Fr(0n),
          )
          .send({ from: client.address });
        console.log(
          `position ${positionNonce.toString()} (bucket ${bucketId}) withdrawn; liquidity returned`,
        );
      } finally {
        await client.stop();
      }
    });
}
