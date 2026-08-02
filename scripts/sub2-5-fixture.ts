import { buildClearingWitness, MAX_ACTIVE_BUCKETS_PER_EPOCH } from "../aggregator/src/witness.js";
import { SCALE } from "../aggregator/src/buckets.js";
import { writeFileSync } from "node:fs";

async function main() {
  const witness = await buildClearingWitness({
    epoch: { order_acc: 0n, cancel_acc: 0n, order_count: 0, cancel_count: 0 },
    pool: { reserve_a: 1000n * SCALE, reserve_b: 1000n * SCALE, current_sqrt_price_before: SCALE },
    orders: [],
    cancellationIndices: [],
    clearing: {
      cleared: false, clearingPrice: 0n, fills: [],
      newReserveA: 1000n * SCALE, newReserveB: 1000n * SCALE,
      feeAPerShareIncrement: 0n, feeBPerShareIncrement: 0n,
    },
    bucketStatesBefore: [],
    bucketStatesAfter: [],
    bucketDeltas: [],
    currentSqrtPriceAfter: SCALE,
  });
  writeFileSync("circuits/clearing/Prover.toml", witness.proverToml);
  console.log("wrote circuits/clearing/Prover.toml");
}
main().catch((e) => { console.error(e); process.exit(1); });
