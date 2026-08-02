#!/usr/bin/env node
//
// Sub-6b Phase 3 Task 3.1: Sub-5b bridge runner rewritten on @quetzal/sdk.
//
// Same business outcome as scripts/testnet-sub5b-bridge.ts but every action
// is an SDK call instead of a CLI subprocess. Demonstrates SDK parity with
// the CLI-based runner.
//
// State: testnet-sub6b-sdk-bridge-state.json (gitignored).
//
// Required env (via .env.testnet):
//   AZTEC_NODE_URL                must include 'testnet'
//   AZTEC_PRIVATE_KEY             alice secret (Schnorr)
//   AZTEC_SECRET_KEY              alice secret (Schnorr alt)
//   L1_RPC_URL / SEPOLIA_RPC_URL  Sepolia HTTPS endpoint
//   DEPLOYER_PK / L1_PRIVATE_KEY  Sepolia private key (used by bridge L1 ops)
//   L1_MAKER_ADDR / SEPOLIA_PUBLIC_ADDRESS  Sepolia EOA address
//
// Usage:
//   dotenv -e .env.testnet -- pnpm tsx scripts/testnet-sub6b-sdk-bridge.ts
//
// Pre-conditions:
//   - quetzal.config.json has .l1.{usdcBridge,wethBridge,wbtcBridge,...}
//     (Sub-6b 1.2 bridge deploy must be GREEN)
//   - aUSDC/aWETH L2 tokens deployed + wired (Sub-6b 1.2 L2 step must be GREEN)

import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { QuetzalClient } from "@quetzal/sdk";

const NODE_URL = process.env.AZTEC_NODE_URL ?? process.env.AZTEC_RPC_URL ?? "";
if (!NODE_URL.includes("testnet")) {
  throw new Error(`AZTEC_NODE_URL must include 'testnet'; got '${NODE_URL || "<unset>"}'`);
}
const L1_RPC_URL = process.env.L1_RPC_URL ?? process.env.SEPOLIA_RPC_URL ?? "";
if (!L1_RPC_URL) throw new Error(`L1_RPC_URL or SEPOLIA_RPC_URL must be set`);

const STATE_PATH = "testnet-sub6b-sdk-bridge-state.json";

interface State {
  step: number;
  notes: Record<string, string>;
  startedAtUnix: number;
}

function loadState(): State {
  if (existsSync(STATE_PATH)) return JSON.parse(readFileSync(STATE_PATH, "utf8")) as State;
  return { step: 0, notes: {}, startedAtUnix: Math.floor(Date.now() / 1000) };
}

function saveState(s: State): void {
  writeFileSync(STATE_PATH, JSON.stringify(s, null, 2));
}

async function main(): Promise<void> {
  const state = loadState();
  console.log(`Sub-6b 3.1 SDK bridge runner. State: ${STATE_PATH}. Started: ${new Date(state.startedAtUnix * 1000).toISOString()}`);

  const client = await QuetzalClient.connect({
    network: "alpha-testnet",
    nodeUrl: NODE_URL,
    account: { type: "schnorr", secret: process.env.AZTEC_PRIVATE_KEY ?? process.env.AZTEC_SECRET_KEY ?? "" },
    l1: {
      rpcUrl: L1_RPC_URL,
      privateKey: process.env.DEPLOYER_PK ?? process.env.L1_PRIVATE_KEY,
      makerAddr: process.env.L1_MAKER_ADDR ?? process.env.SEPOLIA_PUBLIC_ADDRESS,
    },
  });

  try {
    // Step 1-2: env + config verified by QuetzalClient.connect (throws ConfigError otherwise)
    state.notes.step1_2 = "client.connect() OK";
    if (state.step < 2) { state.step = 2; saveState(state); }

    // Step 3: maker wallet OK (also from connect)
    state.notes.maker = client.address.toString();
    if (state.step < 3) { state.step = 3; saveState(state); }

    // Step 4-5: L1 approve + depositToL2Private. SDK's bridge.deposit is reserved
    // (Sub-6b 2.8 left it unimplemented per design — operator script flow is
    // canonical for now). When that gap closes:
    //
    //   const dep = await client.bridge.deposit({ token: "tUSDC", amount: 1_000_000n, isPrivate: true });
    //   state.notes.l1_deposit_tx = dep.l1TxHash;
    //   state.notes.l1_deposit_secret = dep.secret!;
    //   state.notes.l1_deposit_message_index = dep.messageIndex.toString();
    //
    // For now: read from a pre-populated state file (set BRIDGE_DEPOSIT_{SECRET,MESSAGE_INDEX}
    // env vars after running scripts/testnet-sub5b-bridge.ts up through step 5).
    if (state.step < 5) {
      const secret = process.env.BRIDGE_DEPOSIT_SECRET;
      const messageIndex = process.env.BRIDGE_DEPOSIT_MESSAGE_INDEX;
      if (!secret || !messageIndex) {
        console.warn("step 4-5: bridge.deposit not yet SDK-implemented; expecting BRIDGE_DEPOSIT_{SECRET,MESSAGE_INDEX} env vars.");
        state.notes.step4_5 = "DEFERRED: SDK bridge.deposit not implemented; use scripts/testnet-sub5b-bridge.ts step 5";
      } else {
        state.notes.l1_deposit_secret = secret;
        state.notes.l1_deposit_message_index = messageIndex;
        state.notes.step4_5 = "loaded from env";
      }
      state.step = 5; saveState(state);
    }

    // Step 6: L1->L2 messaging wait (~10 min on testnet)
    if (state.step < 6) {
      console.log("step 6: sleeping 600s for L1->L2 messaging window...");
      await sleep(600_000);
      state.step = 6; saveState(state);
    }

    // Step 7: L2 claim via SDK
    if (state.step < 7) {
      if (!state.notes.l1_deposit_secret || !state.notes.l1_deposit_message_index) {
        console.warn("step 7: skipped — no deposit secret available");
      } else {
        console.log("step 7: client.bridge.claim ...");
        const c = await client.bridge.claim({
          token: "tUSDC",
          amount: 1_000_000n,
          isPrivate: true,
          secret: state.notes.l1_deposit_secret,
          messageIndex: state.notes.l1_deposit_message_index,
        });
        state.notes.l2_claim_tx = c.l2TxHash;
        console.log(`  -> L2 claim tx ${c.l2TxHash}`);
      }
      state.step = 7; saveState(state);
    }

    // Step 8: L2 trade — place a sell order, wait, close-epoch (skipped if no orderbook ready)
    if (state.step < 8) {
      console.log("step 8: client.orders.placeOrder ...");
      try {
        const place = await client.orders.placeOrder({
          side: "sell",
          amount: 500_000n,
          limitPrice: 5000n,
          path: ["tUSDC", "tETH"],
        });
        state.notes.place_order_tx = place.txHash;
        state.notes.place_order_nonce = place.nonce.toString();
        console.log(`  -> placed; tx ${place.txHash}, nonce ${place.nonce}`);
        await sleep(180_000); // wait epoch
        // closeEpoch via SDK — added in Task 2.8
        const ce = await client.orders.closeEpoch({ epoch: place.epoch });
        state.notes.close_epoch = JSON.stringify(ce);
      } catch (e) {
        console.warn(`  step 8 trade failed: ${e instanceof Error ? e.message : String(e)}`);
        state.notes.step8_trade = "FAILED (orderbook may not be wired to bridge tokens)";
      }
      state.step = 8; saveState(state);
    }

    // Step 9: L2 exit
    if (state.step < 9) {
      console.log("step 9: client.bridge.exit ...");
      const recipient = process.env.L1_MAKER_ADDR ?? process.env.SEPOLIA_PUBLIC_ADDRESS;
      if (!recipient) throw new Error("L1_MAKER_ADDR or SEPOLIA_PUBLIC_ADDRESS required for step 9");
      try {
        const e = await client.bridge.exit({
          token: "tETH",
          amount: 100_000_000_000_000n, // 0.0001 WETH
          l1Recipient: recipient,
        });
        if ("l2TxHash" in e) state.notes.l2_exit_tx = e.l2TxHash;
        else state.notes.l2_exit_scheduled = `${e.scheduledExits.length} scheduled exits`;
        console.log(`  -> exit OK`);
      } catch (err) {
        console.warn(`  step 9 exit failed: ${err instanceof Error ? err.message : String(err)}`);
        state.notes.step9_exit = "FAILED";
      }
      state.step = 9; saveState(state);
    }

    // Step 10: rollup wait
    if (state.step < 10) {
      console.log("step 10: sleeping 1800s for L2->L1 outbox...");
      await sleep(1_800_000);
      state.step = 10; saveState(state);
    }

    // Step 11: L1 withdraw via client.bridge.tick({autoClaim: true})
    if (state.step < 11) {
      console.log("step 11: client.bridge.tick({autoClaim: true}) ...");
      try {
        const t = await client.bridge.tick({ autoClaim: true });
        state.notes.tick = JSON.stringify(t);
      } catch (err) {
        console.warn(`  step 11 tick failed: ${err instanceof Error ? err.message : String(err)}`);
        state.notes.step11_tick = "FAILED";
      }
      state.step = 11; saveState(state);
    }

    // Step 12: balance check via client.reads.getBalance
    if (state.step < 12) {
      try {
        const bal = await client.reads.getBalance("tETH");
        state.notes.final_weth_balance = bal.toString();
      } catch (err) {
        state.notes.step12_balance = `FAILED: ${err instanceof Error ? err.message : String(err)}`;
      }
      state.step = 12; saveState(state);
    }

    console.log("Sub-6b 3.1 SDK bridge runner: done (see state file for step outcomes).");
  } finally {
    await client.stop();
  }
}

main().catch((e) => {
  const msg = (e instanceof Error ? e.message : String(e)).replace(/0x[0-9a-fA-F]{32,}/g, "0x<REDACTED>");
  console.error(msg);
  process.exit(1);
});
