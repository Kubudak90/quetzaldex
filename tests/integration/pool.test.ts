import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import type { AztecAddress } from "@aztec/aztec.js/addresses";
import type { AztecNode } from "@aztec/aztec.js/node";
import type { EmbeddedWallet } from "@aztec/wallets/embedded";

import { connectToSandbox } from "./helpers/sandbox.js";
import { getTestWallets } from "./helpers/wallets.js";
import { TokenContract } from "./generated/Token.js";
import { LiquidityPoolContract } from "./generated/LiquidityPool.js";

const TUSDC_DECIMALS = 6;
const ONE_TUSDC = 10n ** BigInt(TUSDC_DECIMALS);
const TETH_DECIMALS = 18;
const ONE_TETH = 10n ** BigInt(TETH_DECIMALS);

// Mints. Alice and Bob each get generous balances of both tokens.
const MINT_USDC = 1_000_000n * ONE_TUSDC;
const MINT_ETH = 1_000n * ONE_TETH;

function randomField(): bigint {
  const buf = new Uint8Array(31);
  webcrypto.getRandomValues(buf);
  let n = 0n;
  for (const byte of buf) n = (n << 8n) | BigInt(byte);
  return n;
}

interface PoolState {
  reserve_a: bigint;
  reserve_b: bigint;
  lp_supply: bigint;
  cum_fee_a_per_share: bigint;
  cum_fee_b_per_share: bigint;
}

// `get_pool_state` returns a Noir struct; the ABI decoder yields a plain object,
// `.simulate()` wraps it in { result }.
async function readPoolState(pool: LiquidityPoolContract, from: AztecAddress): Promise<PoolState> {
  const sim = await pool.methods.get_pool_state().simulate({ from });
  const r = (sim as { result: { reserve_a: bigint | number; reserve_b: bigint | number; lp_supply: bigint | number; cum_fee_a_per_share: bigint | number; cum_fee_b_per_share: bigint | number } }).result;
  return {
    reserve_a: BigInt(r.reserve_a),
    reserve_b: BigInt(r.reserve_b),
    lp_supply: BigInt(r.lp_supply),
    cum_fee_a_per_share: BigInt(r.cum_fee_a_per_share),
    cum_fee_b_per_share: BigInt(r.cum_fee_b_per_share),
  };
}

async function readPrivateBalance(token: TokenContract, owner: AztecAddress): Promise<bigint> {
  const sim = await token.methods.balance_of_private(owner).simulate({ from: owner });
  return BigInt(sim.result as bigint | number);
}

async function readPublicBalance(
  token: TokenContract, owner: AztecAddress, from: AztecAddress,
): Promise<bigint> {
  const sim = await token.methods.balance_of_public(owner).simulate({ from });
  return BigInt(sim.result as bigint | number);
}

// Integer sqrt over bigint — the expected initial-share value.
function bigintSqrt(x: bigint): bigint {
  if (x < 2n) return x;
  let lo = 1n, hi = x;
  while (lo < hi) {
    const mid = lo + (hi - lo + 1n) / 2n;
    if (mid * mid <= x) lo = mid;
    else hi = mid - 1n;
  }
  return lo;
}

describe("pool (live integration)", () => {
  let node: AztecNode;
  let wallet: EmbeddedWallet;
  let admin: AztecAddress;
  let alice: AztecAddress;
  let bob: AztecAddress;
  let tUSDC: TokenContract;
  let tETH: TokenContract;
  let pool: LiquidityPoolContract;

  before(async () => {
    node = await connectToSandbox();
    const env = await getTestWallets(node, 3);
    wallet = env.wallet;
    admin = env.accounts[0]!;
    alice = env.accounts[1]!;
    bob = env.accounts[2]!;

    const dU = await TokenContract.deployWithOpts(
      { wallet, method: "constructor_with_minter" },
      "tUSDC".padEnd(31, "\0"), "tUSDC".padEnd(31, "\0"), TUSDC_DECIMALS, admin,
    ).send({ from: admin });
    tUSDC = dU.contract;

    const dE = await TokenContract.deployWithOpts(
      { wallet, method: "constructor_with_minter" },
      "tETH".padEnd(31, "\0"), "tETH".padEnd(31, "\0"), TETH_DECIMALS, admin,
    ).send({ from: admin });
    tETH = dE.contract;

    const P_MIN_SQRT        = 100_000_000_000_000_000n; // 0.1e18
    const BUCKET_GROWTH_NUM = 1_500_000_000_000_000_000n; // 1.5e18
    const dP = await LiquidityPoolContract.deploy(
      wallet, tUSDC.address, tETH.address, P_MIN_SQRT, BUCKET_GROWTH_NUM, admin,
    ).send({ from: admin });
    pool = dP.contract;

    for (const who of [alice, bob]) {
      await tUSDC.methods.mint_to_private(who, MINT_USDC).send({ from: admin });
      await tETH.methods.mint_to_private(who, MINT_ETH).send({ from: admin });
    }
  });

  after(async () => {
    const stop = (wallet as unknown as { stop?: () => Promise<void> }).stop;
    if (typeof stop === "function") await stop.call(wallet);
  });

  // Deposit amounts. The pool ratio is fixed by Alice's first deposit at 100k:1.
  const ALICE_A = 100_000n * ONE_TUSDC;
  const ALICE_B = 1n * ONE_TETH;

  // Zero-filled BucketState hint for tests that don't use bucket-specific state.
  const ZERO_BUCKET_HINT = { reserve_a: 0n, reserve_b: 0n, liquidity: 0n, cum_fee_a_per_share: 0n, cum_fee_b_per_share: 0n };

  it("first deposit sets reserves and mints sqrt(a*b) shares", { timeout: 600_000 }, async () => {
    const hint = await readPoolState(pool, admin);
    assert.equal(hint.lp_supply, 0n, "precondition: empty pool");

    await pool.methods
      .deposit(0n, ALICE_A, ALICE_B, { reserve_a: hint.reserve_a, reserve_b: hint.reserve_b, current_sqrt_price: 0n }, ZERO_BUCKET_HINT, randomField(), randomField(), randomField())
      .send({ from: alice });

    const state = await readPoolState(pool, admin);
    assert.equal(state.reserve_a, ALICE_A, "reserve_a == alice's token A");
    assert.equal(state.reserve_b, ALICE_B, "reserve_b == alice's token B");
    assert.equal(state.lp_supply, bigintSqrt(ALICE_A * ALICE_B), "lp_supply == floor(sqrt(a*b))");
    assert.equal(
      await readPublicBalance(tUSDC, pool.address, admin), ALICE_A,
      "pool holds alice's token A",
    );
  });

  it("second LP at the pool ratio gets proportional shares", { timeout: 600_000 }, async () => {
    const hint = await readPoolState(pool, admin);
    // Bob deposits at exactly the current ratio: half of each reserve.
    const bobA = hint.reserve_a / 2n;
    const bobB = hint.reserve_b / 2n;
    const expectedShares = bobA * hint.lp_supply / hint.reserve_a;

    await pool.methods
      .deposit(0n, bobA, bobB, { reserve_a: hint.reserve_a, reserve_b: hint.reserve_b, current_sqrt_price: 0n }, ZERO_BUCKET_HINT, randomField(), randomField(), randomField())
      .send({ from: bob });

    const state = await readPoolState(pool, admin);
    assert.equal(state.lp_supply, hint.lp_supply + expectedShares, "lp_supply grew proportionally");
    assert.equal(state.reserve_a, hint.reserve_a + bobA, "reserve_a grew by bob's A");
    assert.equal(state.reserve_b, hint.reserve_b + bobB, "reserve_b grew by bob's B");
  });

  it("off-ratio deposit escrows only the matched amount", { timeout: 600_000 }, async () => {
    const hint = await readPoolState(pool, admin);
    // Bob offers token A matching 1/10 of reserve_a, but DOUBLE the matching token B.
    const bobA = hint.reserve_a / 10n;
    const matchedB = bobA * hint.reserve_b / hint.reserve_a;
    const bobB = matchedB * 2n;

    const bobUsdcBefore = await readPrivateBalance(tUSDC, bob);
    const bobEthBefore = await readPrivateBalance(tETH, bob);

    await pool.methods
      .deposit(0n, bobA, bobB, { reserve_a: hint.reserve_a, reserve_b: hint.reserve_b, current_sqrt_price: 0n }, ZERO_BUCKET_HINT, randomField(), randomField(), randomField())
      .send({ from: bob });

    const bobUsdcAfter = await readPrivateBalance(tUSDC, bob);
    const bobEthAfter = await readPrivateBalance(tETH, bob);
    // token A is the limiting side -> all of bobA used; token B -> only matchedB used.
    assert.equal(bobUsdcBefore - bobUsdcAfter, bobA, "all of bob's offered token A is used");
    assert.equal(bobEthBefore - bobEthAfter, matchedB, "only the matched token B is used");
  });

  it("withdraw returns principal and nullifies the position", { timeout: 600_000 }, async () => {
    // Fresh deposit by alice with a known nonce, then withdraw it.
    const depHint = await readPoolState(pool, admin);
    const posNonce = randomField();
    const depA = 10_000n * ONE_TUSDC;
    const depB = depA * depHint.reserve_b / depHint.reserve_a;

    const usdcBefore = await readPrivateBalance(tUSDC, alice);
    await pool.methods
      .deposit(0n, depA, depB, { reserve_a: depHint.reserve_a, reserve_b: depHint.reserve_b, current_sqrt_price: 0n }, ZERO_BUCKET_HINT, randomField(), randomField(), posNonce)
      .send({ from: alice });

    const wHint = await readPoolState(pool, admin);
    await pool.methods.withdraw(posNonce, { reserve_a: wHint.reserve_a, reserve_b: wHint.reserve_b, current_sqrt_price: 0n }, ZERO_BUCKET_HINT, 0n, 0n).send({ from: alice });

    const usdcAfter = await readPrivateBalance(tUSDC, alice);
    // Alice gets back ~her principal (V2 rounding may lose a few base units).
    const delta = usdcBefore > usdcAfter ? usdcBefore - usdcAfter : usdcAfter - usdcBefore;
    assert.ok(delta <= 10n, `alice's token A is restored within rounding dust (delta=${delta})`);

    const positions = await pool.methods.get_positions(alice).simulate({ from: alice });
    const bv = (positions as { result: { storage: { nonce: bigint }[]; len: bigint } }).result;
    const nonces = bv.storage.slice(0, Number(bv.len)).map((p) => BigInt(p.nonce));
    assert.ok(!nonces.includes(posNonce), "the withdrawn position is gone");
  });

  it("withdraw of an unknown nonce is rejected", { timeout: 600_000 }, async () => {
    const hint = await readPoolState(pool, admin);
    await assert.rejects(
      pool.methods.withdraw(randomField(), { reserve_a: hint.reserve_a, reserve_b: hint.reserve_b, current_sqrt_price: 0n }, ZERO_BUCKET_HINT, 0n, 0n).send({ from: alice }),
      /position not found/i,
      "withdrawing a non-existent position must revert",
    );
  });
});
