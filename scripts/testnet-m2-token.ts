#!/usr/bin/env node
//
// M2: Token deploy + mint on testnet (gated on M1 success).
//
// Loads the admin wallet from testnet-m1-state.json, deploys a tUSDC Token
// contract, mints to admin, verifies balance via view call.
//
// Usage: pnpm tsx scripts/testnet-m2-token.ts
// State: testnet-m2-state.json
//
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { Fr, Fq } from "@aztec/aztec.js/fields";
import { createAztecNodeClient, waitForNode } from "@aztec/aztec.js/node";
import { EmbeddedWallet } from "@aztec/wallets/embedded";
import { TokenContract } from "../tests/integration/generated/Token.js";

const RPC_URL = "https://rpc.testnet.aztec-labs.com";
const M1_STATE = "testnet-m1-state.json";
const M2_STATE = "testnet-m2-state.json";

interface M2State {
  step: number;
  tUSDCAddress?: string;
  deployTx?: string;
  mintTx?: string;
  balanceAfterMint?: string;
}

function loadM2State(): M2State {
  if (existsSync(M2_STATE)) return JSON.parse(readFileSync(M2_STATE, "utf8")) as M2State;
  return { step: 0 };
}
function saveM2State(s: M2State) {
  writeFileSync(M2_STATE, JSON.stringify(s, null, 2));
}

async function main() {
  if (!existsSync(M1_STATE)) throw new Error(`${M1_STATE} not found — run M1 first`);
  const m1 = JSON.parse(readFileSync(M1_STATE, "utf8")) as {
    secret: string; salt: string; signingKey: string; address: string; step: number;
  };
  if (m1.step < 5) throw new Error(`M1 not complete (step=${m1.step}); abort`);

  const state = loadM2State();
  console.log(`[M2] starting; resuming from step ${state.step}`);

  const node = createAztecNodeClient(RPC_URL);
  await waitForNode(node);

  const wallet = await EmbeddedWallet.create(node, {
    ephemeral: true,
    pxe: { proverEnabled: true },
  });

  // Re-create the admin Schnorr account from M1's persisted keys.
  const secret = Fr.fromString(m1.secret);
  const salt = Fr.fromString(m1.salt);
  const signingKey = Fq.fromString(m1.signingKey);
  const adminManager = await wallet.createSchnorrAccount(secret, salt, signingKey);
  const admin = (await adminManager.getAccount()).getAddress();
  console.log(`[M2] admin recreated: ${admin.toString()}`);

  if (admin.toString() !== m1.address) {
    throw new Error(`admin address mismatch: ${admin.toString()} vs M1 ${m1.address}`);
  }

  const TUSDC_NAME = "tUSDC".padEnd(31, "\0");
  const TUSDC_SYMBOL = "tUSDC".padEnd(31, "\0");
  const TUSDC_DECIMALS = 6;

  // Step 1: deploy tUSDC Token (admin as minter).
  if (state.step < 1) {
    console.log(`[M2] step 1: deploying tUSDC Token (admin=minter) ...`);
    const start = Date.now();
    const deployedTUSDC = await TokenContract.deployWithOpts(
      { wallet, method: "constructor_with_minter" },
      TUSDC_NAME, TUSDC_SYMBOL, TUSDC_DECIMALS, admin,
    ).send({ from: admin });
    const tUSDCAddr = deployedTUSDC.contract.address.toString();
    state.tUSDCAddress = tUSDCAddr;
    state.step = 1;
    saveM2State(state);
    console.log(`[M2] step 1 OK; tUSDC=${tUSDCAddr} (took ${((Date.now() - start) / 1000).toFixed(1)}s)`);
  } else {
    console.log(`[M2] step 1 cached; tUSDC=${state.tUSDCAddress}`);
  }

  const tUSDCAddr = Fr.fromString(state.tUSDCAddress!);
  const tUSDC = await TokenContract.at(tUSDCAddr, wallet);

  // Step 2: admin mints 1000 tUSDC (1e9 at 6 decimals) to itself
  if (state.step < 2) {
    console.log(`[M2] step 2: mint_to_public(admin, 1000_000_000) ...`);
    const start = Date.now();
    const mintAmount = 1_000_000_000n; // 1000 tUSDC at 6 decimals
    await tUSDC.methods.mint_to_public(admin, mintAmount).send({ from: admin });
    state.mintTx = "submitted";
    state.step = 2;
    saveM2State(state);
    console.log(`[M2] step 2 OK; mint sent (took ${((Date.now() - start) / 1000).toFixed(1)}s)`);
  } else {
    console.log(`[M2] step 2 cached`);
  }

  // Step 3: balance check via simulate (view-call)
  if (state.step < 3) {
    console.log(`[M2] step 3: balance_of_public(admin) ...`);
    const sim = await tUSDC.methods.balance_of_public(admin).simulate({ from: admin });
    // simulate() returns { result: bigint | number }; existing integration tests show this pattern
    const raw = (sim as { result?: bigint | number }).result ?? sim;
    const balance = typeof raw === "object" && raw !== null
      ? BigInt(JSON.stringify(raw))   // shouldn't happen in practice
      : BigInt(raw as bigint | number);
    state.balanceAfterMint = balance.toString();
    state.step = 3;
    saveM2State(state);
    console.log(`[M2] step 3 OK; balance=${balance}`);
    if (balance !== 1_000_000_000n) {
      throw new Error(`balance mismatch: expected 1_000_000_000 got ${balance}`);
    }
  } else {
    console.log(`[M2] step 3 cached; balance=${state.balanceAfterMint}`);
  }

  await wallet.stop();
  console.log(`\n[M2] ALL STEPS PASSED. State: ${M2_STATE}`);
  console.log(`tUSDC: ${state.tUSDCAddress}`);
  console.log(`admin balance: ${state.balanceAfterMint}`);
}

main().catch((e) => {
  console.error(`[M2] FAILED:`, e);
  process.exit(1);
});
