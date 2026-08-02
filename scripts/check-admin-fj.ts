// Quick fee-juice balance read for admin (or arbitrary --addr).
// Usage:
//   AZTEC_NODE_URL=https://rpc.testnet.aztec-labs.com pnpm tsx scripts/check-admin-fj.ts
//   AZTEC_NODE_URL=... pnpm tsx scripts/check-admin-fj.ts 0xabc...
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { createAztecNodeClient, waitForNode } from "@aztec/aztec.js/node";
import { Fr } from "@aztec/aztec.js/fields";
import { deriveStorageSlotInMap } from "@aztec/stdlib/hash";

import { readFileSync } from "node:fs";

async function main(): Promise<void> {
  const NODE_URL = process.env.AZTEC_NODE_URL ?? "https://rpc.testnet.aztec-labs.com";
  const node = createAztecNodeClient(NODE_URL);
  await waitForNode(node);

  let addrStr = process.argv[2];
  if (!addrStr) {
    const m1 = JSON.parse(readFileSync("testnet-m1-state.json", "utf8"));
    addrStr = m1.address;
  }
  const addr = AztecAddress.fromStringUnsafe(addrStr!);
  // v5: the FeeJuice protocol address moved (0x05 on 4.3 -> 0x03 on v5) —
  // resolve it from the node instead of hardcoding.
  const nodeInfo = await node.getNodeInfo();
  const feeJuiceAddr = nodeInfo.protocolContractAddresses.feeJuice;
  const slot = await deriveStorageSlotInMap(new Fr(1), addr);
  const raw = await node.getPublicStorageAt("latest", feeJuiceAddr, slot);
  const bal = raw.toBigInt();
  console.log(`addr:    ${addr.toString()}`);
  console.log(`balance: ${bal} (atomic units)`);
  console.log(`     ≈   ${(Number(bal) / 1e18).toFixed(6)} FJ`);
}

main().catch((e: unknown) => { console.error(e); process.exit(1); });
