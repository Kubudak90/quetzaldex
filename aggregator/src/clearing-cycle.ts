/**
 * Sub-9.3: production clearing-cycle orchestration for the multi-pair orderbook.
 *
 * The Sub-2.5-era `runOneClearingCycle` in daemon.ts targets the SINGLE-POOL
 * shape and is kept around for backward-compat (legacy tests). Sub-4 / Sub-5a
 * deployed the multi-pair orderbook whose `close_epoch_and_clear_verified`
 * expects the ClearingPublic struct (active_pool_count + active_pools[3]). The
 * circuit at `circuits/clearing/src/main.nr` matches this multi-pair shape.
 *
 * `runOneClearingCycleMP` (this module) wires the production flow:
 *
 *   1. Read on-chain EpochState (full shape) + current L2 block via SDK.
 *   2. Drain the queue for this epoch_id; replay-validate against order_acc.
 *   3. Resolve each order's path to per-hop pool_ids (u128 canonical).
 *   4. Read per-pool state (reserves + sqrt_price + 16 buckets).
 *   5. Compute clearing via computeClearingMultiPair.
 *   6. Build Prover.toml via buildClearingWitnessMultiPair.
 *   7. Shell out to nargo execute + bb prove. Read proof.bin + vk.bin.
 *   8. Submit close_epoch_and_clear_verified via SDK.
 *   9. Snapshot fills tree to disk for the maker's `claim` step.
 *
 * Concurrency: a module-level mutex prevents two cycles running at once. If a
 * second tick fires while the first cycle is still in-flight, the second
 * returns immediately (the first will pick up the next iteration).
 *
 * Error policy: per-cycle errors are caught and logged. The watcher keeps
 * polling; on the next epoch the cycle is re-attempted with fresh state.
 *
 * Operational notes:
 *   - This module shells out to `nargo` + `bb`. They MUST be on PATH (the
 *     production image uses `aztecprotocol/aztec:4.2.1` as runtime base which
 *     bakes both in).
 *   - The clearing circuit's vk_hash MUST match the on-chain orderbook's
 *     `clearing_vk_hash` storage. Deploy script pins this; aggregator reads
 *     it from `circuits/clearing/target/vk.bin/vk` at runtime.
 *   - bb prove is slow (~30-60s on a warm L2 host). The watcher polls every
 *     15s; we set a per-cycle deadline well above the worst-case prove time.
 */

import { spawn } from "node:child_process";
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { Fr } from "@aztec/aztec.js/fields";

import type { RevealQueue, RevealPayload } from "./queue.js";
import { validateReveals } from "./validate.js";
import {
  computeClearingMultiPair,
  computePoolStateCommitment,
  deriveAggregateFlows,
  type ClearingOrderMultiPair,
  type PoolStateForRouting,
} from "./clearing.js";
import {
  buildClearingWitnessMultiPair,
  MAX_ACTIVE_POOLS_PER_EPOCH,
  INVALID_POOL_ID,
} from "./witness.js";
import { buildHopFillsTree } from "./merkle.js";
import { writeHopSnapshot } from "./snapshot.js";
import type { PoolRegistry, PoolRegistryEntry } from "./path.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Sub-9.3: full ClearingPublic struct shape, matches contracts/orderbook ClearingPublic. */
export interface ClearingPublicStruct {
  order_acc: string | bigint;   // Fr
  cancel_acc: string | bigint;  // Fr
  order_count: number;
  cancel_count: number;
  fills_root: string;           // 0x-prefixed Fr hex
  active_pool_count: number;
  active_pools: Array<{
    pool_id: number;
    clearing_price: bigint;
    /** Audit #3: canonical token pair (u128-truncated lo/hi) bound into the proof. */
    token_lo: bigint;
    token_hi: bigint;
    swap: {
      a_to_pool: bigint;
      b_to_pool: bigint;
      a_from_pool: bigint;
      b_from_pool: bigint;
      active_bucket_deltas: Array<{
        bucket_id: number;
        reserve_a_add: bigint;
        reserve_a_sub: bigint;
        reserve_b_add: bigint;
        reserve_b_sub: bigint;
        cum_fee_a_per_share_increment: bigint;
        cum_fee_b_per_share_increment: bigint;
      }>;
      active_bucket_count: number;
      current_sqrt_price_after: bigint;
      /** Audit #1: Poseidon2 commitment over the pool's before-state (25 inputs). */
      pool_state_commitment: bigint;
    };
  }>;
}

/**
 * Aggregator-side context for the multi-pair clearing loop. Callbacks
 * abstract the on-chain reads / submit so the orchestrator stays testable.
 */
export interface DaemonContextMP {
  queue: RevealQueue;
  snapshotsDir: string;
  registry: PoolRegistry;

  /** Read full orderbook epoch state. */
  getEpoch(): Promise<{
    epoch_id: number;
    closes_at_block: number;
    order_acc: Fr;
    order_count: number;
    cancel_acc: Fr;
    cancel_count: number;
  }>;
  /** Current L2 block. */
  getBlockNumber(): Promise<number>;
  /** Read one pool's state (incl. bucket states). poolId is the pool_id from registry. */
  getPoolState(poolId: number): Promise<PoolStateForRouting>;
  /** Submit close_epoch_and_clear_verified(publicInputs, proof, vk). */
  submitClearing(args: {
    publicInputs: ClearingPublicStruct;
    proof: Fr[];
    vk: Fr[];
  }): Promise<{ txHash?: string }>;
  /** Sub-9.3: plain close_epoch() fallback for empty/no-cross epochs.
   * Advances the epoch without applying clearing; orders carry forward. */
  submitCloseEpochOnly?: () => Promise<{ txHash?: string }>;
  /** Fee-juice balance of the daemon's fee payer (atomic units), or null if
   * unreadable. Used as a pre-flight gate so a broke wallet doesn't consume
   * reveals it cannot settle. */
  getFeePayerBalance?: () => Promise<bigint | null>;

  /** Circuit project dir (default: circuits/clearing). */
  circuitDir?: string;
  /** nargo binary path (default: nargo). */
  nargoBin?: string;
  /** bb binary path (default: bb). */
  bbBin?: string;
  /** Per-prove deadline ms (default: 180_000). */
  proveDeadlineMs?: number;
  /** Stream subprocess stderr to console (default: true). */
  verbose?: boolean;
}

// ---------------------------------------------------------------------------
// Concurrency guard
// ---------------------------------------------------------------------------
let CYCLE_IN_FLIGHT = false;
export function isCycleInFlight(): boolean { return CYCLE_IN_FLIGHT; }

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const HONK_PROOF_FIELDS = 458; // v5 bb ZK UltraHonk proof size (was 500 on 4.3)
const HONK_VK_FIELDS = 115;
// Audit #1: the orderbook verify now consumes the FULL bb `-t noir-recursive`
// shapes (proof = 458 fields, vk = 115 fields). These equal HONK_*_FIELDS, so the
// bridge fns below are pass-through. The previous 456/127 truncation CORRUPTED the
// proof + vk (dropping 44 proof + adding 12 zero vk fields), guaranteeing verify
// failure -- one reason the verified clearing path was never exercised.
const CONTRACT_PROOF_SIZE = 458; // v5 bb ZK UltraHonk proof size (was 500 on 4.3)
const CONTRACT_VK_SIZE = 115;
const U128_MASK = (1n << 128n) - 1n;

function bridgeProof(buf: Buffer): Fr[] {
  if (buf.length % 32 !== 0) {
    throw new Error(`proof buffer length ${buf.length} is not a multiple of 32 — malformed bb output`);
  }
  const numFields = buf.length / 32;
  if (numFields !== CONTRACT_PROOF_SIZE) {
    throw new Error(`proof has ${numFields} fields, expected ${CONTRACT_PROOF_SIZE} — bb output shape drift`);
  }
  const fields: Fr[] = [];
  for (let i = 0; i < numFields; i++) {
    fields.push(Fr.fromBuffer(buf.subarray(i * 32, (i + 1) * 32)));
  }
  return fields;
}
function bridgeVk(buf: Buffer): Fr[] {
  if (buf.length % 32 !== 0) {
    throw new Error(`vk buffer length ${buf.length} is not a multiple of 32 — malformed bb output`);
  }
  const numFields = buf.length / 32;
  if (numFields !== CONTRACT_VK_SIZE) {
    throw new Error(`vk has ${numFields} fields, expected ${CONTRACT_VK_SIZE} — bb output shape drift`);
  }
  const fields: Fr[] = [];
  for (let i = 0; i < numFields; i++) {
    fields.push(Fr.fromBuffer(buf.subarray(i * 32, (i + 1) * 32)));
  }
  return fields;
}

// ---------------------------------------------------------------------------
// Subprocess helpers
// ---------------------------------------------------------------------------
interface ProcResult { code: number; stdout: string; stderr: string; }
function runProc(
  cmd: string,
  args: string[],
  opts: { cwd?: string; deadlineMs?: number; verbose?: boolean } = {},
): Promise<ProcResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, env: process.env });
    let stdout = ""; let stderr = "";
    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString();
      if (opts.verbose) process.stdout.write(d);
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
      if (opts.verbose) process.stderr.write(d);
    });
    const timer = opts.deadlineMs
      ? setTimeout(() => {
          child.kill("SIGKILL");
          reject(new Error(`subprocess timed out after ${opts.deadlineMs}ms: ${cmd} ${args.join(" ")}`));
        }, opts.deadlineMs)
      : null;
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
  });
}

// ---------------------------------------------------------------------------
// Pool registry construction
// ---------------------------------------------------------------------------

/**
 * Build a u128-canonical pool registry from quetzal.config pool entries.
 *
 * The on-chain orderbook stores `pool_token_a/b` in u128-canonical order
 * (Sub-9.1 P3 fix). The aggregator's path resolver MUST mirror this; otherwise
 * `resolvePoolId` would not find the registry entry for any order whose path
 * disagrees with full-bigint canonical (which is the case for the Sub-9
 * tUSDC/tETH pair).
 */
export function buildU128PoolRegistry(
  configPools: Array<{ pool_id: number; token_a: string; token_b: string; address: string }>,
): PoolRegistry {
  return configPools.map((p): PoolRegistryEntry => {
    const aFull = BigInt(p.token_a);
    const bFull = BigInt(p.token_b);
    const a = aFull & U128_MASK;
    const b = bFull & U128_MASK;
    // Order both the truncated (resolution) and the full (proof-bound token_lo/hi +
    // pool_token_pairs) by the SAME u128 key, matching the contract's
    // `(token.to_field() as u128) <` ordering with FULL field values.
    const [lo, hi, loFull, hiFull] =
      a < b ? [a, b, aFull, bFull] : [b, a, bFull, aFull];
    return { pool_id: p.pool_id, token_a: lo, token_b: hi, token_a_full: loFull, token_b_full: hiFull };
  });
}

/** u128-canonical resolvePoolId, used by the witness builder helpers. */
export function resolvePoolIdU128(reg: PoolRegistry, a: bigint, b: bigint): number {
  const am = a & U128_MASK;
  const bm = b & U128_MASK;
  const [lo, hi] = am < bm ? [am, bm] : [bm, am];
  for (const p of reg) {
    if (p.token_a === lo && p.token_b === hi) return p.pool_id;
  }
  return -1;
}

// ---------------------------------------------------------------------------
// Multi-pool order/path selection (genuine multi-pool clearing)
// ---------------------------------------------------------------------------

/**
 * Per-order routing info derived from a validated reveal's real path.
 *
 * `path` carries the FULL field tokens (used for the order's c_i binding +
 * the witness's pool_token_pairs). `routingPath` carries the SAME tokens
 * u128-TRUNCATED, which is what `computeClearingMultiPair` (via path.ts
 * `resolvePoolId`) must compare against the u128-canonical registry. Both are
 * derived from the SAME source (the reveal's path or the pool-0 fallback);
 * there is no second source of truth.
 */
export interface RoutedRevealPath {
  path_len: 2 | 3;
  /** FULL field tokens — fed to orderPreimages (c_i) and pool_token_pairs. */
  path: [bigint, bigint, bigint];
  /** u128-truncated tokens — fed to computeClearingMultiPair for resolution. */
  routingPath: [bigint, bigint, bigint];
  /** Resolved pool_ids for each hop (length == path_len - 1). */
  hops: number[];
  /** True when the reveal omitted an explicit path and the pool-0 fallback applied. */
  usedFallback: boolean;
}

/**
 * Resolve a validated reveal's real path into per-hop pool_ids, using the
 * u128-canonical registry. Preserves the pool-0 1-hop back-compat fallback for
 * reveals that genuinely omitted their path (path[0]==0 && path[1]==0).
 *
 * Throws a clear error if a non-fallback path doesn't resolve to a registered
 * pool — this is the condition that previously detonated the circuit's
 * `assert(pool_slot != INVALID_POOL_ID)` at runtime.
 */
export function resolveRevealPath(
  reg: PoolRegistry,
  reveal: { path_len: number; path: [bigint, bigint, bigint] },
  fallbackPath: [bigint, bigint, bigint],
): RoutedRevealPath {
  const omitted = reveal.path[0] === 0n && reveal.path[1] === 0n;
  const path: [bigint, bigint, bigint] = omitted
    ? [fallbackPath[0], fallbackPath[1], fallbackPath[2]]
    : [reveal.path[0], reveal.path[1], reveal.path[2]];
  const path_len: 2 | 3 = omitted ? 2 : (reveal.path_len === 3 ? 3 : 2);

  const routingPath: [bigint, bigint, bigint] = [
    path[0] & U128_MASK,
    path[1] & U128_MASK,
    path[2] & U128_MASK,
  ];

  // Resolve each hop. 1-hop => (path[0],path[1]); 2-hop => add (path[1],path[2]).
  const hopCount = path_len - 1;
  const hops: number[] = [];
  for (let i = 0; i < hopCount; i++) {
    const pid = resolvePoolIdU128(reg, path[i]!, path[i + 1]!);
    if (pid < 0) {
      throw new Error(
        `reveal path hop ${i} does not resolve to a registered pool: ` +
        `0x${(path[i] ?? 0n).toString(16)} -> 0x${(path[i + 1] ?? 0n).toString(16)} ` +
        `(path_len=${path_len}); registry has pool_ids [${reg.map((p) => p.pool_id).join(",")}]`,
      );
    }
    hops.push(pid);
  }

  return { path_len, path, routingPath, hops, usedFallback: omitted };
}

// ---------------------------------------------------------------------------
// Logging facade
// ---------------------------------------------------------------------------
type LogLevel = "info" | "warn" | "error" | "debug";
export type LogFn = (level: LogLevel, msg: string, extra?: Record<string, unknown>) => void;
const DEFAULT_LOG: LogFn = (level, msg, extra) => {
  const line = { ts: new Date().toISOString(), level, msg, ...(extra ?? {}) };
  if (level === "error") console.error(JSON.stringify(line));
  else console.log(JSON.stringify(line));
};

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

/**
 * Single-shot multi-pair clearing cycle. Idempotent: if the queue is empty,
 * or the epoch hasn't closed, or another cycle is in flight, it returns early.
 *
 * Returns a short status string for the watcher's log line.
 */
export async function runOneClearingCycleMP(
  ctx: DaemonContextMP,
  log: LogFn = DEFAULT_LOG,
): Promise<string> {
  if (CYCLE_IN_FLIGHT) return "skipped:in-flight";
  CYCLE_IN_FLIGHT = true;
  // M2: reveals are drained destructively; if anything after the drain throws
  // (nargo/bb/snapshot/submit), re-enqueue them so the epoch's orders aren't lost.
  let drainedReveals: RevealPayload[] = [];
  try {
    const blockNow = await ctx.getBlockNumber();
    const epoch = await ctx.getEpoch();

    if (blockNow < epoch.closes_at_block) {
      return `skipped:not-closed(block=${blockNow}<closes=${epoch.closes_at_block})`;
    }

    if (epoch.order_count === 0 && ctx.queue.size() === 0) {
      // Empty epoch — could submit empty-clearing to advance, but for MVP we
      // skip and let the next non-empty cycle handle it.
      return "skipped:empty-epoch";
    }

    // H2: the witness build hardcodes cancellationIndices: [] while feeding the
    // real on-chain cancel_count, so the clearing circuit's cancel_acc replay
    // ALWAYS mismatches when cancel_count > 0 — every nargo execute would fail.
    // Because draining below is destructive, we MUST bail before it so the epoch's
    // reveals survive (they'd otherwise be lost to a guaranteed failure). Skipping
    // here means a cancel-bearing epoch does not clear until cancel-index collection
    // is implemented (threaded into buildClearingWitnessMultiPair + used to filter
    // cancelled orders out of clearingOrders) — a tracked follow-up.
    if (epoch.cancel_count > 0) {
      log("warn", "epoch has cancels but cancel-index collection is unimplemented — skipping (reveals preserved)", {
        epoch_id: epoch.epoch_id,
        cancel_count: epoch.cancel_count,
      });
      return "skipped:cancels-unsupported";
    }

    // Pre-flight fee check (2026-06-10): draining is destructive — if the
    // settle tx later fails "Not enough balance for fee payer", the reveals
    // are already consumed and the epoch's orders strand (observed live,
    // epoch 53: repair+proof succeeded, settle died on fee balance). Leave
    // the reveals QUEUED instead; auto-roll won't touch a non-empty queue,
    // so the cycle simply retries next tick until the top-up cron refunds.
    if (ctx.getFeePayerBalance) {
      const minBalance = BigInt(process.env.CLEAR_MIN_FEE_JUICE ?? "100000000000000000000");
      try {
        const bal = await ctx.getFeePayerBalance();
        if (bal !== null && bal < minBalance) {
          log("warn", "fee payer below clear threshold — leaving reveals queued for retry", {
            balance_fj: (Number(bal) / 1e18).toFixed(2),
            min_fj: (Number(minBalance) / 1e18).toFixed(2),
          });
          return "skipped:low-fee-balance";
        }
      } catch { /* balance read failed — proceed; the send surfaces fee errors */ }
    }

    const reveals = ctx.queue.drainEpoch(epoch.epoch_id);
    drainedReveals = reveals; // M2: remember for re-enqueue on a post-drain throw
    log("info", "draining reveals", { count: reveals.length, epoch_id: epoch.epoch_id });

    if (reveals.length === 0 && epoch.order_count > 0) {
      log("warn", "epoch has orders but no reveals in queue — skipping (other aggregator may win)");
      return "skipped:no-reveals";
    }

    let validated = await validateReveals(reveals, epoch.order_acc);
    if (validated.length === 0 && epoch.order_count > 0) {
      // Self-heal (2026-06-10): reveal anchors drift when the SDK can't read
      // the OrderNote (testnet reorgs stall PXE note discovery) and falls back
      // to the mined block. Search small per-reveal corrections and accept
      // ONLY a combination the on-chain order_acc confirms.
      const { repairReveals } = await import("./validate.js");
      const repaired = await repairReveals(reveals, epoch.order_acc);
      if (repaired) {
        log("warn", "order_acc replay repaired — reveal anchor drift corrected", {
          corrections: repaired.corrections,
          reveals_in_queue: reveals.length,
        });
        validated = repaired.validated;
      }
    }
    if (validated.length === 0 && epoch.order_count > 0) {
      // Diagnostic: replay independently to surface the mismatched acc.
      const { computeCi, replayOrderAcc } = await import("./validate.js");
      const cis = [];
      for (const r of reveals) {
        try {
          // Audit #2: c_i binds path; default to a direct 1-hop path when the
          // reveal omits it (mirrors validate.ts::validateReveals).
          const rawPath = (r.path ?? ["0x0", "0x0", "0x0"]).map((s) => BigInt(s));
          cis.push(await computeCi({
            owner: BigInt(r.owner),
            side: r.side,
            amount_in: BigInt(r.amount_in),
            limit_price: BigInt(r.limit_price),
            order_nonce: BigInt(r.order_nonce),
            submitted_at_block: r.submitted_at_block,
            path_len: r.path_len ?? 2,
            path: [rawPath[0] ?? 0n, rawPath[1] ?? 0n, rawPath[2] ?? 0n],
          }));
        } catch { /* ignore parse */ }
      }
      const replayed = cis.length > 0 ? (await replayOrderAcc(cis)).toString() : "(empty)";
      log("warn", "order_acc replay mismatch — reveals tampered or incomplete", {
        on_chain_order_acc: epoch.order_acc.toString(),
        on_chain_order_count: epoch.order_count,
        replayed_order_acc: replayed,
        reveals_in_queue: reveals.length,
      });
      return "skipped:replay-mismatch";
    }
    log("info", "reveals validated", { count: validated.length });

    // Build per-order multi-pair shape using each reveal's REAL path/pool(s).
    //
    // Genuine multi-pool clearing: every order is routed through the pool(s) its
    // own path resolves to, not a hardcoded pool 0. The validated reveal carries
    // the real path (v.path, full field tokens) + path_len (2=1-hop, 3=2-hop).
    // `resolveRevealPath` resolves each hop to a pool_id via the u128-canonical
    // registry and preserves the pool-0 1-hop back-compat fallback ONLY when a
    // reveal genuinely omitted its path (path == [0,0,0]).
    //
    // computeClearingMultiPair resolves pools via path.ts::resolvePoolId, which
    // compares against the u128-TRUNCATED registry. The full-field path tokens
    // therefore must be truncated for routing (routingPath); the FULL tokens are
    // kept for the order's c_i binding + the witness's pool_token_pairs. Both
    // derive from the SAME source — no second source of truth.
    const POOL_USDC_ETH = ctx.registry.find((p) => p.pool_id === 0);
    if (!POOL_USDC_ETH) throw new Error("registry missing pool_id=0");
    // Fallback path is full-field (token_a_full/token_b_full) so omitted-path
    // reveals still bind their c_i against the canonical pool-0 direct route.
    const pathTokens: [bigint, bigint, bigint] = [
      POOL_USDC_ETH.token_a_full ?? POOL_USDC_ETH.token_a,
      POOL_USDC_ETH.token_b_full ?? POOL_USDC_ETH.token_b,
      0n,
    ];

    const routed = validated.map((v) =>
      resolveRevealPath(ctx.registry, { path_len: v.path_len, path: v.path }, pathTokens),
    );

    const clearingOrders: ClearingOrderMultiPair[] = validated.map((v, i) => ({
      side: v.side,
      amountIn: v.amount_in,
      limitPrice: v.limit_price,
      submittedAtBlock: v.submitted_at_block,
      orderNonce: v.order_nonce.toBigInt(),
      owner: v.owner.toBigInt(), // R1: thread owner into the hop-fill leaf
      path_len: routed[i]!.path_len,
      // Feed the u128-truncated tokens so computeClearingMultiPair's
      // resolvePoolId matches the u128-canonical registry.
      path: routed[i]!.routingPath,
    }));

    // Determine active pool set by resolving each order's real path to pool_id(s).
    const activePoolIds = new Set<number>();
    for (const r of routed) {
      for (const pid of r.hops) activePoolIds.add(pid);
    }

    // Read per-pool state for ALL active pools.
    const poolStateMap = new Map<number, PoolStateForRouting>();
    for (const pid of activePoolIds) {
      const ps = await ctx.getPoolState(pid);
      poolStateMap.set(pid, ps);
    }
    log("info", "pool states read", {
      pool_count: poolStateMap.size,
      active_pool_ids: Array.from(activePoolIds).sort((a, b) => a - b),
    });

    // Compute clearing.
    const clearing = computeClearingMultiPair({
      orders: clearingOrders,
      pools: poolStateMap,
      registry: ctx.registry,
    });

    if (!clearing.cleared) {
      log("info", "clearing did not cross (no eligible orders / no liquidity)");
      // Sub-9.3: fallback — call plain close_epoch() if available to advance the
      // epoch without applying clearing.
      //
      // Audit #5 (corrected): orders do NOT auto-carry-forward. close_epoch()
      // zeroes the on-chain order_acc/order_count, so a resting OrderNote is
      // orphaned from the NEW epoch's clearing set — it will never be picked up
      // by a future close_epoch_and_clear_verified (which asserts
      // order_acc == current). The maker's escrow is NOT lost (cancel_order is
      // independent of order_acc and works in any open epoch), but to trade
      // again the maker must cancel_order + re-submit_order. True auto-requeue
      // would require a contract change (carry order_acc/count forward) and is
      // tracked as a protocol follow-up. Skip if no fallback wired OR queue empty.
      if (ctx.submitCloseEpochOnly && reveals.length > 0) {
        try {
          log("info", "calling plain close_epoch() to advance");
          const r = await ctx.submitCloseEpochOnly();
          log("info", "close_epoch() submitted", { txHash: r.txHash });
          return "no-cross:advanced";
        } catch (e) {
          log("error", "close_epoch() submit failed", {
            error: e instanceof Error ? e.message : String(e),
          });
          return "no-cross:advance-failed";
        }
      }
      return "skipped:no-cross";
    }
    log("info", "clearing computed", {
      active_pool_count: clearing.activePoolCount,
      fills: clearing.fills.length,
    });

    // The circuit indexes active pools by SLOT, not by global pool id — see
    // remapFillPoolIdsToSlots. Do it here, upstream of the witness, the fills
    // Merkle leaves and the hop snapshot, so all three agree with the circuit.
    remapFillPoolIdsToSlots(clearing.fills, clearing.perPoolClearings)

    // Build the witness Prover.toml.
    const orderPreimages = validated.map((v) => ({
      side: v.side,
      amount_in: v.amount_in,
      limit_price: v.limit_price,
      order_nonce: v.order_nonce.toBigInt(),
      submitted_at_block: v.submitted_at_block,
      owner: v.owner.toBigInt(),
      // Audit #2: the circuit recomputes c_i over path; feed the SAME path the
      // contract bound. ValidatedReveal now carries the real path_len/path; fall
      // back to the MVP pool-0 1-hop path only when the reveal omitted them.
      path_len: v.path_len ?? 2,
      path: (v.path_len ?? 2) >= 2 && (v.path[0] !== 0n || v.path[1] !== 0n)
        ? [v.path[0], v.path[1], v.path[2]]
        : [pathTokens[0], pathTokens[1], pathTokens[2]],
    }));

    // Audit #11: surface fallback use loudly. A reveal whose path is [0,0,0]
    // omitted an explicit route, so we recomputed its c_i against the pool-0
    // direct path. That is correct ONLY for pool-0 1-hop orders; any multi-hop or
    // non-pool-0 reveal will fail the on-chain c_i / order_acc replay. Producers
    // (SDK/CLI/smoke) should forward path_len + path[] to remove this fallback.
    const revealsMissingPath = validated.filter(
      (v) => v.path[0] === 0n && v.path[1] === 0n,
    ).length;
    if (revealsMissingPath > 0) {
      log("warn", "reveal(s) lacked an explicit routing path; using pool-0 direct fallback", {
        revealsMissingPath,
        total: validated.length,
        note: "correct only for pool-0 1-hop; multi-hop reveals will fail c_i replay",
      });
    }

    // Per-pool sqrt prices, token pairs, and state commitments BEFORE clearing.
    // Index i corresponds to clearing.perPoolClearings[i] (already sorted by pool_id).
    // Commitments are computed ONCE here and reused for both the witness Prover.toml
    // and the calldata ClearingPublicStruct (byte-identical by construction).
    const poolSqrtPBefore: bigint[] = [];
    const poolTokenPairs: Array<[bigint, bigint]> = [];
    const poolStateCommitments: bigint[] = [];
    for (let i = 0; i < MAX_ACTIVE_POOLS_PER_EPOCH; i++) {
      const slot = clearing.perPoolClearings[i];
      if (slot) {
        const st = poolStateMap.get(slot.pool_id);
        const sqrtP = st?.currentSqrtPrice ?? 0n;
        poolSqrtPBefore.push(sqrtP);
        const regEntry = ctx.registry.find((p) => p.pool_id === slot.pool_id);
        // FULL field addresses (u128-ordered) — the circuit compares the order's full
        // path tokens against pool_token_pairs and binds token_lo/hi to it; the
        // truncated registry fields are for path resolution only.
        poolTokenPairs.push(
          regEntry
            ? [regEntry.token_a_full ?? regEntry.token_a, regEntry.token_b_full ?? regEntry.token_b]
            : [0n, 0n],
        );
        // Audit #1: compute commitment once; reuse in both witness and calldata.
        // bucket_states_before[i] is index-aligned with bucket_deltas[i]: both
        // reference the same bucket (confirmed by computeClearingV2 which builds
        // them in tandem from the same traceBucketSwap output).
        const commitment = await computePoolStateCommitment(
          sqrtP,
          slot.bucketStatesBefore,
          slot.bucketDeltas,
          slot.bucketDeltas.length,
        );
        poolStateCommitments.push(commitment);
      } else {
        poolSqrtPBefore.push(0n);
        poolTokenPairs.push([0n, 0n]);
        poolStateCommitments.push(0n);
      }
    }

    const witness = await buildClearingWitnessMultiPair({
      epoch: {
        order_acc: epoch.order_acc.toBigInt(),
        cancel_acc: epoch.cancel_acc.toBigInt(),
        order_count: epoch.order_count,
        cancel_count: epoch.cancel_count,
      },
      orders: orderPreimages,
      cancellationIndices: [],
      perPoolClearings: clearing.perPoolClearings,
      fills: clearing.fills,
      poolSqrtPBefore,
      poolTokenPairs,
      poolStateCommitments,
    });

    // Write Prover.toml.
    const circuitDir = ctx.circuitDir ?? "circuits/clearing";
    const proverTomlPath = join(circuitDir, "Prover.toml");
    writeFileSync(proverTomlPath, witness.proverToml);
    log("info", "Prover.toml written", { path: proverTomlPath });

    // Shell out: nargo execute → produces target/clearing.gz + public_inputs.
    const nargo = ctx.nargoBin ?? "nargo";
    const bb = ctx.bbBin ?? "bb";
    const deadline = ctx.proveDeadlineMs ?? 180_000;
    const verbose = ctx.verbose ?? true;

    log("info", "running nargo execute");
    const nargoR = await runProc(nargo, ["execute", "clearing"], {
      cwd: circuitDir,
      deadlineMs: deadline,
      verbose,
    });
    if (nargoR.code !== 0) {
      throw new Error(`nargo execute failed code=${nargoR.code}: ${nargoR.stderr.slice(-500)}`);
    }
    log("info", "nargo execute OK");

    log("info", "running bb prove");
    // bb prove uses the witness from nargo execute. Output dir = target/proofdir.
    const bbR = await runProc(bb, [
      "prove",
      "-b", "target/clearing.json",
      "-w", "target/clearing.gz",
      // Audit #1: vk must exist first (compile-all.sh `bb write_vk -t noir-recursive`
      // wrote target/vk.bin/vk). `-t noir-recursive` makes a ZK-UltraHonk proof of
      // 500 fields plus a separate public_inputs file; the orderbook verifies it with
      // proof_type 6 against the calldata public inputs. Replaces `--oracle_hash
      // poseidon2` (not a flag in bb 4.x; it produced an unbindable proof shape).
      "-k", "target/vk.bin/vk",
      "-o", "target/proofdir",
      "-t", "noir-recursive",
    ], {
      cwd: circuitDir,
      deadlineMs: deadline,
      verbose,
    });
    if (bbR.code !== 0) {
      throw new Error(`bb prove failed code=${bbR.code}: ${bbR.stderr.slice(-500)}`);
    }
    log("info", "bb prove OK");

    // Read proof + vk from disk.
    const proofPath = join(circuitDir, "target/proofdir/proof");
    const vkPath = join(circuitDir, "target/vk.bin/vk");
    if (!existsSync(proofPath)) throw new Error(`proof not found at ${proofPath}`);
    if (!existsSync(vkPath)) throw new Error(`vk not found at ${vkPath}`);
    const proofBuf = readFileSync(proofPath);
    const vkBuf = readFileSync(vkPath);
    void HONK_PROOF_FIELDS; void HONK_VK_FIELDS;  // documentation references
    const proofFields = bridgeProof(proofBuf);
    const vkFields = bridgeVk(vkBuf);

    // Build the public_inputs struct that matches the on-chain ClearingPublic.
    const padBucketDelta = () => ({
      bucket_id: 0xffff,
      reserve_a_add: 0n, reserve_a_sub: 0n,
      reserve_b_add: 0n, reserve_b_sub: 0n,
      cum_fee_a_per_share_increment: 0n,
      cum_fee_b_per_share_increment: 0n,
    });
    const SENTINEL_POOL = {
      pool_id: INVALID_POOL_ID,
      clearing_price: 0n,
      // Audit #3: sentinel pools carry zero token pair (no active pool).
      token_lo: 0n,
      token_hi: 0n,
      swap: {
        a_to_pool: 0n, b_to_pool: 0n,
        a_from_pool: 0n, b_from_pool: 0n,
        active_bucket_deltas: [padBucketDelta(), padBucketDelta(), padBucketDelta(), padBucketDelta()],
        active_bucket_count: 0,
        current_sqrt_price_after: 0n,
        // Audit #1: sentinel pools carry zero commitment (hash of [0;25] is non-zero,
        // but the contract only checks active pools; sentinel 0n matches the Noir
        // `if (p as u32) < active_pool_count` guard which skips sentinel slots).
        pool_state_commitment: 0n,
      },
    };
    const sortedPools = clearing.perPoolClearings.slice().sort((a, b) => a.pool_id - b.pool_id);
    const active_pools = [];
    for (let i = 0; i < MAX_ACTIVE_POOLS_PER_EPOCH; i++) {
      const pc = sortedPools[i];
      if (!pc) { active_pools.push(SENTINEL_POOL); continue; }
      const deltas = pc.bucketDeltas.slice();
      while (deltas.length < 4) deltas.push({
        bucket_id: 0xffff,
        reserve_a_add: 0n, reserve_a_sub: 0n,
        reserve_b_add: 0n, reserve_b_sub: 0n,
        cum_fee_a_per_share_increment: 0n,
        cum_fee_b_per_share_increment: 0n,
      });
      // M17: gross to_pool -- before-liquidity is index-aligned with bucketDeltas
      // (same alignment the pool_state_commitment relies on).
      const { aToPool, bToPool, aFromPool, bFromPool } = deriveAggregateFlows(
        pc.bucketDeltas,
        (pc.bucketStatesBefore ?? []).map((s) => s.liquidity),
      );
      // Audit #3: token pair from registry (u128-canonical lo/hi).
      // poolTokenPairs[i] was built from the same perPoolClearings[i] (sorted);
      // since sortedPools is the same order, index i is the same pool.
      const tokenLo = poolTokenPairs[i]?.[0] ?? 0n;
      const tokenHi = poolTokenPairs[i]?.[1] ?? 0n;
      // Audit #1: reuse pre-computed commitment (computed once above, same data).
      const poolCommitment = poolStateCommitments[i] ?? 0n;
      active_pools.push({
        pool_id: pc.pool_id,
        clearing_price: pc.clearingPrice,
        // Audit #3: proof-bound canonical token pair.
        token_lo: tokenLo,
        token_hi: tokenHi,
        swap: {
          a_to_pool: aToPool,
          b_to_pool: bToPool,
          a_from_pool: aFromPool,
          b_from_pool: bFromPool,
          active_bucket_deltas: deltas,
          active_bucket_count: pc.bucketDeltas.length,
          current_sqrt_price_after: pc.currentSqrtPriceAfter,
          // Audit #1: proof-bound commitment to the pool's before-state.
          pool_state_commitment: poolCommitment,
        },
      });
    }

    // Build fills tree (Sub-4 64-leaf hop-fill tree).
    const tree = await buildHopFillsTree(
      clearing.fills.map((f) => ({
        owner: new Fr(f.owner), // R1: owner-bound leaf
        order_nonce: new Fr(f.orderNonce),
        hop_index: f.hop_index,
        amount_out: f.amountOut,
        pool_id: f.pool_id,
      })),
      64,
    );

    const publicInputs: ClearingPublicStruct = {
      order_acc: epoch.order_acc.toString(),
      cancel_acc: epoch.cancel_acc.toString(),
      order_count: epoch.order_count,
      cancel_count: epoch.cancel_count,
      fills_root: tree.root.toString(),
      active_pool_count: clearing.activePoolCount,
      active_pools,
    };

    // Persist the hop-fill snapshot the maker's claim_fill needs: the 4 leaf-preimage
    // fields + leaf_index + the depth-6 sibling path, from the SAME tree whose root
    // (line above) was committed on-chain. leaf_index = the fill's array position i
    // (matches the circuit's leaves[i] indexing). hop_paths keyed `${nonce}:${hop}`.
    try {
      writeHopSnapshot(ctx.snapshotsDir, {
        epoch_id: epoch.epoch_id,
        fills_root: tree.root.toString(),
        hop_fills: clearing.fills.map((f, i) => ({
          order_nonce: new Fr(f.orderNonce).toString(),
          hop_index: f.hop_index,
          amount_out: f.amountOut.toString(),
          pool_id: f.pool_id,
          leaf_index: i,
        })),
        paths: tree.paths,
      });
      log("info", "hop snapshot written", {
        dir: ctx.snapshotsDir,
        epoch: epoch.epoch_id,
        fills: clearing.fills.length,
      });
    } catch (e) {
      // M4: if the maker's claim data (hop snapshot) can't be persisted, do NOT
      // submit — an on-chain fills_root with no snapshot leaves makers unable to
      // build their claim_fill proofs. Abort; the outer catch re-enqueues the
      // reveals (M2) so the cycle retries next tick.
      log("error", "snapshot write failed — aborting clearing submit", { error: String(e) });
      throw e;
    }

    // Submit.
    log("info", "submitting close_epoch_and_clear_verified", {
      proof_fields: proofFields.length,
      vk_fields: vkFields.length,
      fills_count: clearing.fills.length,
    });
    const submitR = await ctx.submitClearing({ publicInputs, proof: proofFields, vk: vkFields });
    log("info", "close_epoch_and_clear_verified submitted", { txHash: submitR.txHash });

    return `cleared:fills=${clearing.fills.length}`;
  } catch (e) {
    // M2: a transient failure AFTER the destructive drain (nargo/bb/snapshot/submit)
    // must not strand the epoch's orders. Re-enqueue so the next tick retries; enqueue
    // is first-write-wins, so this is idempotent even if new reveals arrived meanwhile.
    for (const r of drainedReveals) ctx.queue.enqueue(r);
    throw e;
  } finally {
    CYCLE_IN_FLIGHT = false;
  }
}

// Re-exports for tests + watcher.
export { dirname as _dirname };

/**
 * Rewrite each fill's `pool_id` from the engine's GLOBAL pool id to the
 * ACTIVE-POOL SLOT index the clearing circuit expects.
 *
 * The circuit resolves a fill's slot from its hop token pair and then asserts
 * `fills[f].pool_id == pool_slot`; blocks C2/D also index the active-pool arrays
 * with that same value. The engine, however, tags fills with the global pool id.
 * The two coincide only when the active set happens to be the prefix 0..k, so an
 * epoch whose only active pool is pool 1 detonated `nargo execute` with
 * "fill pool_id != resolved pool slot" (caught live on the v5 testnet).
 *
 * The value is opaque to the contract — claim_fill only hashes it into the leaf —
 * so remapping is safe as long as it happens upstream of EVERY consumer: the
 * witness, the fills Merkle tree (whose root is committed on chain) and the hop
 * snapshot the maker's claim reads back. Active pools keep their global ids; the
 * orderbook routes each swap by `pc.pool_id`.
 *
 * Mutates `fills` in place. Throws if a fill references a non-active pool.
 */
export function remapFillPoolIdsToSlots(
  fills: Array<{ pool_id: number }>,
  perPoolClearings: Array<{ pool_id: number }>,
): void {
  const slotByGlobalPoolId = new Map<number, number>(
    perPoolClearings
      .map((pc) => pc.pool_id)
      .sort((a, b) => a - b)
      .map((globalId, slot) => [globalId, slot] as const),
  );
  for (const f of fills) {
    const slot = slotByGlobalPoolId.get(f.pool_id);
    if (slot === undefined) {
      throw new Error(
        `fill references pool ${f.pool_id}, which is not among the active pools ` +
          `[${[...slotByGlobalPoolId.keys()].join(", ")}]`,
      );
    }
    f.pool_id = slot;
  }
}
