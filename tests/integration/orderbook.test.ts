import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import type { AztecAddress } from "@aztec/aztec.js/addresses";
import type { AztecNode } from "@aztec/aztec.js/node";
import type { EmbeddedWallet } from "@aztec/wallets/embedded";
import { Fr } from "@aztec/aztec.js/fields";
import { poseidon2Hash } from "@aztec/foundation/crypto/poseidon";
import { computeCi } from "../../aggregator/src/validate.js";

// Pool deploy-time parameters (canonical values from deploy-tokens.ts).
const P_MIN_SQRT        = 100_000_000_000_000_000n; // 0.1e18
const BUCKET_GROWTH_NUM = 1_500_000_000_000_000_000n; // 1.5e18

// Zero sentinel for unused slots in the Orderbook fixed-length [AztecAddress; 4] arrays.
const ZERO_ADDR = { address: 0n } as const;

import { connectToSandbox } from "./helpers/sandbox.js";
import { getTestWallets } from "./helpers/wallets.js";

import { TokenContract } from "./generated/Token.js";
import { OrderbookContract } from "./generated/Orderbook.js";
import { LiquidityPoolContract } from "./generated/LiquidityPool.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// `side` semantics inside the Orderbook contract:
//   false (bid) => deposit token A (tUSDC) - we call this "A->B"
//   true  (ask) => deposit token B (tETH)  - we call this "B->A"
const SIDE_A_TO_B = false;
const SIDE_B_TO_A = true;

// Q-format quote-per-base price scaled to 1e18. We use 2.0 throughout (the value is
// not checked for sanity by submit_order beyond being > 0, so any positive value works).
const PRICE_2 = 2_000_000_000_000_000_000n;

const TUSDC_NAME = "tUSDC".padEnd(31, "\0");
const TUSDC_SYMBOL = "tUSDC".padEnd(31, "\0");
const TUSDC_DECIMALS = 6;
const ONE_TUSDC = 10n ** BigInt(TUSDC_DECIMALS);

const TETH_NAME = "tETH".padEnd(31, "\0");
const TETH_SYMBOL = "tETH".padEnd(31, "\0");
const TETH_DECIMALS = 18;
const ONE_TETH = 10n ** BigInt(TETH_DECIMALS);

// Initial mints to alice. tUSDC is the only token alice will spend across the suite,
// so we keep a tight budget on her to make the "insufficient balance" test meaningful.
const MINT_ALICE_TUSDC = 1_000n * ONE_TUSDC;  // 1,000 tUSDC == 1_000_000_000
const MINT_ALICE_TETH  = 5n * ONE_TETH;       // 5 tETH    == 5_000_000_000_000_000_000

// Order amounts.
const ORDER1_USDC = 100n * ONE_TUSDC;         // 100 tUSDC
const ORDER2_ETH  = 2n * ONE_TETH;            // 2 tETH
const ORDER3_USDC_HUGE = 5_000n * ONE_TUSDC;  // 5,000 tUSDC (exceeds remaining balance)
const ORDER4A_USDC = 50n * ONE_TUSDC;         // 50 tUSDC
const ORDER4B_USDC = 75n * ONE_TUSDC;         // 75 tUSDC

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function randomField(): bigint {
  // 31 random bytes fit safely under BN254 field modulus.
  const buf = new Uint8Array(31);
  webcrypto.getRandomValues(buf);
  let n = 0n;
  for (const byte of buf) n = (n << 8n) | BigInt(byte);
  return n;
}

// `get_orders` returns a Noir BoundedVec<OrderNote, 10>. The ABI decoder
// deserialises it as { storage: OrderNote[10], len: bigint }.  Pass
// `sim.result` (the unwrapped simulation return value) directly here.
function extractNonces(boundedVec: unknown): bigint[] {
  const bv = boundedVec as { storage: { nonce: bigint | number }[]; len: bigint | number };
  const len = Number(bv.len);
  return bv.storage.slice(0, len).map((o) => BigInt(o.nonce));
}

async function readPrivateBalance(
  token: TokenContract,
  owner: AztecAddress,
): Promise<bigint> {
  const sim = await token.methods.balance_of_private(owner).simulate({ from: owner });
  return BigInt(sim.result as bigint | number);
}

async function readPublicBalance(
  token: TokenContract,
  owner: AztecAddress,
  from: AztecAddress,
): Promise<bigint> {
  // public `#[view]` reads do not require the caller to own private state, but the
  // simulate path still needs a `from`. Reuse the test's admin/alice to drive it.
  const sim = await token.methods.balance_of_public(owner).simulate({ from });
  return BigInt(sim.result as bigint | number);
}

// Advance the L2 chain until its block height reaches `target`, by sending cheap
// txs (each mints 1 unit to `minter`, mining at least one block). `node.getBlockNumber`
// is the standard Aztec node RPC for the current height.
// Uses mint_to_public to avoid exhausting the PXE's private note tagging window.
async function mineUntilBlock(
  node: AztecNode,
  token: TokenContract,
  minter: AztecAddress,
  target: number,
): Promise<void> {
  let guard = 0;
  while (Number(await node.getBlockNumber()) < target) {
    if (++guard > 50) throw new Error("mineUntilBlock: exceeded 50 txs without reaching target");
    await token.methods.mint_to_public(minter, 1n).send({ from: minter });
  }
}

/**
 * Audit #2 unified per-order hiding commitment c_i. Mirrors the 10-field formula in
 * aggregator/src/validate.ts::computeCi. Inputs MUST be in the exact field order the
 * contract uses; otherwise the recomputed acc' will not match.
 *
 * Noir: poseidon2_hash([owner, side(0/1), amount_in, limit_price, order_nonce,
 *                       submitted_at_block, path_len, path[0], path[1], path[2]])
 */
async function orderCommitment(args: {
  owner: AztecAddress;
  side: boolean;
  amountIn: bigint;
  limitPrice: bigint;
  orderNonce: bigint | Fr;
  submittedAtBlock: number;
  pathLen?: number;
  path?: [bigint, bigint, bigint];
}): Promise<Fr> {
  return computeCi({
    owner: args.owner.toField().toBigInt(),
    side: args.side,
    amount_in: args.amountIn,
    limit_price: args.limitPrice,
    order_nonce: typeof args.orderNonce === "bigint" ? args.orderNonce : args.orderNonce.toBigInt(),
    submitted_at_block: args.submittedAtBlock,
    path_len: args.pathLen ?? 2,
    path: args.path ?? [0n, 0n, 0n],
  });
}

/** acc' = poseidon2([acc, c_i]); the running-hash fold used by _append_order. */
async function foldChain(acc: Fr, c: Fr): Promise<Fr> {
  return poseidon2Hash([acc, c]);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("orderbook (live integration)", () => {
  let node: AztecNode;
  let wallet: EmbeddedWallet;
  let admin: AztecAddress;
  let alice: AztecAddress;
  let tUSDC: TokenContract;
  let tETH: TokenContract;
  let orderbook: OrderbookContract;

  before(async () => {
    node = await connectToSandbox();
    const env = await getTestWallets(node, 2);
    wallet = env.wallet;
    admin = env.accounts[0]!;
    alice = env.accounts[1]!;

    // Deploy two unified Token contracts. Admin is the minter so the suite can seed alice.
    const deployedUSDC = await TokenContract.deployWithOpts(
      { wallet, method: "constructor_with_minter" },
      TUSDC_NAME,
      TUSDC_SYMBOL,
      TUSDC_DECIMALS,
      admin,
    ).send({ from: admin });
    tUSDC = deployedUSDC.contract;

    const deployedETH = await TokenContract.deployWithOpts(
      { wallet, method: "constructor_with_minter" },
      TETH_NAME,
      TETH_SYMBOL,
      TETH_DECIMALS,
      admin,
    ).send({ from: admin });
    tETH = deployedETH.contract;

    // Deploy the pool first (orderbook needs pool_addr at construction time).
    const dPool = await LiquidityPoolContract.deploy(wallet, tUSDC.address, tETH.address, P_MIN_SQRT, BUCKET_GROWTH_NUM, admin)
      .send({ from: admin });
    const pool = dPool.contract;

    // Deploy the orderbook bound to (tUSDC, tETH). Dummy vk_hash = 0 is safe for
    // integration tests that don't call verify_proof_with_type.
    const deployedOB = await OrderbookContract.deploy(
      wallet,
      100,          // epoch_length
      Fr.ZERO,      // clearing_vk_hash (dummy for non-proof tests)
      ZERO_ADDR,    // aggregator_registry
      0n,           // aggregator_fee
      1,            // pool_count
      [pool.address, ZERO_ADDR, ZERO_ADDR, ZERO_ADDR],
      [tUSDC.address, ZERO_ADDR, ZERO_ADDR, ZERO_ADDR],
      [tETH.address, ZERO_ADDR, ZERO_ADDR, ZERO_ADDR],
      admin,        // pool_registry_admin
    ).send({ from: admin });
    orderbook = deployedOB.contract;

    // Seed alice with both tokens, privately.
    await tUSDC.methods.mint_to_private(alice, MINT_ALICE_TUSDC).send({ from: admin });
    await tETH.methods.mint_to_private(alice, MINT_ALICE_TETH).send({ from: admin });
  });

  after(async () => {
    // EmbeddedWallet may or may not expose .stop(); guard so we don't crash the suite teardown.
    const stop = (wallet as unknown as { stop?: () => Promise<void> }).stop;
    if (typeof stop === "function") {
      await stop.call(wallet);
    }
  });

  it("submit_order(A->B): 100 tUSDC moves from alice private to orderbook public balance", { timeout: 600_000 }, async () => {
    const beforeAlice = await readPrivateBalance(tUSDC, alice);
    const beforeOrderbook = await readPublicBalance(tUSDC, orderbook.address, admin);

    await orderbook.methods
      .submit_order(SIDE_A_TO_B, ORDER1_USDC, PRICE_2, randomField(), randomField(),
        2n, [tUSDC.address, tETH.address, Fr.ZERO])
      .send({ from: alice });

    const afterAlice = await readPrivateBalance(tUSDC, alice);
    const afterOrderbook = await readPublicBalance(tUSDC, orderbook.address, admin);

    assert.equal(beforeAlice - afterAlice, ORDER1_USDC, "alice private down by 100 tUSDC");
    assert.equal(afterOrderbook - beforeOrderbook, ORDER1_USDC, "orderbook public up by 100 tUSDC");
  });

  it("submit_order(B->A): escrows tETH, not tUSDC", { timeout: 600_000 }, async () => {
    const beforeETH = await readPrivateBalance(tETH, alice);
    const beforeUSDC = await readPrivateBalance(tUSDC, alice);
    const beforeOrderbookETH = await readPublicBalance(tETH, orderbook.address, admin);
    const beforeOrderbookUSDC = await readPublicBalance(tUSDC, orderbook.address, admin);

    await orderbook.methods
      .submit_order(SIDE_B_TO_A, ORDER2_ETH, PRICE_2, randomField(), randomField(),
        2n, [tETH.address, tUSDC.address, Fr.ZERO])
      .send({ from: alice });

    const afterETH = await readPrivateBalance(tETH, alice);
    const afterUSDC = await readPrivateBalance(tUSDC, alice);
    const afterOrderbookETH = await readPublicBalance(tETH, orderbook.address, admin);
    const afterOrderbookUSDC = await readPublicBalance(tUSDC, orderbook.address, admin);

    assert.equal(beforeETH - afterETH, ORDER2_ETH, "alice tETH down by 2");
    assert.equal(afterOrderbookETH - beforeOrderbookETH, ORDER2_ETH, "orderbook tETH up by 2");
    assert.equal(afterUSDC, beforeUSDC, "alice tUSDC untouched");
    assert.equal(afterOrderbookUSDC, beforeOrderbookUSDC, "orderbook tUSDC untouched");
  });

  it("submit_order rejects when amount exceeds private balance", { timeout: 600_000 }, async () => {
    // After the first test alice has 1000 - 100 = 900 tUSDC. Submitting 5000 must revert.
    const before = await readPrivateBalance(tUSDC, alice);
    assert.ok(before < ORDER3_USDC_HUGE, "precondition: alice cannot cover the huge order");

    await assert.rejects(
      orderbook.methods
        .submit_order(SIDE_A_TO_B, ORDER3_USDC_HUGE, PRICE_2, randomField(), randomField(),
          2n, [tUSDC.address, tETH.address, Fr.ZERO])
        .send({ from: alice }),
      /balance|notes|insufficient|too low/i,
      "submit_order should revert when private balance is insufficient",
    );

    const after = await readPrivateBalance(tUSDC, alice);
    assert.equal(after, before, "alice balance unchanged after revert");
  });

  it("two orders from same user accumulate orderbook balance", { timeout: 600_000 }, async () => {
    const beforeOrderbook = await readPublicBalance(tUSDC, orderbook.address, admin);
    const beforeAlice = await readPrivateBalance(tUSDC, alice);

    await orderbook.methods
      .submit_order(SIDE_A_TO_B, ORDER4A_USDC, PRICE_2, randomField(), randomField(),
        2n, [tUSDC.address, tETH.address, Fr.ZERO])
      .send({ from: alice });

    await orderbook.methods
      .submit_order(SIDE_A_TO_B, ORDER4B_USDC, PRICE_2, randomField(), randomField(),
        2n, [tUSDC.address, tETH.address, Fr.ZERO])
      .send({ from: alice });

    const afterOrderbook = await readPublicBalance(tUSDC, orderbook.address, admin);
    const afterAlice = await readPrivateBalance(tUSDC, alice);

    assert.equal(
      afterOrderbook - beforeOrderbook,
      ORDER4A_USDC + ORDER4B_USDC,
      "orderbook accumulates both order amounts",
    );
    assert.equal(
      beforeAlice - afterAlice,
      ORDER4A_USDC + ORDER4B_USDC,
      "alice private balance drained by the sum of both orders",
    );
  });
});

describe("orderbook cancel_order (live integration)", () => {
  let node: AztecNode;
  let wallet: EmbeddedWallet;
  let admin: AztecAddress;
  let alice: AztecAddress;
  let bob: AztecAddress;
  let tUSDC: TokenContract;
  let tETH: TokenContract;
  let orderbook: OrderbookContract;

  const MINT = 1_000n * ONE_TUSDC;
  const MINT_ETH = 10n * ONE_TETH;
  const ORDER_USDC = 100n * ONE_TUSDC;
  const ORDER_ETH = 3n * ONE_TETH;

  before(async () => {
    node = await connectToSandbox();
    const env = await getTestWallets(node, 3);
    wallet = env.wallet;
    admin = env.accounts[0]!;
    alice = env.accounts[1]!;
    bob = env.accounts[2]!;

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

    const dPool2 = await LiquidityPoolContract.deploy(wallet, tUSDC.address, tETH.address, P_MIN_SQRT, BUCKET_GROWTH_NUM, admin)
      .send({ from: admin });

    const dOB = await OrderbookContract.deploy(
      wallet, 100, Fr.ZERO, ZERO_ADDR, 0n, 1,
      [dPool2.contract.address, ZERO_ADDR, ZERO_ADDR, ZERO_ADDR],
      [tUSDC.address, ZERO_ADDR, ZERO_ADDR, ZERO_ADDR],
      [tETH.address, ZERO_ADDR, ZERO_ADDR, ZERO_ADDR],
      admin,
    ).send({ from: admin });
    orderbook = dOB.contract;

    await tUSDC.methods.mint_to_private(alice, MINT).send({ from: admin });
    await tETH.methods.mint_to_private(alice, MINT_ETH).send({ from: admin });
  });

  after(async () => {
    const stop = (wallet as unknown as { stop?: () => Promise<void> }).stop;
    if (typeof stop === "function") await stop.call(wallet);
  });

  it("submit then cancel restores alice's private balance", { timeout: 600_000 }, async () => {
    const before = await readPrivateBalance(tUSDC, alice);
    const orderNonce = randomField();

    await orderbook.methods
      .submit_order(SIDE_A_TO_B, ORDER_USDC, PRICE_2, randomField(), orderNonce,
        2n, [tUSDC.address, tETH.address, Fr.ZERO])
      .send({ from: alice });

    assert.equal(await readPrivateBalance(tUSDC, alice), before - ORDER_USDC, "escrowed");

    // nonce MUST be 0n: cancel_order calls Token.transfer_public_to_private with
    // from=orderbook.address; because from == msg_sender (self-call), the
    // authorize_once macro requires nonce == 0.
    await orderbook.methods
      .cancel_order(orderNonce, 0n)
      .send({ from: alice });

    assert.equal(await readPrivateBalance(tUSDC, alice), before, "private balance fully restored");
    assert.equal(
      await readPublicBalance(tUSDC, orderbook.address, admin), 0n,
      "orderbook public escrow drained back to zero",
    );
  });

  it("cancel returns the correct token on the ask side", { timeout: 600_000 }, async () => {
    const beforeETH = await readPrivateBalance(tETH, alice);
    const beforeUSDC = await readPrivateBalance(tUSDC, alice);
    const orderNonce = randomField();

    await orderbook.methods
      .submit_order(SIDE_B_TO_A, ORDER_ETH, PRICE_2, randomField(), orderNonce,
        2n, [tETH.address, tUSDC.address, Fr.ZERO])
      .send({ from: alice });
    await orderbook.methods
      .cancel_order(orderNonce, 0n)
      .send({ from: alice });

    assert.equal(await readPrivateBalance(tETH, alice), beforeETH, "tETH restored");
    assert.equal(await readPrivateBalance(tUSDC, alice), beforeUSDC, "tUSDC untouched");
  });

  it("cancelling one of two orders leaves the other resting", { timeout: 600_000 }, async () => {
    const keepNonce = randomField();
    const dropNonce = randomField();

    await orderbook.methods
      .submit_order(SIDE_A_TO_B, ORDER_USDC, PRICE_2, randomField(), keepNonce,
        2n, [tUSDC.address, tETH.address, Fr.ZERO])
      .send({ from: alice });
    await orderbook.methods
      .submit_order(SIDE_A_TO_B, ORDER_USDC, PRICE_2, randomField(), dropNonce,
        2n, [tUSDC.address, tETH.address, Fr.ZERO])
      .send({ from: alice });

    const escrowBoth = await readPublicBalance(tUSDC, orderbook.address, admin);
    assert.equal(escrowBoth, 2n * ORDER_USDC, "both orders escrowed");

    await orderbook.methods
      .cancel_order(dropNonce, 0n)
      .send({ from: alice });

    assert.equal(
      await readPublicBalance(tUSDC, orderbook.address, admin), ORDER_USDC,
      "exactly one order's escrow remains",
    );

    const sim = await orderbook.methods.get_orders(alice).simulate({ from: alice });
    const nonces = extractNonces(sim.result);
    assert.ok(nonces.includes(keepNonce), "the kept order is still listed");
    assert.ok(!nonces.includes(dropNonce), "the cancelled order is gone");
  });

  it("double cancel of the same order fails", { timeout: 600_000 }, async () => {
    const orderNonce = randomField();
    await orderbook.methods
      .submit_order(SIDE_A_TO_B, ORDER_USDC, PRICE_2, randomField(), orderNonce,
        2n, [tUSDC.address, tETH.address, Fr.ZERO])
      .send({ from: alice });
    await orderbook.methods
      .cancel_order(orderNonce, 0n)
      .send({ from: alice });

    await assert.rejects(
      orderbook.methods.cancel_order(orderNonce, 0n).send({ from: alice }),
      /order not found/i,
      "second cancel of the same order must revert",
    );
  });

  it("a non-owner cannot cancel another maker's order", { timeout: 600_000 }, async () => {
    const orderNonce = randomField();
    await orderbook.methods
      .submit_order(SIDE_A_TO_B, ORDER_USDC, PRICE_2, randomField(), orderNonce,
        2n, [tUSDC.address, tETH.address, Fr.ZERO])
      .send({ from: alice });

    await assert.rejects(
      orderbook.methods.cancel_order(orderNonce, 0n).send({ from: bob }),
      /order not found/i,
      "bob cannot cancel alice's order (her PrivateSet yields no match for him)",
    );

    // Clean up so the suite leaves no resting escrow.
    await orderbook.methods.cancel_order(orderNonce, 0n).send({ from: alice });
  });
});

describe("orderbook epoch transitions (live integration)", () => {
  let node: AztecNode;
  let wallet: EmbeddedWallet;
  let admin: AztecAddress;
  let alice: AztecAddress;
  let tUSDC: TokenContract;
  let tETH: TokenContract;
  let orderbook: OrderbookContract;

  const EPOCH_LEN = 12;
  const MINT = 1_000n * ONE_TUSDC;
  const ORDER_USDC = 100n * ONE_TUSDC;

  before(async () => {
    node = await connectToSandbox();
    const env = await getTestWallets(node, 2);
    wallet = env.wallet;
    admin = env.accounts[0]!;
    alice = env.accounts[1]!;

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

    const dPool3 = await LiquidityPoolContract.deploy(wallet, tUSDC.address, tETH.address, P_MIN_SQRT, BUCKET_GROWTH_NUM, admin)
      .send({ from: admin });

    const dOB = await OrderbookContract.deploy(
      wallet, EPOCH_LEN, Fr.ZERO, ZERO_ADDR, 0n, 1,
      [dPool3.contract.address, ZERO_ADDR, ZERO_ADDR, ZERO_ADDR],
      [tUSDC.address, ZERO_ADDR, ZERO_ADDR, ZERO_ADDR],
      [tETH.address, ZERO_ADDR, ZERO_ADDR, ZERO_ADDR],
      admin,
    ).send({ from: admin });
    orderbook = dOB.contract;

    await tUSDC.methods.mint_to_private(alice, MINT).send({ from: admin });
  });

  after(async () => {
    const stop = (wallet as unknown as { stop?: () => Promise<void> }).stop;
    if (typeof stop === "function") await stop.call(wallet);
  });

  it("close_epoch reverts before the epoch has expired", { timeout: 600_000 }, async () => {
    const epoch = await orderbook.methods.get_epoch().simulate({ from: admin });
    const e = (epoch as { result: { closes_at_block: bigint } }).result;
    assert.ok(
      Number(await node.getBlockNumber()) < Number(e.closes_at_block),
      "precondition: epoch not yet expired",
    );
    await assert.rejects(
      orderbook.methods.close_epoch().send({ from: admin }),
      /epoch has not expired/i,
      "close_epoch must revert before closes_at_block",
    );
  });

  it("close_epoch advances the epoch once it has expired", { timeout: 600_000 }, async () => {
    const before = (await orderbook.methods.get_epoch().simulate({ from: admin })) as {
      result: { epoch_id: bigint; closes_at_block: bigint };
    };
    await mineUntilBlock(node, tUSDC, admin, Number(before.result.closes_at_block));

    await orderbook.methods.close_epoch().send({ from: admin });

    const after = (await orderbook.methods.get_epoch().simulate({ from: admin })) as {
      result: { epoch_id: bigint; opened_at_block: bigint; closes_at_block: bigint };
    };
    assert.equal(
      after.result.epoch_id, before.result.epoch_id + 1n,
      "epoch_id must increment",
    );
    assert.equal(
      after.result.closes_at_block - after.result.opened_at_block, BigInt(EPOCH_LEN),
      "new epoch closes EPOCH_LEN blocks after opening",
    );
  });

  it("submit_order is blocked in the expired window, then works in the new epoch", { timeout: 600_000 }, async () => {
    // Drive the current epoch to expiry.
    const epoch = (await orderbook.methods.get_epoch().simulate({ from: admin })) as {
      result: { closes_at_block: bigint };
    };
    await mineUntilBlock(node, tUSDC, admin, Number(epoch.result.closes_at_block));

    // submit_order must revert while the epoch is expired-but-not-closed.
    await assert.rejects(
      orderbook.methods
        .submit_order(SIDE_A_TO_B, ORDER_USDC, PRICE_2, randomField(), randomField(),
          2n, [tUSDC.address, tETH.address, Fr.ZERO])
        .send({ from: alice }),
      /epoch has expired/i,
      "submit_order must revert once the epoch window has elapsed",
    );

    // Close the epoch, then submit_order works again in the fresh epoch.
    await orderbook.methods.close_epoch().send({ from: admin });
    await orderbook.methods
      .submit_order(SIDE_A_TO_B, ORDER_USDC, PRICE_2, randomField(), randomField(),
        2n, [tUSDC.address, tETH.address, Fr.ZERO])
      .send({ from: alice });
  });

  it("resting orders survive an epoch boundary", { timeout: 600_000 }, async () => {
    // One order rests in the current (fresh) epoch.
    const orderNonce = randomField();
    await orderbook.methods
      .submit_order(SIDE_A_TO_B, ORDER_USDC, PRICE_2, randomField(), orderNonce,
        2n, [tUSDC.address, tETH.address, Fr.ZERO])
      .send({ from: alice });

    const escrowBefore = await readPublicBalance(tUSDC, orderbook.address, admin);
    assert.ok(escrowBefore > 0n, "precondition: the submitted order escrowed a non-zero balance");

    // Expire and close the epoch.
    const epoch = (await orderbook.methods.get_epoch().simulate({ from: admin })) as {
      result: { closes_at_block: bigint };
    };
    await mineUntilBlock(node, tUSDC, admin, Number(epoch.result.closes_at_block));
    await orderbook.methods.close_epoch().send({ from: admin });

    // The order's escrow is untouched by the epoch advance.
    const escrowAfter = await readPublicBalance(tUSDC, orderbook.address, admin);
    assert.equal(escrowAfter, escrowBefore, "close_epoch must not touch resting escrow");
  });
});

describe("orderbook order accumulator (live integration)", () => {
  let node: AztecNode;
  let wallet: EmbeddedWallet;
  let admin: AztecAddress;
  let alice: AztecAddress;
  let tUSDC: TokenContract;
  let tETH: TokenContract;
  let orderbook: OrderbookContract;

  const MINT = 130n * ONE_TUSDC;
  const MINT_ETH = 130n * ONE_TETH;

  before(async () => {
    node = await connectToSandbox();
    const env = await getTestWallets(node, 2);
    wallet = env.wallet;
    admin = env.accounts[0]!;
    alice = env.accounts[1]!;

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

    const dPool4 = await LiquidityPoolContract.deploy(wallet, tUSDC.address, tETH.address, P_MIN_SQRT, BUCKET_GROWTH_NUM, admin)
      .send({ from: admin });

    const dOB = await OrderbookContract.deploy(
      wallet, 100, Fr.ZERO, ZERO_ADDR, 0n, 1,
      [dPool4.contract.address, ZERO_ADDR, ZERO_ADDR, ZERO_ADDR],
      [tUSDC.address, ZERO_ADDR, ZERO_ADDR, ZERO_ADDR],
      [tETH.address, ZERO_ADDR, ZERO_ADDR, ZERO_ADDR],
      admin,
    ).send({ from: admin });
    orderbook = dOB.contract;

    // Mint enough tUSDC + tETH to alice's PRIVATE balance to cover later tests.
    await tUSDC.methods.mint_to_private(alice, MINT).send({ from: admin });
    await tETH.methods.mint_to_private(alice, MINT_ETH).send({ from: admin });
  });

  after(async () => {
    const stop = (wallet as unknown as { stop?: () => Promise<void> }).stop;
    if (typeof stop === "function") await stop.call(wallet);
  });

  it("IT1: a single submit_order folds one link into order_acc", { timeout: 600_000 }, async () => {
    const authwitNonce = randomField();
    const orderNonce = randomField();

    await orderbook.methods
      .submit_order(SIDE_A_TO_B, 1n * ONE_TUSDC, PRICE_2, authwitNonce, orderNonce,
        2n, [tUSDC.address, tETH.address, Fr.ZERO])
      .send({ from: alice });

    // Read the OrderNote that was just inserted to get the contract's chosen submitted_at_block.
    const ordersResult = await orderbook.methods.get_orders(alice).simulate({ from: alice });
    const bv = (ordersResult as { result: { storage: { submitted_at_block: bigint | number; nonce: bigint | number }[]; len: bigint | number } }).result;
    const len = Number(bv.len);
    assert.equal(len, 1, "alice has exactly one resting order");

    const note = bv.storage[0]!;
    assert.equal(BigInt(note.nonce), orderNonce, "the resting order's nonce matches");

    // Recompute the expected c_1 and acc' = poseidon2([0, c_1]) in JS.
    const c1 = await orderCommitment({
      owner: alice,
      side: SIDE_A_TO_B,
      amountIn: 1n * ONE_TUSDC,
      limitPrice: PRICE_2,
      orderNonce,
      submittedAtBlock: Number(note.submitted_at_block),
    });
    const expectedAcc = await foldChain(Fr.ZERO, c1);

    const epochResult = await orderbook.methods.get_epoch().simulate({ from: alice });
    const epoch = (epochResult as { result: { order_acc: bigint; cancel_acc: bigint; order_count: bigint | number; cancel_count: bigint | number } }).result;

    assert.equal(epoch.order_acc, expectedAcc.toBigInt(), "order_acc matches poseidon2([0, c_1])");
    assert.equal(Number(epoch.order_count), 1, "order_count is 1");
    assert.equal(epoch.cancel_acc, 0n, "cancel_acc untouched");
    assert.equal(Number(epoch.cancel_count), 0, "cancel_count untouched");
  });

  it("IT2: order_acc equals the manually-replayed 3-link chain after three submits", { timeout: 600_000 }, async () => {
    const submissions = [
      { side: SIDE_A_TO_B, amountIn: 1n * ONE_TUSDC, limitPrice: PRICE_2 },
      { side: SIDE_B_TO_A, amountIn: 1n * ONE_TETH,  limitPrice: PRICE_2 },
      { side: SIDE_A_TO_B, amountIn: 2n * ONE_TUSDC, limitPrice: PRICE_2 },
    ];

    // Capture epoch state BEFORE submits (IT1 may have already advanced order_count to 1).
    const epochBeforeResult = await orderbook.methods.get_epoch().simulate({ from: alice });
    const epochBefore = (epochBeforeResult as { result: { order_acc: bigint; order_count: bigint | number } }).result;
    let expectedAcc = new Fr(epochBefore.order_acc);
    const countStart = Number(epochBefore.order_count);

    for (const s of submissions) {
      const authwitNonce = randomField();
      const orderNonce = randomField();

      await orderbook.methods
        .submit_order(s.side, s.amountIn, s.limitPrice, authwitNonce, orderNonce,
          2n,
          s.side === SIDE_A_TO_B
            ? [tUSDC.address, tETH.address, Fr.ZERO]
            : [tETH.address, tUSDC.address, Fr.ZERO])
        .send({ from: alice });

      // Read alice's notes and find the one we just inserted (its nonce matches).
      const ordersResult = await orderbook.methods.get_orders(alice).simulate({ from: alice });
      const bv = (ordersResult as { result: { storage: { submitted_at_block: bigint | number; nonce: bigint | number }[]; len: bigint | number } }).result;
      const len = Number(bv.len);
      const justInserted = bv.storage.slice(0, len).find((n) => BigInt(n.nonce) === orderNonce);
      assert.ok(justInserted, "the just-submitted order is present in the maker's PrivateSet");

      const c = await orderCommitment({
        owner: alice,
        side: s.side,
        amountIn: s.amountIn,
        limitPrice: s.limitPrice,
        orderNonce,
        submittedAtBlock: Number(justInserted.submitted_at_block),
      });
      expectedAcc = await foldChain(expectedAcc, c);
    }

    const epochAfterResult = await orderbook.methods.get_epoch().simulate({ from: alice });
    const epochAfter = (epochAfterResult as { result: { order_acc: bigint; order_count: bigint | number } }).result;
    assert.equal(
      epochAfter.order_acc,
      expectedAcc.toBigInt(),
      "order_acc must equal the manually-replayed 3-link chain",
    );
    assert.equal(
      Number(epochAfter.order_count),
      countStart + 3,
      "order_count must have incremented by 3",
    );
  });

  it("IT3: cancel_order after one submit advances cancel_acc and cancel_count", { timeout: 600_000 }, async () => {
    const authwitNonce = randomField();
    const orderNonce = randomField();

    await orderbook.methods
      .submit_order(SIDE_A_TO_B, 1n * ONE_TUSDC, PRICE_2, authwitNonce, orderNonce,
        2n, [tUSDC.address, tETH.address, Fr.ZERO])
      .send({ from: alice });

    // Pull the just-submitted note to get its submitted_at_block.
    const ordersResult = await orderbook.methods.get_orders(alice).simulate({ from: alice });
    const bv = (ordersResult as { result: { storage: { submitted_at_block: bigint | number; nonce: bigint | number }[]; len: bigint | number } }).result;
    const len = Number(bv.len);
    const note = bv.storage.slice(0, len).find((n) => BigInt(n.nonce) === orderNonce);
    assert.ok(note, "the just-submitted order is present");

    // Snapshot the epoch BEFORE the cancel to capture cancel_acc/cancel_count baselines.
    const epochAfterSubmitResult = await orderbook.methods.get_epoch().simulate({ from: alice });
    const epochAfterSubmit = (epochAfterSubmitResult as { result: { order_acc: bigint; cancel_acc: bigint; order_count: bigint | number; cancel_count: bigint | number } }).result;
    const orderCountAfterSubmit = Number(epochAfterSubmit.order_count);
    const cancelAccBefore = new Fr(epochAfterSubmit.cancel_acc);
    const cancelCountBefore = Number(epochAfterSubmit.cancel_count);

    // Cancel it. cancel_order is a self-call for the escrow return, so authwit nonce = 0n.
    await orderbook.methods
      .cancel_order(orderNonce, 0n)
      .send({ from: alice });

    // Recompute the same c_i that submit_order folded into order_acc; cancel must fold the
    // same c_i into cancel_acc.
    const cExpected = await orderCommitment({
      owner: alice,
      side: SIDE_A_TO_B,
      amountIn: 1n * ONE_TUSDC,
      limitPrice: PRICE_2,
      orderNonce,
      submittedAtBlock: Number(note.submitted_at_block),
    });
    const expectedCancelAcc = await foldChain(cancelAccBefore, cExpected);

    const epochAfterCancelResult = await orderbook.methods.get_epoch().simulate({ from: alice });
    const epochAfterCancel = (epochAfterCancelResult as { result: { order_acc: bigint; cancel_acc: bigint; order_count: bigint | number; cancel_count: bigint | number } }).result;

    assert.equal(
      epochAfterCancel.cancel_acc,
      expectedCancelAcc.toBigInt(),
      "cancel_acc must fold in the cancelled order's c_i",
    );
    assert.equal(
      Number(epochAfterCancel.cancel_count),
      cancelCountBefore + 1,
      "cancel_count must increment by 1",
    );
    assert.equal(
      Number(epochAfterCancel.order_count),
      orderCountAfterSubmit,
      "order_count must NOT regress on cancel (monotonic)",
    );
  });

  it("IT4: submit then cancel of the same order yields order_acc == cancel_acc", { timeout: 900_000 }, async () => {
    // Deploy a fresh orderbook + fresh tokens for THIS test only, so both running-hash
    // chains start at their identity (0). This is the only way to make
    // order_acc == cancel_acc a meaningful equality (otherwise both chains have
    // arbitrary prior histories and equality would only hold by coincidence).
    //
    // Mirror the same inline deployment pattern used by this describe block's before() hook.
    const freshDU = await TokenContract.deployWithOpts(
      { wallet, method: "constructor_with_minter" },
      "tUSDC".padEnd(31, "\0"), "tUSDC".padEnd(31, "\0"), 6, admin,
    ).send({ from: admin });
    const freshTUSDC = freshDU.contract;

    const freshDE = await TokenContract.deployWithOpts(
      { wallet, method: "constructor_with_minter" },
      "tETH".padEnd(31, "\0"), "tETH".padEnd(31, "\0"), 18, admin,
    ).send({ from: admin });
    const freshTETH = freshDE.contract;

    const freshDPool = await LiquidityPoolContract.deploy(wallet, freshTUSDC.address, freshTETH.address, P_MIN_SQRT, BUCKET_GROWTH_NUM, admin)
      .send({ from: admin });

    const freshDOB = await OrderbookContract.deploy(
      wallet, 100, Fr.ZERO, ZERO_ADDR, 0n, 1,
      [freshDPool.contract.address, ZERO_ADDR, ZERO_ADDR, ZERO_ADDR],
      [freshTUSDC.address, ZERO_ADDR, ZERO_ADDR, ZERO_ADDR],
      [freshTETH.address, ZERO_ADDR, ZERO_ADDR, ZERO_ADDR],
      admin,
    ).send({ from: admin });
    const freshOrderbook = freshDOB.contract;

    // Mint a small amount of tUSDC to alice on the fresh token so submit_order has escrow.
    await freshTUSDC.methods.mint_to_private(alice, 10n * ONE_TUSDC).send({ from: admin });

    // Sanity: fresh chains start at 0.
    const freshEpoch0Raw = await freshOrderbook.methods.get_epoch().simulate({ from: alice });
    const freshEpoch0 = (freshEpoch0Raw as any).result ?? freshEpoch0Raw;
    assert.equal(freshEpoch0.order_acc, 0n, "fresh orderbook starts at order_acc = 0");
    assert.equal(freshEpoch0.cancel_acc, 0n, "fresh orderbook starts at cancel_acc = 0");

    // Submit one order then cancel it on the fresh orderbook.
    const authwitNonce = randomField();
    const orderNonce = randomField();
    await freshOrderbook.methods
      .submit_order(SIDE_A_TO_B, 1n * ONE_TUSDC, PRICE_2, authwitNonce, orderNonce,
        2n, [freshTUSDC.address, freshTETH.address, Fr.ZERO])
      .send({ from: alice });
    await freshOrderbook.methods
      .cancel_order(orderNonce, 0n)
      .send({ from: alice });

    const epochRaw = await freshOrderbook.methods.get_epoch().simulate({ from: alice });
    const epoch = (epochRaw as any).result ?? epochRaw;

    assert.equal(
      epoch.order_acc,
      epoch.cancel_acc,
      "after submit+cancel of the same order, order_acc == cancel_acc (proves both " +
        "sides compute the identical c_i)",
    );
    assert.notEqual(epoch.order_acc, 0n, "the shared acc must be non-zero (both chains were folded once)");
    assert.equal(Number(epoch.order_count), 1, "exactly one submit");
    assert.equal(Number(epoch.cancel_count), 1, "exactly one cancel");
  });

  it("IT6a: close_epoch resets all four accumulator fields from a nonzero state", { timeout: 1_800_000 }, async () => {
    // Deploy a fresh fixture with epoch_length=10 so the epoch expires quickly.
    // Mirror IT4/IT5's inline fresh-fixture pattern.
    const freshDU6a = await TokenContract.deployWithOpts(
      { wallet, method: "constructor_with_minter" },
      "tUSDC".padEnd(31, "\0"), "tUSDC".padEnd(31, "\0"), 6, admin,
    ).send({ from: admin });
    const freshTUSDC6a = freshDU6a.contract;

    const freshDE6a = await TokenContract.deployWithOpts(
      { wallet, method: "constructor_with_minter" },
      "tETH".padEnd(31, "\0"), "tETH".padEnd(31, "\0"), 18, admin,
    ).send({ from: admin });
    const freshTETH6a = freshDE6a.contract;

    const freshDPool6a = await LiquidityPoolContract.deploy(wallet, freshTUSDC6a.address, freshTETH6a.address, P_MIN_SQRT, BUCKET_GROWTH_NUM, admin)
      .send({ from: admin });

    const freshDOB6a = await OrderbookContract.deploy(
      wallet, 10, Fr.ZERO, ZERO_ADDR, 0n, 1,
      [freshDPool6a.contract.address, ZERO_ADDR, ZERO_ADDR, ZERO_ADDR],
      [freshTUSDC6a.address, ZERO_ADDR, ZERO_ADDR, ZERO_ADDR],
      [freshTETH6a.address, ZERO_ADDR, ZERO_ADDR, ZERO_ADDR],
      admin,
    ).send({ from: admin });
    const freshOrderbook6a = freshDOB6a.contract;

    // Mint enough tUSDC to alice on the fresh token to cover two 1-unit orders.
    await freshTUSDC6a.methods.mint_to_private(alice, 5n * ONE_TUSDC).send({ from: admin });

    // Submit two orders so order_count >= 2 and order_acc is nonzero.
    for (let i = 0; i < 2; i++) {
      const authwitNonce = randomField();
      const orderNonce = randomField();
      await freshOrderbook6a.methods
        .submit_order(SIDE_A_TO_B, 1n * ONE_TUSDC, PRICE_2, authwitNonce, orderNonce,
          2n, [freshTUSDC6a.address, freshTETH6a.address, Fr.ZERO])
        .send({ from: alice });
    }

    const dirtyRaw = await freshOrderbook6a.methods.get_epoch().simulate({ from: alice });
    const dirty = (dirtyRaw as any).result ?? dirtyRaw;
    assert.notEqual(dirty.order_acc, 0n, "precondition: order_acc is nonzero");
    assert.ok(Number(dirty.order_count) >= 2, "precondition: order_count >= 2");

    // Advance L2 blocks past closes_at_block using the same mineUntilBlock helper
    // that the 3rd describe block uses.
    await mineUntilBlock(node, freshTUSDC6a, admin, Number(dirty.closes_at_block));

    // Close the epoch via close_epoch().
    await freshOrderbook6a.methods.close_epoch().send({ from: admin });

    const freshEpochRaw = await freshOrderbook6a.methods.get_epoch().simulate({ from: alice });
    const freshEpoch = (freshEpochRaw as any).result ?? freshEpochRaw;
    assert.equal(freshEpoch.order_acc, 0n, "new epoch order_acc resets to 0");
    assert.equal(freshEpoch.cancel_acc, 0n, "new epoch cancel_acc resets to 0");
    assert.equal(Number(freshEpoch.order_count), 0, "new epoch order_count resets to 0");
    assert.equal(Number(freshEpoch.cancel_count), 0, "new epoch cancel_count resets to 0");
  });

  // IT5 is skipped on Aztec 4.2.1 because a single wallet cannot submit 32 unfinalized
  // private txs in a row — the PXE's `sender_tagging_store` window is 20 and finalisation
  // (L1 proof verification) lags far behind the rate at which we can submit, so the 21st
  // submit fails with:
  //   "Highest used index 21 is further than window length from the highest finalized
  //    index 0. Tagging window length 20 is configured too low. Contact the Aztec team
  //    to increase it!"
  // Splitting across multiple wallets would clear the window but still leaves an
  // unfinalised-window race. The MAX_ORDERS_PER_EPOCH = 32 cap is enforced by
  // `_append_order`'s `assert(epoch.order_count < MAX_ORDERS_PER_EPOCH, ...)` and is
  // covered by code review + the compile-time guarantee that the assert string + the
  // global constant agree. A TXE-level direct test of the cap is filed as follow-up.
  it.skip(
    "IT5: 32 submits succeed and the 33rd reverts with epoch order capacity reached (still skipped: Aztec 4.2.1 PXE tagging window per-wallet cap is 20)",
    { timeout: 90 * 60 * 1_000 }, // 90 minutes — 32 live submits add up
    async () => {
      // Deploy a fresh fixture so order_count starts at 0 (mirror IT4's fresh-fixture
      // pattern — same inline deploy so both accumulator chains start at identity).
      const freshDU5 = await TokenContract.deployWithOpts(
        { wallet, method: "constructor_with_minter" },
        "tUSDC".padEnd(31, "\0"), "tUSDC".padEnd(31, "\0"), 6, admin,
      ).send({ from: admin });
      const freshTUSDC5 = freshDU5.contract;

      const freshDE5 = await TokenContract.deployWithOpts(
        { wallet, method: "constructor_with_minter" },
        "tETH".padEnd(31, "\0"), "tETH".padEnd(31, "\0"), 18, admin,
      ).send({ from: admin });
      const freshTETH5 = freshDE5.contract;

      const freshDPool5 = await LiquidityPoolContract.deploy(wallet, freshTUSDC5.address, freshTETH5.address, P_MIN_SQRT, BUCKET_GROWTH_NUM, admin)
        .send({ from: admin });

      const freshDOB5 = await OrderbookContract.deploy(
        // epoch_length=100_000 so 32 sequential submits (each mining a few L2 blocks)
        // cannot expire the epoch mid-loop. With epoch_length=100 we'd hit
        // `epoch has expired; awaiting close_epoch` around submit ~30.
        wallet, 100_000, Fr.ZERO, ZERO_ADDR, 0n, 1,
        [freshDPool5.contract.address, ZERO_ADDR, ZERO_ADDR, ZERO_ADDR],
        [freshTUSDC5.address, ZERO_ADDR, ZERO_ADDR, ZERO_ADDR],
        [freshTETH5.address, ZERO_ADDR, ZERO_ADDR, ZERO_ADDR],
        admin,
      ).send({ from: admin });
      const freshOrderbook5 = freshDOB5.contract;

      // Mint enough tUSDC for 34 single-unit (1n) submits — way more than needed.
      // amount_in=1n means 1 raw token unit, no decimals scaling needed.
      await freshTUSDC5.methods.mint_to_private(alice, 34n).send({ from: admin });

      // Sanity: fresh orderbook starts at order_count = 0.
      const epoch0Raw = await freshOrderbook5.methods.get_epoch().simulate({ from: alice });
      const epoch0 = (epoch0Raw as any).result ?? epoch0Raw;
      assert.equal(Number(epoch0.order_count), 0, "fresh orderbook starts at order_count = 0");

      // 32 submits with 1n amount each. Sequential — Aztec tx nonces per account
      // serialize anyway.
      for (let i = 0; i < 32; i++) {
        const authwitNonce = randomField();
        const orderNonce = randomField();
        await freshOrderbook5.methods
          .submit_order(SIDE_A_TO_B, 1n, PRICE_2, authwitNonce, orderNonce,
            2n, [freshTUSDC5.address, freshTETH5.address, Fr.ZERO])
          .send({ from: alice });
      }

      const epochFullRaw = await freshOrderbook5.methods.get_epoch().simulate({ from: alice });
      const epochFull = (epochFullRaw as any).result ?? epochFullRaw;
      assert.equal(Number(epochFull.order_count), 32, "exactly 32 orders submitted");

      // The 33rd must revert. node:test's assert.rejects catches the thrown error
      // from the contract revert. The error message includes the assertion text.
      const authwitNonce33 = randomField();
      const orderNonce33 = randomField();
      await assert.rejects(
        freshOrderbook5.methods
          .submit_order(SIDE_A_TO_B, 1n, PRICE_2, authwitNonce33, orderNonce33,
            2n, [freshTUSDC5.address, freshTETH5.address, Fr.ZERO])
          .send({ from: alice }),
        /epoch order capacity reached/i,
        "the 33rd submit must revert with the capacity message",
      );

      // order_count must still be exactly 32 (the failed submit reverted atomically).
      const epochFinalRaw = await freshOrderbook5.methods.get_epoch().simulate({ from: alice });
      const epochFinal = (epochFinalRaw as any).result ?? epochFinalRaw;
      assert.equal(Number(epochFinal.order_count), 32, "order_count unchanged after the rejected 33rd");
    },
  );
});
