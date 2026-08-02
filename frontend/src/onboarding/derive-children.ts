// Pure derivation of N child wallets from a master secret.
// Uses the same formula as sdk/src/wallet/pool.ts:deriveChildSecret so the
// addresses the wizard pre-computes match what WalletPool.fromMaster will
// derive at session-connect time.
import { deriveChildSecret } from "@quetzal/sdk";

export interface DerivedChild {
  index: number;
  /** 0x-prefixed 32-byte hex (Fr field element). */
  secret: `0x${string}`;
}

export function deriveChildren(masterSecret: string, n: number): DerivedChild[] {
  if (n < 0) throw new Error("n must be ≥ 0");
  const out: DerivedChild[] = [];
  for (let i = 0; i < n; i++) {
    out.push({
      index: i,
      secret: deriveChildSecret(masterSecret, i) as `0x${string}`,
    });
  }
  return out;
}
