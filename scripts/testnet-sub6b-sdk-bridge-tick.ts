#!/usr/bin/env node
//
// Sub-6b Phase 3 Task 3.3: C4 bridge tick multi-hop smoke on @quetzal/sdk.
//
// Same flow as scripts/testnet-sub6b-c4-tick-smoke.ts but every step is an
// SDK call. Demonstrates parity with the CLI-based smoke runner.
//
// Flow: 1 claim (3 aUSDC L1->L2) -> bridge.exit splitInto=3 intervalDays=0
//       -> tick 3x (pending -> submitted) -> wait rollup -> tick 3x autoClaim
//       (submitted -> done).
//
// State: testnet-sub6b-sdk-tick-state.json (gitignored).
//
// Usage:
//   dotenv -e .env.testnet -- pnpm tsx scripts/testnet-sub6b-sdk-bridge-tick.ts

import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { QuetzalClient } from "@quetzal/sdk";

const NODE_URL = process.env.AZTEC_NODE_URL ?? process.env.AZTEC_RPC_URL ?? "";
if (!NODE_URL.includes("testnet")) throw new Error(`AZTEC_NODE_URL must include 'testnet'`);

const STATE_PATH = "testnet-sub6b-sdk-tick-state.json";

interface State { step: number; notes: Record<string, string>; }
function loadState(): State {
  if (existsSync(STATE_PATH)) return JSON.parse(readFileSync(STATE_PATH, "utf8")) as State;
  return { step: 0, notes: {} };
}
function saveState(s: State): void { writeFileSync(STATE_PATH, JSON.stringify(s, null, 2)); }

async function main(): Promise<void> {
  const state = loadState();
  const recipient = process.env.L1_MAKER_ADDR ?? process.env.SEPOLIA_PUBLIC_ADDRESS;
  if (!recipient) throw new Error("L1_MAKER_ADDR or SEPOLIA_PUBLIC_ADDRESS required");

  const client = await QuetzalClient.connect({
    network: "alpha-testnet",
    nodeUrl: NODE_URL,
    account: { type: "schnorr", secret: process.env.AZTEC_PRIVATE_KEY ?? process.env.AZTEC_SECRET_KEY ?? "" },
    l1: {
      rpcUrl: process.env.L1_RPC_URL ?? process.env.SEPOLIA_RPC_URL,
      privateKey: process.env.DEPLOYER_PK ?? process.env.L1_PRIVATE_KEY,
      makerAddr: recipient,
    },
  });

  try {
    // Step 1: pre-seed claim (uses prior Sub-5b deposit secret if available)
    if (state.step < 1) {
      const secret = process.env.BRIDGE_DEPOSIT_SECRET;
      const messageIndex = process.env.BRIDGE_DEPOSIT_MESSAGE_INDEX;
      if (!secret || !messageIndex) {
        state.notes.step1 = "DEFERRED: run Sub-5b first + set BRIDGE_DEPOSIT_* envs";
      } else {
        try {
          const c = await client.bridge.claim({
            token: "tUSDC",
            amount: 3_000_000n,
            isPrivate: true,
            secret,
            messageIndex,
          });
          state.notes.step1_claim = c.l2TxHash;
        } catch (e) {
          state.notes.step1 = `claim failed: ${e instanceof Error ? e.message : String(e)}`.slice(0, 200);
        }
      }
      state.step = 1; saveState(state);
    }

    // Step 2: split-exit (3 partials, 0-day interval)
    if (state.step < 2) {
      console.log("step 2: client.bridge.exit splitInto=3 ...");
      const e = await client.bridge.exit({
        token: "tUSDC",
        amount: 3_000_000n,
        l1Recipient: recipient,
        splitInto: 3,
        intervalDays: 0,
        ackRound: true,
        ackDelay: true,
      });
      if (!("scheduledExits" in e)) throw new Error("expected scheduledExits, got single-exit result");
      if (e.scheduledExits.length !== 3) throw new Error(`expected 3 scheduled exits, got ${e.scheduledExits.length}`);
      state.notes.scheduled = "3";
      state.step = 2; saveState(state);
    }

    // Step 3: tick 3x (pending -> submitted)
    if (state.step < 3) {
      for (let i = 0; i < 3; i++) {
        console.log(`step 3 tick ${i + 1}/3 ...`);
        const t = await client.bridge.tick();
        state.notes[`tick_${i + 1}`] = JSON.stringify(t);
      }
      state.step = 3; saveState(state);
    }

    // Step 4: wait rollup
    if (state.step < 4) {
      console.log("step 4: sleeping 1800s for L2->L1 outbox...");
      await sleep(1_800_000);
      state.step = 4; saveState(state);
    }

    // Step 5: auto-claim 3x (submitted -> done)
    if (state.step < 5) {
      for (let i = 0; i < 3; i++) {
        console.log(`step 5 auto-claim ${i + 1}/3 ...`);
        const t = await client.bridge.tick({ autoClaim: true });
        state.notes[`autoclaim_${i + 1}`] = JSON.stringify(t);
      }
      // Verify all 3 done
      const bridgeState = JSON.parse(readFileSync(join(homedir(), ".quetzal", "bridge-state.json"), "utf8"));
      const done = bridgeState.scheduledExits.filter((e: { status: string }) => e.status === "done").length;
      state.notes.final_done = String(done);
      if (done !== 3) console.warn(`expected 3 done, got ${done}`);
      state.step = 5; saveState(state);
    }

    console.log("Sub-6b 3.3 SDK tick runner: done.");
  } finally {
    await client.stop();
  }
}

main().catch((e) => {
  const msg = (e instanceof Error ? e.message : String(e)).replace(/0x[0-9a-fA-F]{32,}/g, "0x<REDACTED>");
  console.error(msg);
  process.exit(1);
});
