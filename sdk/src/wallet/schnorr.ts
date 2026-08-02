// sdk/src/wallet/schnorr.ts
// Mirrors the pattern used in cli/src/wallet.ts:openCli — EmbeddedWallet.create
// with ephemeral storage, then createSchnorrAccount with the caller's secret key.
import { Fr, Fq } from "@aztec/aztec.js/fields";
import { deriveMasterMessageSigningSecretKey } from "@aztec/stdlib/keys";
import { EmbeddedWallet } from "@aztec/wallets/embedded";
import type { WalletAdapter } from "./adapter.js";
import { ConfigError } from "../errors.js";

export interface SchnorrSecretAdapterOptions {
  /** 0x-prefixed 32-byte hex secret key (Fr field element). */
  secret: string;
  /** Aztec node JSON-RPC URL, e.g. http://localhost:8080 */
  nodeUrl: string;
  /**
   * Sub-9.3: optional 0x-prefixed 32-byte hex Fr salt. Default Fr.ZERO.
   * Mainly used to reach a pre-deployed account whose addr depends on the
   * tuple (secret, salt, signingKey) — the aggregator reuses admin's
   * already-funded wallet.
   */
  salt?: string;
  /**
   * Sub-9.3: optional 0x-prefixed 32-byte hex Fq signing key. Default
   * derived from secret. Pass this when reaching a pre-deployed wallet
   * whose signingKey was sampled independently.
   */
  signingKey?: string;
  /**
   * Sub-9.3: enable the client IVC prover for tx submission. Default false
   * (read-only simulate() doesn't need it). Set true when this adapter is
   * used to SUBMIT txs (e.g. the aggregator's close_epoch path).
   */
  proverEnabled?: boolean;
  /**
   * Sub-9.3: persistent PXE data directory. Default ephemeral. When set,
   * the PXE retains notes / synced state across restarts — useful for the
   * aggregator's daemon mode (read-only doesn't need it).
   */
  dataDirectory?: string;
}

/**
 * Adapter that spins up an ephemeral embedded PXE, creates a Schnorr account
 * derived from `secret`, and returns it ready for use.
 *
 * The embedded PXE is torn down on stop().  This adapter is appropriate for
 * server-side SDK usage (scripts, CLI, backend services).
 */
export class SchnorrSecretAdapter implements WalletAdapter {
  private embeddedWallet: EmbeddedWallet | null = null;

  constructor(private readonly opts: SchnorrSecretAdapterOptions) {
    if (!opts.secret || !opts.secret.startsWith("0x")) {
      throw new ConfigError(
        "MISSING_ENV",
        "SchnorrSecretAdapter requires a 0x-prefixed hex32 secret",
      );
    }
  }

  async connect() {
    const wallet = await EmbeddedWallet.create(this.opts.nodeUrl, {
      ephemeral: !this.opts.dataDirectory,
      ...(this.opts.dataDirectory ? { pxe: { proverEnabled: this.opts.proverEnabled ?? false, dataDirectory: this.opts.dataDirectory } } : { pxe: { proverEnabled: this.opts.proverEnabled ?? false } }),
    });
    const salt = this.opts.salt ? Fr.fromString(this.opts.salt) : Fr.ZERO;
    // 5.0.0: createSchnorrAccount requires an explicit Fq signing key (rc.2
    // accepted undefined and derived one internally). Reproduce that derivation
    // so a caller-less signing key stays DETERMINISTIC in the secret — random
    // here would give a fresh L2 address on every connect and break the pool.
    const secretFr = Fr.fromString(this.opts.secret);
    const signingKey = this.opts.signingKey
      ? Fq.fromString(this.opts.signingKey)
      : deriveMasterMessageSigningSecretKey(secretFr);
    const accountManager = await wallet.createSchnorrAccount(
      secretFr,
      salt,
      signingKey,
    );
    const account = await accountManager.getAccount();
    this.embeddedWallet = wallet;
    // Return the EmbeddedWallet itself (extends BaseWallet → has executeUtility
    // via PXE delegation), NOT the Account. Account has getAddress()/getCompleteAddress()
    // but lacks the executeUtility/sendTx methods that
    // ContractFunctionInteraction.{simulate,send} call into. The address comes
    // from the account; all contract calls use { from: address } to identify caller.
    // Mirrors scripts/seed-lp.ts and cli/src/wallet.ts which pass EmbeddedWallet.
    return {
      wallet: wallet as unknown as import("@aztec/aztec.js/wallet").Wallet,
      address: account.getAddress(),
    };
  }

  async stop() {
    if (this.embeddedWallet) {
      await this.embeddedWallet.stop();
      this.embeddedWallet = null;
    }
  }
}
