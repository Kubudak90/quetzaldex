// Quick: read admin's tUSDC public balance (to confirm a bridge claim landed).
import { readFileSync } from "node:fs";
import { Fr, Fq } from "@aztec/aztec.js/fields";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { createAztecNodeClient, waitForNode } from "@aztec/aztec.js/node";
import { EmbeddedWallet } from "@aztec/wallets/embedded";
import { TokenContract } from "../tests/integration/generated/Token.js";

const NODE = process.env.AZTEC_NODE_URL ?? "https://rpc.testnet.aztec-labs.com";
const m1 = JSON.parse(readFileSync("testnet-m1-state.json", "utf8"));
const cfg = JSON.parse(readFileSync("quetzal.config.json", "utf8"));
const node = createAztecNodeClient(NODE);
await waitForNode(node);
const wallet = await EmbeddedWallet.create(node, { ephemeral: true, pxe: { proverEnabled: true } });
const am = await wallet.createSchnorrAccount(Fr.fromString(m1.secret), Fr.fromString(m1.salt), Fq.fromString(m1.signingKey));
const admin = (await am.getAccount()).getAddress();
const t = await TokenContract.at(AztecAddress.fromStringUnsafe(cfg.tUSDC), wallet);
const bal: any = await (t.methods as any).balance_of_public(admin).simulate({ from: admin });
const asBig = typeof bal === "bigint" ? bal : (bal?.toBigInt?.() ?? bal?.value ?? bal?.lo ?? null);
console.log("admin:", admin.toString());
console.log("tUSDC public balance raw:", JSON.stringify(bal, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
console.log("tUSDC public balance bigint:", asBig != null ? asBig.toString() : "UNPARSED");
console.log("baseline mint = 1000000000000 (1M); +10 USDC bridge claim = 1000010000000");
