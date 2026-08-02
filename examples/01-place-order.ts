// examples/01-place-order.ts
// Minimal: place a single order on alpha-testnet and print the result.
//
// Run: dotenv -e ../.env.testnet -- pnpm tsx 01-place-order.ts

import { QuetzalClient } from "@quetzal/sdk";

async function main(): Promise<void> {
  const client = await QuetzalClient.connect({
    network: "alpha-testnet",
    nodeUrl: process.env.AZTEC_NODE_URL!,
    account: { type: "schnorr", secret: process.env.AZTEC_PRIVATE_KEY! },
  });
  try {
    const r = await client.orders.placeOrder({
      side: "sell",
      amount: 1_234_567n,        // 1.234567 USDC (6 decimals)
      limitPrice: 5_000n,
      path: ["tUSDC", "tETH"],
    });
    console.log("Order placed:");
    console.log("  tx:    ", r.txHash);
    console.log("  nonce: ", r.nonce.toString());
    console.log("  epoch: ", r.epoch);
  } finally {
    await client.stop();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
