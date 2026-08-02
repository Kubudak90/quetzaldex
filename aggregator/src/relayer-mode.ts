import { setTimeout as sleep } from "node:timers/promises";
import {
  createPublicClient,
  createWalletClient,
  http,
  type Hex,
  type Address,
} from "viem";
import { mainnet, sepolia } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { buildOutboxProof, type OutboxProof } from "../../cli/src/bridge-helpers.js";
import { loadConfig } from "../../cli/src/config.js";
import { TreasuryContract } from "../../tests/integration/generated/Treasury.js";
import { openCli } from "../../cli/src/wallet.js";
import { AztecAddress } from "@aztec/aztec.js/addresses";

const TOKEN_BRIDGE_WITHDRAW_ABI = [
  {
    name: "withdraw",
    inputs: [
      { name: "amount", type: "uint256" },
      { name: "recipient", type: "address" },
      { name: "l2Epoch", type: "uint256" },
      { name: "numCheckpointsInEpoch", type: "uint256" },
      { name: "leafIndex", type: "uint256" },
      { name: "siblingPath", type: "bytes32[]" },
      { name: "l2Sender", type: "bytes32" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    name: "withdrawPrivate",
    inputs: [
      { name: "amount", type: "uint256" },
      { name: "recipient", type: "address" },
      { name: "l2Epoch", type: "uint256" },
      { name: "numCheckpointsInEpoch", type: "uint256" },
      { name: "leafIndex", type: "uint256" },
      { name: "siblingPath", type: "bytes32[]" },
      { name: "l2Sender", type: "bytes32" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
] as const;

export interface RelayerConfig {
  /** Aztec node RPC URL (read Treasury queue + build outbox proofs) */
  aztecNodeUrl: string;
  /** L1 RPC URL for viem writeContract calls */
  l1RpcUrl: string;
  /** Relayer's L1 private key for withdraw tx submission */
  l1PrivateKey: Hex;
  /** L2 Treasury contract address */
  treasuryAddr: string;
  /** Map: L1 bridge address (lowercased) → token identifier */
  bridgesByAddress: Record<string, "USDC" | "WETH" | "wBTC">;
  /** L22/v5: map L1 bridge address (lowercased) → L2 token address (bytes32)
   *  that emitted the exit; forwarded as the withdraw call's l2Sender. */
  l2SendersByBridge: Record<string, string>;
  /** Aztec account index in the wallet (for simulating treasury reads) */
  accountIndex?: number;
}

interface PendingClaim {
  id: bigint;
  l2TxHash: string;
  expectedContent: string;
  l1Recipient: string;
  amount: bigint;
  fee: bigint;
  bridgeAddr: string;
  isPrivate: boolean;
}

/**
 * Sub-5c D2: relayer daemon loop.
 *
 * Polls Treasury.pending_relayer_claims every 60s. For each claim:
 *   1. Build L2→L1 outbox proof via the subprocess binary (A3)
 *   2. Submit L1 TokenBridge.withdraw[Private] via viem
 *   3. Consume the claim on L2 → Treasury pays the fee out of tracked_balance
 *
 * Anyone can call consume_relayer_claim; the L1 withdraw is the gating step
 * (only succeeds once per (epoch, leafIndex) due to Outbox replay guard).
 * First relayer to land the L1 tx wins the fee.
 *
 * Activation: set RELAYER_MODE=1 + L1_RPC_URL + L1_PRIVATE_KEY env vars
 * before starting the aggregator daemon.
 */
export async function runRelayerLoop(cfg: RelayerConfig): Promise<void> {
  console.log("relayer-mode: starting loop");
  console.log(`  aztec node: ${cfg.aztecNodeUrl}`);
  console.log(`  l1 rpc:     ${cfg.l1RpcUrl}`);
  console.log(`  treasury:   ${cfg.treasuryAddr}`);

  const chain = cfg.l1RpcUrl.includes("sepolia") ? sepolia : mainnet;
  const relayerAccount = privateKeyToAccount(cfg.l1PrivateKey);
  const walletClient = createWalletClient({
    chain,
    transport: http(cfg.l1RpcUrl),
    account: relayerAccount,
  });
  const publicClient = createPublicClient({
    chain,
    transport: http(cfg.l1RpcUrl),
  });

  // Open Aztec L2 connection (for Treasury simulate calls)
  const fullConfig = loadConfig();
  const ctx = await openCli(fullConfig, cfg.accountIndex ?? 0);

  try {
    while (true) {
      try {
        const queue = await fetchPendingClaims(ctx, cfg.treasuryAddr);
        if (queue.length > 0) {
          console.log(`relayer-mode: ${queue.length} pending claim(s)`);
        }
        for (const claim of queue) {
          try {
            await processClaim(claim, cfg, publicClient, walletClient, ctx);
          } catch (e) {
            console.error(
              `relayer-mode: claim ${claim.id} failed:`,
              e instanceof Error ? e.message : String(e),
            );
            // Don't break the outer loop on one claim failure
          }
        }
      } catch (e) {
        console.error(
          "relayer-mode: poll iteration failed:",
          e instanceof Error ? e.message : String(e),
        );
      }
      await sleep(60_000);
    }
  } finally {
    await ctx.client.stop();
  }
}

async function fetchPendingClaims(
  ctx: Awaited<ReturnType<typeof openCli>>,
  treasuryAddr: string,
): Promise<PendingClaim[]> {
  const treasury = await TreasuryContract.at(
    AztecAddress.fromStringUnsafe(treasuryAddr),
    ctx.client.wallet,
  );

  // Cast through any: D1/D2 added queue_relayer_claim + consume_relayer_claim +
  // get_pending_relayer_claims_count + get_pending_relayer_claim_at but codegen
  // bindings have not been regenerated yet (Treasury.ts still reflects pre-D1).
  const treasuryDyn = treasury as unknown as {
    methods: {
      get_pending_relayer_claims_count: () => { simulate: () => Promise<bigint> };
      get_pending_relayer_claim_at: (index: number) => {
        simulate: () => Promise<{
          id: bigint;
          l2_tx_hash: bigint;
          expected_content: bigint;
          l1_recipient: { inner: bigint } | bigint;
          amount: bigint;
          fee: bigint;
          requested_at_block: number;
        }>;
      };
    };
  };

  const count = await treasuryDyn.methods.get_pending_relayer_claims_count().simulate();
  if (count === 0n) return [];

  const claims: PendingClaim[] = [];
  for (let i = 0n; i < count; i++) {
    try {
      const raw = await treasuryDyn.methods
        .get_pending_relayer_claim_at(Number(i))
        .simulate();

      // EthAddress is serialised as { inner: bigint } by the ABI codec; fall
      // back to treating the value itself as a bigint if the wrapper is absent.
      const recipientBigInt =
        typeof (raw.l1_recipient as { inner?: bigint }).inner === "bigint"
          ? (raw.l1_recipient as { inner: bigint }).inner
          : (raw.l1_recipient as unknown as bigint);

      claims.push({
        id: BigInt(raw.id),
        l2TxHash:
          "0x" + BigInt(raw.l2_tx_hash).toString(16).padStart(64, "0"),
        expectedContent:
          "0x" + BigInt(raw.expected_content).toString(16).padStart(64, "0"),
        l1Recipient:
          "0x" + recipientBigInt.toString(16).padStart(40, "0"),
        amount: BigInt(raw.amount),
        fee: BigInt(raw.fee),
        // bridgeAddr is not bound in the on-chain RelayerClaim struct.
        // Sub-5d follow-up: extend RelayerClaim to include the L1 portal
        // address OR resolve via content-tag heuristic in the maker CLI (D3).
        bridgeAddr: "",
        isPrivate: false,
      });
    } catch (e) {
      console.error(
        `fetchPendingClaims: slot ${i} read failed:`,
        e instanceof Error ? e.message : String(e),
      );
    }
  }
  return claims;
}

async function processClaim(
  claim: PendingClaim,
  cfg: RelayerConfig,
  publicClient: ReturnType<typeof createPublicClient>,
  walletClient: ReturnType<typeof createWalletClient>,
  ctx: Awaited<ReturnType<typeof openCli>>,
): Promise<void> {
  // Guard: bridgeAddr is not bound in the on-chain RelayerClaim struct.
  // Until Sub-5d extends RelayerClaim (or the maker CLI encodes the L1 portal
  // address) we cannot submit the L1 withdraw — log and skip.
  if (!claim.bridgeAddr) {
    console.warn(
      `  claim ${claim.id}: bridgeAddr unresolved (Treasury claim doesn't bind L1 portal). ` +
        `Sub-5d follow-up: extend RelayerClaim to include bridgeAddr OR use content-tag heuristic.`,
    );
    return;
  }

  // L22/v5: resolve which L2 token emitted this exit (withdraw's l2Sender arg).
  const l2Sender = cfg.l2SendersByBridge[claim.bridgeAddr.toLowerCase()];
  if (!l2Sender) {
    console.warn(
      `  claim ${claim.id}: no L2 token configured for bridge ${claim.bridgeAddr}; skipping`,
    );
    return;
  }

  // 1. Build outbox proof via the subprocess binary
  let proof: OutboxProof;
  try {
    proof = await buildOutboxProof(
      cfg.aztecNodeUrl,
      claim.l2TxHash,
      claim.expectedContent,
      cfg.l1RpcUrl,
      l2Sender,
      claim.bridgeAddr,
    );
  } catch (e) {
    console.error(
      `  claim ${claim.id}: proof build failed:`,
      e instanceof Error ? e.message : String(e),
    );
    return;
  }

  // 2. Submit L1 withdraw or withdrawPrivate
  const functionName = claim.isPrivate ? "withdrawPrivate" : "withdraw";
  console.log(
    `  claim ${claim.id}: submitting L1 ${functionName} to ${claim.bridgeAddr}`,
  );

  const txHash = await (walletClient as ReturnType<typeof createWalletClient> & {
    writeContract: (args: unknown) => Promise<Hex>;
  }).writeContract({
    address: claim.bridgeAddr as Address,
    abi: TOKEN_BRIDGE_WITHDRAW_ABI,
    functionName,
    args: [
      claim.amount,
      claim.l1Recipient as Address,
      proof.l2Epoch,
      proof.numCheckpointsInEpoch,
      proof.leafIndex,
      proof.siblingPath as readonly Hex[],
      l2Sender as Hex,
    ],
  } as any);

  // Wait for L1 inclusion
  await publicClient.waitForTransactionReceipt({ hash: txHash });
  console.log(`  claim ${claim.id}: L1 ${functionName} mined at ${txHash}`);

  // 3. Consume the claim on L2 (Treasury pays the fee to this relayer)
  const treasury = await TreasuryContract.at(
    AztecAddress.fromStringUnsafe(cfg.treasuryAddr),
    ctx.client.wallet,
  );
  const treasuryDyn = treasury as unknown as {
    methods: {
      consume_relayer_claim: (id: bigint) => {
        send: (args: { from: AztecAddress }) => Promise<unknown>;
      };
    };
  };
  await treasuryDyn.methods.consume_relayer_claim(claim.id).send({ from: ctx.client.address });
  console.log(
    `  claim ${claim.id}: consumed; fee ${claim.fee} paid to relayer`,
  );
}
