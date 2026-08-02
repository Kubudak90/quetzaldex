// One-off: mint a public tUSDC + tETH buffer to the admin (=minter) so the
// faucet's drain-floor check (operator public balance >= amount*multiplier)
// passes. The faucet mints fresh per user, so this buffer stays constant.
// Run: AZTEC_NODE_URL=https://rpc.testnet.aztec-labs.com ETHEREUM_HOSTS=$L1_RPC_URL \
//   STATIC_MAX_FEE_PER_L2_GAS=8000000000000 STATIC_MAX_FEE_PER_DA_GAS=1000000000 \
//   node_modules/.bin/tsx scripts/mint-admin-public.ts
import { readFileSync } from "node:fs";
import { Fr, Fq } from "@aztec/aztec.js/fields";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { createAztecNodeClient, waitForNode } from "@aztec/aztec.js/node";
import { EmbeddedWallet } from "@aztec/wallets/embedded";
import { GasFees } from "@aztec/stdlib/gas";
import { TokenContract } from "../tests/integration/generated/Token.js";

const NODE_URL = process.env.AZTEC_NODE_URL ?? "https://rpc.testnet.aztec-labs.com";
if (!NODE_URL.includes("testnet")) throw new Error("AZTEC_NODE_URL must include 'testnet'");
const m1 = JSON.parse(readFileSync("testnet-m1-state.json", "utf8"));
const cfg = JSON.parse(readFileSync("quetzal.config.json", "utf8"));

// Generous buffers (admin balance stays constant — faucet mints to users, not from admin).
const TUSDC_AMT = 1_000_000_000_000n; // 1,000,000 tUSDC (6 dec)
const TETH_AMT = 1_000_000_000_000_000_000_000n; // 1,000 tETH (18 dec)

const raw = createAztecNodeClient(NODE_URL);
await waitForNode(raw);
const sL2 = process.env.STATIC_MAX_FEE_PER_L2_GAS;
const sDa = process.env.STATIC_MAX_FEE_PER_DA_GAS ?? "0";
const node: any = sL2
  ? new Proxy(raw as any, {
      get(t, p, r) {
        if (p === "getCurrentMinFees") return async () => new GasFees(BigInt(sDa), BigInt(sL2));
        const v = Reflect.get(t, p, r);
        return typeof v === "function" ? v.bind(t) : v;
      },
    })
  : raw;

const wallet = await EmbeddedWallet.create(node, {
  ephemeral: false,
  pxe: { proverEnabled: true, dataDirectory: "./testnet-m4-pxe" },
});
const am = await wallet.createSchnorrAccount(
  Fr.fromString(m1.secret),
  Fr.fromString(m1.salt),
  Fq.fromString(m1.signingKey),
);
const admin = (await am.getAccount()).getAddress();
if (admin.toString() !== m1.address) throw new Error(`admin mismatch: ${admin} vs ${m1.address}`);
console.log("admin:", admin.toString());

const tUSDC = await TokenContract.at(AztecAddress.fromStringUnsafe(cfg.tUSDC), wallet);
const tETH = await TokenContract.at(AztecAddress.fromStringUnsafe(cfg.tETH), wallet);

console.log(`mint_to_public(admin, ${TUSDC_AMT}) tUSDC ...`);
await tUSDC.methods.mint_to_public(admin, TUSDC_AMT).send({ from: admin });
console.log("  tUSDC mint OK");
console.log(`mint_to_public(admin, ${TETH_AMT}) tETH ...`);
await tETH.methods.mint_to_public(admin, TETH_AMT).send({ from: admin });
console.log("  tETH mint OK");

const balU = await tUSDC.methods.balance_of_public(admin).simulate();
const balE = await tETH.methods.balance_of_public(admin).simulate();
console.log(`admin public balances: tUSDC=${balU} tETH=${balE}`);
console.log("DONE");
