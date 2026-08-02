// examples/03-bulk-with-decoys.ts
// Anonymity-set bulk submit: 1 real order + 4 decoys (K=5).
//
// Run: dotenv -e ../.env.testnet -- pnpm tsx 03-bulk-with-decoys.ts

import { QuetzalClient, MAX_DECOYS } from "@quetzal/sdk";

async function main(): Promise<void> {
  const client = await QuetzalClient.connect({
    network: "alpha-testnet",
    nodeUrl: process.env.AZTEC_NODE_URL!,
    account: { type: "schnorr", secret: process.env.AZTEC_PRIVATE_KEY! },
  });
  try {
    const r = await client.orders.placeOrderBulk({
      side: "sell",
      amount: 1_234_567n,
      limitPrice: 5_000n,
      path: ["tUSDC", "tETH"],
      decoyCount: MAX_DECOYS,  // 4 (Sub-6a A5 gate cap)
    });
    console.log("Bulk submit (K=5):");
    console.log("  tx:           ", r.txHash);
    console.log("  real nonce:   ", r.realNonce.toString());
    console.log("  decoy nonces: ");
    for (const n of r.decoyNonces) {
      console.log(`    0x${n.toString(16)}`);
    }
    console.log("  epoch:        ", r.epoch);
    console.log("");
    console.log("Decoy registry: ~/.quetzal/decoy-registry-<wallet>.json");
    console.log("Claim auto-skips decoys; run 'quetzal cancel-decoys --epoch N' to reclaim their escrow.");
  } finally {
    await client.stop();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
