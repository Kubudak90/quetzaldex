import { Fr, Fq } from "@aztec/aztec.js/fields";
import { createAztecNodeClient } from "@aztec/aztec.js/node";
import { EmbeddedWallet } from "@aztec/wallets/embedded";
import { writeFileSync } from "node:fs";

async function main() {
  const node = createAztecNodeClient(process.env.AZTEC_NODE_URL!);
  const wallet = await EmbeddedWallet.create(node, { ephemeral: true, pxe: { proverEnabled: true } });
  const secret = Fr.random();
  const salt = Fr.ZERO;
  const signingKey = Fq.random();
  const am = await wallet.createSchnorrAccount(secret, salt, signingKey);
  const addr = (await am.getAccount()).getAddress();

  const state = {
    step: 3, // skip faucet (we'll let user claim manually); resume from step 4 (deploy account)
    secret: secret.toString(),
    salt: salt.toString(),
    signingKey: signingKey.toString(),
    address: addr.toString(),
    faucetResponses: [],
  };
  writeFileSync("deploy-bridge-state.json", JSON.stringify(state, null, 2));

  console.log("");
  console.log("=== FRESH WALLET FOR FAUCET CLAIM ===");
  console.log("Address (paste into faucet):");
  console.log("  " + addr.toString());
  console.log("");
  console.log("After claim, provide these 4 fields from faucet response:");
  console.log("  claimAmount, claimSecretHex, messageLeafIndex, messageHashHex");
  console.log("");
  console.log("State seeded to deploy-bridge-state.json with step=3 (account deploy pending).");
  await wallet.stop?.();
}
main().catch(e => { console.error(e); process.exit(1); });
