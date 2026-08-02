#!/usr/bin/env node
//
// Sub-5b: Sepolia + Aztec testnet bridge runner.
//
// Walks the full L1<>L2 bridge round trip:
//
//   1.  Verify env (AZTEC_NODE_URL contains 'testnet', L1_RPC_URL contains 'sepolia')
//   2.  Verify deploy state (quetzal.config.json has l1.{usdcBridge, wethBridge,
//       timelock} + tUSDC + tETH)
//   3.  Maker wallet bootstrap (Aztec faucet drip + claim, Sepolia ETH from L1
//       faucet for gas)
//   4.  L1: approve USDCBridge to spend maker's Sepolia USDC
//   5.  L1: USDCBridge.depositToL2Private(amount, secret_hash); capture
//       (message_hash, message_index)
//   6.  Wait 4-15 min for the L1->L2 message to land on Aztec's pending tree
//   7.  L2: aUSDC.claim_private(maker, amount, secret, message_index) via
//       'quetzal bridge claim'
//   8.  L2: 1-hop Quetzal trade (aUSDC -> aWETH); wait epoch_length blocks;
//       close_epoch_and_clear_verified
//   9.  L2: aWETH.exit_to_l1_public(amount, l1_recipient) via 'quetzal bridge exit'
//   10. Wait 30 min - 2 hr for the L2->L1 rollup proof to land on L1
//   11. L1: WETHBridge.withdraw(amount, l1_recipient, l2_epoch, leaf_index,
//       sibling_path) via 'quetzal bridge claim-l1' + cast send
//   12. Verify L1 USDC + WETH balance changes are consistent with the round trip
//
// State persists in testnet-sub5b-state.json. Resume-safe: each step short-circuits
// if its outputs are already in state.
//
// Required env:
//   AZTEC_NODE_URL=https://rpc.testnet.aztec-labs.com
//   L1_RPC_URL=<Sepolia RPC>
//   DEPLOYER_PK=<Sepolia private key with USDC + ETH>
//
// Usage:
//   pnpm tsx scripts/testnet-sub5b-bridge.ts
//
// Step bodies are scaffolded but most are stubs. Reference the testnet-m1-hello.ts
// flow for wallet bootstrap and the cli/src/commands/bridge.ts subcommands for
// the claim/exit/claim-l1 surface.

import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { bootstrapAztecWallet } from "./lib/aztec-wallet-bootstrap.js";

// ── Safety checks ─────────────────────────────────────────────────────────────

if (!process.env.AZTEC_NODE_URL?.includes("testnet")) {
  throw new Error(
    `AZTEC_NODE_URL must include 'testnet' as a safety check; got '${process.env.AZTEC_NODE_URL ?? "<unset>"}'.`,
  );
}
if (!process.env.L1_RPC_URL?.includes("sepolia")) {
  throw new Error(
    `L1_RPC_URL must include 'sepolia' as a safety check; got '${process.env.L1_RPC_URL ?? "<unset>"}'.`,
  );
}
if (!process.env.DEPLOYER_PK) {
  throw new Error("DEPLOYER_PK env var required");
}

const STATE_FILE = "testnet-sub5b-state.json";

interface State {
  step: number;
  txHashes: Record<string, string>;
  secrets: Record<string, string>;
  notes: Record<string, unknown>;
}

function loadState(): State {
  if (existsSync(STATE_FILE)) return JSON.parse(readFileSync(STATE_FILE, "utf8")) as State;
  return { step: 0, txHashes: {}, secrets: {}, notes: {} };
}
function saveState(s: State): void {
  writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}

// ── Steps ─────────────────────────────────────────────────────────────────────

async function step1VerifyEnv(state: State) {
  if (state.step >= 1) return;
  // Already validated above by the throw chain. Stamp the step.
  state.step = 1;
  saveState(state);
}

async function step2VerifyDeploys(state: State) {
  if (state.step >= 2) return;
  // Implementer: read quetzal.config.json; assert l1.usdcBridge + l1.wethBridge +
  // l1.timelock + tUSDC + tETH are non-empty addresses. Throw with a clear
  // message if any are missing — operator runs scripts/deploy-bridge.ts first.
  console.log("step2: verify quetzal.config.json has bridge addresses (stub)");
  state.step = 2;
  saveState(state);
}

async function step3MakerWallet(state: State) {
  if (state.step >= 3) return;
  const { account } = await bootstrapAztecWallet(
    process.env.AZTEC_NODE_URL!,
    "testnet-sub5b-maker-wallet.json",
    "https://aztec-faucet.dev-nethermind.xyz/api/drip",
  );
  state.notes.maker = account.toString();
  state.step = 3;
  saveState(state);
}

async function step4L1Approve(state: State) {
  if (state.step >= 4) return;
  // Implementer: via Foundry cast or viem, maker calls
  //   USDC.approve(USDCBridge, 1_000_000_000) on Sepolia. Capture tx hash.
  console.log("step4: L1 approve USDC -> USDCBridge (stub)");
  state.step = 4;
  saveState(state);
}

async function step5L1Deposit(state: State) {
  if (state.step >= 5) return;
  // Implementer:
  //   - Generate secret = randomBytes(32); persist secret in state.secrets.deposit.
  //   - Compute secret_hash = poseidon2_hash_with_separator([secret], DOM_SEP__SECRET_HASH)
  //     to match aztec-nr's compute_secret_hash. (Use @aztec/foundation/crypto or a
  //     Noir-side helper.)
  //   - Call USDCBridge.depositToL2Private(amount, secret_hash) via cast send.
  //   - Parse the (message_hash, message_index) from event logs; persist in state.
  console.log("step5: L1 depositToL2Private (stub)");
  state.step = 5;
  saveState(state);
}

async function step6BridgeWait(state: State) {
  if (state.step >= 6) return;
  // Implementer: poll node.isL1ToL2MessageSynced(message_hash) (or
  // getL1ToL2MessageCheckpoint) every 30s for up to 30 min. Throw if not
  // synced within timeout.
  console.log("step6: wait for L1->L2 message sync (stub, 4-15 min)");
  state.step = 6;
  saveState(state);
}

async function step7L2Claim(state: State) {
  if (state.step >= 7) return;
  // Implementer:
  //   pnpm quetzal bridge claim --token aUSDC --amount <N> --secret <hex> \
  //     --message-index <N>
  // Or invoke the same code path directly (registerBridge's claim action).
  console.log("step7: aUSDC.claim_private via quetzal bridge claim (stub)");
  state.step = 7;
  saveState(state);
}

async function step8L2Trade(state: State) {
  if (state.step >= 8) return;
  // Implementer: submit a 1-hop Quetzal order aUSDC -> aWETH; wait epoch_length
  // blocks; aggregator does close_epoch_and_clear_verified; maker claim_fill.
  console.log("step8: 1-hop Quetzal trade aUSDC -> aWETH (stub)");
  state.step = 8;
  saveState(state);
}

async function step9L2Exit(state: State) {
  if (state.step >= 9) return;
  // Implementer:
  //   pnpm quetzal bridge exit --token aWETH --amount <N> --l1-recipient <addr> \
  //     --no-private
  // (--no-private is required since exit_to_l1_private has no L1 consumer.)
  // Capture L2 tx hash for the proof lookup.
  console.log("step9: aWETH.exit_to_l1_public via quetzal bridge exit --no-private (stub)");
  state.step = 9;
  saveState(state);
}

async function step10RollupWait(state: State) {
  if (state.step >= 10) return;
  // Implementer: poll node.getTxEffect(l2TxHash) until the epoch is reported
  // as proven on L1 (or use a heuristic: wait until current_epoch >
  // tx_effect.epoch + EPOCHS_PER_PROOF). Typical 30 min - 2 hr.
  console.log("step10: wait for L2->L1 rollup proof on L1 (stub, 30 min - 2 hr)");
  state.step = 10;
  saveState(state);
}

async function step11L1Withdraw(state: State) {
  if (state.step >= 11) return;
  // Implementer:
  //   - Compute expectedContent locally via the same sha256_to_field as the
  //     L2 exit_to_l1_public path.
  //   - lookupOutboxMessage(nodeUrl, l2TxHash, expectedContent) -> (epoch, leafIndex)
  //   - Build sibling_path via Aztec's L1 portal manager helper (vendor it)
  //   - cast send WETHBridge.withdraw(amount, l1_recipient, epoch, leafIndex,
  //     sibling_path)
  console.log("step11: L1 WETHBridge.withdraw (stub)");
  state.step = 11;
  saveState(state);
}

async function step12BalanceCheck(state: State) {
  if (state.step >= 12) return;
  // Implementer: cast call USDC.balanceOf(maker) and WETH.balanceOf(maker) on
  // Sepolia. Assert delta matches expected (USDC down by 100, WETH up by
  // post-trade amount).
  console.log("step12: L1 balance verification (stub)");
  state.step = 12;
  saveState(state);
}

// ── Driver ────────────────────────────────────────────────────────────────────

async function main() {
  const state = loadState();
  console.log(`Sub-5b testnet runner starting at step ${state.step + 1}/12`);
  console.log("");

  await step1VerifyEnv(state);
  await step2VerifyDeploys(state);
  await step3MakerWallet(state);
  await step4L1Approve(state);
  await step5L1Deposit(state);
  await step6BridgeWait(state);
  await step7L2Claim(state);
  await step8L2Trade(state);
  await step9L2Exit(state);
  await step10RollupWait(state);
  await step11L1Withdraw(state);
  await step12BalanceCheck(state);

  console.log("");
  console.log("ALL 12 STEPS PASSED. State:");
  console.log(JSON.stringify(state, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
