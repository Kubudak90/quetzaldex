/**
 * E1 — clearing circuit end-to-end happy path.
 *
 * Deploys a fresh fixture on the live VPS stack, submits a perfectly-balanced
 * set of orders (1 buy + 1 sell at exact spot price balance, so netA == 0
 * and no AMM swap is needed). This design guarantees the AMM k-monotonicity
 * assertion in the circuit passes trivially (reserves unchanged).
 *
 * Order scenario:
 *   Pool:  10,000 tUSDC : 5,000 tETH (spot P* = 2e6, i.e. 2 * 1e6 tETH-units per tUSDC-unit)
 *   Buy:   100 tUSDC (1e8 raw units), limit_price = 1e19 (well above spot)
 *   Sell:  50 tETH  (5e19 raw units), limit_price = 1    (well below spot)
 *   netA:  1e8 - floor(5e19 * 2e6 / 1e18) = 1e8 - 1e8 = 0  → no AMM swap
 *
 * After clearing, the witness is written to the VPS, then nargo execute +
 * bb prove --verify are run. The test asserts proof verification.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { spawnSync } from "node:child_process";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import type { AztecAddress } from "@aztec/aztec.js/addresses";
import type { AztecNode } from "@aztec/aztec.js/node";
import type { EmbeddedWallet } from "@aztec/wallets/embedded";
import { Fr } from "@aztec/aztec.js/fields";

import { connectToSandbox } from "./helpers/sandbox.js";
import { getTestWallets } from "./helpers/wallets.js";
import { readProofAsFields } from "./helpers/proof.js";
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

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Use the smaller test circuit (MAX_ORDERS_PER_EPOCH=4) to stay within VPS memory limits.
// The full circuit (MAX=128, ~904K gates) requires >8GB RAM to prove; the test circuit
// (MAX=4, ~13K gates) is structurally identical and proves in seconds.
const CIRCUIT_DIR = "/root/quetzal/circuits/clearing-test";
const CIRCUIT_MAX_ORDERS = 4;  // Must match clearing-test/src/types.nr MAX_ORDERS_PER_EPOCH
// The host-installed bb binary (amd64-linux, no Docker overhead).
const BB_BIN =
  "/root/.aztec/versions/4.2.1/node_modules/@aztec/bb.js/build/amd64-linux/bb";

const ONE_USDC = 10n ** 6n;
const ONE_ETH = 10n ** 18n;

// Pool: 10,000 tUSDC : 5,000 tETH → spot = reserveA * SCALE / reserveB
//   = (10000 * 1e6) * 1e18 / (5000 * 1e18) = 10e9 / 5e3 = 2_000_000 = 2e6
// So the spot price is 2e6 (in the circuit's 1e18-scaled tETH-per-tUSDC units).
const POOL_A = 10_000n * ONE_USDC;   // 10,000 tUSDC = 1e10 raw units
const POOL_B = 5_000n * ONE_ETH;     // 5,000 tETH  = 5e21 raw units

// Balanced order pair at spot P* = 2e6:
//   gross_buy_in_a = 100 tUSDC = 1e8 raw units
//   gross_sell_in_b = 50 tETH  = 5e19 raw units
//   netA = 1e8 - floor(5e19 * 2e6 / 1e18) = 1e8 - 1e8 = 0  (exact balance)
const BUY_USDC  = 100n * ONE_USDC;   // 100 tUSDC = 1e8 raw units
const SELL_ETH  = 50n * ONE_ETH;     // 50 tETH   = 5e19 raw units
// spot = 2_000_000n (reserveA * SCALE / reserveB); clearing price converges near this value.

// Limit prices: generous limits so both orders are eligible at spot.
const BUY_LIMIT  = 10_000_000_000_000_000_000n;  // 1e19 (buy limit >> spot 2e6 → eligible)
const SELL_LIMIT = 1n;                            // 1    (sell limit << spot 2e6 → eligible)

// Epoch length large enough to survive all submits before we expire it.
const EPOCH_LEN = 10_000;

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

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe(
  "clearing circuit E2E (live integration)",
  { timeout: 30 * 60 * 1_000 }, // 30 min total
  () => {
    let node: AztecNode;
    let wallet: EmbeddedWallet;
    let admin: AztecAddress;
    let alice: AztecAddress;   // buyer
    let bob: AztecAddress;     // seller
    let tUSDC: TokenContract;
    let tETH: TokenContract;
    let pool: LiquidityPoolContract;
    let orderbook: OrderbookContract;

    before(async () => {
      node = await connectToSandbox();
      // 3 accounts: admin (minter + LP + clearing authority), alice (buyer), bob (seller)
      const env = await getTestWallets(node, 3);
      wallet = env.wallet;
      admin = env.accounts[0]!;
      alice = env.accounts[1]!;
      bob   = env.accounts[2]!;

      // Deploy fresh tUSDC token.
      const dU = await TokenContract.deployWithOpts(
        { wallet, method: "constructor_with_minter" },
        "tUSDC".padEnd(31, "\0"), "tUSDC".padEnd(31, "\0"), 6, admin,
      ).send({ from: admin });
      tUSDC = dU.contract;

      // Deploy fresh tETH token.
      const dE = await TokenContract.deployWithOpts(
        { wallet, method: "constructor_with_minter" },
        "tETH".padEnd(31, "\0"), "tETH".padEnd(31, "\0"), 18, admin,
      ).send({ from: admin });
      tETH = dE.contract;

      // Deploy LiquidityPool.
      const P_MIN_SQRT        = 100_000_000_000_000_000n; // 0.1e18
      const BUCKET_GROWTH_NUM = 1_500_000_000_000_000_000n; // 1.5e18
      const ZERO_ADDR = { address: 0n } as const;
      const dP = await LiquidityPoolContract.deploy(wallet, tUSDC.address, tETH.address, P_MIN_SQRT, BUCKET_GROWTH_NUM, admin)
        .send({ from: admin });
      pool = dP.contract;

      // Deploy Orderbook.
      const dOB = await OrderbookContract.deploy(
        wallet, EPOCH_LEN, Fr.ZERO, ZERO_ADDR, 0n, 1,
        [pool.address, ZERO_ADDR, ZERO_ADDR, ZERO_ADDR],
        [tUSDC.address, ZERO_ADDR, ZERO_ADDR, ZERO_ADDR],
        [tETH.address, ZERO_ADDR, ZERO_ADDR, ZERO_ADDR],
        admin,
      ).send({ from: admin });
      orderbook = dOB.contract;

      // Wire pool → orderbook (apply_clearing checks msg_sender == orderbook_addr).
      await pool.methods.set_orderbook(orderbook.address).send({ from: admin });

      // Seed admin (LP) with tUSDC + tETH for the pool deposit.
      await tUSDC.methods.mint_to_private(admin, POOL_A + 1_000n * ONE_USDC).send({ from: admin });
      await tETH.methods.mint_to_private(admin, POOL_B + 100n * ONE_ETH).send({ from: admin });

      // Seed alice (buyer) with tUSDC.
      await tUSDC.methods.mint_to_private(alice, BUY_USDC + ONE_USDC).send({ from: admin });
      // Seed bob (seller) with tETH.
      await tETH.methods.mint_to_private(bob, SELL_ETH + ONE_ETH).send({ from: admin });

      // Admin deposits POOL_A tUSDC + POOL_B tETH into the pool.
      const hint0Raw = (await pool.methods.get_pool_state().simulate({ from: admin })).result as { reserve_a: bigint | number; reserve_b: bigint | number; current_sqrt_price: bigint | number };
      const hint0PoolHint = { reserve_a: BigInt(hint0Raw.reserve_a), reserve_b: BigInt(hint0Raw.reserve_b), current_sqrt_price: BigInt(hint0Raw.current_sqrt_price) };
      const zeroBucketHint = { reserve_a: 0n, reserve_b: 0n, liquidity: 0n, cum_fee_a_per_share: 0n, cum_fee_b_per_share: 0n };
      await pool.methods
        .deposit(0n, POOL_A, POOL_B, hint0PoolHint, zeroBucketHint, randomField(), randomField(), randomField())
        .send({ from: admin });
    });

    after(async () => {
      const stop = (wallet as unknown as { stop?: () => Promise<void> }).stop;
      if (typeof stop === "function") await stop.call(wallet);
    });

    it(
      "E1: balanced buy+sell epoch → nargo execute + bb prove --verify",
      { timeout: 28 * 60 * 1_000 }, // 28 min per test
      async () => {
        // ---------------------------------------------------------------
        // 1. Submit one buy (alice) and one sell (bob)
        //    Both have generous limits → eligible at spot P*=2e6.
        //    netA = BUY_USDC - floor(SELL_ETH * SPOT / 1e18) = 1e8 - 1e8 = 0.
        // ---------------------------------------------------------------
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

        // ---------------------------------------------------------------
        // 2. Read alice's and bob's order notes
        // ---------------------------------------------------------------
        const aliceRaw = await orderbook.methods.get_orders(alice).simulate({ from: alice });
        const aliceBv = (aliceRaw as {
          result: { storage: OrderNoteFields[]; len: bigint | number };
        }).result;
        const aliceLen = Number(aliceBv.len);
        assert.ok(aliceLen >= 1, "alice should have at least 1 order");
        const aliceNote = aliceBv.storage.slice(0, aliceLen)
          .find((n) => BigInt(n.nonce) === buyNonce);
        assert.ok(aliceNote, "alice's buy order note not found");

        const bobRaw = await orderbook.methods.get_orders(bob).simulate({ from: bob });
        const bobBv = (bobRaw as {
          result: { storage: OrderNoteFields[]; len: bigint | number };
        }).result;
        const bobLen = Number(bobBv.len);
        assert.ok(bobLen >= 1, "bob should have at least 1 order");
        const bobNote = bobBv.storage.slice(0, bobLen)
          .find((n) => BigInt(n.nonce) === sellNonce);
        assert.ok(bobNote, "bob's sell order note not found");

        // ---------------------------------------------------------------
        // 3. Read epoch state and pool snapshot
        // ---------------------------------------------------------------
        const epochRaw = await orderbook.methods.get_epoch().simulate({ from: admin });
        const epochResult = (epochRaw as {
          result: {
            order_acc: bigint;
            cancel_acc: bigint;
            order_count: bigint | number;
            cancel_count: bigint | number;
            closes_at_block: bigint;
          };
        }).result;

        const poolStateRaw = await pool.methods.get_pool_state().simulate({ from: admin });
        const poolState = poolStateRaw.result;

        // ---------------------------------------------------------------
        // 4. Build orders[] sorted by submission order (submitted_at_block, then nonce)
        //    — the circuit's binding module replays the order_acc chain in this order.
        // ---------------------------------------------------------------
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

        // ---------------------------------------------------------------
        // 5. Run the off-chain aggregator
        // ---------------------------------------------------------------
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
        assert.equal(
          clearingResult.fills.length, 2,
          "both orders (buy + sell) must be filled",
        );

        // Log the clearing price for diagnostics (netA=0 → should equal spot ~2e6,
        // but we don't assert exact equality in case of small rounding at pool margins).
        console.log(`clearing price: ${clearingResult.clearingPrice}, pool reserves: a=${poolState.reserve_a} b=${poolState.reserve_b} lp=${poolState.lp_supply}`);

        // ---------------------------------------------------------------
        // 6. Build the Prover.toml witness
        // ---------------------------------------------------------------
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

        // ---------------------------------------------------------------
        // 7. Write Prover.toml directly to the circuit directory
        // ---------------------------------------------------------------
        const proverTomlPath = `${CIRCUIT_DIR}/Prover.toml`;
        writeFileSync(proverTomlPath, proverToml, "utf8");
        console.log(`Wrote Prover.toml to ${proverTomlPath}`);

        // ---------------------------------------------------------------
        // 8. Run nargo execute directly (env sourced via shell -c)
        // ---------------------------------------------------------------
        const execResult = spawnSync(
          "/bin/bash",
          [
            "-c",
            `source /root/.quetzal-env && cd ${CIRCUIT_DIR} && nargo execute --silence-warnings`,
          ],
          { encoding: "utf8", timeout: 5 * 60 * 1_000 },
        );
        if (execResult.status !== 0) {
          const msg = [
            "nargo execute failed (likely witness/constraint mismatch):",
            "stdout:", execResult.stdout ?? "",
            "stderr:", execResult.stderr ?? "",
          ].join("\n");
          assert.fail(msg);
        }

        // ---------------------------------------------------------------
        // 9a. Write the verification key
        //   write_vk -o <dir> writes <dir>/vk and <dir>/vk_hash.
        //   We recreate the vk dir to ensure a clean state.
        // ---------------------------------------------------------------
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
            "-b", `${CIRCUIT_DIR}/target/clearing_test.json`,
            "-o", vkDir,
          ],
          { encoding: "utf8", timeout: 5 * 60 * 1_000 },
        );
        if (vkResult.status !== 0) {
          const msg = [
            "bb write_vk failed:",
            "stdout:", vkResult.stdout ?? "",
            "stderr:", vkResult.stderr ?? "",
          ].join("\n");
          assert.fail(msg);
        }
        // bb write_vk writes <vkDir>/vk; use that exact file for prove/verify.
        const vkFile = `${vkDir}/vk`;

        // ---------------------------------------------------------------
        // 9b. Generate the proof
        //   prove -o <dir> -k <vk-file> writes <dir>/proof and <dir>/public_inputs.
        // ---------------------------------------------------------------
        const proveResult = spawnSync(
          BB_BIN,
          [
            "prove",
            "-b", `${CIRCUIT_DIR}/target/clearing_test.json`,
            "-w", `${CIRCUIT_DIR}/target/clearing_test.gz`,
            "-o", proofDir,
            "-k", vkFile,
          ],
          { encoding: "utf8", timeout: 20 * 60 * 1_000 },
        );
        if (proveResult.status !== 0) {
          const msg = [
            "bb prove failed:",
            "stdout:", proveResult.stdout ?? "",
            "stderr:", proveResult.stderr ?? "",
          ].join("\n");
          assert.fail(msg);
        }

        // Parse the binary proof file into Fr[] using the shared helper.
        // This validates the proof byte-length and verifies Fr.fromBuffer works
        // for all 456 fields — the same call that close_epoch_and_clear_verified uses.
        const proofFields = readProofAsFields(`${proofDir}/proof`);
        assert.equal(proofFields.length, 500, "proof must deserialise to exactly 500 Fr fields");
        console.log(`proof parsed: ${proofFields.length} Fr fields (first: ${proofFields[0]?.toString()})`);

        // ---------------------------------------------------------------
        // 9c. Verify the proof
        //   verify -k <vk-file> -p <proof-file> -i <public_inputs-file>
        // ---------------------------------------------------------------
        const verifyResult = spawnSync(
          BB_BIN,
          [
            "verify",
            "-k", vkFile,
            "-p", `${proofDir}/proof`,
            "-i", `${proofDir}/public_inputs`,
          ],
          { encoding: "utf8", timeout: 5 * 60 * 1_000 },
        );
        if (verifyResult.status !== 0) {
          const msg = [
            "bb verify failed:",
            "stdout:", verifyResult.stdout ?? "",
            "stderr:", verifyResult.stderr ?? "",
          ].join("\n");
          assert.fail(msg);
        }

        // Proof verified successfully.
        assert.ok(true, "bb verify exited 0 — proof is valid");
      },
    );

    it(
      "E2: tampered fills[0].amount_out makes bb prove --verify reject",
      { timeout: 28 * 60 * 1_000 }, // 28 min per test
      async () => {
        // ---------------------------------------------------------------
        // 1. Re-seed alice + bob for a second round of orders.
        //    E1 spent their initial balances; mint fresh tokens so E2 can
        //    submit_order without a "Balance too low" revert.
        // ---------------------------------------------------------------
        await tUSDC.methods.mint_to_private(alice, BUY_USDC + ONE_USDC).send({ from: admin });
        await tETH.methods.mint_to_private(bob, SELL_ETH + ONE_ETH).send({ from: admin });

        // ---------------------------------------------------------------
        // 3. Submit one buy (alice) and one sell (bob)
        //    Identical order scenario to E1 — perfectly balanced at spot P*=2e6.
        // ---------------------------------------------------------------
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

        // ---------------------------------------------------------------
        // 4. Read ALL of alice's and bob's order notes (E1 + E2 notes, cumulative).
        //    The epoch accumulator now covers all submitted orders; the witness
        //    builder requires orders.length == epoch.order_count.
        // ---------------------------------------------------------------
        const aliceRaw2 = await orderbook.methods.get_orders(alice).simulate({ from: alice });
        const aliceBv2 = (aliceRaw2 as {
          result: { storage: OrderNoteFields[]; len: bigint | number };
        }).result;
        const aliceLen2 = Number(aliceBv2.len);
        assert.ok(aliceLen2 >= 2, `alice should have at least 2 orders (E1+E2), got ${aliceLen2}`);
        const aliceNotes2 = aliceBv2.storage.slice(0, aliceLen2);

        const bobRaw2 = await orderbook.methods.get_orders(bob).simulate({ from: bob });
        const bobBv2 = (bobRaw2 as {
          result: { storage: OrderNoteFields[]; len: bigint | number };
        }).result;
        const bobLen2 = Number(bobBv2.len);
        assert.ok(bobLen2 >= 2, `bob should have at least 2 orders (E1+E2), got ${bobLen2}`);
        const bobNotes2 = bobBv2.storage.slice(0, bobLen2);

        // Spot-check: E2's new orders are present.
        assert.ok(aliceNotes2.find((n) => BigInt(n.nonce) === buyNonce), "alice's E2 buy order note not found");
        assert.ok(bobNotes2.find((n) => BigInt(n.nonce) === sellNonce), "bob's E2 sell order note not found");

        // ---------------------------------------------------------------
        // 5. Read epoch state and pool snapshot
        // ---------------------------------------------------------------
        const epochRaw2 = await orderbook.methods.get_epoch().simulate({ from: admin });
        const epochResult2 = (epochRaw2 as {
          result: {
            order_acc: bigint;
            cancel_acc: bigint;
            order_count: bigint | number;
            cancel_count: bigint | number;
            closes_at_block: bigint;
          };
        }).result;

        const poolStateRaw2 = await pool.methods.get_pool_state().simulate({ from: admin });
        const poolState2 = poolStateRaw2.result;

        // ---------------------------------------------------------------
        // 6. Build orders[] from ALL notes (E1 + E2), sorted by submission order.
        //    Order count is 4 (2 from E1 + 2 from E2).
        // ---------------------------------------------------------------
        const allNotes2: OrderNotePreimage[] = [
          ...aliceNotes2.map((n) => ({
            side: false,
            amount_in: BigInt(n.amount_in),
            limit_price: BigInt(n.limit_price),
            order_nonce: BigInt(n.nonce),
            submitted_at_block: Number(n.submitted_at_block),
            owner: BigInt(n.owner),
          })),
          ...bobNotes2.map((n) => ({
            side: true,
            amount_in: BigInt(n.amount_in),
            limit_price: BigInt(n.limit_price),
            order_nonce: BigInt(n.nonce),
            submitted_at_block: Number(n.submitted_at_block),
            owner: BigInt(n.owner),
          })),
        ].sort((a, b) => {
          if (a.submitted_at_block !== b.submitted_at_block)
            return a.submitted_at_block - b.submitted_at_block;
          return a.order_nonce < b.order_nonce ? -1 : a.order_nonce > b.order_nonce ? 1 : 0;
        });

        assert.equal(
          allNotes2.length, Number(epochResult2.order_count),
          `orders array length (${allNotes2.length}) must match epoch.order_count (${epochResult2.order_count})`,
        );

        // ---------------------------------------------------------------
        // 7. Run the off-chain aggregator over ALL 4 orders
        // ---------------------------------------------------------------
        const clearingOrders2: ClearingOrder[] = allNotes2.map((o) => ({
          side: o.side,
          amountIn: o.amount_in,
          limitPrice: o.limit_price,
          submittedAtBlock: o.submitted_at_block,
          orderNonce: o.order_nonce,
        }));

        const clearingResult2 = computeClearing(
          {
            reserveA: BigInt(poolState2.reserve_a),
            reserveB: BigInt(poolState2.reserve_b),
            lpSupply: BigInt(poolState2.lp_supply),
          },
          clearingOrders2,
        );

        assert.equal(clearingResult2.cleared, true, "aggregator must find a clearing price (E2)");
        // 4 orders total (2 buys + 2 sells), all balanced → 4 fills expected
        assert.equal(
          clearingResult2.fills.length, 4,
          "all 4 orders (2 buys + 2 sells across E1+E2) must be filled",
        );

        const ordersForWitness2 = allNotes2;

        // ---------------------------------------------------------------
        // 8. Build the Prover.toml witness
        // ---------------------------------------------------------------
        const epoch2: EpochState = {
          order_acc: epochResult2.order_acc,
          cancel_acc: epochResult2.cancel_acc,
          order_count: Number(epochResult2.order_count),
          cancel_count: Number(epochResult2.cancel_count),
        };
        const poolSnap2: PoolSnapshotForCircuitSub2 = {
          reserve_a: BigInt(poolState2.reserve_a),
          reserve_b: BigInt(poolState2.reserve_b),
          current_sqrt_price_before: 0n,
        };

        const { proverToml: proverTomlOriginal } = await buildClearingWitness({
          epoch: epoch2,
          pool: poolSnap2,
          orders: ordersForWitness2,
          cancellationIndices: [],
          clearing: clearingResult2,
          bucketStatesBefore: [],
          bucketStatesAfter: [],
          bucketDeltas: [],
          currentSqrtPriceAfter: 0n,
          maxOrders: CIRCUIT_MAX_ORDERS,
        });

        // ---------------------------------------------------------------
        // 9. Tamper: bump fills[0].amount_out by 1 in the TOML string
        //    The regex matches the first `amount_out = "<digits>"` occurrence
        //    in the serialised Prover.toml (which belongs to fills[0]).
        // ---------------------------------------------------------------
        const tampered = proverTomlOriginal.replace(
          /(amount_out\s*=\s*")(\d+)(")/,  // first match only → fills[0].amount_out
          (_match, prefix: string, num: string, suffix: string) => {
            return `${prefix}${BigInt(num) + 1n}${suffix}`;
          },
        );
        if (tampered === proverTomlOriginal) {
          throw new Error(
            "Tampering regex did not match — Prover.toml format may have changed. " +
            "Check that buildClearingWitness emits `amount_out = \"<n>\"` in the fills section.",
          );
        }
        console.log("E2: Prover.toml tampered — fills[0].amount_out bumped by 1");

        // ---------------------------------------------------------------
        // 10. Write the TAMPERED Prover.toml to the circuit directory
        // ---------------------------------------------------------------
        const proverTomlPath2 = `${CIRCUIT_DIR}/Prover.toml`;
        writeFileSync(proverTomlPath2, tampered, "utf8");
        console.log(`E2: Wrote tampered Prover.toml to ${proverTomlPath2}`);

        // ---------------------------------------------------------------
        // 11. Run nargo execute with the tampered witness.
        //    The circuit's per-fill payout assertion should fail here
        //    (constraint violation during witness generation).
        //    If nargo execute somehow passes, bb prove must reject.
        // ---------------------------------------------------------------
        const execResult2 = spawnSync(
          "/bin/bash",
          [
            "-c",
            `source /root/.quetzal-env && cd ${CIRCUIT_DIR} && nargo execute --silence-warnings`,
          ],
          { encoding: "utf8", timeout: 5 * 60 * 1_000 },
        );

        if (execResult2.status !== 0) {
          // Expected path: nargo execute rejects the tampered witness.
          console.log(
            "E2 PASS (nargo execute rejected tampered witness):",
            execResult2.stderr?.slice(0, 500) ?? execResult2.stdout?.slice(0, 500),
          );
          assert.ok(true, "nargo execute correctly rejected the tampered Prover.toml");
          return;
        }

        // nargo execute unexpectedly passed — try bb prove (must reject).
        console.log("E2: nargo execute passed unexpectedly; trying bb prove to force rejection...");

        const vkDir2    = `${CIRCUIT_DIR}/target/vk`;
        const proofDir2 = `${CIRCUIT_DIR}/target/proofdir-tampered`;
        rmSync(proofDir2, { recursive: true, force: true });
        mkdirSync(proofDir2, { recursive: true });

        const vkResult2 = spawnSync(
          BB_BIN,
          [
            "write_vk",
            "-b", `${CIRCUIT_DIR}/target/clearing_test.json`,
            "-o", vkDir2,
          ],
          { encoding: "utf8", timeout: 5 * 60 * 1_000 },
        );
        // Non-fatal if vk already exists — proceed regardless.
        const vkFile2 = `${vkDir2}/vk`;

        const proveResult2 = spawnSync(
          BB_BIN,
          [
            "prove",
            "-b", `${CIRCUIT_DIR}/target/clearing_test.json`,
            "-w", `${CIRCUIT_DIR}/target/clearing_test.gz`,
            "-o", proofDir2,
            "-k", vkFile2,
          ],
          { encoding: "utf8", timeout: 20 * 60 * 1_000 },
        );

        if (proveResult2.status !== 0) {
          console.log(
            "E2 PASS (bb prove rejected tampered witness):",
            proveResult2.stderr?.slice(0, 500) ?? proveResult2.stdout?.slice(0, 500),
          );
          assert.ok(true, "bb prove correctly rejected the tampered witness");
          return;
        }

        // Attempt verify — if prove somehow generated an artifact, verify must reject.
        const verifyResult2 = spawnSync(
          BB_BIN,
          [
            "verify",
            "-k", vkFile2,
            "-p", `${proofDir2}/proof`,
            "-i", `${proofDir2}/public_inputs`,
          ],
          { encoding: "utf8", timeout: 5 * 60 * 1_000 },
        );

        assert.notEqual(
          verifyResult2.status, 0,
          "bb verify must reject the tampered proof — the pipeline should NOT produce a valid proof " +
          "for a tampered witness. Either nargo execute, bb prove, or bb verify must exit non-zero.",
        );

        console.log("E2 PASS (bb verify rejected tampered proof)");
      },
    );
  },
);

// ---------------------------------------------------------------------------
// Type helpers (avoid repeating the complex cast inline)
// ---------------------------------------------------------------------------

interface OrderNoteFields {
  side: boolean;
  amount_in: bigint | number;
  limit_price: bigint | number;
  nonce: bigint | number;
  submitted_at_block: bigint | number;
  owner: bigint | number;
}
