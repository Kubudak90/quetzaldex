// sdk/src/client.ts
import { AztecAddress } from "@aztec/aztec.js/addresses";
import type { Wallet } from "@aztec/aztec.js/wallet";
import type { NetworkName, NetworkConfig, QuetzalContracts } from "./types.js";
import { ConfigError } from "./errors.js";
import { NETWORK_DEFAULTS } from "./config.js";
import type { WalletAdapter } from "./wallet/adapter.js";
import { SchnorrSecretAdapter } from "./wallet/schnorr.js";
import { ExternalPxeAdapter } from "./wallet/pxe.js";
import { AztecWalletAdapter } from "./wallet/aztec-wallet.js";
import { TestAccountAdapter } from "./wallet/test-account.js";
import { OrdersApi } from "./orders.js";
import { BridgeApi } from "./bridge.js";
import { ReadsApi } from "./reads.js";
import { FeesApi } from "./fees.js";
import { AggregatorApi } from "./aggregator.js";
import { PoolsApi } from "./pools.js";

/**
 * Discriminated union covering all supported account types.
 *
 * - "schnorr"      — ephemeral embedded PXE, server-side usage, secret-derived
 * - "test-account" — ephemeral embedded PXE, pre-funded local-network test
 *                    accounts indexed 0..N; used by the CLI + integration tests
 * - "external-pxe" — caller already holds a connected wallet + address
 * - "aztec-wallet" — browser extension discovered via the @aztec/wallet-sdk
 *                    protocol (e.g. Celari); the adapter handles discovery +
 *                    the encrypted channel, so no provider object is passed in
 */
export type AccountSpec =
  | { type: "schnorr"; secret: string; salt?: string; signingKey?: string; proverEnabled?: boolean; dataDirectory?: string }
  | { type: "test-account"; accountIndex: number }
  | { type: "external-pxe"; wallet: Wallet; address: AztecAddress }
  | { type: "aztec-wallet"; appId?: string; discoveryTimeoutMs?: number };

export interface QuetzalClientConnectOptions {
  network: NetworkName;
  nodeUrl?: string;
  account: AccountSpec;
  l1?: NetworkConfig["l1"];
  /** Optional Quetzal deployment metadata; if present, contracts are auto-registered. */
  contracts?: QuetzalContracts;
}

/**
 * Top-level SDK entry point.  Obtain an instance via `QuetzalClient.connect()`.
 *
 * Stores { address, wallet, config, adapter } — no `pxe` field (PXE is not
 * exported from aztec.js 4.2.1 sub-paths; access it through the wallet if needed).
 *
 * After connecting, if `contracts` is present in the config, Quetzal protocol
 * contracts (Orderbook, Token tUSDC/tETH/(tBTC), Pools, AggregatorRegistry,
 * Treasury) are registered against the wallet's PXE so they can be called via
 * `Contract.at(addr, wallet)`.
 */
export class QuetzalClient {
  // API instances are constructed lazily on first access so the SDK entry
  // point's cold-start cost stays low when only a subset is used.
  private _orders?: OrdersApi;
  private _bridge?: BridgeApi;
  private _reads?: ReadsApi;
  private _fees?: FeesApi;
  private _aggregator?: AggregatorApi;
  private _pools?: PoolsApi;

  private constructor(
    public readonly address: AztecAddress,
    public readonly wallet: Wallet,
    public readonly config: NetworkConfig,
    private readonly adapter: WalletAdapter,
  ) {}

  get orders(): OrdersApi {
    if (!this._orders) this._orders = new OrdersApi(this);
    return this._orders;
  }
  get bridge(): BridgeApi {
    if (!this._bridge) this._bridge = new BridgeApi(this);
    return this._bridge;
  }
  get reads(): ReadsApi {
    if (!this._reads) this._reads = new ReadsApi(this);
    return this._reads;
  }
  get fees(): FeesApi {
    if (!this._fees) this._fees = new FeesApi(this);
    return this._fees;
  }
  get aggregator(): AggregatorApi {
    if (!this._aggregator) this._aggregator = new AggregatorApi(this);
    return this._aggregator;
  }
  get pools(): PoolsApi {
    if (!this._pools) this._pools = new PoolsApi(this);
    return this._pools;
  }

  /**
   * Factory: resolves network defaults, validates required fields, spins up
   * the appropriate wallet adapter, and returns a ready-to-use client.
   *
   * @throws {ConfigError} for unknown networks or missing nodeUrl.
   */
  static async connect(opts: QuetzalClientConnectOptions): Promise<QuetzalClient> {
    const defaults = NETWORK_DEFAULTS[opts.network];
    if (!defaults) {
      throw new ConfigError(
        "INVALID_NETWORK",
        `Unknown network: ${opts.network}`,
      );
    }

    const nodeUrl = opts.nodeUrl ?? defaults.nodeUrl;
    if (!nodeUrl) {
      throw new ConfigError(
        "MISSING_ENV",
        `nodeUrl required for network '${opts.network}' (no default configured)`,
      );
    }

    let adapter: WalletAdapter;
    switch (opts.account.type) {
      case "schnorr":
        adapter = new SchnorrSecretAdapter({
          secret: opts.account.secret,
          nodeUrl,
          salt: opts.account.salt,
          signingKey: opts.account.signingKey,
          proverEnabled: opts.account.proverEnabled,
          dataDirectory: opts.account.dataDirectory,
        });
        break;
      case "test-account":
        adapter = new TestAccountAdapter({
          accountIndex: opts.account.accountIndex,
          nodeUrl,
        });
        break;
      case "external-pxe":
        adapter = new ExternalPxeAdapter({
          wallet: opts.account.wallet,
          address: opts.account.address,
        });
        break;
      case "aztec-wallet":
        adapter = new AztecWalletAdapter({
          nodeUrl,
          appId: opts.account.appId,
          discoveryTimeoutMs: opts.account.discoveryTimeoutMs,
        });
        break;
    }

    const { wallet, address } = await adapter.connect();
    const client = new QuetzalClient(
      address,
      wallet,
      { name: opts.network, nodeUrl, l1: opts.l1, contracts: opts.contracts },
      adapter,
    );
    if (opts.contracts) {
      await client.registerContracts();
    }
    return client;
  }

  /**
   * Register the Quetzal protocol contracts against the wallet's PXE so they
   * can be looked up via `Contract.at(addr, wallet)`.  Idempotent.
   *
   * Pulled out as a separate method so tests / advanced users that supplied
   * their own wallet can opt in selectively.
   */
  async registerContracts(): Promise<void> {
    const contracts = this.config.contracts;
    if (!contracts) return;
    // Cast to access registerContract on the underlying EmbeddedWallet wrapper.
    const walletAny = this.wallet as unknown as {
      registerContract?: (instance: unknown, artifact: unknown) => Promise<void>;
    };
    if (typeof walletAny.registerContract !== "function") return; // browser / external adapter — caller is responsible

    const { createAztecNodeClient } = await import("@aztec/aztec.js/node");
    const node = createAztecNodeClient(this.config.nodeUrl);
    const nodeAny = node as unknown as {
      getContract: (addr: AztecAddress) => Promise<unknown>;
    };

    const {
      loadOrderbookContract,
      loadTokenContract,
      loadLiquidityPoolContract,
      loadAggregatorRegistryContract,
      loadTreasuryContract,
    } = await import("./internal/contracts.js");

    const OrderbookContract = await loadOrderbookContract();
    const TokenContract = await loadTokenContract();
    const LiquidityPoolContract = await loadLiquidityPoolContract();

    const corePairs: [string, unknown][] = [
      [contracts.orderbook, OrderbookContract.artifact],
      [contracts.tUSDC, TokenContract.artifact],
      [contracts.tETH, TokenContract.artifact],
    ];
    if (contracts.tBTC) corePairs.push([contracts.tBTC, TokenContract.artifact]);
    for (const [addr, artifact] of corePairs) {
      const instance = await nodeAny.getContract(AztecAddress.fromStringUnsafe(addr));
      if (!instance) throw new ConfigError("UNKNOWN", `contract not found on-chain at ${addr}`);
      await walletAny.registerContract!(instance, artifact);
    }
    for (const pool of contracts.pools) {
      const instance = await nodeAny.getContract(AztecAddress.fromStringUnsafe(pool.address));
      if (!instance) {
        throw new ConfigError(
          "UNKNOWN",
          `pool_id ${pool.pool_id} contract not found on-chain at ${pool.address}`,
        );
      }
      await walletAny.registerContract!(instance, LiquidityPoolContract.artifact);
    }

    if (contracts.aggregatorRegistry) {
      const AggregatorRegistryContract = await loadAggregatorRegistryContract();
      const instance = await nodeAny.getContract(
        AztecAddress.fromStringUnsafe(contracts.aggregatorRegistry),
      );
      if (instance) {
        await walletAny.registerContract!(instance, AggregatorRegistryContract.artifact);
      }
    }
    if (contracts.treasury) {
      const TreasuryContract = await loadTreasuryContract();
      const instance = await nodeAny.getContract(AztecAddress.fromStringUnsafe(contracts.treasury));
      if (instance) {
        await walletAny.registerContract!(instance, TreasuryContract.artifact);
      }
    }
  }

  /** Tears down the underlying adapter (e.g. stops an embedded PXE). */
  async stop(): Promise<void> {
    await this.adapter.stop();
  }
}
