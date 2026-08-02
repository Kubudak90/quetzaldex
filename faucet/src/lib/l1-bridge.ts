// Sub-7a Task 11: L1 → L2 fee-juice bridge wrapper.
//
// Bridges fee-juice on the Aztec testnet's L1 (Sepolia) via the canonical
// L1FeeJuicePortalManager from @aztec/aztec.js. Returns claim data shaped
// to match the WalletBootstrapState.claimData consumed by
// scripts/lib/aztec-wallet-bootstrap.ts (FeeJuicePaymentMethodWithClaim).
//
// ── Deviations from Task 11 plan's starting-point implementation ──────────
//
// 1. **Use the SDK manager, not a hand-rolled ABI.** The plan suggested an
//    inline FEE_JUICE_PORTAL_ABI with `bridgeTokensPublic`. Live reality:
//      - The L1 function is named `depositToAztecPublic`, not
//        `bridgeTokensPublic` (verified against the FeeJuicePortalAbi shipped
//        in @aztec/l1-artifacts@4.2.1 and against Aztec's own
//        ethereum/portal_manager.ts).
//      - Solidity write-function return values do NOT survive a JSON-RPC
//        call, so the plan's `simulateContract.result` extraction would fail
//        at runtime; (messageHash, leafIndex) must be parsed from the
//        DepositToAztecPublic event log.
//      - The portal pulls the ERC20, so an `approve(tokenAddress, portal, amt)`
//        is required before depositing.
//    All of these are handled correctly inside L1FeeJuicePortalManager
//    (NethermindEth/aztec-faucet/src/lib/l2-faucet.ts uses the same pattern).
//
// 2. **secret hash = poseidon2 (computeSecretHash), NOT sha256ToField.**
//    The plan used sha256ToField, but the L2 FeeJuice contract's
//    claim_and_end_setup rehashes the secret with poseidon2 to verify the
//    L1 → L2 message. The canonical helper is computeSecretHash from
//    @aztec/stdlib/hash. Because it's async (poseidon2 needs the wasm
//    backend), computeClaimSecretHash is async.
//
// 3. **No hard-coded sepolia chain.** createEthereumChain handles foundry
//    (devnet) too, and forwards the chainId from config so we don't need
//    to maintain a switch.
//
// 4. **Portal/token addresses auto-discovered.** L1FeeJuicePortalManager.new
//    pulls feeJuicePortalAddress + feeJuiceAddress from node.getNodeInfo();
//    we don't accept them in the constructor any more (still log/echo via
//    env for ops visibility — see FAUCET_L1_FEE_JUICE_PORTAL in .env.example).

import { L1FeeJuicePortalManager } from "@aztec/aztec.js/ethereum";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { Fr } from "@aztec/aztec.js/fields";
import { createAztecNodeClient } from "@aztec/aztec.js/node";
import { createLogger } from "@aztec/aztec.js/log";
import { computeSecretHash } from "@aztec/stdlib/hash";
import { createExtendedL1Client } from "@aztec/ethereum/client";
import { createEthereumChain } from "@aztec/ethereum/chain";
import { privateKeyToAccount } from "viem/accounts";
import {
  createPublicClient,
  http,
  parseAbiItem,
  type Chain,
  type Hex,
} from "viem";
import { sepolia, foundry } from "viem/chains";

const log = createLogger("faucet:l1-bridge");

// ── Unit-testable helpers ──────────────────────────────────────────────────

/**
 * Generate a fresh L1 → L2 claim secret as a bn254-bounded field element.
 * Returned hex matches the shape persisted in
 * WalletBootstrapState.claimData.claimSecretHex.
 */
export function generateClaimSecret(): `0x${string}` {
  return Fr.random().toString() as `0x${string}`;
}

/**
 * Hash a claim secret with poseidon2 (DomainSeparator.SECRET_HASH).
 * Async because the poseidon2 backend is wasm-loaded.
 */
export async function computeClaimSecretHash(
  secretHex: `0x${string}`,
): Promise<`0x${string}`> {
  const secretFr = Fr.fromString(secretHex);
  const hash = await computeSecretHash(secretFr);
  return hash.toString() as `0x${string}`;
}

// ── Bridge wrapper ────────────────────────────────────────────────────────

export interface BridgeFeeJuiceResult {
  l1TxHash: `0x${string}` | undefined;
  messageHashHex: `0x${string}`;
  messageLeafIndex: bigint;
  claimSecretHex: `0x${string}`;
  claimSecretHashHex: `0x${string}`;
  claimAmount: bigint;
}

export interface L1BridgeConfig {
  /** L1 (Sepolia for Aztec testnet) JSON-RPC URL. */
  rpcUrl: string;
  /** Hex private key for the faucet wallet on L1. */
  privateKey: `0x${string}`;
  /** L1 chain id — 11155111 (Sepolia) or 31337 (anvil/foundry). */
  chainId: number;
  /** Aztec node URL — used to auto-discover the FeeJuicePortal address. */
  aztecNodeUrl: string;
}

export class L1Bridge {
  // Cached lazily — node info + portal addresses are immutable per faucet run.
  private readonly aztecNode: ReturnType<typeof createAztecNodeClient>;
  private _l1Client: ReturnType<typeof createExtendedL1Client> | null = null;
  private _portalManager: Promise<L1FeeJuicePortalManager> | null = null;

  // Task #376: serialise bridgeFeeJuice across parallel callers so the
  // shared viem WalletClient never sees two in-flight depositToAztecPublic
  // submissions racing on the same fresh nonce. The chain head always
  // settles to `undefined` (via .then(noop, noop) below) so a failing
  // bridge call doesn't poison the queue for the next caller.
  private _bridgeChain: Promise<unknown> = Promise.resolve();

  constructor(private readonly config: L1BridgeConfig) {
    this.aztecNode = createAztecNodeClient(config.aztecNodeUrl);
  }

  private getL1Client(): ReturnType<typeof createExtendedL1Client> {
    if (!this._l1Client) {
      const account = privateKeyToAccount(this.config.privateKey);
      const chain = createEthereumChain([this.config.rpcUrl], this.config.chainId);
      // @aztec/ethereum bundles its own viem; the PrivateKeyAccount types are
      // structurally identical but TypeScript can't unify the two copies
      // (different nested NonceManager.consume signatures). Runtime is fine.
      // Same workaround used by Nethermind's faucet.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      this._l1Client = createExtendedL1Client([this.config.rpcUrl], account as any, chain.chainInfo);
    }
    return this._l1Client;
  }

  private getPortalManager(): Promise<L1FeeJuicePortalManager> {
    if (!this._portalManager) {
      this._portalManager = L1FeeJuicePortalManager.new(
        this.aztecNode,
        this.getL1Client(),
        log,
      ).catch((err) => {
        // Don't cache failures — allow retry on next call
        this._portalManager = null;
        throw err;
      });
    }
    return this._portalManager;
  }

  /** Native ETH balance of the faucet wallet on L1 — for drain detection. */
  async getEthBalance(): Promise<bigint> {
    const address = privateKeyToAccount(this.config.privateKey).address;
    const chain = this.viemChain();
    const publicClient = createPublicClient({ chain, transport: http(this.config.rpcUrl) });
    return publicClient.getBalance({ address });
  }

  /**
   * ERC20 fee-juice balance of the faucet wallet on L1 — for drain detection.
   * Auto-discovers the L1 fee-juice token address from the Aztec node.
   * Returns null on lookup failure (non-critical — caller can still attempt bridges).
   */
  async getFeeJuiceBalance(): Promise<bigint | null> {
    try {
      const nodeInfo = await this.aztecNode.getNodeInfo();
      const tokenAddress = nodeInfo.l1ContractAddresses.feeJuiceAddress.toString() as Hex;
      const owner = privateKeyToAccount(this.config.privateKey).address;
      const chain = this.viemChain();
      const publicClient = createPublicClient({ chain, transport: http(this.config.rpcUrl) });
      return (await publicClient.readContract({
        address: tokenAddress,
        abi: [parseAbiItem("function balanceOf(address) view returns (uint256)")],
        functionName: "balanceOf",
        args: [owner],
      })) as bigint;
    } catch (err) {
      log.error(`[l1-bridge] getFeeJuiceBalance failed: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  /**
   * Bridge fee-juice from L1 to L2 for `recipient`, amount `amount` (atomic
   * fee-juice units). Performs ERC20 approve + depositToAztecPublic +
   * waits for the L1 receipt, then extracts (messageHash, leafIndex) from
   * the DepositToAztecPublic event log.
   *
   * Returns claim data sufficient for FeeJuicePaymentMethodWithClaim on L2.
   * Looks up the L1 tx hash by matching the event's `key` field; on lookup
   * failure the bridge still succeeds (the L1 tx mined) but l1TxHash is
   * undefined.
   */
  async bridgeFeeJuice(
    recipient: `0x${string}`,
    amount: bigint,
  ): Promise<BridgeFeeJuiceResult> {
    // ── Task #376: serial mutex around the body ─────────────────────────
    // Two parallel /api/drip requests previously shared one viem
    // WalletClient and fetched the same fresh nonce, producing 503
    // "Nonce provided lower than current" on the second submit. Chain
    // this work onto _bridgeChain so callers run one-at-a-time. The chain
    // head is rewritten to always settle to `undefined` so a failing
    // bridge doesn't poison subsequent callers — the rejection only
    // propagates through `ours` to this call's caller.
    const run = async (): Promise<BridgeFeeJuiceResult> => {
      const recipientAddr = AztecAddress.fromStringUnsafe(recipient);
      const portalManager = await this.getPortalManager();
      const l1Client = this.getL1Client();

      // Capture pre-block so the post-call event-log search has a tight window.
      let preBlock: bigint | undefined;
      try {
        preBlock = await l1Client.getBlockNumber();
      } catch {
        // Non-critical — fall back to a wider lookback window below.
      }

      // `mint=false` → use the faucet's pre-funded L1 fee-juice balance.
      // (testnet's open mint handler isn't used here.)
      const claim = await portalManager.bridgeTokensPublic(recipientAddr, amount, false);

      // Look up the L1 tx hash via the DepositToAztecPublic event log, matched
      // by messageHash (the `key` field). Non-critical — proceed without it on
      // failure.
      let l1TxHash: `0x${string}` | undefined;
      try {
        const nodeInfo = await this.aztecNode.getNodeInfo();
        const portalAddr = nodeInfo.l1ContractAddresses.feeJuicePortalAddress.toString() as Hex;
        const postBlock = await l1Client.getBlockNumber();
        const fromBlock = preBlock ?? (postBlock > 10n ? postBlock - 10n : 0n);
        const logs = await l1Client.getLogs({
          address: portalAddr,
          event: parseAbiItem(
            "event DepositToAztecPublic(bytes32 indexed to, uint256 amount, bytes32 secretHash, bytes32 key, uint256 index)",
          ),
          fromBlock,
          toBlock: postBlock + 1n,
        });
        const match = logs.find(
          (l) => l.args.key?.toLowerCase() === claim.messageHash.toLowerCase(),
        );
        l1TxHash = match?.transactionHash as `0x${string}` | undefined;
      } catch (err) {
        log.error(`[l1-bridge] L1 tx hash lookup failed: ${err instanceof Error ? err.message : String(err)}`);
      }

      return {
        l1TxHash,
        messageHashHex: claim.messageHash as `0x${string}`,
        messageLeafIndex: claim.messageLeafIndex,
        claimSecretHex: claim.claimSecret.toString() as `0x${string}`,
        claimSecretHashHex: claim.claimSecretHash.toString() as `0x${string}`,
        claimAmount: claim.claimAmount,
      };
    };

    // Wait for any prior bridge to settle (success OR failure), then run ours.
    const ours = this._bridgeChain.then(() => run(), () => run());
    // Replace the chain head with our promise — but swallow its result for
    // the chain so the NEXT caller doesn't see our throw.
    this._bridgeChain = ours.then(
      () => undefined,
      () => undefined,
    );
    return ours;
  }

  private viemChain(): Chain {
    const map: Record<number, Chain> = { [sepolia.id]: sepolia, [foundry.id]: foundry };
    return (
      map[this.config.chainId] ?? {
        id: this.config.chainId,
        name: `Chain ${this.config.chainId}`,
        nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
        rpcUrls: { default: { http: [this.config.rpcUrl] } },
      }
    );
  }
}
