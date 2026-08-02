// examples/02-bridge-deposit.ts
// L1 -> L2 bridge deposit + claim.
//
// IMPORTANT: SDK-side `client.bridge.deposit` is reserved and currently throws
// BridgeError. For now, run the operator deposit via:
//
//   dotenv -e ../.env.testnet -- pnpm tsx ../scripts/testnet-sub5b-bridge.ts
//
// Once the deposit lands on L2 (~4-15 min for the messaging window),
// run this example to claim it.
//
// The script writes secret + messageIndex to testnet-sub5b-state.json;
// this example reads from environment variables (set them after running the script):
//
//   BRIDGE_DEPOSIT_AMOUNT=1000000
//   BRIDGE_DEPOSIT_SECRET=0x...
//   BRIDGE_DEPOSIT_MESSAGE_INDEX=42
//
// Run: dotenv -e ../.env.testnet -- pnpm tsx 02-bridge-deposit.ts

import { QuetzalClient, BridgeError } from "@quetzal/sdk";

async function main(): Promise<void> {
  const amount = BigInt(process.env.BRIDGE_DEPOSIT_AMOUNT ?? "1000000");
  const secret = process.env.BRIDGE_DEPOSIT_SECRET;
  const messageIndex = process.env.BRIDGE_DEPOSIT_MESSAGE_INDEX ?? "0";
  if (!secret) {
    console.error(
      "Run scripts/testnet-sub5b-bridge.ts first, then set BRIDGE_DEPOSIT_{SECRET,MESSAGE_INDEX} env vars.",
    );
    process.exit(1);
  }
  const client = await QuetzalClient.connect({
    network: "alpha-testnet",
    nodeUrl: process.env.AZTEC_NODE_URL!,
    account: { type: "schnorr", secret: process.env.AZTEC_PRIVATE_KEY! },
  });
  try {
    const cl = await client.bridge.claim({
      token: "tUSDC",
      amount,
      isPrivate: true,
      secret,
      messageIndex,
    });
    console.log(`L2 claim tx: ${cl.l2TxHash}`);
  } catch (e) {
    if (e instanceof BridgeError) {
      console.error(`Bridge claim failed (${e.code}): ${e.message}`);
    } else {
      console.error(e);
    }
    process.exit(1);
  } finally {
    await client.stop();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
