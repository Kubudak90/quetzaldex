import { createAztecNodeClient } from "@aztec/aztec.js/node";
async function main() {
  const node = createAztecNodeClient(process.env.AZTEC_NODE_URL!);
  const addrs = await node.getL1ContractAddresses();
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(addrs)) out[k] = v?.toString?.() ?? String(v);
  console.log(JSON.stringify(out, null, 2));
}
main().catch((e) => { console.error(e); process.exit(1); });
