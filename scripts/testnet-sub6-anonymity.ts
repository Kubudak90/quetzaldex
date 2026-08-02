#!/usr/bin/env node
//
// Sub-6a E2: live anonymity-set lifecycle runner against Aztec testnet.
//
// State-persisted: each step's outcome is written to
// testnet-sub6-state.json (project root). Re-running the script skips any
// step already marked done. Lets the operator survive PXE
// tagging-window stalls + gas spikes + transient testnet outages.
//
// Mirrors testnet-sub5b-bridge.ts state machine; safety checks copied
// + adapted for Sub-6a's bulk-submit + decoy + bridge surfaces.
//
// Usage:
//   pnpm tsx scripts/testnet-sub6-anonymity.ts            # resume
//   pnpm tsx scripts/testnet-sub6-anonymity.ts --reset    # nuke state + restart
//   pnpm tsx scripts/testnet-sub6-anonymity.ts --help     # print usage
//
// Environment:
//   AZTEC_RPC_URL              e.g., https://rpc.testnet.aztec-labs.com
//   AZTEC_PRIVATE_KEY          alice's hex32 secret (will be funded from faucet)
//   L1_RPC_URL                 Sepolia HTTPS endpoint
//   L1_PRIVATE_KEY             alice's Sepolia secret (for bridge txs)
//   L1_MAKER_ADDR              alice's L1 EOA address (for bridge advisory check)
//   ORDERBOOK_ADDR             deployed orderbook L2 address (hex33)
//   USDC_BRIDGE_ADDR           deployed L1 USDC bridge address
//   AUSDC_L2_ADDR              deployed aUSDC L2 token address (hex33)

import { writeFileSync, readFileSync, existsSync } from "node:fs";

// ── Safety checks (module-level, mirrors testnet-sub5b-bridge.ts) ─────────────

// --help and --reset don't need env at all; skip safety checks for them.
const isHelp = process.argv.includes("--help") || process.argv.includes("-h");
const isReset = process.argv.includes("--reset");

if (!isHelp) {
  if (process.env.AZTEC_RPC_URL?.includes("mainnet")) {
    throw new Error(
      `Refusing to run anonymity-set test against mainnet RPC (AZTEC_RPC_URL='${process.env.AZTEC_RPC_URL}').`,
    );
  }
  if (process.env.L1_RPC_URL?.includes("mainnet.infura.io")) {
    throw new Error(
      `Refusing to run against L1 mainnet RPC (L1_RPC_URL='${process.env.L1_RPC_URL}').`,
    );
  }
}

const STATE_FILE = "testnet-sub6-state.json";

// ── State types ───────────────────────────────────────────────────────────────

type StepStatus = "pending" | "done" | "skipped" | "failed";

interface StepRecord {
  name: string;
  status: StepStatus;
  startedAtUnix: number | null;
  completedAtUnix: number | null;
  notes: string;
  txHashes: string[];
}

interface RunnerState {
  startedAtUnix: number;
  aliceAddrL2: string | null;
  aliceAddrL1: string | null;
  decoyNonces: string[];
  realNonce: string | null;
  bulkEpoch: number | null;
  steps: Record<string, StepRecord>;
}

const STEP_NAMES = [
  "S1_wallet_bootstrap",
  "S2_bridge_deposit_seed",
  "S3_bulk_submit_with_8_decoys",
  "S4_assert_registry_has_9_entries",
  "S5_close_epoch_and_clear",
  "S6_selective_claim_filters_decoys",
  "S7_cancel_decoys_reclaims_escrow",
  "S8_round_amount_bridge_exit_blocked_then_acked",
] as const;
type StepName = (typeof STEP_NAMES)[number];

// ── State persistence ─────────────────────────────────────────────────────────

function loadState(): RunnerState {
  if (!existsSync(STATE_FILE)) {
    const steps: Record<string, StepRecord> = {};
    for (const n of STEP_NAMES) {
      steps[n] = {
        name: n,
        status: "pending",
        startedAtUnix: null,
        completedAtUnix: null,
        notes: "",
        txHashes: [],
      };
    }
    return {
      startedAtUnix: Math.floor(Date.now() / 1000),
      aliceAddrL2: null,
      aliceAddrL1: null,
      decoyNonces: [],
      realNonce: null,
      bulkEpoch: null,
      steps,
    };
  }
  return JSON.parse(readFileSync(STATE_FILE, "utf8")) as RunnerState;
}

function saveState(s: RunnerState): void {
  writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}

// ── Step bodies (SCAFFOLD: operator session fills in actual calls) ─────────────

async function runS1WalletBootstrap(state: RunnerState): Promise<void> {
  // SCAFFOLD: copy from scripts/lib/aztec-wallet-bootstrap.ts
  //   1. Connect PXE at AZTEC_RPC_URL via createAztecNodeClient + waitForNode
  //   2. EmbeddedWallet.create(node, { ephemeral: true, pxe: { proverEnabled: true } })
  //   3. Derive alice from AZTEC_PRIVATE_KEY via wallet.createSchnorrAccount(secret, salt, signingKey)
  //   4. POST alice.address to faucet (https://aztec-faucet.dev-nethermind.xyz/api/drip)
  //      if alice fee-juice balance == 0
  //   5. Deploy alice account with FeeJuicePaymentMethodWithClaim (retry loop, 30 min)
  //   6. state.aliceAddrL2 = alice.getAddress().toString()
  //   7. saveState(state)
  console.warn("[S1 SCAFFOLD] copy aztec-wallet-bootstrap.ts wallet bootstrap");
  void state;
}

async function runS2BridgeDepositSeed(state: RunnerState): Promise<void> {
  // SCAFFOLD: copy from scripts/testnet-sub5b-bridge.ts steps 4-8
  //   1. Require L1_RPC_URL, L1_PRIVATE_KEY, USDC_BRIDGE_ADDR, AUSDC_L2_ADDR from env
  //   2. Connect viem walletClient (Sepolia) with L1_PRIVATE_KEY
  //   3. USDC.approve(USDCBridge, 100_000_000) on Sepolia; capture txHash
  //   4. Generate deposit secret = randomBytes(32); persist in state
  //   5. Compute secret_hash = poseidon2_hash_with_separator([secret], DOM_SEP__SECRET_HASH)
  //   6. USDCBridge.depositToL2Private(amount=100_000_000, secretHash, aliceAddrL2)
  //      via viem walletClient; capture (messageHash, messageIndex)
  //   7. Poll node.isL1ToL2MessageSynced(messageHash) every 30s up to 30 min
  //   8. alice.aUSDC.claim_private(amount, secret, messageIndex)
  //   9. Assert alice aUSDC balance >= 100_000_000
  //  10. saveState(state)
  console.warn("[S2 SCAFFOLD] copy testnet-sub5b-bridge.ts deposit steps 4-8");
  void state;
}

async function runS3BulkSubmitWith8Decoys(state: RunnerState): Promise<void> {
  // SCAFFOLD: shell out to the quetzal CLI (mirrors testnet-sub5a.ts step 10)
  //   import { spawn } from "node:child_process"
  //   const proc = spawn('pnpm', ['tsx', 'cli/src/index.ts', 'order', 'place',
  //     '--side', 'sell',
  //     '--amount', '1.234567',
  //     '--limit-price', '5000',
  //     '--path', 'tUSDC,tETH',
  //     '--decoys', '8',
  //     '--account', '0'], { stdio: ['ignore', 'pipe', 'pipe'] })
  //   Capture stdout -> JSON lines -> extract 9 nonces (1 real + 8 decoy)
  //   state.realNonce   = the nonce flagged isDecoy: false
  //   state.decoyNonces = the 8 nonces flagged isDecoy: true
  //   state.bulkEpoch   = tx receipt block's epoch (from node.getBlockNumber() / epochLength)
  //   saveState(state)
  //
  //   NOTE: --decoys 8 is the CLI flag added in Sub-6a E1; assert it exists
  //   before submitting (spawn 'quetzal order place --help' and grep '--decoys')
  console.warn("[S3 SCAFFOLD] spawn 'quetzal order place --decoys 8'; parse 9 nonces");
  void state;
}

async function runS4AssertRegistryHas9Entries(state: RunnerState): Promise<void> {
  // SCAFFOLD: read ~/.quetzal/decoy-registry-<aliceAddrL2>.json
  //   import { homedir } from "node:os"
  //   const registryPath = join(homedir(), '.quetzal',
  //     `decoy-registry-${state.aliceAddrL2}.json`)
  //   const registry = JSON.parse(readFileSync(registryPath, 'utf8'))
  //   const entries = Object.values(registry) as DecoyEntry[]
  //   Assert entries.length === 9
  //   Assert exactly 1 entry has isDecoy === false (the real order)
  //   Assert exactly 8 entries have isDecoy === true
  //   Assert realEntry.nonce === state.realNonce
  //   Assert decoyEntries.map(e => e.nonce).sort() deep-equals state.decoyNonces.sort()
  //   console.log(`[S4] registry OK: 9 entries (1 real + 8 decoys)`)
  console.warn("[S4 SCAFFOLD] assert decoy-registry shape (9 entries, 1 real, 8 decoy)");
  void state;
}

async function runS5CloseEpochAndClear(state: RunnerState): Promise<void> {
  // SCAFFOLD: depends on Sub-3/Sub-5a aggregator flow
  //   1. Query current epoch: const currentEpoch = await node.getBlockNumber() / epochLength
  //   2. While currentEpoch < state.bulkEpoch + 1, sleep 30s and re-poll
  //   3. spawn('pnpm', ['tsx', 'cli/src/index.ts', 'orderbook',
  //        'close-epoch-and-clear-verified', '--epoch', String(state.bulkEpoch)])
  //   4. Capture stdout; assert exit code === 0
  //   5. Assert clearing tx hash present in stdout; append to state.steps.S5.txHashes
  //   6. Assert verified fill set contains state.realNonce (grep stdout for realNonce)
  //   7. Assert decoy nonces are absent from verified fill set
  //      (their limit-price gates fail: decoy orders have intentionally bad prices)
  //   saveState(state)
  //
  //   NOTE: still blocked by 4-deploy circular dep if operator hasn't redeployed
  //   with Sub-5a deterministic-address fix. Check ORDERBOOK_ADDR env is set.
  console.warn("[S5 SCAFFOLD] close epoch + assert verified fill set (real nonce only)");
  void state;
}

async function runS6SelectiveClaimFiltersDecoys(state: RunnerState): Promise<void> {
  // SCAFFOLD:
  //   spawn('pnpm', ['tsx', 'cli/src/index.ts', 'order', 'claim',
  //     '--epoch', String(state.bulkEpoch)])
  //   Capture stdout + stderr
  //   Assert exit code === 0
  //   Assert stdout contains exactly 1 "claim_fill" success line
  //   Assert stdout contains exactly 8 "Skipping decoy nonce" log lines
  //     (one per decoy; CLI checks the decoy-registry before calling claim_fill)
  //   Assert alice aUSDC balance reduced by the real order's settled amount
  //     (not the decoy amounts — those remain escrowed until S7)
  //   saveState(state)
  console.warn("[S6 SCAFFOLD] spawn 'quetzal order claim'; assert 1 fill + 8 skips");
  void state;
}

async function runS7CancelDecoysReclaimsEscrow(state: RunnerState): Promise<void> {
  // SCAFFOLD:
  //   spawn('pnpm', ['tsx', 'cli/src/index.ts', 'cancel-decoys',
  //     '--epoch', String(state.bulkEpoch)])
  //   Capture stdout; assert exit code === 0
  //   Assert stdout contains exactly 8 "cancel_order" success lines
  //   Record 8 cancel tx hashes -> state.steps.S7.txHashes
  //   Assert alice aUSDC balance restored by sum(decoyEscrowAmounts)
  //   Assert decoy-registry entries for the 8 decoy nonces are removed
  //     (read ~/.quetzal/decoy-registry-<aliceAddrL2>.json; assert
  //      state.decoyNonces absent from remaining keys)
  //   saveState(state)
  console.warn("[S7 SCAFFOLD] spawn 'quetzal cancel-decoys'; assert 8 reclaims + registry clean");
  void state;
}

async function runS8RoundAmountBridgeExitBlockedThenAcked(state: RunnerState): Promise<void> {
  // SCAFFOLD:
  //   Phase A: blocked by round-amount privacy guardrail
  //     spawn('pnpm', ['tsx', 'cli/src/index.ts', 'bridge', 'exit',
  //       '--token', 'aUSDC',
  //       '--amount', '10',      // 10.000000 USDC = round_unit -> should block
  //       '--recipient', process.env.L1_MAKER_ADDR!])
  //     Assert exit code !== 0
  //     Assert stderr contains "looks round" or "round_unit" advisory message
  //
  //   Phase B: operator acks risk flags + succeeds
  //     spawn('pnpm', ['tsx', 'cli/src/index.ts', 'bridge', 'exit',
  //       '--token', 'aUSDC',
  //       '--amount', '10',
  //       '--recipient', process.env.L1_MAKER_ADDR!,
  //       '--ack-round',      // suppress round-amount guardrail
  //       '--ack-delay'])     // suppress delay advisory
  //     Assert exit code === 0
  //     Parse L2 tx hash from stdout -> state.steps.S8.txHashes
  //     Assert outbox lookup returns (epoch, leafIndex) for the L2->L1 message
  //       (mirrors testnet-sub5b-bridge.ts step 11 outbox pattern)
  //     saveState(state)
  console.warn("[S8 SCAFFOLD] bridge exit: assert round-amount block, then --ack-round proceeds");
  void state;
}

// ── Step dispatcher ───────────────────────────────────────────────────────────

const STEP_RUNNERS: Record<StepName, (s: RunnerState) => Promise<void>> = {
  S1_wallet_bootstrap: runS1WalletBootstrap,
  S2_bridge_deposit_seed: runS2BridgeDepositSeed,
  S3_bulk_submit_with_8_decoys: runS3BulkSubmitWith8Decoys,
  S4_assert_registry_has_9_entries: runS4AssertRegistryHas9Entries,
  S5_close_epoch_and_clear: runS5CloseEpochAndClear,
  S6_selective_claim_filters_decoys: runS6SelectiveClaimFiltersDecoys,
  S7_cancel_decoys_reclaims_escrow: runS7CancelDecoysReclaimsEscrow,
  S8_round_amount_bridge_exit_blocked_then_acked: runS8RoundAmountBridgeExitBlockedThenAcked,
};

// ── Entry point ───────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  if (isHelp) {
    console.log("Usage: pnpm tsx scripts/testnet-sub6-anonymity.ts [--reset]");
    console.log("");
    console.log("State file: " + STATE_FILE + " (project root, gitignored)");
    console.log("");
    console.log("Steps:");
    for (const n of STEP_NAMES) {
      console.log("  " + n);
    }
    console.log("");
    console.log("Required env vars:");
    console.log("  AZTEC_RPC_URL, AZTEC_PRIVATE_KEY");
    console.log("  L1_RPC_URL, L1_PRIVATE_KEY, L1_MAKER_ADDR");
    console.log("  ORDERBOOK_ADDR, USDC_BRIDGE_ADDR, AUSDC_L2_ADDR");
    return;
  }

  if (isReset) {
    if (existsSync(STATE_FILE)) {
      writeFileSync(STATE_FILE, "");
      console.log(`Reset state file: ${STATE_FILE}`);
    } else {
      console.log(`No state file to reset: ${STATE_FILE}`);
    }
  }

  const state = loadState();
  console.log(`Sub-6a anonymity-set testnet runner. State: ${STATE_FILE}`);
  console.log(`Started: ${new Date(state.startedAtUnix * 1000).toISOString()}`);
  console.log("");

  for (const name of STEP_NAMES) {
    const step = state.steps[name];
    if (!step) throw new Error(`Missing step record for ${name}`);

    if (step.status === "done") {
      console.log(`[skip] ${name} (already done)`);
      continue;
    }
    if (step.status === "skipped") {
      console.log(`[skip] ${name} (operator-marked)`);
      continue;
    }

    console.log(`[run]  ${name}`);
    step.startedAtUnix = Math.floor(Date.now() / 1000);
    saveState(state);

    try {
      await STEP_RUNNERS[name](state);
      step.status = "done";
      step.completedAtUnix = Math.floor(Date.now() / 1000);
      saveState(state);
      console.log(`[done] ${name}`);
    } catch (err) {
      step.status = "failed";
      step.notes = err instanceof Error ? err.message : String(err);
      step.completedAtUnix = Math.floor(Date.now() / 1000);
      saveState(state);
      console.error(`[fail] ${name}: ${step.notes}`);
      throw err;
    }
  }

  console.log("");
  console.log("All steps complete.");
}

main().catch((err) => {
  console.error("Runner failed:");
  console.error(err);
  process.exit(1);
});
