// Sub-9.4 helper: force-close current epoch from admin.
// Use case: brand-new orderbook deployed past epoch 0 closes_at_block; no
// reveals in queue → aggregator's wouldClear stays false → epoch 0 never
// advances → submit_order is permanently rejected with "epoch has expired".
//
// This script just calls Orderbook.close_epoch() from admin.
import { readFileSync } from "node:fs";
import { Fr, Fq } from "@aztec/aztec.js/fields";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { createAztecNodeClient, waitForNode } from "@aztec/aztec.js/node";
import { EmbeddedWallet } from "@aztec/wallets/embedded";
import { GasFees } from "@aztec/stdlib/gas";
import { OrderbookContract } from "../tests/integration/generated/Orderbook.js";

const NODE_URL = process.env.AZTEC_NODE_URL ?? "https://rpc.testnet.aztec-labs.com";
const m1 = JSON.parse(readFileSync("testnet-m1-state.json", "utf8"));
const cfg = JSON.parse(readFileSync("quetzal.config.json", "utf8"));
const orderbookAddr = AztecAddress.fromStringUnsafe(cfg.orderbook);

const _rawNode = createAztecNodeClient(NODE_URL);
await waitForNode(_rawNode);
// STATIC fee override (see redeploy-testnet.ts): bypass aztec-labs' 429'd getCurrentMinFees.
const _sL2 = process.env.STATIC_MAX_FEE_PER_L2_GAS;
const _sDa = process.env.STATIC_MAX_FEE_PER_DA_GAS ?? "0";
const node: any = _sL2
  ? new Proxy(_rawNode as any, {
      get(t, p, r) {
        if (p === "getCurrentMinFees") {
          return async () => new GasFees(BigInt(_sDa), BigInt(_sL2));
        }
        const v = Reflect.get(t, p, r);
        return typeof v === "function" ? v.bind(t) : v;
      },
    })
  : _rawNode;
if (_sL2) console.log(`[force-close] STATIC maxFeesPerGas override active: daGas=${_sDa} l2Gas=${_sL2}`);
const wallet = await EmbeddedWallet.create(node, {
  ephemeral: false,
  pxe: { proverEnabled: true, dataDirectory: "./testnet-m4-pxe" },
});
const mgr = await wallet.createSchnorrAccount(
  Fr.fromString(m1.secret),
  Fr.fromString(m1.salt),
  Fq.fromString(m1.signingKey),
);
const admin = (await mgr.getAccount()).getAddress();
console.log("admin:", admin.toString());
console.log("orderbook:", orderbookAddr.toString());

const ob = await OrderbookContract.at(orderbookAddr, wallet);
console.log("calling Orderbook.close_epoch() ...");
const t0 = Date.now();
// 4.3.0: awaiting .send() resolves after the tx is mined; the SentTx has no
// .wait() method (the old `tx.wait()` threw "tx.wait is not a function" while the
// tx still landed). Mirror the redeploy/seed pattern: await the send directly.
const sent: any = await ob.methods.close_epoch().send({ from: admin });
const txHash = sent?.txHash ?? sent?.getTxHash?.() ?? "sent";
console.log(`close_epoch OK in ${((Date.now() - t0) / 1000).toFixed(1)}s; tx=${txHash}`);

await wallet.stop();
