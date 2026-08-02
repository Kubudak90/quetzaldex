// Browser-side claim + deploy of a child schnorr account using the L1→L2
// fee-juice claim returned by Sub-7a faucet. Mirrors
// scripts/lib/aztec-wallet-bootstrap.ts:bootstrapAztecWallet step 4 but in
// the browser PXE.
import { Fr } from "@aztec/aztec.js/fields";
import { deriveMasterMessageSigningSecretKey } from "@aztec/stdlib/keys";
import { createAztecNodeClient, waitForNode } from "@aztec/aztec.js/node";
import { EmbeddedWallet } from "@aztec/wallets/embedded";
import { FeeJuicePaymentMethodWithClaim } from "@aztec/aztec.js/fee";
import { NO_FROM } from "@aztec/aztec.js/account";
import type { ClaimData } from "./faucet-client";

export const CLAIM_DEPLOY_PHASES = [
  "claiming",
  "proving",
  "sending",
  "waiting",
  "done",
] as const;

export type ClaimDeployPhase = (typeof CLAIM_DEPLOY_PHASES)[number];

export interface ClaimDeployOpts {
  nodeUrl: string;
  childSecretHex: `0x${string}`;
  claimData: ClaimData;
  signal?: AbortSignal;
  onProgress?: (phase: ClaimDeployPhase) => void;
  /** Max wall time (ms) for the L1→L2 message wait + deploy. Default 30 min. */
  timeoutMs?: number;
}

export interface ClaimDeployResult {
  deployTxHash: string;
  deployedAddress: `0x${string}`;
}

export async function claimAndDeploy(opts: ClaimDeployOpts): Promise<ClaimDeployResult> {
  const timeoutMs = opts.timeoutMs ?? 30 * 60 * 1000;
  const startedAt = Date.now();

  opts.onProgress?.("claiming");

  const node = createAztecNodeClient(opts.nodeUrl);
  await waitForNode(node);

  const wallet = await EmbeddedWallet.create(node, {
    ephemeral: true,
    pxe: { proverEnabled: true },
  });

  try {
    const accountManager = await wallet.createSchnorrAccount(
      Fr.fromString(opts.childSecretHex),
      Fr.ZERO,
      // 5.0.0: explicit signing key; derive deterministically so the same
      // secret always resolves to the same L2 address (rc.2's implicit default).
      deriveMasterMessageSigningSecretKey(Fr.fromString(opts.childSecretHex)),
    );
    const address = (await accountManager.getAccount()).getAddress();

    const claim = {
      claimAmount: BigInt(opts.claimData.claimAmount),
      claimSecret: Fr.fromString(opts.claimData.claimSecretHex),
      messageLeafIndex: BigInt(opts.claimData.messageLeafIndex),
    };
    const paymentMethod = new FeeJuicePaymentMethodWithClaim(address, claim);

    // Retry loop — L1→L2 message may not be in the tree yet. Each retry boots a
    // fresh deploy attempt; on retryable errors, sleep 30s and try again.
    let lastErr: unknown;
    while (Date.now() - startedAt < timeoutMs) {
      if (opts.signal?.aborted) throw new DOMException("aborted", "AbortError");
      try {
        opts.onProgress?.("proving");
        const deployMethod = await accountManager.getDeployMethod();
        opts.onProgress?.("sending");
        const sent = await deployMethod.send({ fee: { paymentMethod }, from: NO_FROM });
        opts.onProgress?.("waiting");
        const result = sent as unknown as { receipt: { txHash: { toString(): string } } };
        const deployTxHash = result.receipt.txHash.toString();
        opts.onProgress?.("done");
        return {
          deployTxHash,
          deployedAddress: address.toString() as `0x${string}`,
        };
      } catch (e) {
        lastErr = e;
        const msg = e instanceof Error ? e.message : String(e);
        if (!/L1.*L2|message|tree|membership|claim|not.*ready|Timeout|Insufficient/i.test(msg)) {
          throw e;
        }
        await new Promise((resolve, reject) => {
          const t = setTimeout(resolve, 30_000);
          opts.signal?.addEventListener("abort", () => {
            clearTimeout(t);
            reject(new DOMException("aborted", "AbortError"));
          }, { once: true });
        });
      }
    }
    throw new Error(`claimAndDeploy: timed out after ${timeoutMs}ms; last error: ${(lastErr as Error)?.message ?? lastErr}`);
  } finally {
    await wallet.stop();
  }
}
