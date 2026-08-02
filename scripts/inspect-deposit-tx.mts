import { createPublicClient, http, parseAbi, decodeEventLog } from "viem";
import { sepolia } from "viem/chains";

async function main() {
  const pc = createPublicClient({ chain: sepolia, transport: http(process.env.L1_RPC_URL!) });
  const receipt = await pc.getTransactionReceipt({
    hash: "0x7e776a69fa0cdc66131ef3d9aac9c55eb25fe3e81e0d2e38ee8be5b9739e1ac5",
  });
  console.log(`tx block=${receipt.blockNumber} status=${receipt.status} logs=${receipt.logs.length}`);
  for (const log of receipt.logs) {
    console.log(`  addr=${log.address} topic0=${log.topics[0]}`);
    try {
      const decoded = decodeEventLog({
        abi: parseAbi([
          "event DepositToAztecPublic(bytes32 indexed to, uint256 amount, bytes32 secretHash, bytes32 key, uint256 index)",
        ]),
        topics: log.topics as [`0x${string}`, ...`0x${string}`[]],
        data: log.data,
      });
      console.log(`    DECODED:`, JSON.stringify(decoded, (_k, v) => typeof v === "bigint" ? v.toString() : v));
    } catch {}
  }
}
main().catch(e => { console.error(e); process.exit(1); });
