#!/usr/bin/env node
//
// WETH variant of testnet-bridge-deposit.ts — L1->L2 bridge deposit + claim
// end-to-end test through the WETH bridge into the canonical hybrid tETH.
// Used when the deployer has Sepolia ETH but no Circle USDC: wraps a small
// amount of ETH into canonical Sepolia WETH first, then bridges it.
//
// Flow:
//   0. L1: WETH.deposit{value: 0.005 ETH}  (wrap)
//   1. L1: WETH.approve(WETHBridge, 0.005 WETH)
//   2. L1: WETHBridge.depositToL2Public(0.005 WETH, makerL2, secretHash)
//   3. Wait ~10 min for L1->L2 messaging
//   4. L2: tETH.claim_public(makerL2, amount, secret, messageIndex)
//   5. Verify tETH public balance increased on L2
//
// State: testnet-weth-bridge-state.json (gitignored via *.bak.json? no — keep
// name out of git; testnet-*-state.json patterns cover it).
//
// Usage:
//   set -a; source .env.testnet; set +a; pnpm tsx scripts/testnet-bridge-deposit-weth.ts

import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { createWalletClient, createPublicClient, http, parseAbi, parseEventLogs } from "viem";
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

const STATE_PATH = "testnet-weth-bridge-state.json";

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
    tETH?: string;
    l1?: { wethBridge?: string };
  };
  const tETH = cfg.tETH;
  const wethBridge = cfg.l1?.wethBridge;
  if (!tETH || !wethBridge) throw new Error("quetzal.config.json missing .tETH or .l1.wethBridge");

  // Canonical Sepolia WETH (the bridge's l1Token(), read on-chain 2026-06-09).
  const WETH_L1 = "0xfff9976782d46cc05630d1f6ebab18b2324d6b14" as const;
  const AMOUNT = 5_000_000_000_000_000n; // 0.005 WETH (18 decimals)

  const pk = PK.startsWith("0x") ? PK as `0x${string}` : `0x${PK}` as `0x${string}`;
  const acct = privateKeyToAccount(pk);
  const wc = createWalletClient({ account: acct, chain: sepolia, transport: http(L1_RPC) });
  const pc = createPublicClient({ chain: sepolia, transport: http(L1_RPC) });

  const { wallet, account: maker } = await bootstrapAztecWallet(NODE_URL, "deploy-bridge-state.json");

  try {
    // Step 0: wrap ETH -> WETH
    if (state.step < 1) {
      console.log("step 0: WETH.deposit{value: 0.005 ETH} (wrap) ...");
      const wethAbi = parseAbi(["function deposit() payable"]);
      const hash = await wc.writeContract({
        address: WETH_L1, abi: wethAbi, functionName: "deposit", value: AMOUNT,
      });
      const r = await pc.waitForTransactionReceipt({ hash });
      state.notes.wrap_tx = r.transactionHash;
      console.log(`  wrap tx ${r.transactionHash}`);

      console.log("step 1: WETH.approve(wethBridge, 0.005 WETH) ...");
      const erc20Abi = parseAbi(["function approve(address spender, uint256 amount) returns (bool)"]);
      const h2 = await wc.writeContract({
        address: WETH_L1, abi: erc20Abi, functionName: "approve",
        args: [wethBridge as `0x${string}`, AMOUNT],
      });
      const r2 = await pc.waitForTransactionReceipt({ hash: h2 });
      state.notes.approve_tx = r2.transactionHash;
      console.log(`  approve tx ${r2.transactionHash}`);
      state.step = 1; saveState(state);
    }

    // Step 2: depositToL2Public(amount, l2Recipient, secretHash)
    if (state.step < 2) {
      console.log("step 2: WETHBridge.depositToL2Public(0.005 WETH, makerL2, secretHash) ...");
      const secretFr = Fr.random();
      const secret = secretFr.toString();
      const secretHash = (await computeSecretHash(secretFr)).toString();
      const makerBytes32 = new Fr(BigInt(maker.toString())).toString();

      const depositAbi = parseAbi([
        "function depositToL2Public(uint256 amount, bytes32 l2Recipient, bytes32 secretHash) returns (bytes32 messageHash, uint256 messageIndex)",
        "event DepositInitiated(address indexed sender, bytes32 indexed l2Recipient, uint256 amount, bytes32 secretHash, uint256 messageIndex, bool isPrivate)",
      ]);
      const hash = await wc.writeContract({
        address: wethBridge as `0x${string}`, abi: depositAbi, functionName: "depositToL2Public",
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

    // Step 4: claim_public on L2 into hybrid tETH
    if (state.step < 4) {
      console.log("step 4: register tETH contract in PXE + call claim_public ...");
      const { createAztecNodeClient } = await import("@aztec/aztec.js/node");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const node = createAztecNodeClient(NODE_URL) as any;
      const instance = await node.getContract(AztecAddress.fromStringUnsafe(tETH));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const walletAny = wallet as any;
      if (typeof walletAny.registerContract === "function") {
        await walletAny.registerContract(instance, TokenContract.artifact);
      }

      const tETHContract = await TokenContract.at(AztecAddress.fromStringUnsafe(tETH), wallet);
      const secret = state.notes.secret!;
      const secretFr = Fr.fromString(secret);
      const messageIndex = BigInt(state.notes.message_index!);
      // 4.3.0: await .send() resolves after mining (no .wait()).
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sent: any = await (tETHContract.methods as any).claim_public(maker, AMOUNT, secretFr, messageIndex).send({ from: maker });
      state.notes.claim_tx = sent?.txHash?.toString?.() ?? sent?.getTxHash?.()?.toString?.() ?? "sent";
      console.log(`  claim tx ${state.notes.claim_tx}`);
      state.step = 4; saveState(state);
    }

    // Step 5: verify balance
    if (state.step < 5) {
      const tETHContract = await TokenContract.at(AztecAddress.fromStringUnsafe(tETH), wallet);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const bal = await (tETHContract.methods as any).balance_of_public(maker).simulate({ from: maker });
      state.notes.final_balance = String(bal);
      console.log(`  final tETH public balance for maker: ${bal}`);
      state.step = 5; saveState(state);
    }

    console.log("");
    console.log("L1->L2 WETH bridge deposit + claim: GREEN");
  } finally {
    await wallet.stop();
  }
}

main().catch((e) => {
  const msg = (e instanceof Error ? e.message : String(e)).replace(/0x[0-9a-fA-F]{64,}/g, "0x<REDACTED>");
  console.error(msg);
  process.exit(1);
});
