/**
 * Week 5d-4 end-to-end: claim_fill with Merkle inclusion proof.
 *
 * Full pipeline (Task 12 of the 5d-4 plan): alice + bob submit balanced orders
 * -> aggregator runs computeClearing + buildClearingWitness -> admin closes the
 * epoch via close_epoch_and_clear_verified with a real bb-generated proof ->
 * the per-epoch fills_root is recorded in storage -> the aggregator writes a
 * snapshot to disk -> each maker reads the snapshot, looks up their inclusion
 * path, and calls claim_fill(order_nonce, amount_out, epoch_id, siblings,
 * leaf_index) -> the contract's _assert_fill_root callback validates the path
 * against the stored root, and we assert each maker's PRIVATE balance of the
 * output token increased by the canonical payout.
 *
 * Why this test (T5-T9 are NOT in test.nr's TXE suite):
 *   The TXE simulator cannot execute std::verify_proof_with_type (per
 *   memory/reference_aztec_txe_recursive_verify.md and the comment block in
 *   contracts/orderbook/src/test.nr around line 343). Recursive-proof rejection,
 *   replay, wrong-sibling, wrong-amount, wrong-epoch, and oob-leaf_index cases
 *   can only be exercised against a live Aztec sandbox where the kernel
 *   actually verifies the Honk proof. This file is the live alternative.
 *
 * Dev-stack requirement: the test PXE_URL must point at a running aztec node
 * (default http://localhost:8080), and the dev stack must be brought up via
 * `scripts/dev.sh` (which boots anvil at :18545 and aztec at :18080 with the
 * env shim). Without that stack the test exits at `connectToSandbox()`. See
 * memory/project_week05c_integration_gap.md — full TS integration tests are
 * historically Docker-blocked on the dev box. When the stack is up, expected
 * wallclock is ~45-60 min, dominated by one `bb prove` at N=32 (~10-25 min)
 * plus the usual sandbox tx overhead.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { spawnSync } from "node:child_process";
import { writeFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AztecAddress } from "@aztec/aztec.js/addresses";
import type { AztecNode } from "@aztec/aztec.js/node";
import type { EmbeddedWallet } from "@aztec/wallets/embedded";
import { Fr } from "@aztec/aztec.js/fields";

import { connectToSandbox } from "./helpers/sandbox.js";
import { getTestWallets } from "./helpers/wallets.js";
import {
  readProofAsFields,
  readVkAsFields,
  readVkHash,
} from "./helpers/proof.js";
import { TokenContract } from "./generated/Token.js";
import { OrderbookContract } from "./generated/Orderbook.js";
import { LiquidityPoolContract } from "./generated/LiquidityPool.js";

import {
  computeClearing,
  type ClearingOrder,
} from "../../aggregator/src/clearing.js";
import {
  buildClearingWitness,
  type OrderNotePreimage,
  type EpochState,
  type PoolSnapshotForCircuitSub2,
} from "../../aggregator/src/witness.js";
import { buildFillsTree } from "../../aggregator/src/merkle.js";
import { writeSnapshot, readSnapshot } from "../../aggregator/src/snapshot.js";

// ---------------------------------------------------------------------------
// Constants — mirror clearing.test.ts E1's production-circuit conventions.
// ---------------------------------------------------------------------------

// Production circuit (MAX_ORDERS_PER_EPOCH = 32).
const CIRCUIT_DIR = "/root/quetzal/circuits/clearing";
const CIRCUIT_MAX_ORDERS = 32;
// Host-installed bb binary (amd64-linux, no Docker overhead).
const BB_BIN =
  "/root/.aztec/versions/4.2.1/node_modules/@aztec/bb.js/build/amd64-linux/bb";

// Contract array sizes for `close_epoch_and_clear_verified`. Audit #1: these are
// the FULL bb `-t noir-recursive` shapes (proof 500, vk 115). The old 456/127
// truncate+pad corrupted the proof + vk so recursive verify could never pass.
const CONTRACT_PROOF_SIZE = 500;
const CONTRACT_VK_SIZE = 115;

const ONE_USDC = 10n ** 6n;
const ONE_ETH  = 10n ** 18n;

// Balanced pool 10,000 tUSDC : 5,000 tETH ⇒ spot P* = 2e6
// (reserveA * SCALE / reserveB = 1e10 * 1e18 / 5e21 = 2e6).
const POOL_A = 10_000n * ONE_USDC;
const POOL_B = 5_000n  * ONE_ETH;

// Balanced order pair at spot (netA == 0 ⇒ no AMM swap, k-monotonicity trivial):
//   buy 100 tUSDC of A,  sell 50 tETH of B.
const BUY_USDC = 100n * ONE_USDC;
const SELL_ETH = 50n  * ONE_ETH;
const BUY_LIMIT  = 10_000_000_000_000_000_000n; // 1e19, well above spot 2e6
const SELL_LIMIT = 1n;                            // well below spot 2e6

// Circuit-canonical payout formula (mirror of circuits/clearing/src/pricing.nr):
//   buy  payout = floor( floor(amount_in * SCALE / P*) * (FEE_DEN - FEE_NUM_FEE) / FEE_DEN )
//   sell payout = floor( floor(amount_in * P* / SCALE) * (FEE_DEN - FEE_NUM_FEE) / FEE_DEN )
// with FEE_NUM_FEE = 30, FEE_DEN = 10000 (the 0.3% LP fee, withheld from the output).
// For the balanced fixture at P* = 2e6:
//   alice (buy, in=100*1e6 USDC):  gross_B = 1e8 * 1e18 / 2e6 = 5e19 tETH;
//                                  payout = 5e19 * 9970 / 10000 = 49 850 000 000 000 000 000.
//   bob   (sell, in=50*1e18 ETH):  gross_A = 5e19 * 2e6 / 1e18 = 1e8 tUSDC;
//                                  payout = 1e8 * 9970 / 10000 = 99 700 000.
const ALICE_EXPECTED_OUT = 49_850_000_000_000_000_000n;   // tETH, 18-dec
const BOB_EXPECTED_OUT   =          99_700_000n;          // tUSDC, 6-dec

// Epoch length: setup, two submits, off-chain proving (mines no blocks), then
// mine to expiry. 20 is comfortable headroom over the submit count + churn.
const EPOCH_LEN = 20;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function randomField(): bigint {
  const buf = new Uint8Array(31);
  webcrypto.getRandomValues(buf);
  let n = 0n;
  for (const b of buf) n = (n << 8n) | BigInt(b);
  return n;
}

async function currentBlock(node: AztecNode): Promise<number> {
  return Number(await node.getBlockNumber());
}

/** Truncate-or-pad `bb prove`'s 500-field output to the contract's [Field; 456]. */
function bridgeProofToContractSize(fileFields: Fr[]): Fr[] {
  if (fileFields.length === CONTRACT_PROOF_SIZE) return fileFields;
  if (fileFields.length > CONTRACT_PROOF_SIZE) {
    return fileFields.slice(0, CONTRACT_PROOF_SIZE);
  }
  const padded = [...fileFields];
  while (padded.length < CONTRACT_PROOF_SIZE) padded.push(Fr.ZERO);
  return padded;
}

/** Truncate-or-pad `bb write_vk`'s 115-field output to the contract's [Field; 127]. */
function bridgeVkToContractSize(fileFields: Fr[]): Fr[] {
  if (fileFields.length === CONTRACT_VK_SIZE) return fileFields;
  if (fileFields.length > CONTRACT_VK_SIZE) {
    return fileFields.slice(0, CONTRACT_VK_SIZE);
  }
  const padded = [...fileFields];
  while (padded.length < CONTRACT_VK_SIZE) padded.push(Fr.ZERO);
  return padded;
}

interface OrderNoteFields {
  side: boolean;
  amount_in: bigint | number;
  limit_price: bigint | number;
  nonce: bigint | number;
  submitted_at_block: bigint | number;
  owner: bigint | number;
}

/**
 * Build the ClearingPublic argument matching the contract's struct shape
 * (mirrors circuits/clearing/src/main.nr fn main pub parameters):
 *   { order_acc, cancel_acc, order_count, cancel_count,
 *     reserve_a, reserve_b, lp_supply,
 *     clearing_price, fills_root: Field, swap: ClearingSwap }
 *
 * Week 5d-4: fills_root replaces the old fills[]: [FillEntry; 32] + fills_len: u32.
 * The swap fields are derived from the aggregator's reserve deltas and
 * fee-per-share increments — a faithful echo of the circuit's `swap` pub input.
 *
 * (Mirror of the same helper in clearing.test.ts; duplicated here so this test
 * file is self-contained and not coupled to E1's local export surface.)
 */
async function buildPublicInputsStruct(
  epoch: { order_acc: bigint; cancel_acc: bigint; order_count: bigint | number; cancel_count: bigint | number },
  pool: { reserve_a: bigint; reserve_b: bigint; lp_supply?: bigint },
  clearing: {
    clearingPrice: bigint;
    fills: { orderNonce: bigint; amountOut: bigint }[];
    newReserveA: bigint;
    newReserveB: bigint;
    feeAPerShareIncrement: bigint;
    feeBPerShareIncrement: bigint;
  },
  canonicalFills: { orderNonce: bigint; amountOut: bigint }[],
) {
  const tree = await buildFillsTree(
    canonicalFills.map((f) => ({ order_nonce: new Fr(f.orderNonce), amount_out: f.amountOut })),
  );
  const deltaA = clearing.newReserveA - pool.reserve_a;
  const deltaB = clearing.newReserveB - pool.reserve_b;
  // Audit #1: public_inputs now uses active_pool_count + active_pools[] multi-pool shape.
  const bucketDelta = {
    bucket_id: 0n,
    reserve_a_add: deltaA > 0n ? deltaA : 0n,
    reserve_a_sub: deltaA < 0n ? -deltaA : 0n,
    reserve_b_add: deltaB > 0n ? deltaB : 0n,
    reserve_b_sub: deltaB < 0n ? -deltaB : 0n,
    cum_fee_a_per_share_increment: clearing.feeAPerShareIncrement,
    cum_fee_b_per_share_increment: clearing.feeBPerShareIncrement,
  };
  const swap = {
    a_to_pool: 0n,
    b_to_pool: 0n,
    a_from_pool: 0n,
    b_from_pool: 0n,
    active_bucket_deltas: [bucketDelta],
    active_bucket_count: 1n,
    current_sqrt_price_after: 0n,
  };
  return {
    order_acc: epoch.order_acc,
    cancel_acc: epoch.cancel_acc,
    order_count: Number(epoch.order_count),
    cancel_count: Number(epoch.cancel_count),
    fills_root: tree.root.toBigInt(),
    active_pool_count: 1n,
    active_pools: [{ pool_id: 0n, clearing_price: clearing.clearingPrice, swap }],
  };
}

/**
 * Replicate circuits/clearing/src/pricing.nr::payout() so we can derive the
 * CANONICAL fills the on-chain Merkle tree was built from. The TS aggregator's
 * `computeClearing.fills` use a different pro-rata distribution model — see
 * the comment block atop aggregator/src/witness.ts.
 */
const SCALE_FP = 1_000_000_000_000_000_000n;
const FEE_NUM_FEE = 30n;
const FEE_DEN_FEE = 10_000n;
function circuitPayout(order: OrderNotePreimage, clearingPrice: bigint): bigint {
  const gross = order.side
    ? (order.amount_in * clearingPrice) / SCALE_FP    // sell: in_B * P* / SCALE → A
    : (order.amount_in * SCALE_FP) / clearingPrice;   // buy:  in_A * SCALE / P* → B
  return (gross * (FEE_DEN_FEE - FEE_NUM_FEE)) / FEE_DEN_FEE;
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe(
  "Week 5d-4 e2e — claim_fill with Merkle inclusion proof (live integration)",
  { timeout: 60 * 60 * 1_000 }, // 60 min for the whole suite (bb prove dominates)
  () => {
    let node: AztecNode;
    let wallet: EmbeddedWallet;
    let admin: AztecAddress;
    let alice: AztecAddress; // buyer  (A → B)
    let bob:   AztecAddress; // seller (B → A)
    let tUSDC: TokenContract;
    let tETH:  TokenContract;
    let pool:  LiquidityPoolContract;
    let orderbook: OrderbookContract;
    let snapshotsDir: string;

    before(async () => {
      node = await connectToSandbox();
      const env = await getTestWallets(node, 3);
      wallet = env.wallet;
      admin  = env.accounts[0]!;
      alice  = env.accounts[1]!;
      bob    = env.accounts[2]!;

      snapshotsDir = mkdtempSync(join(tmpdir(), "quetzal-claim-merkle-snap-"));

      // Fresh tUSDC.
      const dU = await TokenContract.deployWithOpts(
        { wallet, method: "constructor_with_minter" },
        "tUSDC".padEnd(31, "\0"), "tUSDC".padEnd(31, "\0"), 6, admin,
      ).send({ from: admin });
      tUSDC = dU.contract;

      // Fresh tETH.
      const dE = await TokenContract.deployWithOpts(
        { wallet, method: "constructor_with_minter" },
        "tETH".padEnd(31, "\0"), "tETH".padEnd(31, "\0"), 18, admin,
      ).send({ from: admin });
      tETH = dE.contract;

      // Fresh LiquidityPool.
      const P_MIN_SQRT        = 100_000_000_000_000_000n; // 0.1e18
      const BUCKET_GROWTH_NUM = 1_500_000_000_000_000_000n; // 1.5e18
      const ZERO_ADDR = { address: 0n } as const;
      const dP = await LiquidityPoolContract.deploy(wallet, tUSDC.address, tETH.address, P_MIN_SQRT, BUCKET_GROWTH_NUM, admin)
        .send({ from: admin });
      pool = dP.contract;

      // The orderbook is bound to the production circuit's vk_hash (written by
      // scripts/compile-all.sh).
      const vkHash = readVkHash(`${CIRCUIT_DIR}/target/vk.bin/vk_hash`);

      const dOB = await OrderbookContract.deploy(
        wallet, EPOCH_LEN, vkHash, ZERO_ADDR, 0n, 1,
        [pool.address, ZERO_ADDR, ZERO_ADDR, ZERO_ADDR],
        [tUSDC.address, ZERO_ADDR, ZERO_ADDR, ZERO_ADDR],
        [tETH.address, ZERO_ADDR, ZERO_ADDR, ZERO_ADDR],
        admin,
      ).send({ from: admin });
      orderbook = dOB.contract;

      // Wire pool → orderbook (apply_clearing's only_orderbook gate).
      await pool.methods.set_orderbook(orderbook.address).send({ from: admin });

      // Seed balances.
      await tUSDC.methods.mint_to_private(admin, POOL_A + 1_000n * ONE_USDC).send({ from: admin });
      await tETH .methods.mint_to_private(admin, POOL_B + 100n  * ONE_ETH ).send({ from: admin });
      await tUSDC.methods.mint_to_private(alice, BUY_USDC + ONE_USDC).send({ from: admin });
      await tETH .methods.mint_to_private(bob,   SELL_ETH + ONE_ETH ).send({ from: admin });

      // Pool deposit (balanced 10k tUSDC : 5k tETH).
      const hint0Raw = (await pool.methods.get_pool_state().simulate({ from: admin })).result as { reserve_a: bigint | number; reserve_b: bigint | number; current_sqrt_price: bigint | number };
      const hint0PoolHint = { reserve_a: BigInt(hint0Raw.reserve_a), reserve_b: BigInt(hint0Raw.reserve_b), current_sqrt_price: BigInt(hint0Raw.current_sqrt_price) };
      const zeroBucketHint = { reserve_a: 0n, reserve_b: 0n, liquidity: 0n, cum_fee_a_per_share: 0n, cum_fee_b_per_share: 0n };
      await pool.methods
        .deposit(0n, POOL_A, POOL_B, hint0PoolHint, zeroBucketHint, randomField(), randomField(), randomField())
        .send({ from: admin });
    });

    after(async () => {
      if (snapshotsDir) rmSync(snapshotsDir, { recursive: true, force: true });
      const stop = (wallet as unknown as { stop?: () => Promise<void> }).stop;
      if (typeof stop === "function") await stop.call(wallet);
    });

    it(
      "alice + bob submit → admin close_epoch_and_clear_verified → snapshot → each claims via inclusion proof",
      { timeout: 50 * 60 * 1_000 }, // 50 min (bb prove at N=32 dominates)
      async () => {
        // ===================================================================
        // 1. SUBMIT — alice's balanced buy, bob's balanced sell.
        // ===================================================================
        const buyNonce  = randomField();
        const sellNonce = randomField();

        await orderbook.methods
          .submit_order(false, BUY_USDC, BUY_LIMIT, randomField(), buyNonce,
            2n, [tUSDC.address, tETH.address, Fr.ZERO])
          .send({ from: alice });

        await orderbook.methods
          .submit_order(true, SELL_ETH, SELL_LIMIT, randomField(), sellNonce,
            2n, [tETH.address, tUSDC.address, Fr.ZERO])
          .send({ from: bob });

        // ===================================================================
        // 2. READ on-chain state — order notes, epoch, pool snapshot.
        // ===================================================================
        const aliceRaw = await orderbook.methods.get_orders(alice).simulate({ from: alice });
        const aliceBv = (aliceRaw as {
          result: { storage: OrderNoteFields[]; len: bigint | number };
        }).result;
        const aliceLen = Number(aliceBv.len);
        assert.ok(aliceLen >= 1, "alice must have at least 1 order");
        const aliceNote = aliceBv.storage.slice(0, aliceLen)
          .find((n) => BigInt(n.nonce) === buyNonce);
        assert.ok(aliceNote, "alice's buy order note not found");

        const bobRaw = await orderbook.methods.get_orders(bob).simulate({ from: bob });
        const bobBv = (bobRaw as {
          result: { storage: OrderNoteFields[]; len: bigint | number };
        }).result;
        const bobLen = Number(bobBv.len);
        assert.ok(bobLen >= 1, "bob must have at least 1 order");
        const bobNote = bobBv.storage.slice(0, bobLen)
          .find((n) => BigInt(n.nonce) === sellNonce);
        assert.ok(bobNote, "bob's sell order note not found");

        const epochRaw = await orderbook.methods.get_epoch().simulate({ from: admin });
        const epochResult = (epochRaw as {
          result: {
            epoch_id: bigint | number;
            order_acc: bigint;
            cancel_acc: bigint;
            order_count: bigint | number;
            cancel_count: bigint | number;
            closes_at_block: bigint;
          };
        }).result;
        const epochId = Number(epochResult.epoch_id);

        const poolStateRaw = await pool.methods.get_pool_state().simulate({ from: admin });
        const poolState = poolStateRaw.result;

        // ===================================================================
        // 3. BUILD orders[] in canonical submission order (the circuit's
        //    binding module replays order_acc in this exact order).
        // ===================================================================
        const ordersForWitness: OrderNotePreimage[] = [
          {
            side: false,
            amount_in: BigInt(aliceNote.amount_in),
            limit_price: BigInt(aliceNote.limit_price),
            order_nonce: buyNonce,
            submitted_at_block: Number(aliceNote.submitted_at_block),
            owner: BigInt(aliceNote.owner),
          },
          {
            side: true,
            amount_in: BigInt(bobNote.amount_in),
            limit_price: BigInt(bobNote.limit_price),
            order_nonce: sellNonce,
            submitted_at_block: Number(bobNote.submitted_at_block),
            owner: BigInt(bobNote.owner),
          },
        ].sort((a, b) => {
          if (a.submitted_at_block !== b.submitted_at_block)
            return a.submitted_at_block - b.submitted_at_block;
          return a.order_nonce < b.order_nonce ? -1 : a.order_nonce > b.order_nonce ? 1 : 0;
        });

        // ===================================================================
        // 4. AGGREGATOR — computeClearing.
        // ===================================================================
        const clearingOrders: ClearingOrder[] = ordersForWitness.map((o) => ({
          side: o.side,
          amountIn: o.amount_in,
          limitPrice: o.limit_price,
          submittedAtBlock: o.submitted_at_block,
          orderNonce: o.order_nonce,
        }));

        const clearingResult = computeClearing(
          {
            reserveA: BigInt(poolState.reserve_a),
            reserveB: BigInt(poolState.reserve_b),
            lpSupply: BigInt(poolState.lp_supply),
          },
          clearingOrders,
        );

        assert.equal(clearingResult.cleared, true, "aggregator must find a clearing price");
        assert.equal(clearingResult.fills.length, 2, "both orders must be filled");

        // ===================================================================
        // 5. WITNESS — write Prover.toml.
        // ===================================================================
        const epoch: EpochState = {
          order_acc: epochResult.order_acc,
          cancel_acc: epochResult.cancel_acc,
          order_count: Number(epochResult.order_count),
          cancel_count: Number(epochResult.cancel_count),
        };
        const poolSnap: PoolSnapshotForCircuitSub2 = {
          reserve_a: BigInt(poolState.reserve_a),
          reserve_b: BigInt(poolState.reserve_b),
          current_sqrt_price_before: 0n,
        };

        const { proverToml } = await buildClearingWitness({
          epoch,
          pool: poolSnap,
          orders: ordersForWitness,
          cancellationIndices: [],
          clearing: clearingResult,
          bucketStatesBefore: [],
          bucketStatesAfter: [],
          bucketDeltas: [],
          currentSqrtPriceAfter: 0n,
          maxOrders: CIRCUIT_MAX_ORDERS,
        });

        const proverTomlPath = `${CIRCUIT_DIR}/Prover.toml`;
        writeFileSync(proverTomlPath, proverToml, "utf8");

        const execResult = spawnSync(
          "/bin/bash",
          [
            "-c",
            `source /root/.quetzal-env && cd ${CIRCUIT_DIR} && nargo execute --silence-warnings`,
          ],
          { encoding: "utf8", timeout: 5 * 60 * 1_000 },
        );
        if (execResult.status !== 0) {
          assert.fail([
            "nargo execute failed (witness/constraint mismatch):",
            "stdout:", execResult.stdout ?? "",
            "stderr:", execResult.stderr ?? "",
          ].join("\n"));
        }

        // ===================================================================
        // 6. PROVE — bb write_vk + bb prove.
        // ===================================================================
        const vkDir    = `${CIRCUIT_DIR}/target/vk`;
        const proofDir = `${CIRCUIT_DIR}/target/proofdir`;
        rmSync(vkDir,    { recursive: true, force: true });
        mkdirSync(vkDir, { recursive: true });
        rmSync(proofDir, { recursive: true, force: true });
        mkdirSync(proofDir, { recursive: true });

        const vkResult = spawnSync(
          BB_BIN,
          [
            "write_vk",
            "-b", `${CIRCUIT_DIR}/target/clearing.json`,
            "-o", vkDir,
            "-t", "noir-recursive",
          ],
          { encoding: "utf8", timeout: 10 * 60 * 1_000 },
        );
        if (vkResult.status !== 0) {
          assert.fail([
            "bb write_vk failed:",
            "stdout:", vkResult.stdout ?? "",
            "stderr:", vkResult.stderr ?? "",
          ].join("\n"));
        }
        const vkFile = `${vkDir}/vk`;

        const proveResult = spawnSync(
          BB_BIN,
          [
            "prove",
            "-b", `${CIRCUIT_DIR}/target/clearing.json`,
            "-w", `${CIRCUIT_DIR}/target/clearing.gz`,
            "-o", proofDir,
            "-k", vkFile,
          ],
          { encoding: "utf8", timeout: 40 * 60 * 1_000 },
        );
        if (proveResult.status !== 0) {
          assert.fail([
            "bb prove failed (likely RAM OOM at N=32; consider N=16 contingency):",
            `exit=${proveResult.status}`,
            "stdout:", proveResult.stdout ?? "",
            "stderr:", proveResult.stderr ?? "",
          ].join("\n"));
        }

        const proofFieldsFile = readProofAsFields(`${proofDir}/proof`);
        const vkFieldsFile    = readVkAsFields(vkFile);
        const proofFields = bridgeProofToContractSize(proofFieldsFile);
        const vkFields    = bridgeVkToContractSize(vkFieldsFile);
        assert.equal(proofFields.length, CONTRACT_PROOF_SIZE, "bridged proof length");
        assert.equal(vkFields.length,    CONTRACT_VK_SIZE,    "bridged vk length");

        // ===================================================================
        // 7. CANONICAL FILLS — re-derive using circuitPayout so the tree we
        //    build off-chain matches the one the circuit's witness builder
        //    constructed (which is what the on-chain root commits to).
        // ===================================================================
        const filledNonces = new Set(clearingResult.fills.map((f) => f.orderNonce));
        const canonicalFills: { orderNonce: bigint; amountOut: bigint }[] = [];
        for (const o of ordersForWitness) {
          if (filledNonces.has(o.order_nonce)) {
            canonicalFills.push({
              orderNonce: o.order_nonce,
              amountOut: circuitPayout(o, clearingResult.clearingPrice),
            });
          }
        }
        // Spec-check the canonical payouts against the documented constants.
        const aliceCanonical = canonicalFills.find((f) => f.orderNonce === buyNonce);
        const bobCanonical   = canonicalFills.find((f) => f.orderNonce === sellNonce);
        assert.ok(aliceCanonical, "alice's canonical fill present");
        assert.ok(bobCanonical,   "bob's canonical fill present");
        assert.equal(aliceCanonical!.amountOut, ALICE_EXPECTED_OUT,
          "alice canonical payout matches the documented value");
        assert.equal(bobCanonical!.amountOut, BOB_EXPECTED_OUT,
          "bob canonical payout matches the documented value");

        const publicInputsStruct = await buildPublicInputsStruct(
          epochResult, poolSnap, clearingResult, canonicalFills,
        );

        // ===================================================================
        // 8. MINE past expiry then CLOSE via verified flow.
        // ===================================================================
        while ((await currentBlock(node)) < Number(epochResult.closes_at_block)) {
          await tUSDC.methods.mint_to_public(admin, 1n).send({ from: admin });
        }

        await orderbook.methods
          .close_epoch_and_clear_verified(publicInputsStruct, proofFields, vkFields)
          .send({ from: admin });

        // Sanity: epoch advanced.
        const postEpochRaw = await orderbook.methods.get_epoch().simulate({ from: admin });
        const postEpoch = (postEpochRaw as {
          result: { epoch_id: bigint | number };
        }).result;
        assert.equal(
          Number(postEpoch.epoch_id), epochId + 1,
          "epoch_id must increment after close_epoch_and_clear_verified",
        );

        // ===================================================================
        // 9. SNAPSHOT — write the per-epoch Merkle tree to disk.
        // ===================================================================
        const fillsForSnapshot = canonicalFills.map((f) => ({
          order_nonce: new Fr(f.orderNonce),
          amount_out: f.amountOut,
        }));
        const tree = await buildFillsTree(fillsForSnapshot);
        // Cross-check the tree root matches what we passed as public_inputs.fills_root.
        assert.equal(
          tree.root.toBigInt(), publicInputsStruct.fills_root,
          "snapshot tree root must match the on-chain stored root",
        );
        writeSnapshot(snapshotsDir, {
          epoch_id: epochId,
          fills: fillsForSnapshot,
          tree,
        });

        // ===================================================================
        // 10. ALICE CLAIM — read snapshot, look up path, call claim_fill,
        //     assert her private tETH balance grew by ALICE_EXPECTED_OUT.
        // ===================================================================
        const snap = readSnapshot(snapshotsDir, epochId);
        const aliceNonceHex = new Fr(buyNonce).toString();
        const alicePath = snap.paths.get(aliceNonceHex);
        assert.ok(alicePath, "alice's inclusion path must be in the snapshot");

        const aliceBalBefore = await tETH.methods
          .balance_of_private(alice).simulate({ from: alice });
        const aliceBefore = BigInt((aliceBalBefore as { result: bigint | number }).result);

        await orderbook.methods
          .claim_fill(
            epochId,
            new Fr(buyNonce),
            0,   // hop_index: 0 for direct single-pool path
            ALICE_EXPECTED_OUT,
            0,   // pool_id: 0 for single-pool test
            alicePath!.leaf_index,
            alicePath!.siblings,
          )
          .send({ from: alice });

        const aliceBalAfter = await tETH.methods
          .balance_of_private(alice).simulate({ from: alice });
        const aliceAfter = BigInt((aliceBalAfter as { result: bigint | number }).result);
        assert.equal(
          aliceAfter - aliceBefore, ALICE_EXPECTED_OUT,
          "alice's private tETH balance must grow by ALICE_EXPECTED_OUT after claim_fill",
        );

        // ===================================================================
        // 11. BOB CLAIM — same flow on token A.
        // ===================================================================
        const bobNonceHex = new Fr(sellNonce).toString();
        const bobPath = snap.paths.get(bobNonceHex);
        assert.ok(bobPath, "bob's inclusion path must be in the snapshot");

        const bobBalBefore = await tUSDC.methods
          .balance_of_private(bob).simulate({ from: bob });
        const bobBefore = BigInt((bobBalBefore as { result: bigint | number }).result);

        await orderbook.methods
          .claim_fill(
            epochId,
            new Fr(sellNonce),
            0,   // hop_index: 0 for direct single-pool path
            BOB_EXPECTED_OUT,
            0,   // pool_id: 0 for single-pool test
            bobPath!.leaf_index,
            bobPath!.siblings,
          )
          .send({ from: bob });

        const bobBalAfter = await tUSDC.methods
          .balance_of_private(bob).simulate({ from: bob });
        const bobAfter = BigInt((bobBalAfter as { result: bigint | number }).result);
        assert.equal(
          bobAfter - bobBefore, BOB_EXPECTED_OUT,
          "bob's private tUSDC balance must grow by BOB_EXPECTED_OUT after claim_fill",
        );
      },
    );
  },
);
