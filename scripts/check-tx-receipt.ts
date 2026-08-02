import { createAztecNodeClient } from "@aztec/aztec.js/node";
import { TxHash } from "@aztec/stdlib/tx";
async function main() {
  const node = createAztecNodeClient("https://rpc.testnet.aztec-labs.com");
  const r = await node.getTxReceipt(TxHash.fromString(process.argv[2]!));
  console.log("status:", r?.status, "block:", String(r?.blockNumber), "err:", r?.error || "none");
}
main().catch(e => { console.error(String(e).slice(0,300)); process.exit(1); });
