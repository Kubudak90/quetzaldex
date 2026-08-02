#!/usr/bin/env node
//
// Sub-8.3: Full L1↔L2 bridge E2E validation runner.
//
// Walks the full deposit → claim → exit → outbox-proof → L1-withdraw round
// trip on Aztec testnet + Sepolia. State-persisted, resume-safe (same pattern
// as scripts/seed-lp.ts and wallet-pool-bootstrap.ts): each step short-circuits
// if its outputs are already in state.
//
// Validates the surface that the Sub-7c bridge UI consumes:
//   - sdk/src/bridge.ts BridgeApi.{deposit, getMessageReady, claim, exit, prepareL1Withdraw}
//   - sdk/src/util/outbox-proof.ts buildOutboxProof
//   - sdk/src/util/sha256-content.ts computeWithdrawContent
//
// State file: testnet-bridge-e2e-state.json (gitignored).
//
// Usage:
//   dotenv -e .env.testnet -- pnpm tsx scripts/testnet-bridge-e2e.ts
//
// Required env (.env.testnet):
//   AZTEC_NODE_URL=https://rpc.testnet.aztec-labs.com
//   L1_RPC_URL=<Sepolia RPC>
//   L1_PRIVATE_KEY=<Sepolia private key with ≥0.01 ETH + ≥15 USDC>
//   L1_PUBLIC_ADDRESS=<address derived from L1_PRIVATE_KEY>
//
// Steps:
//   0  env / config / node sanity
//   1  L1 USDC.approve(usdcBridge, DEPOSIT_AMOUNT)
//   2  L1 USDCBridge.depositToL2Public(amount, makerL2, secretHash)
//   3  poll BridgeApi.getMessageReady() until the L1→L2 inbox message lands
//   4  L2 aUSDC.claim_public(maker, amount, secret, leafIndex)
//   5  verify L2 aUSDC balance increased
//   6  L2 aUSDC.exit_to_l1_public(EXIT_AMOUNT, l1Recipient) → l2TxHash
//   7  poll buildOutboxProof() until the L2 epoch is proven on L1
//   8  L1 USDCBridge.withdraw(amount, recipient, l2Epoch, leafIndex, siblingPath)
//   9  verify L1 USDC balance change (≈ -DEPOSIT + EXIT)
//
// Steps 7+ require Aztec testnet epoch finalisation (~30-90 min). If we time
// out there, state is preserved and the next run resumes from the same point.

import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import {
  createWalletClient,
  createPublicClient,
  http,
  parseAbi,
  parseEventLogs,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { Fr } from "@aztec/aztec.js/fields";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { computeSecretHash } from "@aztec/stdlib/hash";
import { bootstrapAztecWallet } from "./lib/aztec-wallet-bootstrap.js";
import { TokenContract } from "../tests/integration/generated/Token.js";
// Outbox proof + withdraw content reconstruction come from the workspace SDK
// main barrel (see sdk/src/index.ts re-exports).
import {
  buildOutboxProof,
  OutboxProofNotReadyError,
  computeWithdrawContent,
} from "@quetzal/sdk";

// ── Tunables ─────────────────────────────────────────────────────────────────
const DEPOSIT_AMOUNT = 10_000_000n; // 10 USDC (6 decimals)
const EXIT_AMOUNT = 5_000_000n; //  5 USDC
const STATE_PATH = "testnet-bridge-e2e-state.json";

const POLL_INBOX_INTERVAL_MS = 30_000; //  30 s
const POLL_INBOX_MAX_MIN = 25; //  25 min
const POLL_OUTBOX_INTERVAL_MS = 120_000; // 120 s
const POLL_OUTBOX_MAX_MIN = 90; //  90 min

const USDC_L1 = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238" as const;

// ── State ────────────────────────────────────────────────────────────────────
interface State {
  step: number;
  startedAt: string;
  // L1 deposit (steps 1-3)
  approveTx?: string;
  depositTx?: string;
  depositGasGwei?: string;
  secret?: string;
  secretHash?: string;
  messageIndex?: string;
  messageHash?: string;
  l1UsdcBalBefore?: string;
  // L2 claim (steps 4-5)
  claimTx?: string;
  l2BalAfterClaim?: string;
  // L2 exit (step 6)
  exitTx?: string;
  exitContent?: string;
  exitL1Recipient?: string;
  // L1 withdraw (steps 7-9)
  l2Epoch?: string;
  outboxLeafIndex?: string;
  siblingPath?: string[];
  withdrawTx?: string;
  l1UsdcBalAfter?: string;
  // timings (seconds since startedAt)
  timings: Record<string, number>;
  errors: Array<{ step: number; ts: string; msg: string }>;
}

function loadState(): State {
  if (existsSync(STATE_PATH)) {
    return JSON.parse(readFileSync(STATE_PATH, "utf8")) as State;
  }
  return {
    step: 0,
    startedAt: new Date().toISOString(),
    timings: {},
    errors: [],
  };
}
function saveState(s: State): void {
  writeFileSync(STATE_PATH, JSON.stringify(s, null, 2));
}
function mark(state: State, key: string): void {
  state.timings[key] = Math.floor(
    (Date.now() - new Date(state.startedAt).getTime()) / 1000,
  );
}
function recordError(state: State, step: number, err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  state.errors.push({ step, ts: new Date().toISOString(), msg });
  saveState(state);
}

// ── ABIs ─────────────────────────────────────────────────────────────────────
const ERC20_ABI = parseAbi([
  "function approve(address spender, uint256 amount) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
]);
const DEPOSIT_ABI = parseAbi([
  "function depositToL2Public(uint256 amount, bytes32 l2Recipient, bytes32 secretHash) returns (bytes32 messageHash, uint256 messageIndex)",
  "event DepositInitiated(address indexed sender, bytes32 indexed l2Recipient, uint256 amount, bytes32 secretHash, uint256 messageIndex, bool isPrivate)",
]);
const WITHDRAW_ABI = parseAbi([
  "function withdraw(uint256 amount, address recipient, uint256 l2Epoch, uint256 leafIndex, bytes32[] siblingPath)",
]);

// ── Main ─────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  // Env validation
  const NODE_URL = process.env.AZTEC_NODE_URL ?? "";
  if (!NODE_URL.includes("testnet")) {
    throw new Error(
      `AZTEC_NODE_URL must include 'testnet' as a safety check; got '${NODE_URL || "<unset>"}'.`,
    );
  }
  const L1_RPC = process.env.L1_RPC_URL ?? process.env.SEPOLIA_RPC_URL ?? "";
  if (!L1_RPC) throw new Error("L1_RPC_URL or SEPOLIA_RPC_URL env var required");
  const PK = process.env.L1_PRIVATE_KEY ?? process.env.DEPLOYER_PK ?? "";
  if (!PK) throw new Error("L1_PRIVATE_KEY (or DEPLOYER_PK) env var required");

  const cfg = JSON.parse(readFileSync("quetzal.config.json", "utf8")) as {
    bridge?: { aUSDC?: string };
    l1?: { usdcBridge?: string };
  };
  const aUSDC = cfg.bridge?.aUSDC;
  const usdcBridge = cfg.l1?.usdcBridge;
  if (!aUSDC || !usdcBridge) {
    throw new Error("quetzal.config.json missing .bridge.aUSDC or .l1.usdcBridge");
  }

  const state = loadState();
  console.log(
    `[sub8-3] resuming from step ${state.step}; deposit=${DEPOSIT_AMOUNT} exit=${EXIT_AMOUNT}`,
  );
  console.log(`[sub8-3] L1 bridge = ${usdcBridge}`);
  console.log(`[sub8-3] L2 aUSDC  = ${aUSDC}`);

  // ── viem L1 ──
  const pk = PK.startsWith("0x") ? (PK as `0x${string}`) : (`0x${PK}` as `0x${string}`);
  const acct = privateKeyToAccount(pk);
  const wc = createWalletClient({
    account: acct,
    chain: sepolia,
    transport: http(L1_RPC),
  });
  const pc = createPublicClient({ chain: sepolia, transport: http(L1_RPC) });
  console.log(`[sub8-3] L1 operator = ${acct.address}`);

  // Snapshot L1 USDC at start if not done
  if (state.l1UsdcBalBefore === undefined) {
    const bal = await pc.readContract({
      address: USDC_L1,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [acct.address],
    });
    state.l1UsdcBalBefore = (bal as bigint).toString();
    saveState(state);
    console.log(`[sub8-3] L1 USDC balance before = ${state.l1UsdcBalBefore}`);
  }

  // ── Aztec L2 wallet (reuse deploy-bridge-state.json) ──
  const { wallet, account: maker } = await bootstrapAztecWallet(
    NODE_URL,
    "deploy-bridge-state.json",
  );
  console.log(`[sub8-3] L2 maker = ${maker.toString()}`);

  try {
    // ── Step 1: L1 USDC.approve ──
    if (state.step < 1) {
      console.log("step 1: USDC.approve(usdcBridge, DEPOSIT_AMOUNT) ...");
      const hash = await wc.writeContract({
        address: USDC_L1,
        abi: ERC20_ABI,
        functionName: "approve",
        args: [usdcBridge as `0x${string}`, DEPOSIT_AMOUNT],
      });
      const r = await pc.waitForTransactionReceipt({ hash });
      state.approveTx = r.transactionHash;
      mark(state, "approve_done_s");
      state.step = 1;
      saveState(state);
      console.log(`  approve tx ${r.transactionHash} (gas ${r.gasUsed})`);
    }

    // ── Step 2: L1 deposit ──
    if (state.step < 2) {
      console.log("step 2: USDCBridge.depositToL2Public(amount, makerL2, secretHash) ...");
      const secretFr = Fr.random();
      const secret = secretFr.toString();
      const secretHash = (await computeSecretHash(secretFr)).toString();
      const makerBytes32 = new Fr(BigInt(maker.toString())).toString();

      const hash = await wc.writeContract({
        address: usdcBridge as `0x${string}`,
        abi: DEPOSIT_ABI,
        functionName: "depositToL2Public",
        args: [DEPOSIT_AMOUNT, makerBytes32 as `0x${string}`, secretHash as `0x${string}`],
      });
      const r = await pc.waitForTransactionReceipt({ hash });
      const logs = parseEventLogs({
        abi: DEPOSIT_ABI,
        logs: r.logs,
        eventName: "DepositInitiated",
      });
      if (logs.length === 0) throw new Error("DepositInitiated event missing from receipt");
      state.depositTx = r.transactionHash;
      state.secret = secret;
      state.secretHash = secretHash;
      state.messageIndex = logs[0].args.messageIndex.toString();
      state.depositGasGwei = r.gasUsed.toString();
      mark(state, "deposit_done_s");
      state.step = 2;
      saveState(state);
      console.log(
        `  deposit tx ${r.transactionHash} ; messageIndex ${state.messageIndex} ; secretHash ${secretHash}`,
      );
    }

    // ── Step 3: bounded sleep, let the claim retry loop confirm readiness ──
    // The L1→L2 inbox window on Sepolia is ~3-15 min (Sub-7c RUNBOOK).  We
    // sleep a conservative 4 min here so most subsequent claim attempts
    // succeed first try; step 4 has its own 15-min retry budget.
    if (state.step < 3) {
      const sleepMs = 4 * 60_000;
      console.log(`step 3: sleeping ${sleepMs / 1000}s for L1→L2 inbox window before attempting claim ...`);
      await sleep(sleepMs);
      mark(state, "inbox_wait_s");
      state.step = 3;
      saveState(state);
    }

    // ── Step 4: L2 claim_public ──
    if (state.step < 4) {
      console.log("step 4: register aUSDC + aUSDC.claim_public(maker, amount, secret, leafIndex) ...");
      const { createAztecNodeClient } = await import("@aztec/aztec.js/node");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const node = createAztecNodeClient(NODE_URL) as any;
      const instance = await node.getContract(AztecAddress.fromStringUnsafe(aUSDC));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const walletAny = wallet as any;
      if (typeof walletAny.registerContract === "function") {
        await walletAny.registerContract(instance, TokenContract.artifact);
      }
      const token = await TokenContract.at(AztecAddress.fromStringUnsafe(aUSDC), wallet);
      const secretFr = Fr.fromString(state.secret!);
      const leafIdx = BigInt(state.messageIndex!);

      // Retry loop: testnet sometimes lags 1-2 more minutes after the witness
      // appears.  Caps at 15 min.
      const claimStart = Date.now();
      const claimDeadline = 15 * 60 * 1000;
      let claimTxHash: string | undefined;
      while (Date.now() - claimStart < claimDeadline) {
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const tx = await (token.methods as any)
            .claim_public(maker, DEPOSIT_AMOUNT, secretFr, leafIdx)
            .send({ from: maker });
          const r = await tx.wait();
          claimTxHash = r.txHash?.toString?.() ?? "unknown";
          break;
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          const retryable = /L1.*L2|message|tree|membership|claim/i.test(msg);
          console.log(`  claim attempt failed: ${msg.slice(0, 200)}`);
          if (!retryable) throw e;
          await sleep(60_000);
        }
      }
      if (!claimTxHash) throw new Error("claim_public timed out after 15 min");
      state.claimTx = claimTxHash;
      mark(state, "claim_done_s");
      state.step = 4;
      saveState(state);
      console.log(`  claim tx ${claimTxHash}`);
    }

    // ── Step 5: verify L2 balance ──
    if (state.step < 5) {
      console.log("step 5: verifying L2 aUSDC balance increased ...");
      const token = await TokenContract.at(AztecAddress.fromStringUnsafe(aUSDC), wallet);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const bal = await (token.methods as any).balance_of_public(maker).simulate();
      state.l2BalAfterClaim = bal.toString();
      mark(state, "verify_done_s");
      state.step = 5;
      saveState(state);
      console.log(`  L2 aUSDC public balance: ${bal}`);
    }

    // ── Step 6: L2 exit_to_l1_public ──
    if (state.step < 6) {
      console.log(`step 6: aUSDC.exit_to_l1_public(${EXIT_AMOUNT}, l1Recipient=${acct.address}) ...`);
      const token = await TokenContract.at(AztecAddress.fromStringUnsafe(aUSDC), wallet);
      const l1RecipientFr = new Fr(BigInt(acct.address));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const tx = await (token.methods as any)
        .exit_to_l1_public(EXIT_AMOUNT, l1RecipientFr)
        .send({ from: maker });
      const r = await tx.wait();
      const l2TxHash = r.txHash?.toString?.() ?? "unknown";

      // Compute expected outbox content (matches L1 + L2 reconstruction).
      // L1 recipient is treated as the 20-byte address (no padding).
      const content = computeWithdrawContent(acct.address, EXIT_AMOUNT, false);
      state.exitTx = l2TxHash;
      state.exitContent = content;
      state.exitL1Recipient = acct.address;
      mark(state, "exit_done_s");
      state.step = 6;
      saveState(state);
      console.log(`  exit tx ${l2TxHash} ; expectedContent ${content}`);
    }

    // ── Step 7: poll for outbox proof (epoch finalisation on L1) ──
    if (state.step < 7) {
      console.log(
        `step 7: polling buildOutboxProof for l2TxHash=${state.exitTx} (epoch must finalise on L1, ~30-90 min) ...`,
      );
      const start = Date.now();
      let proof: Awaited<ReturnType<typeof buildOutboxProof>> | undefined;
      while (Date.now() - start < POLL_OUTBOX_MAX_MIN * 60_000) {
        try {
          proof = await buildOutboxProof(NODE_URL, state.exitTx!, state.exitContent!);
          break;
        } catch (e) {
          if (e instanceof OutboxProofNotReadyError) {
            const elapsed = Math.floor((Date.now() - start) / 1000);
            console.log(`  proof not ready (elapsed ${elapsed}s); sleeping ${POLL_OUTBOX_INTERVAL_MS / 1000}s`);
            await sleep(POLL_OUTBOX_INTERVAL_MS);
            continue;
          }
          throw e;
        }
      }
      if (!proof) {
        // BLOCKED: epoch hasn't finalised within our window.  Persist state
        // so a future rerun resumes from this step.
        recordError(
          state,
          7,
          new Error(
            `outbox proof not ready after ${POLL_OUTBOX_MAX_MIN} min; rerun later`,
          ),
        );
        throw new Error(
          `[sub8-3] BLOCKED at step 7: L2 epoch not yet proven on L1. ` +
            `Rerun this script later (state preserved in ${STATE_PATH}).`,
        );
      }
      state.l2Epoch = proof.l2Epoch;
      state.outboxLeafIndex = proof.leafIndex;
      state.siblingPath = proof.siblingPath;
      mark(state, "outbox_ready_s");
      state.step = 7;
      saveState(state);
      console.log(
        `  outbox proof ready: epoch=${proof.l2Epoch} leafIndex=${proof.leafIndex} pathLen=${proof.siblingPath.length}`,
      );
    }

    // ── Step 8: L1 withdraw ──
    if (state.step < 8) {
      console.log("step 8: USDCBridge.withdraw(amount, recipient, l2Epoch, leafIndex, siblingPath) ...");
      const hash = await wc.writeContract({
        address: usdcBridge as `0x${string}`,
        abi: WITHDRAW_ABI,
        functionName: "withdraw",
        args: [
          EXIT_AMOUNT,
          acct.address,
          BigInt(state.l2Epoch!),
          BigInt(state.outboxLeafIndex!),
          state.siblingPath as `0x${string}`[],
        ],
      });
      const r = await pc.waitForTransactionReceipt({ hash });
      state.withdrawTx = r.transactionHash;
      mark(state, "withdraw_done_s");
      state.step = 8;
      saveState(state);
      console.log(`  withdraw tx ${r.transactionHash} (gas ${r.gasUsed})`);
    }

    // ── Step 9: verify L1 USDC balance ──
    if (state.step < 9) {
      console.log("step 9: verifying L1 USDC balance change ...");
      const bal = await pc.readContract({
        address: USDC_L1,
        abi: ERC20_ABI,
        functionName: "balanceOf",
        args: [acct.address],
      });
      state.l1UsdcBalAfter = (bal as bigint).toString();
      mark(state, "verify_l1_done_s");
      state.step = 9;
      saveState(state);
      const delta = BigInt(state.l1UsdcBalAfter) - BigInt(state.l1UsdcBalBefore!);
      console.log(
        `  L1 USDC before=${state.l1UsdcBalBefore} after=${state.l1UsdcBalAfter} delta=${delta}`,
      );
      const expected = -DEPOSIT_AMOUNT + EXIT_AMOUNT; // -10 + 5 = -5 USDC
      if (delta !== expected) {
        console.warn(`  WARN: expected delta ${expected}, got ${delta}`);
      }
    }

    console.log("");
    console.log("Sub-8.3 bridge E2E: GREEN");
    console.log(JSON.stringify(state, null, 2));
  } finally {
    await wallet.stop();
  }
}

main().catch((e) => {
  const msg = (e instanceof Error ? e.message : String(e)).replace(
    /0x[0-9a-fA-F]{64,}/g,
    "0x<REDACTED>",
  );
  console.error(msg);
  process.exit(1);
});
