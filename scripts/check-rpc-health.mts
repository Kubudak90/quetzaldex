// Check whether the Aztec testnet node's min-fee L1 RPC is healthy.
//
// Since the testnet upgraded to 4.3.0 (~2026-05-29), the public node
// (rpc.testnet.aztec-labs.com) computes min-fees by reading the L1 rollup via a
// shared Quicknode Sepolia key that is rate-limited (HTTP 429) -- which blocks
// ALL transactions (deploy, faucet, bridge). This probe detects recovery.
//
// Output (single line):
//   RPC_OK <fees>   -> getCurrentMinFees succeeded; the node can transact again
//   RPC_429         -> still rate-limited (the known outage)
//   RPC_ERR <msg>   -> some other error
//   RPC_TIMEOUT     -> node unresponsive within 40s
//
// Usage: AZTEC_NODE_URL=https://rpc.testnet.aztec-labs.com node --import tsx scripts/check-rpc-health.mts
import { createAztecNodeClient, waitForNode } from "@aztec/aztec.js/node";

const url = process.env.AZTEC_NODE_URL ?? "https://rpc.testnet.aztec-labs.com";
setTimeout(() => { console.log("RPC_TIMEOUT"); process.exit(2); }, 40000).unref();

try {
  const node: any = createAztecNodeClient(url);
  await waitForNode(node);
  const fees = await node.getCurrentMinFees();
  // fees contain BigInts — JSON.stringify needs a replacer or it throws
  // "Do not know how to serialize a BigInt" (which would masquerade as RPC_ERR).
  console.log("RPC_OK " + JSON.stringify(fees, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
  process.exit(0);
} catch (e) {
  const msg = e instanceof Error ? e.message : String(e);
  if (/429|Too Many Requests|getTimestampForSlot/i.test(msg)) {
    console.log("RPC_429");
    process.exit(1);
  }
  console.log("RPC_ERR " + msg.slice(0, 160).replace(/\n/g, " "));
  process.exit(3);
}
