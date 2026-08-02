// Sub-8.3 resume runner — picks up from step 4 (L2 claim_public) using
// FeeJuicePaymentMethodWithClaim with drip claim data recovered from Sepolia
// logs. Pairs with testnet-bridge-e2e.ts (which got stuck at step 4 because
// the maker wallet had no fee-juice). After step 4 succeeds, maker has
// ~99 fee-juice remaining → enough for exit_to_l1_public, then we build
// outbox proof and broadcast L1 withdraw.

import { writeFileSync, readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import {
  createWalletClient, createPublicClient, http, parseAbi,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { Fr } from "@aztec/aztec.js/fields";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { FeeJuicePaymentMethodWithClaim } from "@aztec/aztec.js/fee";
import { createAztecNodeClient } from "@aztec/aztec.js/node";
import { bootstrapAztecWallet } from "./lib/aztec-wallet-bootstrap.js";
import { TokenContract } from "../tests/integration/generated/Token.js";
import { buildOutboxProof, computeWithdrawContent } from "@quetzal/sdk";

const NODE_URL = process.env.AZTEC_NODE_URL!;
const L1_RPC = process.env.L1_RPC_URL!;
const L1_PK = process.env.L1_PRIVATE_KEY! as `0x${string}`;

const aUSDC = "0x19aec530674b3b54977b5216fdcad01d5219346e902f2bcb84653a950dd23369";
const USDC_BRIDGE = "0x219ffbb6a504fcd69ae80d1e70db699b48a9936b" as `0x${string}`;
const STATE_FILE = "testnet-bridge-e2e-state.json";

// Recovered drip data (from Sepolia DepositToAztecPublic log @ block 10941226)
const DRIP_CLAIM_AMOUNT = "100000000000000000000";
const DRIP_SECRET = "0x180a7f5a10d2cf4bff4008e1ceca82077080cc0d739841070841b088f2d9574b";
const DRIP_MESSAGE_LEAF_INDEX = "94190592";

const DEPOSIT_AMOUNT = 10_000_000n;  // 10 USDC (6 decimals)
const EXIT_AMOUNT = 5_000_000n;       // 5 USDC

interface State {
  step: number;
  startedAt: string;
  timings: Record<string, number>;
  errors: { step: number; msg: string }[];
  l1UsdcBalBefore?: string;
  l1UsdcBalAfter?: string;
  approveTx?: string;
  depositTx?: string;
  secret?: string;
  secretHash?: string;
  messageIndex?: string;
  depositGasGwei?: string;
  claimTx?: string;
  l2BalAfterClaim?: string;
  exitTx?: string;
  withdrawTx?: string;
  outboxProof?: { l2Epoch: string; leafIndex: string; siblingPathLen: number };
}

const loadState = (): State => JSON.parse(readFileSync(STATE_FILE, "utf8"));
const saveState = (s: State) => writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
const mark = (s: State, key: string) => {
  const elapsed = Math.floor((Date.now() - new Date(s.startedAt).getTime()) / 1000);
  s.timings[key] = elapsed;
};

async function main() {
  const state = loadState();
  console.log(`[sub8-3-resume] resuming from step ${state.step}; deposit=${DEPOSIT_AMOUNT} exit=${EXIT_AMOUNT}`);

  // ── Boot L1 + L2 wallets ──
  const l1Acct = privateKeyToAccount(L1_PK);
  const l1Public = createPublicClient({ chain: sepolia, transport: http(L1_RPC) });
  const l1Wallet = createWalletClient({ account: l1Acct, chain: sepolia, transport: http(L1_RPC) });

  console.log(`[sub8-3-resume] L1 operator = ${l1Acct.address}`);
  const { wallet, account: maker } = await bootstrapAztecWallet(
    NODE_URL,
    "deploy-bridge-state.json",
  );
  console.log(`[sub8-3-resume] L2 maker = ${maker.toString()}`);

  // ── Step 4: claim_public with FeeJuicePaymentMethodWithClaim ──
  if (state.step < 4) {
    console.log("[sub8-3-resume] step 4: aUSDC.claim_public(maker, 10 USDC, secret, leafIdx) with FeeJuicePaymentMethodWithClaim");
    const node = createAztecNodeClient(NODE_URL) as unknown as { getContract: (a: AztecAddress) => Promise<unknown> };
    const instance = await node.getContract(AztecAddress.fromStringUnsafe(aUSDC));
    const walletAny = wallet as unknown as { registerContract?: (i: unknown, art: unknown) => Promise<void> };
    if (typeof walletAny.registerContract === "function") {
      await walletAny.registerContract(instance, TokenContract.artifact);
    }
    const token = await TokenContract.at(AztecAddress.fromStringUnsafe(aUSDC), wallet);
    const depositSecret = Fr.fromString(state.secret!);
    const depositLeafIdx = BigInt(state.messageIndex!);

    const claim = {
      claimAmount: BigInt(DRIP_CLAIM_AMOUNT),
      claimSecret: Fr.fromString(DRIP_SECRET),
      messageLeafIndex: BigInt(DRIP_MESSAGE_LEAF_INDEX),
    };
    const paymentMethod = new FeeJuicePaymentMethodWithClaim(maker, claim);

    const claimStart = Date.now();
    const deadline = 15 * 60 * 1000;
    let claimTxHash: string | undefined;
    while (Date.now() - claimStart < deadline) {
      try {
        const tx = await (token.methods as unknown as {
          claim_public: (to: AztecAddress, amt: bigint, secret: Fr, leafIdx: bigint) => {
            send: (opts: { fee: { paymentMethod: unknown }; from: AztecAddress }) => Promise<{ wait: () => Promise<{ txHash: { toString: () => string } }> }>;
          };
        })
          .claim_public(maker, DEPOSIT_AMOUNT, depositSecret, depositLeafIdx)
          .send({ fee: { paymentMethod }, from: maker });
        const r = await tx.wait();
        claimTxHash = r.txHash.toString();
        break;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.log(`  claim attempt failed: ${msg.slice(0, 300)}`);
        if (!/L1.*L2|message|tree|membership|claim|not.*ready|Timeout|Insufficient/i.test(msg)) throw e;
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
    console.log("[sub8-3-resume] step 5: verifying L2 aUSDC public balance");
    const token = await TokenContract.at(AztecAddress.fromStringUnsafe(aUSDC), wallet);
    const bal = await (token.methods as unknown as { balance_of_public: (a: AztecAddress) => { simulate: () => Promise<bigint> } }).balance_of_public(maker).simulate();
    state.l2BalAfterClaim = bal.toString();
    mark(state, "verify_done_s");
    state.step = 5;
    saveState(state);
    console.log(`  L2 aUSDC public balance: ${bal} (expected >=${DEPOSIT_AMOUNT})`);
    if (BigInt(bal) < DEPOSIT_AMOUNT) throw new Error("claim did not increase balance");
  }

  // ── Step 6: exit_to_l1_public(5 USDC) ──
  if (state.step < 6) {
    console.log(`[sub8-3-resume] step 6: aUSDC.exit_to_l1_public(${EXIT_AMOUNT}, l1Recipient=${l1Acct.address})`);
    const token = await TokenContract.at(AztecAddress.fromStringUnsafe(aUSDC), wallet);
    // Contract signature: exit_to_l1_public(amount: u128, l1_recipient: EthAddress)
    // TS binding accepts the L1 address as Fr (raw 20-byte address as bigint).
    const l1RecipFr = new Fr(BigInt(l1Acct.address));
    const tx = await (token.methods as unknown as {
      exit_to_l1_public: (amount: bigint, l1Recipient: Fr) => {
        send: (opts: { from: AztecAddress }) => Promise<{ wait: () => Promise<{ txHash: { toString: () => string } }> }>;
      };
    })
      .exit_to_l1_public(EXIT_AMOUNT, l1RecipFr)
      .send({ from: maker });
    const r = await tx.wait();
    state.exitTx = r.txHash.toString();
    mark(state, "exit_done_s");
    state.step = 6;
    saveState(state);
    console.log(`  exit tx ${state.exitTx}`);
  }

  // ── Step 7: poll buildOutboxProof until epoch finalises on L1 ──
  if (state.step < 7) {
    console.log(`[sub8-3-resume] step 7: polling buildOutboxProof for ${state.exitTx} (epoch must finalise on L1, ~30-90 min)`);
    const content = computeWithdrawContent(
      l1Acct.address as `0x${string}`,
      EXIT_AMOUNT,
      false, // isPrivate=false (public exit)
    );
    const pollStart = Date.now();
    const deadline = 2 * 60 * 60 * 1000; // 2h
    let proof: { l2Epoch: string; leafIndex: string; siblingPath: `0x${string}`[]; content: `0x${string}` } | undefined;
    while (Date.now() - pollStart < deadline) {
      try {
        proof = await buildOutboxProof(NODE_URL, state.exitTx!, content);
        break;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.log(`  outbox not ready: ${msg.slice(0, 200)}`);
        if (!/not.*ready|finalised|epoch/i.test(msg)) throw e;
        await sleep(120_000);
      }
    }
    if (!proof) {
      console.log("[sub8-3-resume] BLOCKED at step 7 — L2 epoch not proven on L1 within 2h budget. State saved; rerun to resume.");
      mark(state, "outbox_blocked_s");
      saveState(state);
      return;
    }
    state.outboxProof = { l2Epoch: proof.l2Epoch, leafIndex: proof.leafIndex, siblingPathLen: proof.siblingPath.length };
    mark(state, "outbox_done_s");
    state.step = 7;
    saveState(state);
    console.log(`  outbox proof ready: l2Epoch=${proof.l2Epoch} leafIdx=${proof.leafIndex} pathLen=${proof.siblingPath.length}`);

    // ── Step 8: USDCBridge.withdraw(...) on L1 ──
    if (state.step < 8) {
      console.log(`[sub8-3-resume] step 8: USDCBridge.withdraw — L1 broadcast`);
      const withdrawAbi = parseAbi([
        "function withdraw(uint256 amount, address recipient, uint256 l2Epoch, uint256 leafIndex, bytes32[] siblingPath)",
      ]);
      const hash = await l1Wallet.writeContract({
        address: USDC_BRIDGE,
        abi: withdrawAbi,
        functionName: "withdraw",
        args: [
          EXIT_AMOUNT,
          l1Acct.address,
          BigInt(proof.l2Epoch),
          BigInt(proof.leafIndex),
          proof.siblingPath,
        ],
      });
      const r = await l1Public.waitForTransactionReceipt({ hash });
      state.withdrawTx = hash;
      mark(state, "withdraw_done_s");
      state.step = 8;
      saveState(state);
      console.log(`  L1 withdraw tx ${hash} (block ${r.blockNumber})`);
    }
  }

  // ── Step 9: verify L1 USDC balance increased ──
  if (state.step < 9) {
    console.log("[sub8-3-resume] step 9: verifying L1 USDC balance");
    const usdc = await l1Public.readContract({
      address: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
      abi: parseAbi(["function balanceOf(address) view returns (uint256)"]),
      functionName: "balanceOf",
      args: [l1Acct.address],
    }) as bigint;
    state.l1UsdcBalAfter = usdc.toString();
    mark(state, "verify_l1_done_s");
    state.step = 9;
    saveState(state);
    const delta = usdc - BigInt(state.l1UsdcBalBefore!);
    console.log(`  L1 USDC balance: ${usdc} (Δ=${delta} from before)`);
  }

  console.log("[sub8-3-resume] ALL STEPS PASSED.");
  console.log(JSON.stringify(state.timings, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
