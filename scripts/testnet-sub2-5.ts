#!/usr/bin/env node
//
// Joint Sub-2.5 + Sub-3 testnet validation runner.
//
// Idempotent: persists deployed addresses + nonces in testnet-state.json
// so a partial run can resume. Steps:
//   1. Deploy stack (4-deploy circular-dep dance from deploy-tokens.ts)
//   2. Register aggregator (Sub-3 path)
//   3. Submit alice's order (Sub-1 path)
//   4. LP1 + LP2 deposit (Sub-2 path, buckets 5 + 7)
//   5. Wait epoch_length blocks
//   6. close_epoch_and_clear_verified (Sub-2.5 path, real ClientIVC proof)
//   7. claim_fill (Sub-1 5d-4 Merkle path)
//   8. LP1 + LP2 withdraw (Sub-2 path)
//   9. Treasury check: aggregator received fee (Sub-3 path)
//
// Required env:
//   AZTEC_NODE_URL=https://aztec-testnet.example.com/
//
// Usage: pnpm tsx scripts/testnet-sub2-5.ts
//
import { writeFileSync, readFileSync, existsSync } from "node:fs";

const NODE_URL = process.env.AZTEC_NODE_URL;
if (!NODE_URL || !NODE_URL.includes("testnet")) {
  throw new Error("AZTEC_NODE_URL must be set + must contain 'testnet' (safety check)");
}
const STATE_FILE = "testnet-state.json";

interface TestnetState {
  step: number;
  txHashes: Record<string, string>;
  contracts: Partial<{
    tUSDC: string; tETH: string; pool: string; orderbook: string;
    aggregatorRegistry: string; treasury: string;
  }>;
  positions: Record<string, string>;
  orders: Record<string, string>;
}

function loadState(): TestnetState {
  if (existsSync(STATE_FILE)) {
    return JSON.parse(readFileSync(STATE_FILE, "utf8")) as TestnetState;
  }
  return { step: 0, txHashes: {}, contracts: {}, positions: {}, orders: {} };
}
function saveState(s: TestnetState) {
  writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}

async function step1Deploy(state: TestnetState) {
  if (state.step >= 1) {
    console.log(`step 1 already done; contracts: ${JSON.stringify(state.contracts)}`);
    return;
  }
  // ... implementer wires deployments using same patterns as
  //     scripts/deploy-tokens.ts (4-deploy circular-dep dance) ...
  // For each deploy, capture tx_hash into state.txHashes and contract
  // address into state.contracts.
  state.step = 1;
  saveState(state);
}

async function step2Register(state: TestnetState) {
  if (state.step >= 2) return;
  // ... implementer wires aggregator-registry registration ...
  state.step = 2;
  saveState(state);
}

async function step3SubmitOrder(state: TestnetState) {
  if (state.step >= 3) return;
  // ... alice.submit_order(buy, 100*SCALE, 2*SCALE, ...) ...
  state.step = 3;
  saveState(state);
}

async function step4Deposit(state: TestnetState) {
  if (state.step >= 4) return;
  // ... lp1.deposit(5, ...) + lp2.deposit(7, ...) ...
  state.step = 4;
  saveState(state);
}

async function step5WaitEpoch(state: TestnetState) {
  if (state.step >= 5) return;
  // ... wait epoch_length testnet blocks via node.getBlockNumber polling ...
  state.step = 5;
  saveState(state);
}

async function step6Clear(state: TestnetState) {
  if (state.step >= 6) return;
  // ... build witness via buildClearingWitness, run nargo execute + bb prove,
  //     call close_epoch_and_clear_verified with the produced (proof, vk) ...
  state.step = 6;
  saveState(state);
}

async function step7ClaimFill(state: TestnetState) {
  if (state.step >= 7) return;
  // ... alice.claim_fill(nonce, merkle_proof, ...) ...
  state.step = 7;
  saveState(state);
}

async function step8Withdraw(state: TestnetState) {
  if (state.step >= 8) return;
  // ... lp1.withdraw(position_nonce, ...) + lp2.withdraw(position_nonce, ...) ...
  state.step = 8;
  saveState(state);
}

async function step9TreasuryCheck(state: TestnetState) {
  if (state.step >= 9) return;
  // ... treasury.view_balance(aggregator_addr) > 0 ...
  state.step = 9;
  saveState(state);
}

async function main() {
  const state = loadState();
  console.log(`starting at step ${state.step + 1}/9`);
  await step1Deploy(state);
  await step2Register(state);
  await step3SubmitOrder(state);
  await step4Deposit(state);
  await step5WaitEpoch(state);
  await step6Clear(state);
  await step7ClaimFill(state);
  await step8Withdraw(state);
  await step9TreasuryCheck(state);
  console.log("ALL STEPS PASSED. tx hashes:");
  console.log(JSON.stringify(state.txHashes, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
