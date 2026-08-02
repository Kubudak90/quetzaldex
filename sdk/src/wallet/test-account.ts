// sdk/src/wallet/test-account.ts
// Mirrors cli/src/wallet.ts:openCli (pre-Sub-6b 2.8) — EmbeddedWallet.create
// against a local-network node, then registerInitialLocalNetworkAccountsInWallet
// and pick account by index.
//
// Server / CLI-only: used for testnet + sandbox flows where the operator does
// not yet have a production-derived Schnorr secret and instead wants one of the
// pre-funded test wallets.

import type { Wallet } from "@aztec/aztec.js/wallet";
import type { AztecAddress } from "@aztec/aztec.js/addresses";
import { createAztecNodeClient, waitForNode } from "@aztec/aztec.js/node";
import { EmbeddedWallet } from "@aztec/wallets/embedded";
import { registerInitialLocalNetworkAccountsInWallet } from "@aztec/wallets/testing";
import type { WalletAdapter } from "./adapter.js";
import { ConfigError } from "../errors.js";

export interface TestAccountAdapterOptions {
  nodeUrl: string;
  accountIndex: number;
}

export class TestAccountAdapter implements WalletAdapter {
  private embeddedWallet: EmbeddedWallet | null = null;

  constructor(private readonly opts: TestAccountAdapterOptions) {
    if (!opts.nodeUrl) {
      throw new ConfigError("MISSING_ENV", "TestAccountAdapter requires a nodeUrl");
    }
    if (
      typeof opts.accountIndex !== "number" ||
      !Number.isInteger(opts.accountIndex) ||
      opts.accountIndex < 0
    ) {
      throw new ConfigError(
        "MISSING_ENV",
        `TestAccountAdapter accountIndex must be a non-negative integer; got ${opts.accountIndex}`,
      );
    }
  }

  async connect(): Promise<{ wallet: Wallet; address: AztecAddress }> {
    const node = createAztecNodeClient(this.opts.nodeUrl);
    await waitForNode(node);
    const wallet = await EmbeddedWallet.create(node, {
      ephemeral: true,
      pxe: { proverEnabled: false },
    });
    const addresses = await registerInitialLocalNetworkAccountsInWallet(wallet);
    const address = addresses[this.opts.accountIndex];
    if (!address) {
      throw new ConfigError(
        "MISSING_ENV",
        `account index ${this.opts.accountIndex} out of range — ${addresses.length} test accounts available`,
      );
    }
    this.embeddedWallet = wallet;
    // EmbeddedWallet itself is the Wallet (sign/send messages dispatch via the
    // PXE backing it); callers pass it to Contract.at(addr, wallet).
    return {
      wallet: wallet as unknown as Wallet,
      address,
    };
  }

  async stop(): Promise<void> {
    if (this.embeddedWallet) {
      const stop = (this.embeddedWallet as unknown as { stop?: () => Promise<void> }).stop;
      if (typeof stop === "function") await stop.call(this.embeddedWallet);
      this.embeddedWallet = null;
    }
  }
}
