/**
 * SETTLE-INV bb-prove integration harness (LOCAL only).
 *
 * Builds a synthetic single-pool 1-hop clearing with the NEW conservation-exact
 * emitter (computeClearingMultiPair), runs it through the live witness builder
 * (buildClearingWitnessMultiPair), and writes circuits/clearing/Prover.toml.
 * Then `nargo execute` runs the circuit's witness-gen (every assert incl. block
 * C2 conservation/floor/solvency) — success == the circuit ACCEPTS honest fills.
 *
 * Usage: tsx prove-settle.ts <case> [tamper]
 *   case:   oneSided | cow
 *   tamper: overpay | underpay | proportional | twohop   (optional)
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  computeClearingMultiPair,
  computePoolStateCommitment,
  deriveAggregateFlows,
} from "../src/clearing.js";
import type {
  ClearingOrderMultiPair,
  PoolStateForRouting,
  HopFill,
} from "../src/clearing.js";
import { buildClearingWitnessMultiPair, MAX_ACTIVE_POOLS_PER_EPOCH } from "../src/witness.js";
import { computeCi, replayOrderAcc } from "../src/validate.js";
import { SCALE } from "../src/buckets.js";
import type { PoolRegistry } from "../src/path.js";

const TA = 0x111n; // token_lo (small: full == u128-truncated, a == lo)
const TB = 0x222n; // token_hi
const OWNER = 0xabcdn;

function buildSinglePool(reserveA: bigint, reserveB: bigint): PoolStateForRouting {
  return {
    reserveA,
    reserveB,
    lpSupply: SCALE,
    currentSqrtPrice: SCALE, // 1.0
    bucketBounds: [{ sqrt_lower: SCALE / 100n, sqrt_upper: SCALE * 100n }],
    bucketStates: [
      {
        reserve_a: reserveA,
        reserve_b: reserveB,
        liquidity: SCALE,
        cum_fee_a_per_share: 0n,
        cum_fee_b_per_share: 0n,
      },
    ],
  };
}

const reg: PoolRegistry = [{ pool_id: 0, token_a: TA, token_b: TB }];

type Order = {
  side: boolean;
  amount_in: bigint;
  limit_price: bigint;
  order_nonce: bigint;
  submitted_at_block: number;
  owner: bigint;
  path_len: 2 | 3;
  path: [bigint, bigint, bigint];
};

// Realistic raw token amounts (~1e9), matching the live token scale (proven fill
// amount_out ~99699899). The circuit's mul_div requires the floor divisor
// (sum_in_group) < 2^64, so per-group filled input must stay < ~1.8e19 raw units.
const A_IN = 1_000_000_000n;     // 1e9
const CASES: Record<string, Order[]> = {
  oneSided: [
    // single seller: brings TB, receives TA (path[0]=output TA, path[1]=input TB)
    { side: true, amount_in: A_IN, limit_price: SCALE / 1000n,
      order_nonce: 43n, submitted_at_block: 1, owner: OWNER, path_len: 2, path: [TA, TB, 0n] },
  ],
  cow: [
    { side: false, amount_in: 2n * A_IN, limit_price: 5n * SCALE,
      order_nonce: 42n, submitted_at_block: 1, owner: OWNER, path_len: 2, path: [TA, TB, 0n] },
    { side: true, amount_in: A_IN, limit_price: SCALE / 1000n,
      order_nonce: 43n, submitted_at_block: 1, owner: OWNER, path_len: 2, path: [TA, TB, 0n] },
  ],
};

async function main() {
  const caseName = process.argv[2] ?? "oneSided";
  const tamper = process.argv[3];
  const orders = CASES[caseName];
  if (!orders) throw new Error(`unknown case ${caseName}`);

  const pool = buildSinglePool(10_000n * SCALE, 5_000n * SCALE);
  const pools = new Map<number, PoolStateForRouting>([[0, pool]]);

  const clearing = computeClearingMultiPair({
    orders: orders.map((o) => ({
      side: o.side,
      amountIn: o.amount_in,
      limitPrice: o.limit_price,
      submittedAtBlock: o.submitted_at_block,
      orderNonce: o.order_nonce,
      path: o.path,
      path_len: o.path_len,
    })) as ClearingOrderMultiPair[],
    pools,
    registry: reg,
  });
  if (!clearing.cleared) throw new Error("clearing did not clear — adjust the fixture");

  let fills: HopFill[] = clearing.fills;
  let ordersForWitness = orders;

  // --- reconciliation debug: replicate the circuit's C2 accounting for pool 0 ---
  {
    const slot = clearing.perPoolClearings[0]!;
    const flows = deriveAggregateFlows(
      slot.bucketDeltas,
      (slot.bucketStatesBefore ?? []).map((s) => s.liquidity),
    );
    let payLo = 0n, payHi = 0n, sumLo = 0n, sumHi = 0n;
    for (const f of clearing.fills) {
      const o = orders.find((x) => x.order_nonce === f.orderNonce)!;
      const outTok = o.side ? o.path[0] : o.path[1];
      if (outTok === TA) { payLo += f.amountOut; sumLo += o.amount_in; }
      else { payHi += f.amountOut; sumHi += o.amount_in; }
    }
    const availLo = flows.aFromPool + sumHi - flows.aToPool;
    const availHi = flows.bFromPool + sumLo - flows.bToPool;
    console.error("[debug] flows", flows);
    console.error("[debug] payLo", payLo, "availLo", availLo, "match", payLo === availLo);
    console.error("[debug] payHi", payHi, "availHi", availHi, "match", payHi === availHi);
    console.error("[debug] sumLo", sumLo, "sumHi", sumHi);
  }

  // --- tamper modes (negatives) ---
  if (tamper === "overpay") {
    fills = fills.map((f, i) => (i === 0 ? { ...f, amountOut: f.amountOut + 10n * SCALE } : f));
  } else if (tamper === "underpay") {
    fills = fills.map((f, i) => (i === 0 ? { ...f, amountOut: f.amountOut - 1_000_000n } : f));
  } else if (tamper === "proportional") {
    fills = fills.map((f) => ({ ...f, amountOut: f.amountOut / 2n }));
  } else if (tamper === "twohop") {
    // Inject a 2-hop order + a fill referencing it (emitter would drop it; we force it).
    ordersForWitness = [
      { side: false, amount_in: 10n * SCALE, limit_price: 100n * SCALE,
        order_nonce: 99n, submitted_at_block: 1, owner: OWNER, path_len: 3, path: [TA, TB, 0x333n] },
    ];
    fills = [{ orderNonce: 99n, hop_index: 0, amountOut: 1n, pool_id: 0 }];
  }

  // order_acc = replay of c_i over the orders in witness array order.
  const cis = [];
  for (const o of ordersForWitness) {
    cis.push(await computeCi({
      owner: o.owner, side: o.side, amount_in: o.amount_in, limit_price: o.limit_price,
      order_nonce: o.order_nonce, submitted_at_block: o.submitted_at_block,
      path_len: o.path_len, path: o.path,
    }));
  }
  const orderAcc = (await replayOrderAcc(cis)).toBigInt();

  // Per-pool sqrtP/pairs/commitments aligned with perPoolClearings (padded to 3).
  const poolSqrtPBefore: bigint[] = [];
  const poolTokenPairs: Array<[bigint, bigint]> = [];
  const poolStateCommitments: bigint[] = [];
  for (let i = 0; i < MAX_ACTIVE_POOLS_PER_EPOCH; i++) {
    const slot = clearing.perPoolClearings[i];
    if (slot) {
      const st = pools.get(slot.pool_id)!;
      poolSqrtPBefore.push(st.currentSqrtPrice);
      poolTokenPairs.push([TA, TB]);
      poolStateCommitments.push(
        await computePoolStateCommitment(
          st.currentSqrtPrice, slot.bucketStatesBefore, slot.bucketDeltas, slot.bucketDeltas.length,
        ),
      );
    } else {
      poolSqrtPBefore.push(0n);
      poolTokenPairs.push([0n, 0n]);
      poolStateCommitments.push(0n);
    }
  }

  const witness = await buildClearingWitnessMultiPair({
    epoch: { order_acc: orderAcc, cancel_acc: 0n, order_count: ordersForWitness.length, cancel_count: 0 },
    orders: ordersForWitness.map((o) => ({
      side: o.side, amount_in: o.amount_in, limit_price: o.limit_price,
      order_nonce: o.order_nonce, submitted_at_block: o.submitted_at_block, owner: o.owner,
      path_len: o.path_len, path: o.path,
    })),
    cancellationIndices: [],
    perPoolClearings: clearing.perPoolClearings,
    fills,
    poolSqrtPBefore,
    poolTokenPairs,
    poolStateCommitments,
  });

  const here = dirname(fileURLToPath(import.meta.url));
  const tomlPath = join(here, "../../circuits/clearing/Prover.toml");
  writeFileSync(tomlPath, witness.proverToml);
  console.error(
    `[prove-settle] case=${caseName} tamper=${tamper ?? "none"} ` +
    `fills=${fills.length} order_acc=0x${orderAcc.toString(16)} -> wrote ${tomlPath}`,
  );
}

main().catch((e) => {
  console.error("[prove-settle] ERROR", e);
  process.exit(1);
});
