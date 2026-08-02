import { createPublicClient, http, parseAbi } from "viem";
import { sepolia } from "viem/chains";
import { createAztecNodeClient } from "@aztec/aztec.js/node";
import { Fr } from "@aztec/aztec.js/fields";

async function main() {
  const RPC = process.env.L1_RPC_URL!;
  const NODE = process.env.AZTEC_NODE_URL!;
  const MAKER = "0x2399a3557af5cf714812a6911908d2fe998030b7b0c31c054a76034bfd6cb8dc" as `0x${string}`;
  const USDC_BRIDGE = "0x219ffbb6a504fcd69ae80d1e70db699b48a9936b" as `0x${string}`;

  const pc = createPublicClient({ chain: sepolia, transport: http(RPC) });
  const head = await pc.getBlockNumber();
  // L1 deposit was ~30 min ago, ~150 blocks
  const fromBlock = head > 300n ? head - 300n : 0n;

  const logs = await pc.getLogs({
    address: USDC_BRIDGE,
    event: parseAbi(["event DepositToAztecPublic(bytes32 indexed to, uint256 amount, bytes32 secretHash, bytes32 key, uint256 index)"])[0],
    args: { to: MAKER },
    fromBlock,
    toBlock: head,
  });

  console.log(`found ${logs.length} USDCBridge deposit log(s) to maker`);
  for (const log of logs.slice(-5)) {
    console.log({
      block: log.blockNumber?.toString(),
      txHash: log.transactionHash,
      amount: log.args.amount?.toString(),
      messageHash: log.args.key,
      messageIndex: log.args.index?.toString(),
    });
  }

  // Now check the LATEST log's messageHash in the L2 tree
  if (logs.length > 0) {
    const latest = logs[logs.length - 1]!;
    const msgHash = latest.args.key!;
    const node = createAztecNodeClient(NODE) as unknown as {
      getL1ToL2MessageMembershipWitness: (b: string, m: Fr) => Promise<unknown | undefined>;
    };
    const w = await node.getL1ToL2MessageMembershipWitness("latest", Fr.fromHexString(msgHash));
    console.log(`\nUSDC deposit messageHash ${msgHash}: ${w === undefined ? "NOT IN TREE" : "IN TREE ✓"}`);
  }
}
main().catch(e => { console.error(e); process.exit(1); });
