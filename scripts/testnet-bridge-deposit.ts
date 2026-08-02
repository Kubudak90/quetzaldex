#!/usr/bin/env node
//
// Sub-6b Phase 1.4: L1->L2 bridge deposit + claim end-to-end test.
//
// Flow:
//   1. L1: USDC.approve(USDCBridge, 10 USDC)
//   2. L1: USDCBridge.depositToL2Public(10 USDC, makerL2, secretHash)
//   3. Wait ~5-15 min for L1->L2 messaging
//   4. L2: aUSDC.claim_public(makerL2, 10 USDC, secret, messageIndex)
//   5. Verify aUSDC balance increased on L2
//
// State: testnet-sub6b-deposit-state.json (gitignored).
//
// Usage:
//   dotenv -e .env.testnet -- pnpm tsx scripts/testnet-bridge-deposit.ts

import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { randomBytes } from "node:crypto";
import { createWalletClient, createPublicClient, http, parseAbi, parseEventLogs, keccak256, encodePacked } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { Fr } from "@aztec/aztec.js/fields";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { computeSecretHash } from "@aztec/stdlib/hash";
import { bootstrapAztecWallet } from "./lib/aztec-wallet-bootstrap.js";
import { TokenContract } from "../tests/integration/generated/Token.js";

const NODE_URL = process.env.AZTEC_NODE_URL ?? "";
if (!NODE_URL.includes("testnet")) throw new Error("AZTEC_NODE_URL must include 'testnet'");
const L1_RPC = process.env.L1_RPC_URL ?? process.env.SEPOLIA_RPC_URL ?? "";
if (!L1_RPC) throw new Error("L1_RPC_URL or SEPOLIA_RPC_URL required");
const PK = process.env.DEPLOYER_PK ?? process.env.L1_PRIVATE_KEY ?? "";
if (!PK) throw new Error("DEPLOYER_PK required");

const STATE_PATH = "testnet-sub6b-deposit-state.json";

interface State {
  step: number;
  notes: Record<string, string>;
}
function loadState(): State {
  if (existsSync(STATE_PATH)) return JSON.parse(readFileSync(STATE_PATH, "utf8")) as State;
  return { step: 0, notes: {} };
}
function saveState(s: State): void { writeFileSync(STATE_PATH, JSON.stringify(s, null, 2)); }

async function main(): Promise<void> {
  const state = loadState();
  const cfg = JSON.parse(readFileSync("quetzal.config.json", "utf8")) as {
    tUSDC?: string;
    l1?: { usdcBridge?: string };
  };
  // Post-hybrid (2026-06): the L1 USDC bridge is repointed (setL2TokenAddress) at
  // the canonical HYBRID tUSDC, so a deposit claims into the tradeable DEX token.
  // (Was cfg.bridge.aUSDC, the now-orphaned pure-bridged token.)
  const aUSDC = cfg.tUSDC;
  const usdcBridge = cfg.l1?.usdcBridge;
  if (!aUSDC || !usdcBridge) {
    throw new Error("quetzal.config.json missing .tUSDC or .l1.usdcBridge");
  }

  const USDC_L1 = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238" as const;
  const AMOUNT = 10_000_000n; // 10 USDC (6 decimals)

  // viem L1 client
  const pk = PK.startsWith("0x") ? PK as `0x${string}` : `0x${PK}` as `0x${string}`;
  const acct = privateKeyToAccount(pk);
  const wc = createWalletClient({ account: acct, chain: sepolia, transport: http(L1_RPC) });
  const pc = createPublicClient({ chain: sepolia, transport: http(L1_RPC) });

  // Aztec L2 maker wallet (same bridge admin / deploy wallet)
  const { wallet, account: maker } = await bootstrapAztecWallet(NODE_URL, "deploy-bridge-state.json", process.env.BOOTSTRAP_FAUCET_URL);

  try {
    // Step 1: approve
    if (state.step < 1) {
      console.log("step 1: USDC.approve(usdcBridge, 10 USDC) ...");
      const erc20Abi = parseAbi(["function approve(address spender, uint256 amount) returns (bool)"]);
      const hash = await wc.writeContract({
        address: USDC_L1, abi: erc20Abi, functionName: "approve",
        args: [usdcBridge as `0x${string}`, AMOUNT],
      });
      const r = await pc.waitForTransactionReceipt({ hash });
      state.notes.approve_tx = r.transactionHash;
      console.log(`  approve tx ${r.transactionHash}`);
      state.step = 1; saveState(state);
    }

    // Step 2: depositToL2Public(amount, l2Recipient, secretHash)
    if (state.step < 2) {
      console.log("step 2: USDCBridge.depositToL2Public(10 USDC, makerL2, secretHash) ...");
      const secretFr = Fr.random();
      const secret = secretFr.toString();
      const secretHash = (await computeSecretHash(secretFr)).toString();
      const makerBytes32 = new Fr(BigInt(maker.toString())).toString();

      const depositAbi = parseAbi([
        "function depositToL2Public(uint256 amount, bytes32 l2Recipient, bytes32 secretHash) returns (bytes32 messageHash, uint256 messageIndex)",
        "event DepositInitiated(address indexed sender, bytes32 indexed l2Recipient, uint256 amount, bytes32 secretHash, uint256 messageIndex, bool isPrivate)",
      ]);
      const hash = await wc.writeContract({
        address: usdcBridge as `0x${string}`, abi: depositAbi, functionName: "depositToL2Public",
        args: [AMOUNT, makerBytes32 as `0x${string}`, secretHash as `0x${string}`],
      });
      const r = await pc.waitForTransactionReceipt({ hash });
      const logs = parseEventLogs({ abi: depositAbi, logs: r.logs, eventName: "DepositInitiated" });
      if (logs.length === 0) throw new Error("DepositInitiated event missing");
      const msgIdx = logs[0].args.messageIndex.toString();
      state.notes.deposit_tx = r.transactionHash;
      state.notes.secret = secret;
      state.notes.secret_hash = secretHash;
      state.notes.message_index = msgIdx;
      console.log(`  deposit tx ${r.transactionHash} ; messageIndex ${msgIdx} ; secretHash ${secretHash}`);
      state.step = 2; saveState(state);
    }

    // Step 3: wait
    if (state.step < 3) {
      console.log("step 3: waiting 600s for L1->L2 messaging window ...");
      await sleep(600_000);
      state.step = 3; saveState(state);
    }

    // Step 4: claim_public on L2
    if (state.step < 4) {
      console.log("step 4: register aUSDC contract in PXE + call claim_public ...");
      // Register aUSDC contract instance in PXE
      const { createAztecNodeClient } = await import("@aztec/aztec.js/node");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const node = createAztecNodeClient(NODE_URL) as any;
      const instance = await node.getContract(AztecAddress.fromStringUnsafe(aUSDC));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const walletAny = wallet as any;
      if (typeof walletAny.registerContract === "function") {
        await walletAny.registerContract(instance, TokenContract.artifact);
      }

      const aUSDCContract = await TokenContract.at(AztecAddress.fromStringUnsafe(aUSDC), wallet);
      const secret = state.notes.secret!;
      const secretFr = Fr.fromString(secret);
      const messageIndex = BigInt(state.notes.message_index!);
      // claim_public(to, amount, secret, message_leaf_index)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      // 4.3.0: await .send() resolves after mining; the SentTx has no .wait()
      // (the old `tx.wait()` threw "tx.wait is not a function" while the claim still
      // landed → step 4 never recorded). Await the send directly.
      const sent: any = await (aUSDCContract.methods as any).claim_public(maker, AMOUNT, secretFr, messageIndex).send({ from: maker });
      state.notes.claim_tx = sent?.txHash?.toString?.() ?? sent?.getTxHash?.()?.toString?.() ?? "sent";
      console.log(`  claim tx ${state.notes.claim_tx}`);
      state.step = 4; saveState(state);
    }

    // Step 5: verify balance
    if (state.step < 5) {
      const aUSDCContract = await TokenContract.at(AztecAddress.fromStringUnsafe(aUSDC), wallet);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const bal = await (aUSDCContract.methods as any).balance_of_public(maker).simulate({ from: maker });
      state.notes.final_balance = bal.toString();
      console.log(`  final aUSDC public balance for maker: ${bal}`);
      state.step = 5; saveState(state);
    }

    console.log("");
    console.log("L1->L2 bridge deposit + claim: GREEN");
  } finally {
    await wallet.stop();
  }
}

main().catch((e) => {
  const msg = (e instanceof Error ? e.message : String(e)).replace(/0x[0-9a-fA-F]{64,}/g, "0x<REDACTED>");
  console.error(msg);
  process.exit(1);
});

void keccak256; void encodePacked; // unused; kept to preserve import shape if needed
