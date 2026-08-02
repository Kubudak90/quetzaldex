// sdk/src/fees.ts
// Fee-juice management: read an account's L2 fee-juice balance, and redeem an
// L1->L2 fee-juice claim (from the faucet) into that balance.
//
// Each Quetzal wallet self-pays L2 tx fees from its own fee-juice balance (no
// sponsorship — see wallet/pool.ts). Onboarding funds it once via a claim
// redeemed at deploy; this API lets the app show the running balance and
// top it up afterwards, so a wallet that drains mid-session can recover without
// re-onboarding. An order tx costs ~3.4 FJ, so the 100 FJ onboarding claim is
// only ~25-30 orders — hence the need for an in-app refuel.
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { Fr } from "@aztec/aztec.js/fields";
import type { QuetzalClient } from "./client.js";
import type { QuetzalContracts } from "./types.js";
import { ConfigError, OrderError } from "./errors.js";

/**
 * Canonical L2 FeeJuice protocol contract address (ProtocolContractAddress.FeeJuice).
 * Fixed across deployments; its `balances` map lives at storage base slot 1.
 */
const FEE_JUICE_ADDRESS =
  "0x0000000000000000000000000000000000000000000000000000000000000005";
const FEE_JUICE_BALANCES_SLOT = 1n;

/** Minimal node surface we use for raw public-storage reads. */
interface NodeStorageReader {
  getPublicStorageAt(referenceBlock: unknown, contract: AztecAddress, slot: Fr): Promise<Fr>;
}

/** L1->L2 fee-juice claim returned by the faucet's /api/drip (string-encoded). */
export interface FeeJuiceClaim {
  claimAmount: string | bigint;
  claimSecretHex: string;
  messageLeafIndex: string | bigint;
}

function requireContracts(client: QuetzalClient): QuetzalContracts {
  const c = client.config.contracts;
  if (!c) {
    throw new ConfigError(
      "MISSING_ENV",
      "QuetzalClient.config.contracts not set; pass `contracts` to QuetzalClient.connect()",
    );
  }
  return c;
}

export class FeesApi {
  constructor(private client: QuetzalClient) {}

  // Lazily-created node client for raw public-storage reads. getPublicStorageAt
  // lives on the node/PXE interface, not the typed Wallet, so we read via the
  // node directly (cached across calls).
  private _node?: NodeStorageReader;

  private async node(): Promise<NodeStorageReader> {
    if (!this._node) {
      const { createAztecNodeClient } = await import("@aztec/aztec.js/node");
      this._node = createAztecNodeClient(this.client.config.nodeUrl) as unknown as NodeStorageReader;
    }
    return this._node;
  }

  /**
   * Read the L2 fee-juice balance (in fee-juice base units, 1e18 = 1 FJ) for
   * `address` (defaults to the connected account). Reads the FeeJuice contract's
   * public `balances[address]` slot directly via the node — no proof, no fee.
   */
  async getJuiceBalance(address?: string): Promise<bigint> {
    const { deriveStorageSlotInMap } = await import("@aztec/stdlib/hash");
    const addr = address ? AztecAddress.fromStringUnsafe(address) : this.client.address;
    const slot = await deriveStorageSlotInMap(FEE_JUICE_BALANCES_SLOT, addr);
    const node = await this.node();
    const value = await node.getPublicStorageAt(
      "latest",
      AztecAddress.fromStringUnsafe(FEE_JUICE_ADDRESS),
      slot,
    );
    return value.toBigInt();
  }

  /**
   * Redeem a fee-juice claim (from the faucet) into the connected account's
   * fee-juice balance. The claim pays the fee of a tiny no-op carrier tx
   * (`transfer_public_to_public` self->self, 1 unit), which is how Aztec credits
   * the claimed amount minus that tx's fee. Returns the carrier tx hash.
   *
   * The L1->L2 claim message takes ~1-2 min to bridge after the faucet drip, so
   * this retries on the "not yet in the tree" admission error until `timeoutMs`
   * (default 5 min). `onProgress("bridging"|"redeeming")` lets the UI narrate the
   * wait. Throws OrderError if still not redeemable after the timeout.
   */
  async redeemClaim(
    claim: FeeJuiceClaim,
    opts: { timeoutMs?: number; onProgress?: (phase: "bridging" | "redeeming") => void } = {},
  ): Promise<{ txHash: string }> {
    const timeoutMs = opts.timeoutMs ?? 5 * 60 * 1000;
    const contracts = requireContracts(this.client);
    const { FeeJuicePaymentMethodWithClaim } = await import("@aztec/aztec.js/fee");
    const { loadTokenContract } = await import("./internal/contracts.js");
    const TokenContract = await loadTokenContract();
    const token = await TokenContract.at(
      AztecAddress.fromStringUnsafe(contracts.tETH),
      this.client.wallet,
    );
    const paymentMethod = new FeeJuicePaymentMethodWithClaim(this.client.address, {
      claimAmount: BigInt(claim.claimAmount),
      claimSecret: Fr.fromString(claim.claimSecretHex),
      messageLeafIndex: BigInt(claim.messageLeafIndex),
    });

    const startedAt = Date.now();
    let lastErr: unknown;
    while (Date.now() - startedAt < timeoutMs) {
      try {
        opts.onProgress?.("redeeming");
        // aztec.js 4.x `.send({from})` resolves to { receipt, ... } once mined.
        const sendResult = await token.methods
          .transfer_public_to_public(this.client.address, this.client.address, 1n, Fr.ZERO)
          .send({ from: this.client.address, fee: { paymentMethod } });
        const receipt = (sendResult as { receipt?: { txHash?: { toString(): string } } }).receipt;
        return { txHash: receipt?.txHash?.toString() ?? "" };
      } catch (e) {
        lastErr = e;
        const msg = e instanceof Error ? e.message : String(e);
        // Retry only while the L1->L2 message hasn't landed; surface anything else.
        if (!/membership|message|not.*ready|leaf|L1.*L2|claim/i.test(msg)) throw e;
        opts.onProgress?.("bridging");
        await new Promise((r) => setTimeout(r, 25_000));
      }
    }
    throw new OrderError(
      "UNKNOWN",
      "Fee-juice claim didn't become redeemable in time — the L1→L2 bridge message hasn't landed. Try again in a minute.",
      lastErr,
    );
  }
}
