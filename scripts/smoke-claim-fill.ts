#!/usr/bin/env node
//
// Closes the last link of the public flow: redeem the fill produced by
// scripts/sub9-e2e-smoke.ts using exactly the path the browser takes
// (SDK claimFill -> aggregator /proof -> 7-arg claim_fill).
//
//   AZTEC_NODE_URL=… AGG_URL=… pnpm exec tsx scripts/smoke-claim-fill.ts
//
import { readFileSync } from "node:fs";
import { Fr, Fq } from "@aztec/aztec.js/fields";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { createAztecNodeClient, waitForNode } from "@aztec/aztec.js/node";
import { EmbeddedWallet } from "@aztec/wallets/embedded";
import { TokenContract } from "../tests/integration/generated/Token.js";
import { QuetzalClient } from "../sdk/src/index.js";

const NODE = process.env.AZTEC_NODE_URL ?? "https://v5.testnet.rpc.aztec-labs.com";
const AGG_URL = process.env.AGG_URL ?? "https://aggregator.quetzaldex.xyz";
const cfg = JSON.parse(readFileSync("quetzal.config.json", "utf8"));
const st = JSON.parse(readFileSync("sub9-e2e-state.json", "utf8"));

const nonce: string = st.revealPayload.order_nonce;
const epoch: number = st.revealPayload.epoch_id;
console.log(`[claim] nonce=${nonce} epoch=${epoch}`);

const node = createAztecNodeClient(NODE);
await waitForNode(node);

const wallet = await EmbeddedWallet.create(node, {
  ephemeral: false,
  pxe: { proverEnabled: true, dataDirectory: process.env.CLAIM_PXE_DIR ?? "./smoke-claim-pxe" },
});
const acct = await wallet.createSchnorrAccount(
  Fr.fromString(st.childSecret), Fr.fromString(st.childSalt), Fq.fromString(st.childSigningKey));
const me = (await acct.getAccount()).getAddress();
console.log(`[claim] wallet=${me.toString()} (expected ${st.childAddress})`);

async function reg(addr: string, artifact: unknown): Promise<void> {
  const inst = await (node as unknown as { getContract: (a: AztecAddress) => Promise<unknown> })
    .getContract(AztecAddress.fromStringUnsafe(addr));
  if (inst) await (wallet as unknown as { registerContract: (i: unknown, a: unknown) => Promise<void> })
    .registerContract(inst, artifact);
}
await reg(cfg.tETH, (TokenContract as unknown as { artifact: unknown }).artifact);
const tETH = await TokenContract.at(AztecAddress.fromStringUnsafe(cfg.tETH), wallet);

async function privBal(): Promise<bigint> {
  const s = await tETH.methods.balance_of_private(me).simulate({ from: me });
  return BigInt((s as { result: bigint }).result);
}

const before = await privBal();
console.log(`[claim] tETH private BEFORE: ${before}`);

const client = await QuetzalClient.connect({
  network: "alpha-testnet",
  nodeUrl: NODE,
  account: { type: "external-pxe", wallet, address: me } as never,
  l1: cfg.l1 as never,
  contracts: {
    orderbook: cfg.orderbook, tUSDC: cfg.tUSDC, tETH: cfg.tETH, tBTC: cfg.tBTC,
    pools: cfg.pools, treasury: cfg.treasury, aggregatorRegistry: cfg.aggregatorRegistry,
    admin: cfg.admin,
  },
} as never);

console.log(`[claim] calling claimFill via ${AGG_URL} ...`);
const res = await (client as unknown as {
  orders: { claimFill: (o: unknown) => Promise<unknown> };
}).orders.claimFill({ nonce: BigInt(nonce), epoch, aggregatorUrl: AGG_URL, filterDecoys: true });
console.log(`[claim] claimFill result: ${JSON.stringify(res)}`);

const after = await privBal();
console.log(`[claim] tETH private AFTER:  ${after}`);
console.log(after > before ? `[claim] ✅ CLAIMED +${after - before}` : `[claim] ❌ balance unchanged`);
process.exit(after > before ? 0 : 1);
