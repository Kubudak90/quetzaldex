// sdk/src/wallet/pxe.ts
import type { Wallet } from "@aztec/aztec.js/wallet";
import type { AztecAddress } from "@aztec/aztec.js/addresses";
import type { WalletAdapter } from "./adapter.js";

export interface ExternalPxeAdapterOptions {
  /** A pre-connected AccountWallet (or any Wallet) provided by the caller. */
  wallet: Wallet;
  /** The wallet's address. */
  address: AztecAddress;
}

/**
 * Adapter for callers that already hold a connected wallet (e.g. from a test
 * setup, or from a framework that manages the PXE lifecycle externally).
 *
 * stop() is a no-op — the caller owns the wallet lifecycle.
 */
export class ExternalPxeAdapter implements WalletAdapter {
  constructor(private readonly opts: ExternalPxeAdapterOptions) {}

  async connect() {
    return {
      wallet: this.opts.wallet,
      address: this.opts.address,
    };
  }

  async stop() {
    // External PXE — caller manages lifecycle.
  }
}
