/**
 * Sub-4 Task F1: emit a minimal empty-clearing Prover.toml for the Sub-4
 * multi-pair circuit (circuits/clearing/src/main.nr).
 *
 * Uses buildHopFillsTree from aggregator/src/merkle.ts to compute the
 * canonical fills_root for 0 fills (64 empty leaf sentinels).
 *
 * The TOML field names EXACTLY match the fn main parameter list in main.nr:
 *   public:  order_acc, cancel_acc, order_count, cancel_count,
 *            fills_root, active_pool_count, active_pool_clearings[3]
 *   private: orders[32], cancelled_indices[32], fills[64], fills_len,
 *            fill_to_order_index[64], pool_bucket_states_before[3][4],
 *            pool_bucket_states_after[3][4], pool_sqrt_p_before[3],
 *            pool_token_pairs[3][2]
 */
import { writeFileSync } from "node:fs";
import { buildHopFillsTree } from "../aggregator/src/merkle.js";

const MAX_ORDERS = 32;
const MAX_FILLS = 64;      // 2 * MAX_ORDERS
const MAX_POOLS = 3;
const MAX_BUCKETS = 4;
const INVALID_POOL_ID = 0xffffffff;
const INVALID_BUCKET_ID = 0xffff;

async function main() {
  // 1. Compute fills_root for 0 fills (64 empty sentinels).
  const tree = await buildHopFillsTree([], MAX_FILLS);
  const fillsRoot = tree.root.toString();
  console.log("fills_root:", fillsRoot);

  const lines: string[] = [];

  // ===== Public inputs =====
  lines.push(`order_acc = "0x0"`);
  lines.push(`cancel_acc = "0x0"`);
  lines.push(`order_count = 0`);
  lines.push(`cancel_count = 0`);
  lines.push(`fills_root = "${fillsRoot}"`);
  lines.push(`active_pool_count = 0`);

  // active_pool_clearings[3] — all INVALID_POOL_ID sentinels.
  const sentinelBucketDelta =
    `{ bucket_id = ${INVALID_BUCKET_ID}, ` +
    `reserve_a_add = "0", reserve_a_sub = "0", ` +
    `reserve_b_add = "0", reserve_b_sub = "0", ` +
    `cum_fee_a_per_share_increment = "0", ` +
    `cum_fee_b_per_share_increment = "0" }`;

  // Build sentinel bucket deltas array string (inline, single line for TOML compatibility).
  const bucketDeltasInline =
    `[${Array(MAX_BUCKETS).fill(sentinelBucketDelta).join(", ")}]`;

  // Build the swap inline string.
  const swapInline =
    `{ a_to_pool = "0", b_to_pool = "0", a_from_pool = "0", b_from_pool = "0", ` +
    `current_sqrt_price_after = "0", active_bucket_count = 0, ` +
    `active_bucket_deltas = ${bucketDeltasInline} }`;

  lines.push(`active_pool_clearings = [`);
  for (let p = 0; p < MAX_POOLS; p++) {
    lines.push(
      `  { pool_id = ${INVALID_POOL_ID}, clearing_price = "0", swap = ${swapInline} },`,
    );
  }
  lines.push(`]`);

  // ===== Private witnesses =====

  // orders[32] — all zero-padded with path_len=2 (1-hop sentinel), path=[0,0,0].
  lines.push(`orders = [`);
  for (let i = 0; i < MAX_ORDERS; i++) {
    lines.push(
      `  { side = false, amount_in = "0", limit_price = "0", ` +
      `order_nonce = "0x0", submitted_at_block = 0, owner = "0x0", ` +
      `path_len = 2, path = ["0x0", "0x0", "0x0"] },`,
    );
  }
  lines.push(`]`);

  // cancelled_indices[32]
  lines.push(`cancelled_indices = [${Array(MAX_ORDERS).fill(0).join(", ")}]`);

  // fills[64] — Sub-4 FillLeaf has order_nonce, hop_index, amount_out, pool_id.
  lines.push(`fills = [`);
  for (let i = 0; i < MAX_FILLS; i++) {
    lines.push(
      `  { order_nonce = "0x0", hop_index = 0, amount_out = "0", pool_id = 0 },`,
    );
  }
  lines.push(`]`);

  lines.push(`fills_len = 0`);

  // fill_to_order_index[64]
  lines.push(`fill_to_order_index = [${Array(MAX_FILLS).fill(0).join(", ")}]`);

  // pool_bucket_states_before[3][4] — 2D array of BucketState.
  const sentinelBucketState =
    `{ reserve_a = "0", reserve_b = "0", liquidity = "0", ` +
    `cum_fee_a_per_share = "0", cum_fee_b_per_share = "0" }`;

  lines.push(`pool_bucket_states_before = [`);
  for (let p = 0; p < MAX_POOLS; p++) {
    lines.push(`  [`);
    for (let b = 0; b < MAX_BUCKETS; b++) {
      lines.push(`    ${sentinelBucketState},`);
    }
    lines.push(`  ],`);
  }
  lines.push(`]`);

  // pool_bucket_states_after[3][4]
  lines.push(`pool_bucket_states_after = [`);
  for (let p = 0; p < MAX_POOLS; p++) {
    lines.push(`  [`);
    for (let b = 0; b < MAX_BUCKETS; b++) {
      lines.push(`    ${sentinelBucketState},`);
    }
    lines.push(`  ],`);
  }
  lines.push(`]`);

  // pool_sqrt_p_before[3] — array of u128.
  lines.push(`pool_sqrt_p_before = [${Array(MAX_POOLS).fill('"0"').join(", ")}]`);

  // pool_token_pairs[3][2] — array of [Field; 2] pairs.
  lines.push(`pool_token_pairs = [`);
  for (let p = 0; p < MAX_POOLS; p++) {
    lines.push(`  ["0x0", "0x0"],`);
  }
  lines.push(`]`);

  const toml = lines.join("\n") + "\n";
  writeFileSync("circuits/clearing/Prover.toml", toml);
  console.log("wrote circuits/clearing/Prover.toml");
  console.log("\nFirst 30 lines:");
  console.log(lines.slice(0, 30).join("\n"));
}

main().catch((e) => { console.error(e); process.exit(1); });
