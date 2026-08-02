import { getInitialTestAccountsData } from "@aztec/accounts/testing";
import { EmbeddedWallet } from "@aztec/wallets/embedded";
import { registerInitialLocalNetworkAccountsInWallet } from "@aztec/wallets/testing";
import type { AztecAddress } from "@aztec/aztec.js/addresses";
import type { AztecNode } from "@aztec/aztec.js/node";

/**
 * A fully-set-up tenant: the in-process PXE-backed wallet and the addresses
 * of the local-network's pre-funded Schnorr test accounts (already deployed
 * on-chain by `aztec start --local-network`). Use any of these addresses as
 * a `from` for sending transactions.
 */
export interface TestEnv {
  wallet: EmbeddedWallet;
  accounts: AztecAddress[];
}

/**
 * Create an ephemeral EmbeddedWallet connected to the running Aztec node and
 * register the local-network's initial test accounts. Asserts at least `min`
 * accounts are available.
 *
 * In v4.x the "PXE" is no longer a separate JSON-RPC service — the wallet
 * spins one up in-process. The Aztec node JSON-RPC endpoint at PXE_URL is the
 * actual L2 we connect to.
 */
export async function getTestWallets(node: AztecNode, min = 2): Promise<TestEnv> {
  const wallet = await EmbeddedWallet.create(node, {
    ephemeral: true,
    pxe: { proverEnabled: false },
  });

  const accounts = await registerInitialLocalNetworkAccountsInWallet(wallet);
  if (accounts.length < min) {
    throw new Error(`expected at least ${min} test accounts, got ${accounts.length}`);
  }
  return { wallet, accounts };
}

/**
 * Lower-level escape hatch: the raw seed data for the local-network's initial
 * test accounts (secret keys, salts, signing keys, addresses). Useful when
 * driving the wallet through a different code path.
 */
export async function getInitialAccountsData() {
  return await getInitialTestAccountsData();
}
