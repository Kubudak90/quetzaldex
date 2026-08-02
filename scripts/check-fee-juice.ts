import { createAztecNodeClient } from "@aztec/aztec.js/node";
import { AztecAddress } from "@aztec/aztec.js/addresses";
async function main() {
  const node = createAztecNodeClient(process.env.AZTEC_NODE_URL!);
  const addr = AztecAddress.fromStringUnsafe(process.argv[2]!);
  // Fee Juice contract is at the canonical 0x...05 address; read balance via getPublicStorageAt
  const FEE_JUICE_ADDR = AztecAddress.fromStringUnsafe("0x0000000000000000000000000000000000000000000000000000000000000005");
  // Storage slot for balances depends on contract; can't easily compute without ABI.
  // Try a public RPC method instead: node.getCurrentBalance or similar.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const n = node as any;
  if (typeof n.getPublicBalanceOf === "function") {
    const bal = await n.getPublicBalanceOf(FEE_JUICE_ADDR, addr);
    console.log(`fee-juice balance: ${bal}`);
    return;
  }
  // Fallback: just dump available methods
  const proto = Object.getPrototypeOf(node);
  const names = Object.getOwnPropertyNames(proto).filter(n => !n.startsWith("_"));
  console.log("node methods:", names.slice(0, 30));
}
main().catch(e => { console.error(e); process.exit(1); });
