#!/usr/bin/env node
// claim-fill-e2e.ts — redeem a filled order via claim_fill, with a SETTLEMENT GATE.
//
// Root cause (workflow wueo3lf4e): claim_fill's CONSTRAINED get_notes needs the
// OrderNote settled in the note-hash-tree at the PXE anchor (latest synced block).
// get_orders/view_notes (unconstrained) sees the note before it's settled → a false
// "present:true". Fix: before sending, drive PXE sync + pre-flight the CONSTRAINED
// claim_fill.simulate in a retry loop until it stops throwing "order not found".
//
// Reuses the sub9 wallet + its PXE. Usage:
//   SNAP=aggregator/snapshots/epoch-761.json pnpm tsx scripts/claim-fill-e2e.ts
import { readFileSync, existsSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { Fr, Fq } from "@aztec/aztec.js/fields";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { createAztecNodeClient, waitForNode } from "@aztec/aztec.js/node";
import { EmbeddedWallet } from "@aztec/wallets/embedded";
import { OrderbookContract } from "../tests/integration/generated/Orderbook.js";
import { TokenContract } from "../tests/integration/generated/Token.js";
import { QuetzalClient } from "../sdk/src/index.js";

const NODE_URL = process.env.AZTEC_NODE_URL ?? "https://rpc.testnet.aztec-labs.com";
const CONFIG = "quetzal.config.json", STATE = "sub9-e2e-state.json", PXE_DIR = "./sub9-e2e-pxe";
const HOP = Number(process.env.HOP ?? "0");
const GATE_ATTEMPTS = Number(process.env.GATE_ATTEMPTS ?? "30");

async function syncedBlock(wallet: unknown): Promise<string> {
  try {
    const pxe = (wallet as { pxe?: { getSyncedBlockHeader?: () => Promise<{ globalVariables?: { blockNumber?: unknown } }> } }).pxe;
    const h = await pxe?.getSyncedBlockHeader?.();
    return String(h?.globalVariables?.blockNumber ?? "?");
  } catch { return "?"; }
}

async function main() {
  const config = JSON.parse(readFileSync(CONFIG, "utf8"));
  const state = JSON.parse(readFileSync(STATE, "utf8"));
  const orderNonceHex: string = state.submittedOrder.orderNonce;
  const epoch = Number(state.submittedOrder.epoch);
  const snapPath = process.env.SNAP ?? `aggregator/snapshots/epoch-${epoch}.json`;
  if (!existsSync(snapPath)) throw new Error(`snapshot not found: ${snapPath}`);
  const snap = JSON.parse(readFileSync(snapPath, "utf8")) as { hop_fills: Array<{ order_nonce: string; hop_index: number; amount_out: string; pool_id: number; leaf_index: number }>; hop_paths: Record<string, string[]> };
  const leaf = snap.hop_fills.find((f) => f.order_nonce === orderNonceHex && f.hop_index === HOP);
  if (!leaf || leaf.amount_out === "0") throw new Error(`no populated fill for ${orderNonceHex} hop ${HOP}`);
  const sib = snap.hop_paths[`${orderNonceHex}:${HOP}`];
  if (!sib || sib.length !== 6) throw new Error(`bad sibling path len=${sib?.length}`);
  console.log(`[claim] order=${orderNonceHex} epoch=${epoch} hop=${HOP} amount_out=${leaf.amount_out} pool=${leaf.pool_id} leaf_index=${leaf.leaf_index}`);

  const node = createAztecNodeClient(NODE_URL); await waitForNode(node);
  const wallet = await EmbeddedWallet.create(node, { ephemeral: false, pxe: { proverEnabled: true, dataDirectory: PXE_DIR } });
  const am = await wallet.createSchnorrAccount(Fr.fromString(state.childSecret), Fr.fromString(state.childSalt), Fq.fromString(state.childSigningKey));
  const address = (await am.getAccount()).getAddress();
  const client = await QuetzalClient.connect({
    network: "alpha-testnet", nodeUrl: NODE_URL, account: { type: "external-pxe", wallet, address }, l1: config.l1,
    contracts: { orderbook: config.orderbook, tUSDC: config.tUSDC, tETH: config.tETH, tBTC: config.tBTC, pools: config.pools, treasury: config.treasury, aggregatorRegistry: config.aggregatorRegistry },
  });
  console.log(`[claim] maker=${address.toString()}  nodeTip=${await node.getBlockNumber()}`);

  const orderbook = await OrderbookContract.at(AztecAddress.fromStringUnsafe(config.orderbook), wallet);
  const ob = orderbook as unknown as { methods: { claim_fill: (e: number, n: Fr, h: bigint, a: bigint, p: bigint, li: bigint, sp: Fr[]) => { send: (o: { from: AztecAddress }) => Promise<unknown>; simulate: (o: { from: AztecAddress }) => Promise<unknown> } } };
  const mkInteraction = () => ob.methods.claim_fill(epoch, Fr.fromString(orderNonceHex), BigInt(HOP), BigInt(leaf.amount_out), BigInt(leaf.pool_id), BigInt(leaf.leaf_index), sib.map((s) => Fr.fromString(s)));

  // ── SETTLEMENT GATE ──────────────────────────────────────────────────────
  // Pre-flight the CONSTRAINED claim_fill.simulate (NOT get_orders/view_notes,
  // which gives a false positive) until the OrderNote is settled at the anchor.
  console.log(`[claim] settlement gate: driving PXE sync + pre-flighting constrained claim_fill.simulate ...`);
  let ready = false;
  for (let i = 0; i < GATE_ATTEMPTS; i++) {
    try { await client.reads.getOrders(); } catch { /* drives sync */ }
    const sb = await syncedBlock(wallet);
    try {
      await mkInteraction().simulate({ from: address });
      console.log(`[claim] gate[${i}] synced=${sb} → constrained simulate PASSED (note settled at anchor)`);
      ready = true; break;
    } catch (e) {
      const m = (e as Error).message || "";
      const why = /order not found/.test(m) ? "order not found (not settled at anchor yet)" : m.replace(/\s+/g, " ").slice(0, 140);
      console.log(`[claim] gate[${i}] synced=${sb} nodeTip=${await node.getBlockNumber()} → not ready: ${why}`);
      await sleep(12000);
    }
  }
  if (!ready) throw new Error("settlement gate timed out — constrained claim_fill.simulate never passed");

  const tETH = await TokenContract.at(AztecAddress.fromStringUnsafe(config.tETH), wallet);
  const rd = async () => BigInt(((await tETH.methods.balance_of_private(address).simulate({ from: address })) as { result: bigint }).result);
  const before = await rd();
  console.log(`[claim] tETH private BEFORE: ${before}`);

  console.log(`[claim] sending claim_fill for real ...`);
  const res = await mkInteraction().send({ from: address });
  console.log(`[claim] claim_fill MINED; tx=${(res as { receipt?: { txHash?: { toString(): string } } }).receipt?.txHash?.toString() ?? "(no hash)"}`);

  let after = before;
  for (let i = 0; i < 12; i++) { after = await rd(); if (after > before) break; await sleep(3000); }
  console.log(`[claim] tETH private AFTER: ${after}  delta=${after - before}  expected +${leaf.amount_out}`);
  console.log(after - before === BigInt(leaf.amount_out) ? "\n✓✓✓ CLAIM_FILL E2E PASS — proceeds arrived; full order→fill→snapshot→claim loop closed." : "\n⚠ delta != amount_out — inspect");
  await wallet.stop();
}
main().catch((e) => { console.error("[claim] FAIL:", e); process.exit(1); });
