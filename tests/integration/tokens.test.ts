import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import type { AztecAddress } from "@aztec/aztec.js/addresses";
import type { AztecNode } from "@aztec/aztec.js/node";
import type { EmbeddedWallet } from "@aztec/wallets/embedded";

import { connectToSandbox } from "./helpers/sandbox.js";
import { getTestWallets } from "./helpers/wallets.js";

import { TokenContract } from "./generated/Token.js";

// Brand constants must match the contract globals.
// The constructor_with_minter takes str<31>; right-pad both strings.
const TUSDC_NAME = "tUSDC".padEnd(31, "\0");
const TUSDC_SYMBOL = "tUSDC".padEnd(31, "\0");
const TUSDC_DECIMALS = 6;
const ONE_TUSDC = 10n ** BigInt(TUSDC_DECIMALS);
const MINT_TUSDC = 1_000_000n * ONE_TUSDC;        // 1,000,000 tUSDC (== 1_000_000_000_000)

const TETH_NAME = "tETH".padEnd(31, "\0");
const TETH_SYMBOL = "tETH".padEnd(31, "\0");
const TETH_DECIMALS = 18;
const ONE_TETH = 10n ** BigInt(TETH_DECIMALS);
const MINT_TETH = 5n * ONE_TETH;                  // 5 tETH (== 5_000_000_000_000_000_000)
const TRANSFER_TETH = 2n * ONE_TETH;              // 2 tETH

describe("tokens (live integration)", () => {
  let node: AztecNode;
  let wallet: EmbeddedWallet;
  let accounts: AztecAddress[];
  let admin: AztecAddress;
  let alice: AztecAddress;

  before(async () => {
    node = await connectToSandbox();
    const env = await getTestWallets(node, 2);
    wallet = env.wallet;
    accounts = env.accounts;
    admin = accounts[0]!;
    alice = accounts[1]!;
  });

  it("deploys tUSDC, mints 1M to admin privately, balance matches", { timeout: 600_000 }, async () => {
    const deployed = await TokenContract.deployWithOpts(
      { wallet, method: "constructor_with_minter" },
      TUSDC_NAME,
      TUSDC_SYMBOL,
      TUSDC_DECIMALS,
      admin, // minter
    ).send({ from: admin });

    const token = deployed.contract;

    // mint privately to admin
    await token.methods.mint_to_private(admin, MINT_TUSDC).send({ from: admin });

    // balance_of_private is a utility function — read via simulate
    const sim = await token.methods.balance_of_private(admin).simulate({ from: admin });
    const balance = BigInt(sim.result as bigint | number);

    assert.equal(balance, MINT_TUSDC);
  });

  it("deploys tETH, mints 5 tETH to admin, transfers 2 tETH private->private to alice", { timeout: 600_000 }, async () => {
    const deployed = await TokenContract.deployWithOpts(
      { wallet, method: "constructor_with_minter" },
      TETH_NAME,
      TETH_SYMBOL,
      TETH_DECIMALS,
      admin, // minter
    ).send({ from: admin });

    const token = deployed.contract;

    // mint 5 tETH privately to admin
    await token.methods.mint_to_private(admin, MINT_TETH).send({ from: admin });

    // transfer 2 tETH private->private from admin to alice
    // _nonce = 0 (authwit is signed by admin since admin == from)
    await token.methods
      .transfer_private_to_private(admin, alice, TRANSFER_TETH, 0)
      .send({ from: admin });

    const adminSim = await token.methods.balance_of_private(admin).simulate({ from: admin });
    const aliceSim = await token.methods.balance_of_private(alice).simulate({ from: alice });
    const adminBalance = BigInt(adminSim.result as bigint | number);
    const aliceBalance = BigInt(aliceSim.result as bigint | number);

    assert.equal(adminBalance, MINT_TETH - TRANSFER_TETH); // 3 tETH
    assert.equal(aliceBalance, TRANSFER_TETH); // 2 tETH
  });
});
