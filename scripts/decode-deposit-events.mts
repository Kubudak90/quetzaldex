import { createPublicClient, http, parseAbi, decodeEventLog } from "viem";
import { sepolia } from "viem/chains";
import { createAztecNodeClient } from "@aztec/aztec.js/node";
import { Fr } from "@aztec/aztec.js/fields";

async function main() {
  const pc = createPublicClient({ chain: sepolia, transport: http(process.env.L1_RPC_URL!) });
  const receipt = await pc.getTransactionReceipt({
    hash: "0x7e776a69fa0cdc66131ef3d9aac9c55eb25fe3e81e0d2e38ee8be5b9739e1ac5",
  });

  for (const log of receipt.logs) {
    // L1Inbox MessageSent
    if (log.topics[0] === "0xe3afb584bcff3adb9d452d2e1ccbcd4aee164ae2a8cdab637aecf866a53fbb77") {
      const dec = decodeEventLog({
        abi: parseAbi(["event MessageSent(uint256 indexed checkpointNumber, uint256 index, bytes32 indexed hash, bytes16 rollingHash)"]),
        topics: log.topics as [`0x${string}`, ...`0x${string}`[]],
        data: log.data,
      });
      console.log("L1Inbox.MessageSent:");
      console.log(JSON.stringify(dec.args, (_k, v) => typeof v === "bigint" ? v.toString() : v, 2));
    }
    // Bridge DepositInitiated
    if (log.topics[0] === "0x6d427fdb35b9c2ae11c4374e424fdc75bd8ae80001f74d846ea70bf7233af909") {
      const dec = decodeEventLog({
        abi: parseAbi(["event DepositInitiated(address indexed sender, bytes32 indexed l2Recipient, uint256 amount, bytes32 secretHash, uint256 messageIndex, bool isPrivate)"]),
        topics: log.topics as [`0x${string}`, ...`0x${string}`[]],
        data: log.data,
      });
      console.log("Bridge.DepositInitiated:");
      console.log(JSON.stringify(dec.args, (_k, v) => typeof v === "bigint" ? v.toString() : v, 2));
    }
  }

  // Check the L1Inbox messageHash against L2 tree
  const inboxLog = receipt.logs.find(l => l.topics[0] === "0xe3afb584bcff3adb9d452d2e1ccbcd4aee164ae2a8cdab637aecf866a53fbb77")!;
  const msgHash = inboxLog.topics[2]!;
  console.log(`\nUSDC deposit L1Inbox messageHash = ${msgHash}`);
  const node = createAztecNodeClient(process.env.AZTEC_NODE_URL!) as unknown as {
    getL1ToL2MessageMembershipWitness: (b: string, m: Fr) => Promise<unknown | undefined>;
  };
  const w = await node.getL1ToL2MessageMembershipWitness("latest", Fr.fromHexString(msgHash));
  console.log(`L2 tree membership: ${w === undefined ? "NOT IN TREE" : "IN TREE ✓"}`);
  if (w) console.log(JSON.stringify(w, (_k, v) => typeof v === "bigint" ? v.toString() : v).slice(0, 200));
}
main().catch(e => { console.error(e); process.exit(1); });
