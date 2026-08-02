// Mint Sepolia FeeJuice (L1 ERC20) to an address via the public mint helper.
//
// Discovery (2026-06-10): the operator's original 10,000 FJ came from ten
// sequential calls to `mint(address)` (selector 0x6a627842) on the helper at
// 0x5602c39a… — a PUBLIC minter for Aztec's testnet FeeJuice token
// (0x762c1320…). Each call mints 1,000 FJ to the given address. This script
// repeats that, paying only Sepolia gas.
//
// Usage:
//   set -a; source .env.testnet; set +a; \
//   pnpm tsx scripts/mint-l1-fj.ts [count] [recipient]
//   # defaults: count=10, recipient=the operator (DEPLOYER_PK's address)
//
import { createWalletClient, createPublicClient, http, parseAbi, formatEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";

const HELPER = "0x5602c39a6e9c5ace589f64f754927bcda4f4bfc9" as const;
const FEE_JUICE = "0x762c132040fda6183066fa3b14d985ee55aa3c18" as const;

const L1_RPC = process.env.L1_RPC_URL ?? process.env.SEPOLIA_RPC_URL ?? process.env.FAUCET_L1_RPC_URL ?? "";
const PK = process.env.DEPLOYER_PK ?? process.env.L1_PRIVATE_KEY ?? process.env.FAUCET_L1_PK ?? "";
if (!L1_RPC || !PK) throw new Error("L1_RPC_URL + DEPLOYER_PK (or FAUCET_L1_*) env required");

const COUNT = Math.min(50, Math.max(1, Number(process.argv[2] ?? "10")));
// Cron guard: when MIN_STOCK_FJ is set, only mint if the recipient's balance
// is below it (whole-FJ units). Lets a scheduled job keep the stock topped
// without minting greedily on a shared testnet resource.
const MIN_STOCK_FJ = process.env.MIN_STOCK_FJ ? BigInt(process.env.MIN_STOCK_FJ) * 10n ** 18n : null;

async function main(): Promise<void> {
  const acct = privateKeyToAccount((PK.startsWith("0x") ? PK : `0x${PK}`) as `0x${string}`);
  const recipient = (process.argv[3] ?? acct.address) as `0x${string}`;
  const wc = createWalletClient({ account: acct, chain: sepolia, transport: http(L1_RPC) });
  const pc = createPublicClient({ chain: sepolia, transport: http(L1_RPC) });
  const erc = parseAbi(["function balanceOf(address) view returns (uint256)"]);
  const mintAbi = parseAbi(["function mint(address to)"]);

  const before = await pc.readContract({ address: FEE_JUICE, abi: erc, functionName: "balanceOf", args: [recipient] });
  if (MIN_STOCK_FJ !== null && before >= MIN_STOCK_FJ) {
    console.log(`[mint-fj] stock healthy: ${formatEther(before)} FJ >= floor; nothing to do`);
    return;
  }
  console.log(`[mint-fj] recipient=${recipient} before=${formatEther(before)} FJ; minting ${COUNT} x 1000 FJ ...`);

  let nonce = await pc.getTransactionCount({ address: acct.address });
  const hashes: `0x${string}`[] = [];
  for (let i = 0; i < COUNT; i++) {
    const hash = await wc.writeContract({
      address: HELPER, abi: mintAbi, functionName: "mint", args: [recipient], nonce: nonce++,
    });
    hashes.push(hash);
    console.log(`[mint-fj]   ${i + 1}/${COUNT} sent ${hash}`);
  }
  await pc.waitForTransactionReceipt({ hash: hashes[hashes.length - 1]! });
  const after = await pc.readContract({ address: FEE_JUICE, abi: erc, functionName: "balanceOf", args: [recipient] });
  console.log(`[mint-fj] after=${formatEther(after)} FJ (+${formatEther(after - before)})`);
}

main().catch((e) => { console.error(String(e).slice(0, 400)); process.exit(1); });
