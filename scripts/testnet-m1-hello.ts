#!/usr/bin/env node
//
// M1: Hello-world testnet validation.
//
// Aztec testnet fee-juice flow:
//   1. Generate Schnorr account keypair
//   2. POST address to faucet -> faucet bridges fee-juice from L1 -> L2
//      and returns claimData (claimAmount, claimSecret, messageLeafIndex)
//   3. Wait for L1->L2 message to land on Aztec's pending message tree
//   4. Deploy the account paying for the deploy via FeeJuicePaymentMethodWithClaim
//      (which consumes the L1->L2 message in the SAME tx as the deploy)
//   5. Verify account is registered
//
// Usage: pnpm tsx scripts/testnet-m1-hello.ts
// State: testnet-m1-state.json (idempotent resume)
//
import { bootstrapAztecWallet } from "./lib/aztec-wallet-bootstrap.js";

const RPC_URL    = process.env.AZTEC_NODE_URL ?? "https://rpc.testnet.aztec-labs.com";
const FAUCET_URL = "https://aztec-faucet.dev-nethermind.xyz/api/drip";
const STATE_FILE = "testnet-m1-state.json";

async function main() {
  const { wallet, account } = await bootstrapAztecWallet(RPC_URL, STATE_FILE, FAUCET_URL);
  await wallet.stop();
  console.log(`\n[M1] ALL STEPS PASSED.`);
  console.log(`Address: ${account.toString()}`);
}

main().catch((e) => {
  console.error(`[M1] FAILED:`, e);
  process.exit(1);
});
