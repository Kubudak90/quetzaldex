// Address derivation from a child schnorr secret via Aztec SDK.
// Booting a full EmbeddedWallet for a *pure* address computation is heavyweight;
// however the SDK's deterministic address calculation requires creating the
// account view which needs a node-connected wallet. We accept the boot cost
// (~5-10s per call) — it's amortized across the wizard's N child onboards
// because the EmbeddedWallet caches its node connection per-instance.
//
// In tests, mock this via deps.deriveAddress to skip the boot entirely.
import { Fr } from "@aztec/aztec.js/fields";
import { deriveMasterMessageSigningSecretKey } from "@aztec/stdlib/keys";
import { createAztecNodeClient, waitForNode } from "@aztec/aztec.js/node";
import { EmbeddedWallet } from "@aztec/wallets/embedded";

let cachedWallet: { wallet: EmbeddedWallet; nodeUrl: string } | null = null;

export async function defaultDeriveAddress(
  secret: `0x${string}`,
  nodeUrl: string,
): Promise<`0x${string}`> {
  if (!cachedWallet || cachedWallet.nodeUrl !== nodeUrl) {
    const node = createAztecNodeClient(nodeUrl);
    await waitForNode(node);
    const wallet = await EmbeddedWallet.create(node, {
      ephemeral: true,
      pxe: { proverEnabled: false }, // address derivation doesn't need prover
    });
    cachedWallet = { wallet, nodeUrl };
  }
  const accountManager = await cachedWallet.wallet.createSchnorrAccount(
    Fr.fromString(secret),
    Fr.ZERO,
    // 5.0.0: explicit signing key; derive deterministically so the same secret
    // always resolves to the same L2 address (rc.2's implicit default). MUST
    // match claim-deploy.ts, or the shown address won't be the deployed one.
    deriveMasterMessageSigningSecretKey(Fr.fromString(secret)),
  );
  const address = (await accountManager.getAccount()).getAddress();
  return address.toString() as `0x${string}`;
}
