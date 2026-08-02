// sdk/src/wallet/aztec-wallet.ts
import type { Wallet } from "@aztec/aztec.js/wallet";
import type { AztecAddress } from "@aztec/aztec.js/addresses";
import { Fr } from "@aztec/aztec.js/fields";
import type { WalletProvider } from "@aztec/wallet-sdk/manager";
import type { WalletAdapter } from "./adapter.js";
import { ConfigError } from "../errors.js";

const DEFAULT_APP_ID = "quetzal";
const DEFAULT_DISCOVERY_TIMEOUT_MS = 8000;

export interface AztecWalletAdapterOptions {
  /** Aztec node URL — discovery needs ChainInfo (chainId + version) from the node. */
  nodeUrl: string;
  /** dApp identifier announced to wallets during discovery. Defaults to "quetzal". */
  appId?: string;
  /** How long to wait (ms) for a wallet to announce itself before failing. Default 8000. */
  discoveryTimeoutMs?: number;
}

/**
 * Adapter for Aztec browser-extension wallets that speak the official
 * `@aztec/wallet-sdk` discovery protocol (e.g. Celari).
 *
 * Flow: read ChainInfo from the node -> run WalletManager extension discovery ->
 * establish an ECDH-encrypted channel with the first discovered wallet ->
 * `confirm()` to obtain a live aztec.js `Wallet`. Private keys stay inside the
 * extension; the page drives the wallet over the encrypted channel (sendTx /
 * simulateTx / createAuthWit / ...), so no PXE is embedded in the page.
 *
 * MVP: auto-picks the first discovered wallet and confirms directly — the
 * extension shows its own approval UI. dApp-side MITM emoji verification
 * (`PendingConnection.verificationHash`) is deferred.
 *
 * stop() best-effort disconnects the channel; page lifecycle owns it otherwise.
 */
export class AztecWalletAdapter implements WalletAdapter {
  private provider?: WalletProvider;

  constructor(private readonly opts: AztecWalletAdapterOptions) {
    if (!opts.nodeUrl) {
      throw new ConfigError(
        "MISSING_ENV",
        "AztecWalletAdapter requires a nodeUrl to discover wallets",
      );
    }
  }

  async connect() {
    const appId = this.opts.appId ?? DEFAULT_APP_ID;
    const timeout = this.opts.discoveryTimeoutMs ?? DEFAULT_DISCOVERY_TIMEOUT_MS;

    // 1. ChainInfo (chainId + version): discovery filters wallets on it and the
    //    wallet uses it for replay protection when constructing transactions.
    //    These are lightweight node reads (unaffected by L1 fee-oracle limits).
    const { createAztecNodeClient } = await import("@aztec/aztec.js/node");
    const node = createAztecNodeClient(this.opts.nodeUrl) as unknown as {
      getChainId(): Promise<number>;
      getVersion(): Promise<number>;
    };
    const [chainId, version] = await Promise.all([node.getChainId(), node.getVersion()]);
    const chainInfo = { chainId: new Fr(chainId), version: new Fr(version) };

    // 2. Discover extension wallets; take the first that announces itself.
    const { WalletManager } = await import("@aztec/wallet-sdk/manager");
    const session = WalletManager.configure({ extensions: { enabled: true } }).getAvailableWallets(
      { chainInfo, appId, timeout },
    );

    let provider: WalletProvider | undefined;
    for await (const discovered of session.wallets) {
      provider = discovered;
      break; // MVP: first wallet wins
    }
    session.cancel();

    if (!provider) {
      throw new ConfigError(
        "MISSING_ENV",
        "No Aztec wallet detected. Install and unlock a wallet extension (e.g. Celari), then retry.",
      );
    }
    this.provider = provider;

    // 3. ECDH key-exchange -> encrypted channel -> confirm. The extension shows
    //    its own approval popup; dApp-side emoji verification is deferred (MVP).
    const pending = await provider.establishSecureChannel(appId);
    const wallet = (await pending.confirm()) as Wallet;

    // 4. Address = first account. Wallet.getAccounts() -> Aliased<AztecAddress>[]
    //    where the address is the `.item` field (NOT `.address`).
    const accounts = await wallet.getAccounts();
    if (!accounts.length) {
      throw new ConfigError("MISSING_ENV", "Connected Aztec wallet exposes no accounts");
    }
    const address = accounts[0].item as AztecAddress;

    return { wallet, address };
  }

  async stop() {
    // Best-effort teardown of the encrypted channel. Page lifecycle owns it.
    try {
      await this.provider?.disconnect();
    } catch {
      /* ignore — disconnect is best-effort */
    }
  }
}
