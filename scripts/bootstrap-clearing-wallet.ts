#!/usr/bin/env node
//
// Bootstrap a DEDICATED aggregator clearing wallet (separate from the protocol
// admin, for security — the clearing wallet only holds fee-juice, no mint/gov
// powers). Drips fee-juice + deploys the account (FeeJuicePaymentMethodWithClaim).
//
// Reuses the proven bootstrap lib (static-fee bypass works on aztec-labs when
// STATIC_MAX_FEE_PER_L2_GAS is set). Keys land in clearing-wallet-state.json;
// wire them into the aggregator's AGGREGATOR_L2_{SECRET,SALT,SIGNING_KEY}.
//
// Usage:
//   AZTEC_NODE_URL=https://rpc.testnet.aztec-labs.com \
//   STATIC_MAX_FEE_PER_L2_GAS=8000000000000 STATIC_MAX_FEE_PER_DA_GAS=1000000000 \
//     pnpm tsx scripts/bootstrap-clearing-wallet.ts
//
import { bootstrapAztecWallet } from "./lib/aztec-wallet-bootstrap.js";

const RPC_URL    = process.env.AZTEC_NODE_URL ?? "https://rpc.testnet.aztec-labs.com";
const FAUCET_URL = process.env.FAUCET_URL ?? "https://aztec-faucet.dev-nethermind.xyz/api/drip";
const STATE_FILE = process.env.CLEARING_STATE_FILE ?? "clearing-wallet-state.json";

async function main() {
  const { wallet, account } = await bootstrapAztecWallet(RPC_URL, STATE_FILE, FAUCET_URL);
  await wallet.stop();
  console.log(`\n[clearing-wallet] DEPLOYED + FUNDED`);
  console.log(`address: ${account.toString()}`);
  console.log(`keys persisted in ${STATE_FILE} (secret/salt/signingKey) — wire into aggregator env`);
}

main().catch((e) => {
  console.error(`[clearing-wallet] FAILED:`, e);
  process.exit(1);
});
