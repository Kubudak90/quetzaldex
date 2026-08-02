import { Fr, Fq } from "@aztec/aztec.js/fields";
import { createAztecNodeClient } from "@aztec/aztec.js/node";
import { EmbeddedWallet } from "@aztec/wallets/embedded";
async function main() {
  const node = createAztecNodeClient(process.env.AZTEC_NODE_URL!);
  const wallet = await EmbeddedWallet.create(node, { ephemeral: true });
  const secret = Fr.fromString(process.env.AZTEC_SECRET_KEY!);
  const salt = Fr.ZERO;
  const signingKey = Fq.fromString(process.env.AZTEC_PRIVATE_KEY!);
  const am = await wallet.createSchnorrAccount(secret, salt, signingKey);
  const addr = (await am.getAccount()).getAddress();
  console.log("derived address:", addr.toString());
  console.log("env AZTEC_PUBLIC_ADDRESS:", process.env.AZTEC_PUBLIC_ADDRESS);
  console.log("env AZTEC_ZERO_SALT_DERIVED_ADDRESS:", process.env.AZTEC_ZERO_SALT_DERIVED_ADDRESS);
  await wallet.stop?.();
}
main().catch(e => { console.error(e); process.exit(1); });
