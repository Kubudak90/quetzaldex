import type { Command } from "commander";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { LiquidityPoolContract } from "../../../tests/integration/generated/LiquidityPool.js";
import { loadConfig } from "../config.js";
import { openCli } from "../wallet.js";
import { randomField } from "@quetzal/sdk";
import { readPoolHint, readBucketHint, type BucketStateHint } from "../pool-hint.js";

// Sub-2 LP deposit. Stays CLI-local because the bucket-state hint + auto-b math
// + position nonce generation are LP-specific concerns the SDK doesn't yet
// model (a future OrdersApi.lp.deposit could lift this; tracked for Sub-7).
export function registerDeposit(program: Command): void {
  program
    .command("deposit")
    .description("supply liquidity to a specific bucket (Sub-2 concentrated liquidity)")
    .requiredOption("--bucket <id>", "bucket id (0..15)")
    .requiredOption("--amount-a <n>", "token A amount (smallest unit)")
    .option("--amount-b <n>", "token B amount; omit with --auto-b")
    .option("--auto-b", "auto-derive amount_b from bucket's current ratio")
    .option("--pool-id <n>", "Pool ID from quetzal pools list", "0")
    .action(async (_opts, cmd: Command) => {
      const opts = cmd.optsWithGlobals();
      const bucketId = Number(opts.bucket);
      if (!Number.isInteger(bucketId) || bucketId < 0 || bucketId > 15) {
        throw new Error("--bucket must be an integer in 0..15");
      }
      const amountA = BigInt(opts.amountA);

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

        const bucketHint: BucketStateHint = await readBucketHint(pool, bucketId, client.address);

        let amountB: bigint;
        if (opts["autoB"]) {
          if (bucketHint.reserve_a === 0n) {
            throw new Error(
              "--auto-b requires non-empty bucket; specify --amount-b for first deposit",
            );
          }
          amountB = (amountA * bucketHint.reserve_b) / bucketHint.reserve_a;
          console.log(
            `auto-b: derived amount_b=${amountB} from bucket ratio ${bucketHint.reserve_b}/${bucketHint.reserve_a}`,
          );
        } else {
          if (!opts["amountB"]) throw new Error("specify --amount-b or use --auto-b");
          amountB = BigInt(opts.amountB);
        }

        const poolHint = await readPoolHint(pool, client.address);

        const positionNonce = randomField();
        await pool.methods
          .deposit(
            bucketId,
            amountA,
            amountB,
            poolHint,
            bucketHint,
            randomField(),
            randomField(),
            positionNonce,
          )
          .send({ from: client.address });

        console.log(`liquidity deposited to bucket ${bucketId} (A=${amountA}, B=${amountB})`);
        console.log(`position nonce: 0x${positionNonce.toString(16)}`);
        console.log(`withdraw later with: quetzal withdraw --nonce 0x${positionNonce.toString(16)}`);
      } finally {
        await client.stop();
      }
    });
}
