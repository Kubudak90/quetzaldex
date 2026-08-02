/**
 * Sub-8.1 aggregator main entrypoint.
 *
 * Mode (MVP, reveal-server-only):
 *   - Boots Fastify on PORT (default 3000) with POST /reveal + GET /health.
 *   - Spawns a background "epoch watcher" loop that polls the orderbook via a
 *     read-only client and LOGS the current epoch, queue size, and whether a
 *     clearing would have been triggered. It does NOT submit the clearing tx
 *     yet — that step requires nargo + bb proof gen + a funded L2 wallet,
 *     which is deferred to Sub-8.1.next (see ops/RUNBOOK-aggregator.md).
 *
 * Future (full clearing daemon):
 *   - Wire `runDaemon(ctx)` from ./daemon.ts. The DaemonContext needs:
 *     * getEpoch  → orderbook.get_epoch()
 *     * getPool   → pool.get_reserves() + current_sqrt_price
 *     * runNargoExecute / runBbProve → shell out to nargo + bb binaries
 *     * submitClearing → orderbook.close_epoch_and_clear_verified(...)
 *
 * Env contract:
 *   - PORT                            HTTP port (default 3000)
 *   - AZTEC_NODE_URL                  Aztec L2 RPC (e.g. https://rpc.testnet.aztec-labs.com)
 *   - ORDERBOOK_ADDRESS               L2 Orderbook contract address (0x…)
 *   - POOL_ADDRESS                    L2 Pool contract address (optional)
 *   - AGGREGATOR_L2_SECRET            ephemeral wallet secret for read-only PXE
 *                                     calls (any 32-byte hex; reads only).
 *                                     Optional — if missing, the watcher logs a
 *                                     warning and skips on-chain polling.
 *   - WATCHER_INTERVAL_MS             poll interval (default 15000)
 *   - LOG_LEVEL                       info|debug (default info)
 *   - RELAYER_MODE=1                  enables bridge-claim relayer side-loop
 *                                     (Sub-5c; requires L1_RPC_URL + L1_PRIVATE_KEY)
 */

import { setTimeout as sleep } from "node:timers/promises";
import Fastify from "fastify";
import { z } from "zod";
import { Fr } from "@aztec/aztec.js/fields";
import { RevealQueue, type RevealPayload } from "./queue.js";
import {
  runOneClearingCycleMP,
  buildU128PoolRegistry,
  type DaemonContextMP,
  type ClearingPublicStruct,
} from "./clearing-cycle.js";
import type { PoolStateForRouting } from "./clearing.js";
import { registerProofRoute } from "./proof.js";

// ── Logging ────────────────────────────────────────────────────────────────
const LOG_LEVEL = (process.env.LOG_LEVEL ?? "info").toLowerCase();
function log(level: "info" | "warn" | "error" | "debug", msg: string, extra?: Record<string, unknown>): void {
  if (level === "debug" && LOG_LEVEL !== "debug") return;
  const line = {
    ts: new Date().toISOString(),
    level,
    msg,
    ...(extra ?? {}),
  };
  // Use console so Docker captures it on stdout/stderr.
  if (level === "error") console.error(JSON.stringify(line));
  else console.log(JSON.stringify(line));
}

// ── Fastify reveal server ──────────────────────────────────────────────────
// Mirrors src/server.ts shape but inlines so we can extend /health with the
// extra fields (lastEpochSeen, watcherStatus) without coupling test helpers.
const RevealSchema = z.object({
  epoch_id: z.number().int().nonnegative(),
  order_nonce: z.string().regex(/^0x[0-9a-fA-F]+$/),
  side: z.boolean(),
  amount_in: z.string().regex(/^\d+$/),
  limit_price: z.string().regex(/^\d+$/),
  submitted_at_block: z.number().int().nonnegative(),
  owner: z.string().regex(/^0x[0-9a-fA-F]+$/),
  submission_tx_hash: z.string().optional(),
  // Audit #11: path_len + path are bound into the order's c_i. They MUST be in the
  // schema, else zod safeParse STRIPS them from req.body → validateReveals defaults
  // to a [0,0,0] path → order_acc replay mismatch for any real (non-default) path,
  // so clearing always skips. (server.ts had these; main.ts — the live entry,
  // `node --import tsx src/main.ts` — was missing them: the real path-loss bug.)
  path_len: z.number().int().min(2).max(3).optional(),
  path: z.array(z.string().regex(/^0x[0-9a-fA-F]+$/)).length(3).optional(),
});

interface WatcherState {
  status: "idle" | "polling" | "disabled" | "error";
  lastEpochSeen: number | null;
  lastBlockSeen: number | null;
  lastError: string | null;
  lastPollAt: string | null;
}

const watcher: WatcherState = {
  status: "idle",
  lastEpochSeen: null,
  lastBlockSeen: null,
  lastError: null,
  lastPollAt: null,
};

// Cache for per-pool p_min_sqrt + bucket_growth_num (PublicImmutables — never change).
// Populated on first getPoolState call per pool_id; avoids re-reading every cycle.
const poolBoundsCache = new Map<number, { pMinSqrt: bigint; growthNum: bigint }>();

async function buildHttp(
  queue: RevealQueue,
  snapshotsDir: string,
): Promise<ReturnType<typeof Fastify>> {
  const app = Fastify({ logger: false });

  app.post("/reveal", async (req, reply) => {
    const parse = RevealSchema.safeParse(req.body);
    if (!parse.success) {
      return reply.code(400).send({ error: "invalid payload", issues: parse.error.issues });
    }
    const payload: RevealPayload = parse.data;
    queue.enqueue(payload);
    log("debug", "reveal enqueued", {
      epoch_id: payload.epoch_id,
      order_nonce: payload.order_nonce,
      queueSize: queue.size(),
    });
    return { ok: true };
  });

  app.get("/health", async () => ({
    ok: true,
    service: "quetzal-aggregator",
    queueSize: queue.size(),
    watcher: { ...watcher },
  }));

  // Sub-4 browser claim path: serve hop-fill Merkle proofs so the SDK/UI can
  // assemble the 7-arg claim_fill. Reads the SAME snapshots the clearing cycle
  // writes (snapshotsDir), keeping the CLI and browser claim paths in lockstep.
  registerProofRoute(app, snapshotsDir);

  // Root for human eyeballs — keeps unknown probes from 404'ing in the logs.
  app.get("/", async () => ({
    ok: true,
    service: "quetzal-aggregator",
    endpoints: ["POST /reveal", "GET /health", "GET /proof"],
  }));

  await app.ready();
  return app;
}

// ── Background epoch watcher (MVP: logs only) ──────────────────────────────
//
// Imports the SDK + opens a read-only QuetzalClient. If config loading or
// PXE bootstrap fails (missing env, network unreachable, etc.) we degrade
// gracefully: server keeps running, watcher.status becomes "disabled" or
// "error", and /health reflects that. This is intentional — accepting
// reveals into the queue is independently useful even without on-chain
// reads.
async function startEpochWatcher(queue: RevealQueue): Promise<void> {
  const intervalMs = Number(process.env.WATCHER_INTERVAL_MS ?? "15000");
  const nodeUrl = process.env.AZTEC_NODE_URL;
  const orderbookAddr = process.env.ORDERBOOK_ADDRESS;
  const secret = process.env.AGGREGATOR_L2_SECRET;
  // Sub-9.3: optional pool address triplet (USDC/ETH, USDC/BTC, ETH/BTC).
  // If present, the watcher wires the FULL multi-pair clearing loop.
  const poolUsdcEth = process.env.POOL_USDC_ETH_ADDRESS ?? process.env.POOL_ADDRESS;
  const poolUsdcBtc = process.env.POOL_USDC_BTC_ADDRESS;
  const poolEthBtc = process.env.POOL_ETH_BTC_ADDRESS;
  const tUSDC = process.env.TUSDC_ADDRESS;
  const tETH = process.env.TETH_ADDRESS;
  const tBTC = process.env.TBTC_ADDRESS;
  const snapshotsDir = process.env.SNAPSHOTS_DIR ?? "/repo/aggregator/data/snapshots";
  // Sub-9.3: clearing-cycle gate. Set CLEARING_ENABLED=1 to enable the
  // multi-pair clearing submit path. Default is "log-only" (Sub-8.1 MVP).
  const clearingEnabled = process.env.CLEARING_ENABLED === "1";

  if (!nodeUrl || !orderbookAddr || !secret) {
    log("warn", "epoch watcher disabled — missing env", {
      have_nodeUrl: Boolean(nodeUrl),
      have_orderbook: Boolean(orderbookAddr),
      have_secret: Boolean(secret),
    });
    watcher.status = "disabled";
    return;
  }

  // Lazy-import SDK + aztec-node so a misconfigured-but-running container still
  // serves /reveal + /health while we fix the L2 wiring.
  let client: unknown;
  let node: { getBlockNumber: () => Promise<number> } | null = null;
  try {
    const sdkMod = await import("@quetzal/sdk");
    const QuetzalClient = (sdkMod as { QuetzalClient: { connect: (opts: unknown) => Promise<unknown> } })
      .QuetzalClient;
    // Aztec node client for block-number reads (cheaper than SDK roundtrips).
    const nodeMod = await import("@aztec/aztec.js/node");
    const createAztecNodeClient = (nodeMod as { createAztecNodeClient: (url: string) => unknown }).createAztecNodeClient;
    node = createAztecNodeClient(nodeUrl) as { getBlockNumber: () => Promise<number> };
    log("info", "epoch watcher: connecting to Aztec node", { nodeUrl, clearingEnabled });

    // Construct pool list (Sub-9.3): all 3 pools if envs are present.
    const pools = [];
    if (poolUsdcEth && tUSDC && tETH) pools.push({ pool_id: 0, token_a: tETH, token_b: tUSDC, address: poolUsdcEth });
    if (poolUsdcBtc && tUSDC && tBTC) pools.push({ pool_id: 1, token_a: tBTC, token_b: tUSDC, address: poolUsdcBtc });
    if (poolEthBtc && tETH && tBTC) pools.push({ pool_id: 2, token_a: tETH, token_b: tBTC, address: poolEthBtc });

    client = await QuetzalClient.connect({
      network: nodeUrl.includes("testnet") ? "alpha-testnet" : "sandbox",
      nodeUrl,
      account: {
        type: "schnorr",
        secret,
        // Sub-9.3: optional salt + signingKey to reach a pre-deployed wallet
        // (e.g. admin's). Without these, the SDK derives address from secret
        // + Fr.ZERO salt + derived signingKey -> a NEW unfunded account.
        salt: process.env.AGGREGATOR_L2_SALT,
        signingKey: process.env.AGGREGATOR_L2_SIGNING_KEY,
        // Sub-9.3: enable client IVC prover when clearing path is enabled —
        // tx submission requires real proofs (close_epoch / close_epoch_and_clear_verified).
        proverEnabled: clearingEnabled,
        // Optional persistent PXE for warm-restart speed.
        dataDirectory: process.env.PXE_DATA_DIRECTORY,
      },
      contracts: {
        orderbook: orderbookAddr,
        tUSDC: tUSDC ?? "0x" + "0".repeat(64),
        tETH: tETH ?? "0x" + "0".repeat(64),
        tBTC,
        admin: process.env.ADMIN_ADDRESS ?? "0x" + "0".repeat(64),
        pools,
        aggregatorRegistry: process.env.AGGREGATOR_REGISTRY_ADDRESS,
        treasury: process.env.TREASURY_ADDRESS,
      },
    });
    log("info", "epoch watcher: PXE bootstrap complete", { pools: pools.length });
  } catch (e) {
    watcher.status = "error";
    watcher.lastError = `bootstrap: ${e instanceof Error ? e.message : String(e)}`;
    log("error", "epoch watcher: bootstrap failed", { error: watcher.lastError });
    return;
  }

  // Sub-9.3: build the DaemonContextMP if clearing is enabled.
  let daemonCtx: DaemonContextMP | null = null;
  if (clearingEnabled) {
    try {
      daemonCtx = await buildDaemonContextMP({
        queue,
        snapshotsDir,
        client,
        node: node!,
        poolUsdcEth,
        poolUsdcBtc,
        poolEthBtc,
        tUSDC,
        tETH,
        tBTC,
      });
      log("info", "DaemonContextMP built — clearing loop wired", {
        registry_size: daemonCtx.registry.length,
        snapshots_dir: snapshotsDir,
      });
    } catch (e) {
      // Don't kill the watcher — fallback to log-only mode if context build fails.
      log("error", "DaemonContextMP build failed; falling back to log-only", {
        error: e instanceof Error ? e.message : String(e),
      });
      daemonCtx = null;
    }
  }

  // Polling loop. Runs forever; per-iteration errors are logged + swallowed.
  log("info", "epoch watcher: started", { intervalMs, clearingEnabled: Boolean(daemonCtx) });
  // Auto-roll cooldown: an expired epoch with no reveals would otherwise sit
  // closed forever (the daemon never clears an empty epoch), so the NEXT user's
  // submit_order reverts "epoch has expired". We roll it (close_epoch). The
  // cooldown (> close_epoch mine time) prevents double-rolling while the prior
  // roll tx is still pending.
  let lastAutoRollAt = 0;
  // Race guard (2026-06-10): the clearing cycle drains the reveal queue at its
  // start, so a poll tick landing mid-cycle sees queue==0 on an expired epoch
  // and auto-rolls it — close_epoch then mines before the clear tx, which
  // reverts "epoch has not expired yet" against the fresh epoch (observed live,
  // epoch 45: fills=3 computed+proved, settle lost). Auto-roll must never fire
  // while a cycle is in flight.
  let clearingInFlight = false;
  while (true) {
    try {
      watcher.status = "polling";
      const c = client as { reads: { getCurrentEpoch: () => Promise<{ epoch_id: number; closes_at_block: number }> } };
      const epoch = await c.reads.getCurrentEpoch();
      const blockNow = node ? await node.getBlockNumber() : null;
      watcher.lastEpochSeen = epoch.epoch_id;
      queue.setCurrentEpoch(epoch.epoch_id); // M3: bound the queue to epochs near the live one
      watcher.lastBlockSeen = blockNow ?? epoch.closes_at_block;
      watcher.lastPollAt = new Date().toISOString();
      watcher.lastError = null;
      const wouldClear =
        queue.sizeForEpoch(epoch.epoch_id) > 0 &&
        blockNow !== null &&
        blockNow >= epoch.closes_at_block;
      log("info", "epoch poll", {
        epoch_id: epoch.epoch_id,
        closes_at_block: epoch.closes_at_block,
        block_now: blockNow,
        queueSize: queue.size(),
        wouldClear,
      });

      // Sub-9.3: fire clearing cycle when gate is hit.
      if (wouldClear && daemonCtx && !clearingInFlight) {
        log("info", "epoch close window hit — running clearing cycle");
        // Run in background (don't block the next poll). Mutex inside
        // runOneClearingCycleMP prevents concurrent cycles.
        clearingInFlight = true;
        runOneClearingCycleMP(daemonCtx, log)
          .then(
            (status) => log("info", "clearing cycle complete", { status }),
            (err) => log("error", "clearing cycle failed", {
              error: err instanceof Error ? err.message : String(err),
            }),
          )
          .finally(() => { clearingInFlight = false; });
      } else if (
        daemonCtx?.submitCloseEpochOnly &&
        !clearingInFlight &&
        blockNow !== null &&
        blockNow >= epoch.closes_at_block &&
        queue.sizeForEpoch(epoch.epoch_id) === 0 &&
        Date.now() - lastAutoRollAt > 90_000
      ) {
        // Expired epoch with no reveals → roll it so the orderbook stays open for
        // the next user (otherwise their submit_order reverts "epoch has expired").
        //
        // Fee gate (2026-07-13, caught live): unlike the clearing cycle this path
        // had NO fee-balance check, so once the fee payer ran low it retried a
        // doomed close_epoch every tick, burning the remainder to zero and wedging
        // the orderbook (epoch expired, cannot roll, no funds to ever roll). Bail
        // early and loudly instead — the balance is an ops problem, not a retry one.
        lastAutoRollAt = Date.now();
        if (daemonCtx.getFeePayerBalance) {
          const minBalance = BigInt(process.env.CLEAR_MIN_FEE_JUICE ?? "100000000000000000000");
          try {
            const bal = await daemonCtx.getFeePayerBalance();
            if (bal !== null && bal < minBalance) {
              log("warn", "fee payer below threshold — NOT auto-rolling (top up the clearing wallet)", {
                balance_fj: (Number(bal) / 1e18).toFixed(2),
                min_fj: (Number(minBalance) / 1e18).toFixed(2),
              });
              // Skip THIS tick only. `return` here would exit the poll function
              // itself (the loop's `await sleep()` lives at the bottom of the
              // while body) and silently kill the watcher.
              await sleep(intervalMs);
              continue;
            }
          } catch { /* balance read failed — proceed; the send surfaces fee errors */ }
        }
        // M5: hold the same in-flight flag the clearing cycle uses, so a roll and a
        // clearing cycle can never overlap in either direction (a cycle starting while
        // a close_epoch roll tx is pending would race and lose late reveals).
        clearingInFlight = true;
        log("info", "epoch expired + empty — auto-rolling (close_epoch) to keep orderbook open");
        daemonCtx.submitCloseEpochOnly()
          .then(
            (r) => log("info", "auto-roll close_epoch submitted", { txHash: r.txHash }),
            (err) => log("error", "auto-roll close_epoch failed", {
              error: err instanceof Error ? err.message : String(err),
            }),
          )
          .finally(() => { clearingInFlight = false; });
      }
    } catch (e) {
      watcher.status = "error";
      watcher.lastError = e instanceof Error ? e.message : String(e);
      log("error", "epoch poll failed", { error: watcher.lastError });
    }
    await sleep(intervalMs);
  }
}

/**
 * Sub-9.3: build the DaemonContextMP that bridges from SDK → daemon orchestrator.
 * Heavy: opens a long-lived QuetzalClient + aztec node client.
 */
async function buildDaemonContextMP(args: {
  queue: RevealQueue;
  snapshotsDir: string;
  client: unknown;
  node: { getBlockNumber: () => Promise<number> };
  poolUsdcEth?: string;
  poolUsdcBtc?: string;
  poolEthBtc?: string;
  tUSDC?: string;
  tETH?: string;
  tBTC?: string;
}): Promise<DaemonContextMP> {
  // Build u128-canonical registry from env pools.
  const configPools = [];
  if (args.poolUsdcEth && args.tUSDC && args.tETH)
    configPools.push({ pool_id: 0, address: args.poolUsdcEth, token_a: args.tETH, token_b: args.tUSDC });
  if (args.poolUsdcBtc && args.tUSDC && args.tBTC)
    configPools.push({ pool_id: 1, address: args.poolUsdcBtc, token_a: args.tBTC, token_b: args.tUSDC });
  if (args.poolEthBtc && args.tETH && args.tBTC)
    configPools.push({ pool_id: 2, address: args.poolEthBtc, token_a: args.tETH, token_b: args.tBTC });
  if (configPools.length === 0) throw new Error("no pools configured for clearing loop");
  const registry = buildU128PoolRegistry(configPools);

  // SDK types
  type SdkClient = {
    reads: { getCurrentEpochFull: () => Promise<{
      epoch_id: number; closes_at_block: number;
      order_acc: string; order_count: number;
      cancel_acc: string; cancel_count: number;
    }> };
    pools: {
      getPoolState: (poolId: number) => Promise<{ reserveA: bigint; reserveB: bigint; currentSqrtPrice: bigint }>;
      getBucket: (bucketId: number, poolId: number) => Promise<{
        reserveA: bigint; reserveB: bigint; liquidity: bigint;
        cumFeeAPerShare: bigint; cumFeeBPerShare: bigint;
      }>;
      getPMinSqrt: (poolId: number) => Promise<bigint>;
      getBucketGrowthNum: (poolId: number) => Promise<bigint>;
    };
    orders: {
      closeEpochVerified: (opts: { proofFields: Fr[]; vkFields: Fr[]; publicInputs: unknown }) =>
        Promise<{ epoch_id: number; closes_at_block: number }>;
      closeEpoch: (opts?: { epoch?: number }) => Promise<{ epoch_id: number; closes_at_block: number }>;
    };
  };
  const c = args.client as SdkClient;

  return {
    queue: args.queue,
    snapshotsDir: args.snapshotsDir,
    registry,
    circuitDir: process.env.CIRCUIT_DIR ?? "/repo/circuits/clearing",
    nargoBin: process.env.NARGO_BIN ?? "nargo",
    bbBin: process.env.BB_BIN ?? "bb",
    proveDeadlineMs: Number(process.env.PROVE_DEADLINE_MS ?? "300000"),
    verbose: process.env.PROVE_VERBOSE !== "0",
    getEpoch: async () => {
      const e = await c.reads.getCurrentEpochFull();
      return {
        epoch_id: e.epoch_id,
        closes_at_block: e.closes_at_block,
        order_acc: Fr.fromString(e.order_acc),
        order_count: e.order_count,
        cancel_acc: Fr.fromString(e.cancel_acc),
        cancel_count: e.cancel_count,
      };
    },
    getBlockNumber: () => args.node.getBlockNumber(),
    getFeePayerBalance: async () => {
      // Fee-juice public balance of the daemon's own account (the fee payer).
      // v5 moved the FeeJuice protocol contract (0x…05 on 4.3 → 0x…03 on v5);
      // resolve it from the node instead of hardcoding. Balances map at slot 1.
      try {
        const { deriveStorageSlotInMap } = await import("@aztec/stdlib/hash");
        const { AztecAddress } = await import("@aztec/aztec.js/addresses");
        const addr = (c as unknown as { address?: { toString(): string } }).address;
        if (!addr) return null;
        const nodeInfo = await (args.node as unknown as {
          getNodeInfo: () => Promise<{ protocolContractAddresses: { feeJuice: { toString(): string } } }>;
        }).getNodeInfo();
        const feeJuice = AztecAddress.fromStringUnsafe(
          nodeInfo.protocolContractAddresses.feeJuice.toString(),
        );
        const slot = await deriveStorageSlotInMap(new Fr(1n), AztecAddress.fromStringUnsafe(addr.toString()));
        const raw = await (args.node as unknown as {
          getPublicStorageAt: (block: string, c: unknown, s: unknown) => Promise<{ toBigInt(): bigint }>;
        }).getPublicStorageAt("latest", feeJuice, slot);
        return raw.toBigInt();
      } catch {
        return null;
      }
    },
    getPoolState: async (poolId: number) => {
      // Sub-9.3: read pool aggregate + 16 buckets. We read ALL buckets since
      // clearing needs the full state for proper sqrt-price tracing. Slow on
      // testnet (~30s for 16 reads) but correct. Optimisation deferred.
      const aggregate = await c.pools.getPoolState(poolId);
      const buckets = [];
      for (let i = 0; i < 16; i++) {
        const b = await c.pools.getBucket(i, poolId);
        buckets.push({
          reserve_a: b.reserveA,
          reserve_b: b.reserveB,
          liquidity: b.liquidity,
          cum_fee_a_per_share: b.cumFeeAPerShare,
          cum_fee_b_per_share: b.cumFeeBPerShare,
        });
      }
      // Read p_min_sqrt + bucket_growth_num on first call (PublicImmutables — cached).
      if (!poolBoundsCache.has(poolId)) {
        const pMinSqrt = await c.pools.getPMinSqrt(poolId);
        const growthNum = await c.pools.getBucketGrowthNum(poolId);
        poolBoundsCache.set(poolId, { pMinSqrt, growthNum });
      }
      const { pMinSqrt, growthNum } = poolBoundsCache.get(poolId)!;
      const { computeAllBucketBounds } = await import("@quetzal/sdk") as unknown as {
        computeAllBucketBounds: (pMinSqrt: bigint, growthNum: bigint, numBuckets: number) => Array<{ sqrt_lower: bigint; sqrt_upper: bigint }>;
      };
      const result: PoolStateForRouting = {
        reserveA: aggregate.reserveA,
        reserveB: aggregate.reserveB,
        lpSupply: 0n,  // unused by computeClearingV2 in the Sub-2.5+ V3 path
        currentSqrtPrice: aggregate.currentSqrtPrice,
        bucketBounds: computeAllBucketBounds(pMinSqrt, growthNum, 16),
        bucketStates: buckets,
      };
      return result;
    },
    submitClearing: async ({ publicInputs, proof, vk }: {
      publicInputs: ClearingPublicStruct;
      proof: Fr[];
      vk: Fr[];
    }) => {
      const res = await c.orders.closeEpochVerified({
        proofFields: proof,
        vkFields: vk,
        publicInputs,
      });
      void res;
      return { txHash: "submitted" };
    },
    submitCloseEpochOnly: async () => {
      const res = await c.orders.closeEpoch();
      void res;
      return { txHash: "submitted" };
    },
  };
}

// ── Optional relayer side-loop (Sub-5c) ────────────────────────────────────
async function maybeStartRelayer(): Promise<void> {
  if (process.env.RELAYER_MODE !== "1") return;
  if (!process.env.L1_RPC_URL || !process.env.L1_PRIVATE_KEY) {
    log("warn", "RELAYER_MODE=1 set but L1_RPC_URL/L1_PRIVATE_KEY missing — skipping");
    return;
  }
  try {
    log("info", "relayer-mode: starting side-loop");
    const { runRelayerLoop } = await import("./relayer-mode.js");
    const { loadConfig } = await import("../../cli/src/config.js");
    const config = loadConfig();
    if (!config.treasury) {
      log("warn", "relayer-mode: config.treasury missing — skipping");
      return;
    }
    const bridgesByAddress: Record<string, "USDC" | "WETH" | "wBTC"> = {};
    if (config.l1?.usdcBridge) bridgesByAddress[config.l1.usdcBridge.toLowerCase()] = "USDC";
    if (config.l1?.wethBridge) bridgesByAddress[config.l1.wethBridge.toLowerCase()] = "WETH";
    if (config.l1?.wbtcBridge) bridgesByAddress[config.l1.wbtcBridge.toLowerCase()] = "wBTC";
    // L22/v5: bridge → L2 token address (bytes32 l2Sender for withdraw calls).
    const l2SendersByBridge: Record<string, string> = {};
    if (config.l1?.usdcBridge && config.tUSDC)
      l2SendersByBridge[config.l1.usdcBridge.toLowerCase()] = config.tUSDC;
    if (config.l1?.wethBridge && config.tETH)
      l2SendersByBridge[config.l1.wethBridge.toLowerCase()] = config.tETH;
    if (config.l1?.wbtcBridge && config.tBTC)
      l2SendersByBridge[config.l1.wbtcBridge.toLowerCase()] = config.tBTC;
    runRelayerLoop({
      aztecNodeUrl: config.nodeUrl,
      l1RpcUrl: process.env.L1_RPC_URL,
      l1PrivateKey: process.env.L1_PRIVATE_KEY as `0x${string}`,
      treasuryAddr: config.treasury,
      bridgesByAddress,
      l2SendersByBridge,
    }).catch((e: unknown) => {
      log("error", "relayer-mode crashed", { error: e instanceof Error ? e.message : String(e) });
    });
  } catch (e) {
    log("error", "relayer-mode init failed", { error: e instanceof Error ? e.message : String(e) });
  }
}

// ── Entrypoint ─────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  const port = Number(process.env.PORT ?? "3000");
  const queue = new RevealQueue();

  log("info", "starting quetzal-aggregator", {
    port,
    relayerMode: process.env.RELAYER_MODE === "1",
    logLevel: LOG_LEVEL,
  });

  // Must match the dir the clearing cycle writes snapshots to (startEpochWatcher
  // uses the same default) so GET /proof serves the live hop-fill snapshots.
  const snapshotsDir = process.env.SNAPSHOTS_DIR ?? "/repo/aggregator/data/snapshots";
  const app = await buildHttp(queue, snapshotsDir);
  await app.listen({ port, host: "0.0.0.0" });
  log("info", "http server listening", { port, snapshotsDir });

  // Fire off the watcher + relayer loops without awaiting — they run forever.
  startEpochWatcher(queue).catch((e: unknown) => {
    log("error", "epoch watcher crashed", { error: e instanceof Error ? e.message : String(e) });
  });
  maybeStartRelayer().catch(() => {});

  // Graceful shutdown — close fastify cleanly so docker stop's SIGTERM
  // doesn't leak the port.
  const shutdown = async (sig: string): Promise<void> => {
    log("info", "shutting down", { signal: sig });
    try {
      await app.close();
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((e: unknown) => {
  console.error(JSON.stringify({
    ts: new Date().toISOString(),
    level: "error",
    msg: "fatal",
    error: e instanceof Error ? e.message : String(e),
  }));
  process.exit(1);
});
