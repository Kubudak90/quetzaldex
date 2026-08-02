#!/usr/bin/env node
// topup-orderbook-teth.ts — DIAGNOSTIC: admin mints a small amount of tETH to the
// orderbook's PUBLIC balance, to cover the few-atomic-unit shortfall between the
// committed hop-fill amount_out and the pool's actual a_from_pool (the conservation
// rounding bug fixed in aggregator/src/clearing.ts). This lets the ALREADY-COMMITTED
// epoch-5 fill be claimed, proving the claim_fill select+merkle+payout path end-to-end.
// (Future fills cleared by the fixed aggregator need NO top-up.)
//
// Usage: AMOUNT=100 pnpm tsx scripts/topup-orderbook-teth.ts
import { readFileSync } from "node:fs";
import { Fr, Fq } from "@aztec/aztec.js/fields";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { createAztecNodeClient, waitForNode } from "@aztec/aztec.js/node";
import { EmbeddedWallet } from "@aztec/wallets/embedded";
import { GasFees } from "@aztec/stdlib/gas";
import { TokenContract } from "../tests/integration/generated/Token.js";

const NODE_URL = process.env.AZTEC_NODE_URL ?? "https://rpc.testnet.aztec-labs.com";
const AMOUNT = BigInt(process.env.AMOUNT ?? "100");
const TOKEN = process.env.TOKEN ?? "tETH"; // tETH | tUSDC | tBTC

async function main() {
  const c = JSON.parse(readFileSync("quetzal.config.json", "utf8"));
  const m1 = JSON.parse(readFileSync("testnet-m1-state.json", "utf8"));
  const raw = createAztecNodeClient(NODE_URL); await waitForNode(raw);
  const sL2 = process.env.STATIC_MAX_FEE_PER_L2_GAS;
  const node: any = sL2 ? new Proxy(raw as any, { get(t, p, r) {
    if (p === "getCurrentMinFees") return async () => new GasFees(0n, BigInt(sL2));
    const v = Reflect.get(t, p, r); return typeof v === "function" ? v.bind(t) : v;
  }}) : raw;
  const wallet = await EmbeddedWallet.create(node, { ephemeral: false, pxe: { proverEnabled: true, dataDirectory: "./testnet-m4-pxe" } });
  const am = await wallet.createSchnorrAccount(Fr.fromString(m1.secret), Fr.fromString(m1.salt), Fq.fromString(m1.signingKey));
  const admin = (await am.getAccount()).getAddress();
  if (admin.toString().toLowerCase() !== c.admin.toLowerCase()) throw new Error(`admin mismatch ${admin} vs ${c.admin}`);
  const ob = AztecAddress.fromStringUnsafe(c.orderbook);
  const tokenAddr = c[TOKEN];
  if (!tokenAddr) throw new Error(`config.${TOKEN} missing`);
  const tok = await TokenContract.at(AztecAddress.fromStringUnsafe(tokenAddr), wallet);
  const before = BigInt(((await tok.methods.balance_of_public(ob).simulate({ from: admin })) as { result: bigint }).result);
  console.log(`[topup] admin=${admin} orderbook=${c.orderbook} token=${TOKEN}`);
  console.log(`[topup] orderbook ${TOKEN} public BEFORE: ${before}; minting +${AMOUNT}`);
  await tok.methods.mint_to_public(ob, AMOUNT).send({ from: admin });
  const after = BigInt(((await tok.methods.balance_of_public(ob).simulate({ from: admin })) as { result: bigint }).result);
  console.log(`[topup] orderbook ${TOKEN} public AFTER:  ${after}  (delta ${after - before})`);
  await wallet.stop();
}
main().catch((e) => { console.error("[topup] FAIL:", e); process.exit(1); });
