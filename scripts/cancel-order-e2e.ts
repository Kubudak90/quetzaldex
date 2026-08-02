#!/usr/bin/env node
// cancel-order-e2e.ts — prove cancel_order works on the fixed orderbook (same
// select-by-nonce fix as claim_fill). Cancels an orphaned resting order and
// verifies the escrowed input (tUSDC) is refunded to the maker's private balance.
// Reuses the sub9 wallet. Run with the drpc fetch-shim on testnet.
//
//   CANCEL_NONCE=0x00a7a8f9... NODE_OPTIONS="--import file://$PWD/scripts/drpc-fetch-shim.mjs" \
//   AZTEC_NODE_URL=https://aztec-testnet.drpc.org pnpm tsx scripts/cancel-order-e2e.ts
import { readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { Fr, Fq } from "@aztec/aztec.js/fields";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { createAztecNodeClient, waitForNode } from "@aztec/aztec.js/node";
import { EmbeddedWallet } from "@aztec/wallets/embedded";
import { OrderbookContract } from "../tests/integration/generated/Orderbook.js";
import { TokenContract } from "../tests/integration/generated/Token.js";

const NODE_URL = process.env.AZTEC_NODE_URL ?? "https://aztec-testnet.drpc.org";
const CONFIG = "quetzal.config.json", STATE = "sub9-e2e-state.json", PXE_DIR = "./sub9-e2e-pxe";
const GATE_ATTEMPTS = Number(process.env.GATE_ATTEMPTS ?? "40");
const ESCROW = BigInt(process.env.ESCROW ?? "1000000"); // 1 tUSDC escrowed per order

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
  // pick the nonce to cancel: env, else first orphan, else the submittedOrder
  const orphans: Array<{ orderNonce: string }> = state.orphanedOrders ?? [];
  const nonceHex: string = process.env.CANCEL_NONCE ?? orphans[0]?.orderNonce ?? state.submittedOrder?.orderNonce;
  if (!nonceHex) throw new Error("no order nonce to cancel");
  console.log(`[cancel] target order_nonce=${nonceHex}`);

  const node = createAztecNodeClient(NODE_URL); await waitForNode(node);
  const wallet = await EmbeddedWallet.create(node, { ephemeral: false, pxe: { proverEnabled: true, dataDirectory: PXE_DIR } });
  const am = await wallet.createSchnorrAccount(Fr.fromString(state.childSecret), Fr.fromString(state.childSalt), Fq.fromString(state.childSigningKey));
  const address = (await am.getAccount()).getAddress();
  console.log(`[cancel] maker=${address.toString()} nodeTip=${await node.getBlockNumber()}`);

  const orderbook = await OrderbookContract.at(AztecAddress.fromStringUnsafe(config.orderbook), wallet);
  const ob = orderbook as unknown as { methods: { cancel_order: (n: Fr, a: bigint) => { send: (o: { from: AztecAddress }) => Promise<unknown>; simulate: (o: { from: AztecAddress }) => Promise<unknown> } } };
  const mk = () => ob.methods.cancel_order(Fr.fromString(nonceHex), 0n);

  // settlement gate: constrained cancel_order.simulate until the note is found.
  console.log(`[cancel] settlement gate: pre-flighting constrained cancel_order.simulate ...`);
  let ready = false;
  for (let i = 0; i < GATE_ATTEMPTS; i++) {
    try { await (orderbook as unknown as { methods: { get_orders: () => { simulate: (o: { from: AztecAddress }) => Promise<unknown> } } }).methods.get_orders().simulate({ from: address }); } catch { /* drives sync */ }
    const sb = await syncedBlock(wallet);
    try {
      await mk().simulate({ from: address });
      console.log(`[cancel] gate[${i}] synced=${sb} → constrained simulate PASSED (note found by nonce)`);
      ready = true; break;
    } catch (e) {
      const m = (e as Error).message || "";
      const why = /order not found/.test(m) ? "order not found (not settled / wrong nonce)" : m.replace(/\s+/g, " ").slice(0, 140);
      console.log(`[cancel] gate[${i}] synced=${sb} → not ready: ${why}`);
      await sleep(12000);
    }
  }
  if (!ready) throw new Error("settlement gate timed out — cancel_order.simulate never passed");

  const tUSDC = await TokenContract.at(AztecAddress.fromStringUnsafe(config.tUSDC), wallet);
  const rd = async () => BigInt(((await tUSDC.methods.balance_of_private(address).simulate({ from: address })) as { result: bigint }).result);
  const before = await rd();
  console.log(`[cancel] tUSDC private BEFORE: ${before}`);

  console.log(`[cancel] sending cancel_order for real ...`);
  const res = await mk().send({ from: address });
  console.log(`[cancel] cancel_order MINED; tx=${(res as { receipt?: { txHash?: { toString(): string } } }).receipt?.txHash?.toString() ?? "(no hash)"}`);

  let after = before;
  for (let i = 0; i < 12; i++) { after = await rd(); if (after > before) break; await sleep(3000); }
  console.log(`[cancel] tUSDC private AFTER: ${after}  delta=${after - before}  expected +${ESCROW}`);
  console.log(after - before === ESCROW ? "\n✓✓✓ CANCEL_ORDER E2E PASS — escrow refunded; select-by-nonce fix works for cancel too." : "\n⚠ delta != escrow — inspect (refund may differ or note already cancelled)");
  await wallet.stop();
}
main().catch((e) => { console.error("[cancel] FAIL:", e); process.exit(1); });
