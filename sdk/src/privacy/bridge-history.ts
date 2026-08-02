// cli/src/bridge/bridge-history.ts
// Sub-6a C1: L1 DepositInitiated event query via viem getLogs.
//
// Used by Sub-6a C2 (bridge exit pre-check) to detect round-trip-revealing
// patterns: maker deposits X USDC on L1, withdraws X aUSDC back to L1 a few
// days later → observable correlation on Etherscan. The pre-check warns +
// requires --ack-delay to proceed.

import { createPublicClient, http, parseAbiItem, type Address, type Hex } from "viem";
import { mainnet, sepolia } from "viem/chains";

export interface DepositRecord {
  blockNumber: bigint;
  timestamp: number;       // unix seconds
  txHash: Hex;
  bridgeAddr: Address;
  amount: bigint;
  l2Recipient: Hex;        // bytes32; bytes32(0) for private deposits
  isPrivate: boolean;
}

const DEPOSIT_INITIATED_ABI = parseAbiItem(
  "event DepositInitiated(address indexed sender, bytes32 indexed l2Recipient, uint256 amount, bytes32 secretHash, uint256 messageIndex, bool isPrivate)",
);

/**
 * Query L1 for recent DepositInitiated events from `maker` across the listed bridges.
 *
 * @param l1RpcUrl    L1 RPC URL (Sepolia for testnet, mainnet for mainnet)
 * @param bridgeAddrs L1 TokenBridge proxy addresses to scan (USDC + WETH + wBTC)
 * @param maker       Maker's L1 address
 * @param windowDays  How many days back to scan (default 7)
 */
export async function queryRecentDeposits(
  l1RpcUrl: string,
  bridgeAddrs: Address[],
  maker: Address,
  windowDays: number = 7,
): Promise<DepositRecord[]> {
  const chain = l1RpcUrl.includes("sepolia") ? sepolia : mainnet;
  const client = createPublicClient({ chain, transport: http(l1RpcUrl) });

  const now = Math.floor(Date.now() / 1000);
  const fromTs = now - windowDays * 86400;

  // Estimate fromBlock from fromTs (~12s/block both chains)
  const latestBlock = await client.getBlock({ blockTag: "latest" });
  const blocksBack = BigInt(Math.ceil((windowDays * 86400) / 12));
  const fromBlock = latestBlock.number - blocksBack > 0n ? latestBlock.number - blocksBack : 0n;

  const records: DepositRecord[] = [];
  for (const bridge of bridgeAddrs) {
    const logs = await client.getLogs({
      address: bridge,
      event: DEPOSIT_INITIATED_ABI,
      args: { sender: maker },
      fromBlock,
      toBlock: "latest",
    });
    for (const log of logs) {
      const block = await client.getBlock({ blockNumber: log.blockNumber! });
      const ts = Number(block.timestamp);
      if (ts < fromTs) continue;
      records.push({
        blockNumber: log.blockNumber!,
        timestamp: ts,
        txHash: log.transactionHash!,
        bridgeAddr: bridge,
        amount: log.args.amount!,
        l2Recipient: log.args.l2Recipient!,
        isPrivate: log.args.isPrivate!,
      });
    }
  }
  records.sort((a, b) => b.timestamp - a.timestamp);  // newest first
  return records;
}

/**
 * True if `exitAmount` is within ±tolerancePct% of any record's amount.
 * The matched record (or null) is returned so the caller can include the
 * matched deposit details in the warning message.
 */
export function isRoundTripRisk(
  exitAmount: bigint,
  records: DepositRecord[],
  tolerancePct: number = 5,
): { risk: boolean; matched: DepositRecord | null } {
  const tol = BigInt(tolerancePct);
  for (const r of records) {
    const low = (r.amount * (100n - tol)) / 100n;
    const high = (r.amount * (100n + tol)) / 100n;
    if (exitAmount >= low && exitAmount <= high) return { risk: true, matched: r };
  }
  return { risk: false, matched: null };
}
