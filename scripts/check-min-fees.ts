// Print a fee ceiling = current feePerL2Gas × multiplier (default 1.3),
// for piping into STATIC_MAX_FEE_PER_L2_GAS on volatile-fee testnet days.
import { createAztecNodeClient, waitForNode } from "@aztec/aztec.js/node";
async function main() {
  const node = createAztecNodeClient(process.env.AZTEC_NODE_URL ?? "https://rpc.testnet.aztec-labs.com");
  await waitForNode(node);
  const f = await node.getCurrentMinFees();
  const mult = Number(process.env.FEE_MULT ?? "1.3");
  const ceil = (f.feePerL2Gas * BigInt(Math.round(mult * 100))) / 100n;
  console.log(ceil.toString());
}
main().catch((e) => { console.error(String(e).slice(0, 200)); process.exit(1); });
