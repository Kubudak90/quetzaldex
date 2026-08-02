// Read-only: balance_of_public(user) for tUSDC/tETH via admin PXE (no writes).
import { readFileSync } from "node:fs";
import { Fr, Fq } from "@aztec/aztec.js/fields";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { createAztecNodeClient, waitForNode } from "@aztec/aztec.js/node";
import { EmbeddedWallet } from "@aztec/wallets/embedded";
import { TokenContract } from "../tests/integration/generated/Token.js";

interface M1State { secret: string; salt: string; signingKey: string; address: string }

async function main(): Promise<void> {
  const m1 = JSON.parse(readFileSync("testnet-m1-state.json", "utf8")) as M1State;
  const cfg = JSON.parse(readFileSync("quetzal.config.json", "utf8")) as { tUSDC: string; tETH: string };
  const user = AztecAddress.fromStringUnsafe(process.argv[2]!);

  const node = createAztecNodeClient(process.env.AZTEC_NODE_URL ?? "https://rpc.testnet.aztec-labs.com");
  await waitForNode(node);
  const wallet = await EmbeddedWallet.create(node, {
    ephemeral: false, pxe: { proverEnabled: false, dataDirectory: "./testnet-m4-pxe" },
  });
  const adminMgr = await wallet.createSchnorrAccount(
    Fr.fromString(m1.secret), Fr.fromString(m1.salt), Fq.fromString(m1.signingKey),
  );
  const admin = (await adminMgr.getAccount()).getAddress();

  for (const key of ["tUSDC", "tETH"] as const) {
    const token = await TokenContract.at(AztecAddress.fromStringUnsafe(cfg[key]), wallet);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const bal = await (token.methods as any).balance_of_public(user).simulate({ from: admin });
    console.log(`${key} balance_of_public(${user.toString().slice(0, 10)}…): ${bal?.result ?? bal}`);
  }
  await wallet.stop();
}
main().catch((e) => { console.error(String(e).slice(0, 400)); process.exit(1); });
