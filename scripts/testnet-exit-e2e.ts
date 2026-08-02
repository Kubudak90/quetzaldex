// testnet-exit-e2e.ts — L2→L1 EXIT round trip (the half testnet-bridge-e2e.ts
// can't reach on this network, because its deposit leg needs mintable L1 USDC
// and the bridge's L1 token is Circle's canonical Sepolia FiatToken).
//
// The maker bootstrapped by testnet-bridge-deposit-weth.ts already holds bridged
// tETH on L2, so we start at the exit and drive exactly the code the v5 migration
// rewrote:
//   1. L2  tETH.exit_to_l1_public(amount, l1Recipient)   → burns + emits the L2→L1 message
//   2.     buildOutboxProof(...)                          → v5 progressive per-checkpoint
//                                                           roots read from the L1 Outbox
//                                                           (getRoots), returns
//                                                           numCheckpointsInEpoch
//   3. L1  TokenBridge.withdraw(7-arg incl numCheckpointsInEpoch + l2Sender)
//   4.     assert the recipient's L1 WETH balance rose by `amount`
//
// Step 2 blocks until the L2 epoch is PROVEN on L1 (~30-90 min on testnet). State
// is persisted, so a timeout is not a loss: re-run and it resumes at the same step.
//
// Usage:
//   AZTEC_NODE_URL=https://v5.testnet.rpc.aztec-labs.com \
//   STATIC_MAX_FEE_PER_L2_GAS=20000000000000 STATIC_MAX_FEE_PER_DA_GAS=2000000000 \
//     pnpm tsx scripts/testnet-exit-e2e.ts
//
// State: testnet-exit-e2e-state.json (gitignored).
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { AztecAddress } from "@aztec/aztec.js/addresses";

import { bootstrapAztecWallet } from "./lib/aztec-wallet-bootstrap.js";
import { TokenContract } from "../tests/integration/generated/Token.js";
import { buildOutboxProof, computeWithdrawContent, OutboxProofNotReadyError } from "../sdk/src/index.js";
import type { OutboxProof } from "../sdk/src/index.js";

const NODE_URL = process.env.AZTEC_NODE_URL ?? "https://v5.testnet.rpc.aztec-labs.com";
if (!NODE_URL.includes("testnet")) throw new Error(`AZTEC_NODE_URL must be a testnet URL; got ${NODE_URL}`);

const L1_RPC = process.env.L1_RPC_URL ?? process.env.SEPOLIA_RPC_URL;
const L1_PK = (process.env.DEPLOYER_PK ?? process.env.L1_PRIVATE_KEY) as `0x${string}` | undefined;
if (!L1_RPC || !L1_PK) throw new Error("need L1_RPC_URL + DEPLOYER_PK (or L1_PRIVATE_KEY)");

const MAKER_STATE = "deploy-bridge-state.json";   // the WETH-deposit maker (holds bridged tETH)
const STATE_PATH = "testnet-exit-e2e-state.json";
const EXIT_AMOUNT = BigInt(process.env.EXIT_AMOUNT ?? "1000000000000"); // 1e12 wei tETH (tiny)
const PROOF_POLL_MS = 60_000;
const PROOF_ATTEMPTS = Number(process.env.PROOF_ATTEMPTS ?? "90"); // 90 min

interface State {
  step: number;
  l2TxHash?: string;
  content?: string;
  proof?: OutboxProof;
  l1TxHash?: string;
  l1BalanceBefore?: string;
  notes: string[];
}

function loadState(): State {
  if (existsSync(STATE_PATH)) return JSON.parse(readFileSync(STATE_PATH, "utf8")) as State;
  return { step: 0, notes: [] };
}
function save(s: State): void {
  writeFileSync(STATE_PATH, JSON.stringify(s, null, 2));
}
function note(s: State, msg: string): void {
  s.notes.push(`${new Date().toISOString()} ${msg}`);
}

async function main(): Promise<void> {
  const state = loadState();
  const cfg = JSON.parse(readFileSync("quetzal.config.json", "utf8")) as {
    tETH: string;
    l1: { wethBridge: string };
  };
  const wethBridge = cfg.l1.wethBridge as `0x${string}`;

  const l1Account = privateKeyToAccount(L1_PK!);
  const l1Public = createPublicClient({ chain: sepolia, transport: http(L1_RPC) });
  const l1Wallet = createWalletClient({ account: l1Account, chain: sepolia, transport: http(L1_RPC) });
  const l1Recipient = l1Account.address;

  console.log(`[exit-e2e] node=${NODE_URL}`);
  console.log(`[exit-e2e] tETH=${cfg.tETH}`);
  console.log(`[exit-e2e] wethBridge=${wethBridge}  l1Recipient=${l1Recipient}`);
  console.log(`[exit-e2e] exit amount=${EXIT_AMOUNT} (wei tETH)`);

  const { wallet, account: maker } = await bootstrapAztecWallet(NODE_URL, MAKER_STATE);
  const tETH = await TokenContract.at(AztecAddress.fromStringUnsafe(cfg.tETH), wallet);

  const l1TokenAbi = [
    { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
  ] as const;
  const bridgeAbi = [
    { type: "function", name: "l1Token", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] },
    {
      type: "function", name: "withdraw", stateMutability: "nonpayable",
      inputs: [
        { name: "amount", type: "uint256" },
        { name: "recipient", type: "address" },
        { name: "l2Epoch", type: "uint256" },
        { name: "numCheckpointsInEpoch", type: "uint256" },
        { name: "leafIndex", type: "uint256" },
        { name: "siblingPath", type: "bytes32[]" },
        { name: "l2Sender", type: "bytes32" },
      ],
      outputs: [],
    },
  ] as const;

  const l1Token = (await l1Public.readContract({
    address: wethBridge, abi: bridgeAbi, functionName: "l1Token",
  })) as `0x${string}`;

  // ── Step 1: L2 exit ────────────────────────────────────────────────────────
  if (state.step < 1) {
    const before = (await l1Public.readContract({
      address: l1Token, abi: l1TokenAbi, functionName: "balanceOf", args: [l1Recipient],
    })) as bigint;
    state.l1BalanceBefore = before.toString();
    console.log(`[exit-e2e] step 1: tETH.exit_to_l1_public(${EXIT_AMOUNT}, ${l1Recipient}) ...`);
    // v5: awaiting .send() resolves after mining; there is no .wait().
    // v5: awaiting .send() resolves after mining; there is no .wait(). The tx
    // hash is exposed either as a `txHash` field or an async `getTxHash()`.
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const sent: any = await (tETH.methods as any).exit_to_l1_public(EXIT_AMOUNT, l1Recipient).send({ from: maker });
    let l2TxHash: string | undefined = sent?.txHash?.toString?.();
    if (!l2TxHash && typeof sent?.getTxHash === "function") {
      l2TxHash = (await sent.getTxHash())?.toString?.();
    }
    /* eslint-enable @typescript-eslint/no-explicit-any */
    if (!l2TxHash) throw new Error("exit_to_l1_public: could not read the L2 tx hash from the send() result");
    state.l2TxHash = l2TxHash;
    // The content hash the L1 bridge will look for in the outbox.
    state.content = computeWithdrawContent(l1Recipient, EXIT_AMOUNT, false);
    state.step = 1;
    note(state, `exit_to_l1_public l2Tx=${state.l2TxHash} content=${state.content}`);
    save(state);
    console.log(`[exit-e2e]   l2Tx=${state.l2TxHash}`);
    console.log(`[exit-e2e]   content=${state.content}`);
  } else {
    console.log(`[exit-e2e] step 1 cached; l2Tx=${state.l2TxHash}`);
  }

  // ── Step 2: outbox proof (blocks on epoch proving) ─────────────────────────
  if (state.step < 2) {
    console.log(`[exit-e2e] step 2: buildOutboxProof — waits for the L2 epoch to be PROVEN on L1 ...`);
    for (let i = 1; i <= PROOF_ATTEMPTS; i++) {
      try {
        const proof = await buildOutboxProof(
          NODE_URL, state.l2TxHash!, state.content!, { rpcUrl: L1_RPC! },
          { l2Sender: cfg.tETH, l1Bridge: wethBridge },
        );
        state.proof = proof;
        state.step = 2;
        note(state, `outbox proof: epoch=${proof.l2Epoch} checkpoints=${proof.numCheckpointsInEpoch} leaf=${proof.leafIndex}`);
        save(state);
        console.log(`[exit-e2e]   PROOF READY after ${i} attempt(s)`);
        console.log(`[exit-e2e]   l2Epoch=${proof.l2Epoch} numCheckpointsInEpoch=${proof.numCheckpointsInEpoch} leafIndex=${proof.leafIndex} siblings=${proof.siblingPath.length}`);
        break;
      } catch (e) {
        const notReady = e instanceof OutboxProofNotReadyError;
        const msg = e instanceof Error ? e.message : String(e);
        console.log(`[exit-e2e]   attempt ${i}/${PROOF_ATTEMPTS}: ${notReady ? "epoch not proven yet" : msg.slice(0, 140)}`);
        if (i === PROOF_ATTEMPTS) {
          console.log(`[exit-e2e] TIMED OUT waiting for the epoch proof; state saved — re-run to resume.`);
          await wallet.stop();
          process.exit(3);
        }
        await sleep(PROOF_POLL_MS);
      }
    }
  } else {
    console.log(`[exit-e2e] step 2 cached; epoch=${state.proof!.l2Epoch}`);
  }

  // ── Step 3: L1 withdraw (7-arg, v5) ───────────────────────────────────────
  if (state.step < 3) {
    const p = state.proof!;
    console.log(`[exit-e2e] step 3: L1 WETHBridge.withdraw(...) — 7-arg v5 shape ...`);
    const hash = await l1Wallet.writeContract({
      address: wethBridge,
      abi: bridgeAbi,
      functionName: "withdraw",
      args: [
        EXIT_AMOUNT,
        l1Recipient,
        BigInt(p.l2Epoch),
        BigInt(p.numCheckpointsInEpoch),
        BigInt(p.leafIndex),
        p.siblingPath,
        cfg.tETH as `0x${string}`,
      ],
    });
    const rcpt = await l1Public.waitForTransactionReceipt({ hash });
    if (rcpt.status !== "success") throw new Error(`L1 withdraw reverted: ${hash}`);
    state.l1TxHash = hash;
    state.step = 3;
    note(state, `L1 withdraw ok tx=${hash}`);
    save(state);
    console.log(`[exit-e2e]   l1Tx=${hash} status=success`);
  } else {
    console.log(`[exit-e2e] step 3 cached; l1Tx=${state.l1TxHash}`);
  }

  // ── Step 4: verify the L1 balance moved ───────────────────────────────────
  const after = (await l1Public.readContract({
    address: l1Token, abi: l1TokenAbi, functionName: "balanceOf", args: [l1Recipient],
  })) as bigint;
  const before = BigInt(state.l1BalanceBefore ?? "0");
  const delta = after - before;
  console.log(`[exit-e2e] step 4: L1 token balance ${before} -> ${after} (delta ${delta})`);
  if (delta !== EXIT_AMOUNT) {
    throw new Error(`expected +${EXIT_AMOUNT} on L1, got ${delta}`);
  }
  state.step = 4;
  note(state, `verified L1 delta=+${delta}`);
  save(state);

  console.log(`\n[exit-e2e] L2->L1 EXIT ROUND TRIP: GREEN`);
  await wallet.stop();
}

main().catch((e: unknown) => {
  console.error(`[exit-e2e] FAILED:`, e instanceof Error ? e.message : String(e));
  process.exit(1);
});
