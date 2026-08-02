#!/usr/bin/env node
// check-fj.ts — read an address's fee-juice PUBLIC balance via a node storage read.
// Mirrors aggregator/src/main.ts getFeePayerBalance: canonical FeeJuice protocol
// contract at 0x..05, balances map at slot 1. Avoids the broken @aztec/protocol-contracts
// import that breaks check-admin-fj.ts / probe-balances.ts.
//
// Prints exactly:  balance: <raw-wei-integer>
// Usage: AZTEC_NODE_URL=<node> tsx scripts/check-fj.ts <address>
import { createAztecNodeClient, waitForNode } from "@aztec/aztec.js/node";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { Fr } from "@aztec/aztec.js/fields";
import { deriveStorageSlotInMap } from "@aztec/stdlib/hash";

const NODE_URL = process.env.AZTEC_NODE_URL ?? "https://aztec-testnet.drpc.org";

async function main(): Promise<void> {
  const addr = process.argv[2];
  if (!addr) {
    console.error("usage: check-fj.ts <address>");
    process.exit(2);
  }
  const node = createAztecNodeClient(NODE_URL);
  await waitForNode(node);
  // v5 moved the FeeJuice protocol contract (0x…05 on 4.3 → 0x…03 on v5); a
  // hardcoded address reads an empty contract and reports 0, which makes the
  // auto-topup cron think every wallet is broke and bridge on every run.
  const nodeInfo = await node.getNodeInfo();
  const feeJuice = AztecAddress.fromStringUnsafe(
    nodeInfo.protocolContractAddresses.feeJuice.toString(),
  );
  const slot = await deriveStorageSlotInMap(new Fr(1n), AztecAddress.fromStringUnsafe(addr));
  const raw = await (node as unknown as {
    getPublicStorageAt: (b: string, c: unknown, s: unknown) => Promise<{ toBigInt(): bigint }>;
  }).getPublicStorageAt("latest", feeJuice, slot);
  console.log("balance: " + raw.toBigInt().toString());
}

main().catch((e: unknown) => {
  console.error("[check-fj] FAILED:", e instanceof Error ? e.message : String(e));
  process.exit(1);
});
