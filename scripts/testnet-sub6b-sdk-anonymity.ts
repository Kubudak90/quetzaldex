#!/usr/bin/env node
//
// Sub-6b Phase 3 Task 3.2: Sub-6a anonymity runner rewritten on @quetzal/sdk.
//
// Same 8-step business outcome as scripts/testnet-sub6-anonymity.ts but via
// SDK calls. Demonstrates SDK parity with CLI for the anonymity-set lifecycle.
//
// State: testnet-sub6b-sdk-anonymity-state.json (gitignored).
//
// Required env (.env.testnet):
//   AZTEC_NODE_URL                must include 'testnet'
//   AZTEC_PRIVATE_KEY             alice secret
//   L1_RPC_URL / SEPOLIA_RPC_URL  Sepolia HTTPS endpoint
//   L1_MAKER_ADDR / SEPOLIA_PUBLIC_ADDRESS  Sepolia EOA
//
// Usage:
//   dotenv -e .env.testnet -- pnpm tsx scripts/testnet-sub6b-sdk-anonymity.ts
//
// Pre-conditions:
//   - quetzal.config.json has tUSDC + tETH + orderbook + treasury + aggregatorRegistry
//   - alice has tUSDC balance on the configured orderbook (or trade flow will fail)
//   - If bridge ops in S8: quetzal.config.json.l1.* populated

import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { QuetzalClient, MAX_DECOYS, BridgeError, type QuetzalContracts } from "@quetzal/sdk";

const NODE_URL = process.env.AZTEC_NODE_URL ?? process.env.AZTEC_RPC_URL ?? "";
if (!NODE_URL.includes("testnet")) {
  throw new Error(`AZTEC_NODE_URL must include 'testnet'; got '${NODE_URL || "<unset>"}'`);
}

const STATE_PATH = "testnet-sub6b-sdk-anonymity-state.json";

// Load deployed contract addresses from quetzal.config.json so the SDK can
// auto-register them against the wallet's PXE on connect.
function loadContracts(): QuetzalContracts {
  if (!existsSync("quetzal.config.json")) {
    throw new Error("quetzal.config.json not found at cwd — run from project root");
  }
  const cfg = JSON.parse(readFileSync("quetzal.config.json", "utf8")) as Record<string, unknown>;
  return {
    orderbook: cfg.orderbook as string,
    tUSDC: cfg.tUSDC as string,
    tETH: cfg.tETH as string,
    pools: cfg.pools as QuetzalContracts["pools"],
    admin: cfg.admin as string,
    aggregatorRegistry: cfg.aggregatorRegistry as string,
    treasury: cfg.treasury as string,
  };
}

const STEP_NAMES = [
  "S1_wallet_bootstrap",
  "S2_bridge_deposit_seed",
  "S3_bulk_submit_with_decoys",
  "S4_assert_registry_shape",
  "S5_close_epoch_and_clear",
  "S6_selective_claim_filters_decoys",
  "S7_cancel_decoys_reclaims_escrow",
  "S8_round_amount_bridge_exit_blocked_then_acked",
] as const;
type StepName = (typeof STEP_NAMES)[number];

interface StepRecord { status: "pending" | "done" | "skipped" | "failed"; notes: string; }
interface State {
  aliceAddr: string | null;
  realNonce: string | null;
  decoyNonces: string[];
  bulkEpoch: number | null;
  steps: Record<StepName, StepRecord>;
  startedAtUnix: number;
}

function loadState(): State {
  if (existsSync(STATE_PATH)) return JSON.parse(readFileSync(STATE_PATH, "utf8")) as State;
  const steps = {} as Record<StepName, StepRecord>;
  for (const n of STEP_NAMES) steps[n] = { status: "pending", notes: "" };
  return {
    aliceAddr: null,
    realNonce: null,
    decoyNonces: [],
    bulkEpoch: null,
    steps,
    startedAtUnix: Math.floor(Date.now() / 1000),
  };
}

function saveState(s: State): void {
  writeFileSync(STATE_PATH, JSON.stringify(s, null, 2));
}

async function main(): Promise<void> {
  const state = loadState();
  console.log(`Sub-6b 3.2 SDK anonymity runner. State: ${STATE_PATH}. Started: ${new Date(state.startedAtUnix * 1000).toISOString()}`);

  const client = await QuetzalClient.connect({
    network: "alpha-testnet",
    nodeUrl: NODE_URL,
    account: { type: "schnorr", secret: process.env.AZTEC_PRIVATE_KEY ?? process.env.AZTEC_SECRET_KEY ?? "" },
    contracts: loadContracts(),
    l1: {
      rpcUrl: process.env.L1_RPC_URL ?? process.env.SEPOLIA_RPC_URL,
      privateKey: process.env.DEPLOYER_PK ?? process.env.L1_PRIVATE_KEY,
      makerAddr: process.env.L1_MAKER_ADDR ?? process.env.SEPOLIA_PUBLIC_ADDRESS,
    },
  });

  try {
    // S1: wallet bootstrap via SDK
    state.aliceAddr = client.address.toString();
    state.steps.S1_wallet_bootstrap.status = "done";
    state.steps.S1_wallet_bootstrap.notes = state.aliceAddr;
    saveState(state);

    // S2: bridge deposit seed (re-use prior runner output if present)
    if (state.steps.S2_bridge_deposit_seed.status === "pending") {
      if (existsSync("testnet-sub5b-state.json")) {
        const s5b = JSON.parse(readFileSync("testnet-sub5b-state.json", "utf8"));
        state.steps.S2_bridge_deposit_seed.notes = `inherited Sub-5b l2_claim_tx=${s5b.notes?.l2_claim_tx ?? "<unknown>"}`;
        state.steps.S2_bridge_deposit_seed.status = "done";
      } else {
        state.steps.S2_bridge_deposit_seed.notes = "DEFERRED: no prior Sub-5b state; SDK bridge.deposit reserved";
        state.steps.S2_bridge_deposit_seed.status = "skipped";
      }
      saveState(state);
    }

    // S3: bulk submit K=5 (1 real + 4 decoys) via SDK
    if (state.steps.S3_bulk_submit_with_decoys.status === "pending") {
      try {
        const bulk = await client.orders.placeOrderBulk({
          side: "sell",
          amount: 1_234_567n,
          limitPrice: 5_000n,
          path: ["tUSDC", "tETH"],
          decoyCount: MAX_DECOYS, // 4
        });
        state.realNonce = bulk.realNonce.toString();
        state.decoyNonces = bulk.decoyNonces.map((n) => n.toString());
        state.bulkEpoch = bulk.epoch;
        state.steps.S3_bulk_submit_with_decoys.status = "done";
        state.steps.S3_bulk_submit_with_decoys.notes = `K=5 submitted; tx ${bulk.txHash}, real nonce ${state.realNonce}`;
      } catch (e) {
        state.steps.S3_bulk_submit_with_decoys.status = "failed";
        state.steps.S3_bulk_submit_with_decoys.notes = `${e instanceof Error ? e.message : String(e)}`.slice(0, 300);
      }
      saveState(state);
    }

    // S4: assert registry shape
    if (state.steps.S4_assert_registry_shape.status === "pending" && state.aliceAddr) {
      const regPath = join(homedir(), ".quetzal", `decoy-registry-${state.aliceAddr.toLowerCase()}.json`);
      if (!existsSync(regPath)) {
        state.steps.S4_assert_registry_shape.status = "failed";
        state.steps.S4_assert_registry_shape.notes = `registry missing at ${regPath}`;
      } else {
        const reg = JSON.parse(readFileSync(regPath, "utf8")) as Record<string, boolean>;
        const real = Object.entries(reg).filter(([, v]) => v === false);
        const decoy = Object.entries(reg).filter(([, v]) => v === true);
        if (real.length === 1 && decoy.length === 4) {
          state.steps.S4_assert_registry_shape.status = "done";
          state.steps.S4_assert_registry_shape.notes = `K=5 registry shape OK: 1 real + 4 decoys`;
        } else {
          state.steps.S4_assert_registry_shape.status = "failed";
          state.steps.S4_assert_registry_shape.notes = `real=${real.length} decoy=${decoy.length}`;
        }
      }
      saveState(state);
    }

    // S5: wait + close-epoch via SDK
    if (state.steps.S5_close_epoch_and_clear.status === "pending") {
      try {
        console.log("S5: sleeping 720s for epoch advance...");
        await sleep(720_000);
        const ce = await client.orders.closeEpoch({ epoch: state.bulkEpoch ?? 0 });
        state.steps.S5_close_epoch_and_clear.status = "done";
        state.steps.S5_close_epoch_and_clear.notes = `closeEpoch -> ${JSON.stringify(ce)}`;
      } catch (e) {
        state.steps.S5_close_epoch_and_clear.status = "failed";
        state.steps.S5_close_epoch_and_clear.notes = `${e instanceof Error ? e.message : String(e)}`.slice(0, 300);
      }
      saveState(state);
    }

    // S6: selective claim with filterDecoys
    if (state.steps.S6_selective_claim_filters_decoys.status === "pending" && state.realNonce && state.bulkEpoch !== null) {
      try {
        const claim = await client.orders.claimFill({
          nonce: BigInt(state.realNonce),
          epoch: state.bulkEpoch,
          filterDecoys: true,
        });
        state.steps.S6_selective_claim_filters_decoys.status = "done";
        state.steps.S6_selective_claim_filters_decoys.notes = `claim tx ${claim.txHash}`;
      } catch (e) {
        state.steps.S6_selective_claim_filters_decoys.status = "failed";
        state.steps.S6_selective_claim_filters_decoys.notes = `${e instanceof Error ? e.message : String(e)}`.slice(0, 300);
      }
      saveState(state);
    }

    // S7: cancel decoys via SDK (loop)
    if (state.steps.S7_cancel_decoys_reclaims_escrow.status === "pending") {
      let reclaimed = 0;
      for (const decoy of state.decoyNonces) {
        try {
          await client.orders.cancelOrder({ nonce: BigInt(decoy) });
          reclaimed++;
        } catch {
          // continue; partial success acceptable
        }
      }
      state.steps.S7_cancel_decoys_reclaims_escrow.status = reclaimed === state.decoyNonces.length ? "done" : "failed";
      state.steps.S7_cancel_decoys_reclaims_escrow.notes = `${reclaimed}/${state.decoyNonces.length} decoy cancels succeeded`;
      saveState(state);
    }

    // S8: round-amount advisory — exit twice (blocked then acked)
    if (state.steps.S8_round_amount_bridge_exit_blocked_then_acked.status === "pending") {
      const recipient = process.env.L1_MAKER_ADDR ?? process.env.SEPOLIA_PUBLIC_ADDRESS;
      if (!recipient) {
        state.steps.S8_round_amount_bridge_exit_blocked_then_acked.status = "skipped";
        state.steps.S8_round_amount_bridge_exit_blocked_then_acked.notes = "no L1_MAKER_ADDR";
      } else {
        let phaseA = false;
        try {
          await client.bridge.exit({
            token: "tUSDC",
            amount: 10_000_000n, // round_unit, no ackRound
            l1Recipient: recipient,
          });
        } catch (e) {
          if (e instanceof BridgeError || (e instanceof Error && e.message.toLowerCase().includes("round"))) phaseA = true;
        }
        let phaseB = false;
        try {
          await client.bridge.exit({
            token: "tUSDC",
            amount: 10_000_000n,
            l1Recipient: recipient,
            ackRound: true,
            ackDelay: true,
          });
          phaseB = true;
        } catch {
          phaseB = false;
        }
        state.steps.S8_round_amount_bridge_exit_blocked_then_acked.status = phaseA && phaseB ? "done" : "failed";
        state.steps.S8_round_amount_bridge_exit_blocked_then_acked.notes = `phaseA blocked: ${phaseA}, phaseB acked: ${phaseB}`;
      }
      saveState(state);
    }

    console.log("Sub-6b 3.2 SDK anonymity runner: done (see state file for step outcomes).");
  } finally {
    await client.stop();
  }
}

main().catch((e) => {
  const msg = (e instanceof Error ? e.message : String(e)).replace(/0x[0-9a-fA-F]{32,}/g, "0x<REDACTED>");
  console.error(msg);
  process.exit(1);
});
