// sdk/src/wallet/pool.ts
// Sub-6c B1-B3: WalletPool — N-wallet round-robin to bypass Aztec PXE's
// ~20-unfinalised-private-tx-per-wallet tagging cap.
//
// Each child wallet is HD-derived from a master secret + index. Pool
// transparently round-robins submissions; auto-skips children at the
// PXE_TAGGING_CAP; throws WalletPoolExhausted when all are saturated.
//
// Fee-juice topup for each child wallet is the OPERATOR's responsibility
// (Aztec faucet drip on testnet; self-fund on mainnet). The SDK does
// not sponsor fees.

import { createHash } from "node:crypto";
import { QuetzalClient } from "../client.js";
import type { NetworkName, NetworkConfig, QuetzalContracts } from "../types.js";
import { ConfigError } from "../errors.js";

export const PXE_TAGGING_CAP = 18; // 2 below Aztec's ~20 for safety buffer

export interface WalletPoolOptions {
  masterSecret: string; // 0x-prefixed hex32 root
  n: number;            // pool size; recommend 3-5
  network: NetworkName;
  nodeUrl?: string;
  l1?: NetworkConfig["l1"];
  /**
   * Optional Quetzal protocol deployment metadata. When present, each child
   * QuetzalClient registers the protocol contracts against its PXE so
   * reads/writes (orders, pools, reads APIs) resolve addresses without the
   * caller passing them on every method call.
   */
  contracts?: QuetzalContracts;
}

interface PoolChild {
  client: QuetzalClient;
  index: number;
  pendingTx: number;
}

/**
 * bn254 Fr modulus. Masking sha256 to 254 bits gives values up to 2^254 − 1,
 * which is ~1.53× this modulus — so ~35% of raw hashes land in [p, 2^254) and
 * `Fr.fromString` rejects them. Rejection-sampling below resolves it
 * deterministically without changing the round-0 value for indices that
 * land in-range.
 */
const P_BN254 = BigInt(
  "0x30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001",
);

/**
 * Derive a child wallet secret from a master secret + index.
 *
 * Formula (round 0): childSecret_i = sha256(masterHex_bytes || u32_be(i)),
 * masked to 254 bits. If the result is ≥ p (bn254 Fr modulus), rehash with
 * an extra `round` byte (1, 2, …) appended and retry. Round 0 preserves the
 * original formula so addresses for in-range indices stay backward-compatible.
 */
export function deriveChildSecret(masterHex: string, index: number): string {
  const baseBuf = Buffer.concat([
    Buffer.from(masterHex.slice(2), "hex"),
    Buffer.from(index.toString(16).padStart(8, "0"), "hex"),
  ]);
  for (let round = 0; round < 256; round++) {
    const buf = round === 0
      ? baseBuf
      : Buffer.concat([baseBuf, Buffer.from([round])]);
    const digest = createHash("sha256").update(buf).digest("hex");
    const masked = BigInt("0x" + digest) & ((1n << 254n) - 1n);
    if (masked < P_BN254) {
      return "0x" + masked.toString(16).padStart(64, "0");
    }
  }
  // Statistically impossible: 256 consecutive rounds all ≥ p has probability
  // (~0.35)^256 ≈ 10^-117. If this fires, sha256 is broken.
  throw new Error("deriveChildSecret: exhausted 256 rounds");
}

export class WalletPool {
  private children: PoolChild[];
  private cursor = 0;

  private constructor(children: PoolChild[]) {
    this.children = children;
  }

  static async fromMaster(opts: WalletPoolOptions): Promise<WalletPool> {
    // Input validation runs BEFORE any QuetzalClient.connect calls
    if (!opts.masterSecret.startsWith("0x") || opts.masterSecret.length !== 66) {
      throw new ConfigError(
        "MISSING_ENV",
        "masterSecret must be 0x-prefixed hex32 (66 chars total)",
      );
    }
    if (opts.n < 1 || opts.n > 20) {
      throw new ConfigError(
        "UNKNOWN",
        `pool size n must be in [1, 20]; got ${opts.n}`,
      );
    }
    const children: PoolChild[] = [];
    for (let i = 0; i < opts.n; i++) {
      const childHex = deriveChildSecret(opts.masterSecret, i);
      const client = await QuetzalClient.connect({
        network: opts.network,
        nodeUrl: opts.nodeUrl,
        // The pool exists to SUBMIT orders, so each child needs a real prover.
        // Without this, SchnorrSecretAdapter defaults proverEnabled=false and the
        // embedded PXE submits an unproven (mock) tx that a real node rejects with
        // "Invalid tx: Invalid proof" — while account deploy works because
        // claim-deploy.ts enables the prover explicitly. (Root cause of the
        // 2026-06-14 order-submission failures; see invalid-proof investigation.)
        account: { type: "schnorr", secret: childHex, proverEnabled: true },
        l1: opts.l1,
        contracts: opts.contracts,
      });
      children.push({ client, index: i, pendingTx: 0 });
    }
    return new WalletPool(children);
  }

  /**
   * @internal — test-only constructor. Allows unit tests to inject stubbed
   * children without going through QuetzalClient.connect (which requires a
   * live node). Not part of the public API; do not use in production.
   */
  static __forTesting__(stubs: Array<{ client: unknown; index: number; pendingTx: number }>): WalletPool {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return new WalletPool(stubs as any);
  }

  get size(): number {
    return this.children.length;
  }

  get addresses(): string[] {
    return this.children.map((c) => c.client.address.toString());
  }

  /**
   * Round-robin pick the next non-saturated child.
   * Throws if all N children are at PXE_TAGGING_CAP.
   */
  next(): QuetzalClient {
    for (let i = 0; i < this.children.length; i++) {
      const idx = (this.cursor + i) % this.children.length;
      const child = this.children[idx];
      if (child.pendingTx < PXE_TAGGING_CAP) {
        this.cursor = (idx + 1) % this.children.length;
        return this.wrapClient(child);
      }
    }
    throw new Error(
      "WalletPoolExhausted: all N wallets at PXE_TAGGING_CAP; " +
        "wait for finalization or grow pool",
    );
  }

  /**
   * Sticky-acquire: same tag returns the same child across calls.
   * Useful for related operations (place + claim of same epoch's order).
   */
  acquireFor(tag: string): QuetzalClient {
    const hashHex = createHash("sha256").update(tag).digest("hex").slice(0, 16);
    const idx = Number(BigInt("0x" + hashHex) % BigInt(this.children.length));
    return this.wrapClient(this.children[idx]);
  }

  /**
   * Aggregate `getOrders()` across all children. Each entry tags the wallet
   * that owns those orders so the caller can re-issue actions against the
   * correct child via `acquireFor(wallet)`.
   */
  async getAllOrders(): Promise<Array<{ wallet: string; orders: unknown[] }>> {
    const results = await Promise.all(
      this.children.map(async (c) => ({
        wallet: c.client.address.toString(),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        orders: await ((c.client as any).reads.getOrders() as Promise<unknown[]>),
      })),
    );
    return results;
  }

  /**
   * Sum the public balance of `token` across all child wallets.
   */
  async getAggregatedBalance(token: string): Promise<bigint> {
    const balances = await Promise.all(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      this.children.map((c) => ((c.client as any).reads.getBalance(token) as Promise<bigint>)),
    );
    return balances.reduce((acc, b) => acc + b, 0n);
  }

  async stop(): Promise<void> {
    await Promise.all(this.children.map((c) => c.client.stop()));
  }

  /**
   * Wrap a child's QuetzalClient with a Proxy that intercepts tx-emitting
   * calls on `orders.*` + `bridge.*` to increment/decrement `pendingTx`.
   *
   * Decrement happens on promise resolve (success OR failure). The simplification
   * vs. tracking actual on-chain finalization is acceptable: PXE's tagging-window
   * release happens at finalization regardless of the SDK's counter, and the
   * counter's job is just to gate `next()` selection.
   */
  private wrapClient(child: PoolChild): QuetzalClient {
    const tagged = new Set(["placeOrder", "placeOrderBulk", "claimFill", "cancelOrder", "claim", "exit"]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return new Proxy(child.client as any, {
      get(target, prop) {
        if (prop === "orders" || prop === "bridge") {
          const sub = (target as Record<string, unknown>)[prop as string];
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          return new Proxy(sub as any, {
            get(subTarget, method) {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const fn = (subTarget as any)[method];
              const methodStr = String(method);
              if (typeof fn !== "function" || !tagged.has(methodStr)) {
                return typeof fn === "function" ? fn.bind(subTarget) : fn;
              }
              return async (...args: unknown[]) => {
                child.pendingTx++;
                try {
                  const result = await fn.apply(subTarget, args);
                  child.pendingTx = Math.max(0, child.pendingTx - 1);
                  return result;
                } catch (e) {
                  child.pendingTx = Math.max(0, child.pendingTx - 1);
                  throw e;
                }
              };
            },
          });
        }
        return Reflect.get(target, prop);
      },
    }) as QuetzalClient;
  }
}
