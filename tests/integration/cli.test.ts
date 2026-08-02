import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync, rmSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { webcrypto } from "node:crypto";
import type { AztecAddress } from "@aztec/aztec.js/addresses";
import type { AztecNode } from "@aztec/aztec.js/node";
import type { EmbeddedWallet } from "@aztec/wallets/embedded";
import { Fr } from "@aztec/aztec.js/fields";

// Pool deploy-time parameters (canonical values from deploy-tokens.ts).
const _P_MIN_SQRT        = 100_000_000_000_000_000n; // 0.1e18
const _BUCKET_GROWTH_NUM = 1_500_000_000_000_000_000n; // 1.5e18
const _ZERO_ADDR = { address: 0n } as const;

import { connectToSandbox } from "./helpers/sandbox.js";
import { getTestWallets } from "./helpers/wallets.js";
import { TokenContract } from "./generated/Token.js";
import { OrderbookContract } from "./generated/Orderbook.js";
import { LiquidityPoolContract } from "./generated/LiquidityPool.js";
import {
  computeClearing,
  clearingAt,
  selectBatch,
  type ClearingOrder,
  type ClearingResult,
} from "../../aggregator/src/clearing.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../..");
const CLI_ENTRY = resolve(REPO_ROOT, "cli/src/index.ts");
const CONFIG_PATH = resolve(REPO_ROOT, "quetzal.config.cli-test.json");

const ONE_TUSDC = 10n ** 6n;
const ONE_TETH = 10n ** 18n;
const MINT = 1_000n * ONE_TUSDC;
const MINT_ETH = 10n * ONE_TETH; // 10 tETH — covers the 1 tETH deposit smoke test
const ORDER_AMOUNT = 100n * ONE_TUSDC;
const PRICE_2 = 2_000_000_000_000_000_000n;

/** Run the CLI as a child process from the repo root; return its stdout. */
function quetzal(...args: string[]): string {
  return execFileSync(
    process.execPath,
    ["--import", "tsx", CLI_ENTRY, "--config", CONFIG_PATH, ...args],
    { cwd: REPO_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
}

/** A random BN254 field element (31 random bytes stay under the field modulus). */
function randomField(): bigint {
  const buf = new Uint8Array(31);
  webcrypto.getRandomValues(buf);
  let n = 0n;
  for (const b of buf) n = (n << 8n) | BigInt(b);
  return n;
}

interface PoolStateRaw {
  reserve_a: bigint | number;
  reserve_b: bigint | number;
  lp_supply: bigint | number;
  cum_fee_a_per_share: bigint | number;
  cum_fee_b_per_share: bigint | number;
}

/**
 * Translate a `ClearingResult` into the ten-field `ClearingSwap` the contract expects.
 * Mirrors the same helper in clearing.test.ts.
 */
function buildClearingSwap(
  poolState: PoolStateRaw,
  orders: ClearingOrder[],
  result: ClearingResult,
) {
  const oldReserveA = BigInt(poolState.reserve_a);
  const oldReserveB = BigInt(poolState.reserve_b);

  const ev = clearingAt(
    {
      reserveA: oldReserveA,
      reserveB: oldReserveB,
      lpSupply: BigInt(poolState.lp_supply),
    },
    selectBatch(orders),
    result.clearingPrice,
  );
  const { swap } = ev;

  const deltaA = result.newReserveA - oldReserveA;
  const deltaB = result.newReserveB - oldReserveB;

  return {
    a_to_pool: swap.ammAIn,
    b_to_pool: swap.ammBIn,
    a_from_pool: swap.ammAOut,
    b_from_pool: swap.ammBOut,
    reserve_a_add: deltaA > 0n ? deltaA : 0n,
    reserve_a_sub: deltaA < 0n ? -deltaA : 0n,
    reserve_b_add: deltaB > 0n ? deltaB : 0n,
    reserve_b_sub: deltaB < 0n ? -deltaB : 0n,
    fee_a_per_share_increment: result.feeAPerShareIncrement,
    fee_b_per_share_increment: result.feeBPerShareIncrement,
  };
}

describe("cli smoke (live integration)", () => {
  let node: AztecNode;
  let wallet: EmbeddedWallet;
  let admin: AztecAddress;
  let tUSDC: TokenContract;
  let tETH: TokenContract;
  let orderbook: OrderbookContract;
  let pool: LiquidityPoolContract;

  before(async () => {
    node = await connectToSandbox();
    const env = await getTestWallets(node, 1);
    wallet = env.wallet;
    admin = env.accounts[0]!;

    const dU = await TokenContract.deployWithOpts(
      { wallet, method: "constructor_with_minter" },
      "tUSDC".padEnd(31, "\0"), "tUSDC".padEnd(31, "\0"), 6, admin,
    ).send({ from: admin });
    tUSDC = dU.contract;

    const dE = await TokenContract.deployWithOpts(
      { wallet, method: "constructor_with_minter" },
      "tETH".padEnd(31, "\0"), "tETH".padEnd(31, "\0"), 18, admin,
    ).send({ from: admin });
    tETH = dE.contract;

    const dP = await LiquidityPoolContract.deploy(
      wallet, tUSDC.address, tETH.address, _P_MIN_SQRT, _BUCKET_GROWTH_NUM, admin,
    ).send({ from: admin });
    pool = dP.contract;

    const dOB = await OrderbookContract.deploy(
      wallet, 8, Fr.ZERO, _ZERO_ADDR, 0n, 1,
      [pool.address, _ZERO_ADDR, _ZERO_ADDR, _ZERO_ADDR],
      [tUSDC.address, _ZERO_ADDR, _ZERO_ADDR, _ZERO_ADDR],
      [tETH.address, _ZERO_ADDR, _ZERO_ADDR, _ZERO_ADDR],
      admin,
    ).send({ from: admin });
    orderbook = dOB.contract;

    await pool.methods.set_orderbook(orderbook.address).send({ from: admin });

    await tUSDC.methods.mint_to_private(admin, MINT).send({ from: admin });
    await tETH.methods.mint_to_private(admin, MINT_ETH).send({ from: admin });

    writeFileSync(
      CONFIG_PATH,
      JSON.stringify(
        {
          nodeUrl: process.env.PXE_URL ?? process.env.AZTEC_NODE_URL ?? "http://localhost:8080",
          tUSDC: tUSDC.address.toString(),
          tETH: tETH.address.toString(),
          orderbook: orderbook.address.toString(),
          pool: pool.address.toString(),
          admin: admin.toString(),
        },
        null,
        2,
      ),
    );
  });

  after(async () => {
    rmSync(CONFIG_PATH, { force: true });
    const stop = (wallet as unknown as { stop?: () => Promise<void> }).stop;
    if (typeof stop === "function") await stop.call(wallet);
  });

  // Advance the L2 chain to `target` by sending cheap mint txs (each mines >=1 block).
  async function mineUntilBlock(target: number): Promise<void> {
    let guard = 0;
    while (Number(await node.getBlockNumber()) < target) {
      if (++guard > 50) throw new Error("mineUntilBlock: exceeded 50 txs");
      await tUSDC.methods.mint_to_public(admin, 1n).send({ from: admin });
    }
  }

  it("order -> orders -> cancel -> orders round-trip", { timeout: 600_000 }, () => {
    const orderOut = quetzal(
      "order", "--side", "buy", "--amount", ORDER_AMOUNT.toString(), "--limit", PRICE_2.toString(),
    );
    const nonceMatch = orderOut.match(/order nonce:\s*(0x[0-9a-fA-F]+)/);
    assert.ok(nonceMatch, `\`quetzal order\` should print an order nonce; got:\n${orderOut}`);
    const nonce = nonceMatch![1]!;

    const listed = quetzal("orders");
    assert.match(listed, new RegExp(nonce, "i"), "the new order must appear in `quetzal orders`");

    const cancelOut = quetzal("cancel", "--nonce", nonce);
    assert.match(cancelOut, /cancelled/i, "`quetzal cancel` should confirm cancellation");

    const afterCancel = quetzal("orders");
    assert.match(afterCancel, /no resting orders/i, "the order list must be empty after cancel");
  });

  it("close-epoch advances the epoch once it has expired", { timeout: 600_000 }, async () => {
    const before = (await orderbook.methods.get_epoch().simulate({ from: admin })) as {
      result: { epoch_id: bigint; closes_at_block: bigint };
    };
    await mineUntilBlock(Number(before.result.closes_at_block));

    const out = quetzal("close-epoch");
    assert.match(out, /epoch advanced/i, "`quetzal close-epoch` should confirm the advance");

    const after = (await orderbook.methods.get_epoch().simulate({ from: admin })) as {
      result: { epoch_id: bigint };
    };
    assert.equal(after.result.epoch_id, before.result.epoch_id + 1n, "epoch_id must increment");
  });

  it("deposit -> positions -> withdraw round-trip", { timeout: 600_000 }, async () => {
    const depositOut = quetzal(
      "deposit", "--amount-a", (1000n * 10n ** 6n).toString(), "--amount-b", (10n ** 18n).toString(),
    );
    const nonceMatch = depositOut.match(/position nonce:\s*(0x[0-9a-fA-F]+)/);
    assert.ok(nonceMatch, `\`quetzal deposit\` should print a position nonce; got:\n${depositOut}`);
    const nonce = nonceMatch![1]!;

    const listed = quetzal("positions");
    assert.match(listed, new RegExp(nonce, "i"), "the new position must appear in `quetzal positions`");

    const withdrawOut = quetzal("withdraw", "--nonce", nonce);
    assert.match(withdrawOut, /withdrawn/i, "`quetzal withdraw` should confirm the withdrawal");

    const afterList = quetzal("positions");
    assert.match(afterList, /no LP positions/i, "positions must be empty after withdraw");
  });

  // Audit #1: the old authority-gated close_epoch_and_clear(fills, swap) was removed in
  // favour of close_epoch_and_clear_verified (recursive-proof gated). This round-trip
  // can no longer clear+claim via the CLI without generating a real bb proof, so it is
  // skipped until rewired to the verified path (Docker-gated anyway). The body falls
  // back to close_epoch() purely so it still typechecks.
  it.skip("order -> clear -> claim round-trip via CLI", { timeout: 900_000 }, async () => {
    // Seed the pool with a balanced deposit so the aggregator can find a clearing price.
    // Use same-denomination units on both sides so spot = 1e18 (1:1 book).
    const POOL_AMOUNT = 500n * ONE_TUSDC; // small enough to stay within admin's balance
    const hint0Raw = (await pool.methods.get_pool_state().simulate({ from: admin })).result as { reserve_a: bigint | number; reserve_b: bigint | number; current_sqrt_price: bigint | number };
    const hint0PoolHint = { reserve_a: BigInt(hint0Raw.reserve_a), reserve_b: BigInt(hint0Raw.reserve_b), current_sqrt_price: BigInt(hint0Raw.current_sqrt_price) };
    const zeroBucketHint = { reserve_a: 0n, reserve_b: 0n, liquidity: 0n, cum_fee_a_per_share: 0n, cum_fee_b_per_share: 0n };
    await pool.methods
      .deposit(0n, POOL_AMOUNT, POOL_AMOUNT, hint0PoolHint, zeroBucketHint, randomField(), randomField(), randomField())
      .send({ from: admin });

    // Admin submits two crossing orders: a buy (pays tUSDC) and a sell (pays tETH).
    // Sizes and limits are set to guarantee they cross at the 1:1 spot price.
    const PRICE_1 = 1_000_000_000_000_000_000n; // 1.0 (1e18-scaled)
    const BUY_AMOUNT = 10n * ONE_TUSDC;          // admin pays tUSDC
    const SELL_AMOUNT = 10n * ONE_TUSDC;         // admin pays tETH, same 1e6 unit scale as tUSDC for the 1:1 book
    const buyNonce = randomField();
    const sellNonce = randomField();

    await orderbook.methods
      .submit_order(false, BUY_AMOUNT, 2n * PRICE_1, randomField(), buyNonce,
        2n, [tUSDC.address, tETH.address, Fr.ZERO])
      .send({ from: admin });
    await orderbook.methods
      .submit_order(true, SELL_AMOUNT, PRICE_1 / 2n, randomField(), sellNonce,
        2n, [tETH.address, tUSDC.address, Fr.ZERO])
      .send({ from: admin });

    // Run the off-chain aggregator.
    const poolState = (await pool.methods.get_pool_state().simulate({ from: admin })).result;
    const orders: ClearingOrder[] = [
      { side: false, amountIn: BUY_AMOUNT, limitPrice: 2n * PRICE_1, submittedAtBlock: 1, orderNonce: buyNonce },
      { side: true, amountIn: SELL_AMOUNT, limitPrice: PRICE_1 / 2n, submittedAtBlock: 2, orderNonce: sellNonce },
    ];
    const result = computeClearing(
      {
        reserveA: BigInt(poolState.reserve_a),
        reserveB: BigInt(poolState.reserve_b),
        lpSupply: BigInt(poolState.lp_supply),
      },
      orders,
    );
    assert.equal(result.cleared, true, "the aggregator should clear this crossing book");

    // Build the contract arguments.
    const fills = result.fills.map((f) => ({ order_nonce: f.orderNonce, amount_out: f.amountOut }));
    const swap = buildClearingSwap(poolState, orders, result);

    // Mine past epoch expiry.
    const epoch = (await orderbook.methods.get_epoch().simulate({ from: admin })).result;
    await mineUntilBlock(Number(epoch.closes_at_block));
    // close_epoch_and_clear was removed in Audit #1; replaced by close_epoch_and_clear_verified.
    // For this CLI smoke test the fills/swap args are no longer accepted; close_epoch() advances
    // the epoch (without on-chain fill records in the unverified path).
    void fills; void swap; // suppress unused-variable warnings
    await orderbook.methods.close_epoch().send({ from: admin });

    // The buy order (admin, account 0) should now be claimable via the CLI.
    const claimOut = quetzal("claim", "--nonce", `0x${buyNonce.toString(16)}`);
    assert.match(claimOut, /claimed [1-9]\d* output tokens/i, "`quetzal claim` should confirm the claimed amount");
  });
});
