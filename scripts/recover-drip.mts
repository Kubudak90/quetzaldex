import { createPublicClient, http, parseAbi } from "viem";
import { sepolia } from "viem/chains";
import { createAztecNodeClient } from "@aztec/aztec.js/node";

async function main() {
  const RPC = process.env.L1_RPC_URL!;
  const NODE = process.env.AZTEC_NODE_URL!;
  const MAKER = "0x2399a3557af5cf714812a6911908d2fe998030b7b0c31c054a76034bfd6cb8dc" as `0x${string}`;

  const node = createAztecNodeClient(NODE);
  const info = await node.getNodeInfo();
  const portal = info.l1ContractAddresses.feeJuicePortalAddress.toString() as `0x${string}`;
  console.log("fee juice portal:", portal);

  const pc = createPublicClient({ chain: sepolia, transport: http(RPC) });
  const head = await pc.getBlockNumber();
  const fromBlock = head > 200n ? head - 200n : 0n;
  console.log(`scanning Sepolia blocks ${fromBlock}..${head} for DepositToAztecPublic at portal`);

  const logs = await pc.getLogs({
    address: portal,
    event: parseAbi(["event DepositToAztecPublic(bytes32 indexed to, uint256 amount, bytes32 secretHash, bytes32 key, uint256 index)"])[0],
    args: { to: MAKER },
    fromBlock,
    toBlock: head,
  });

  console.log(`found ${logs.length} matching log(s)`);
  for (const log of logs.slice(-3)) {
    console.log(JSON.stringify({
      block: log.blockNumber?.toString(),
      txHash: log.transactionHash,
      to: log.args.to,
      amount: log.args.amount?.toString(),
      secretHash: log.args.secretHash,
      messageHash: log.args.key,
      messageIndex: log.args.index?.toString(),
    }, null, 2));
  }
}
main().catch(e => { console.error(e); process.exit(1); });
