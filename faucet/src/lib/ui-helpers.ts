// Pure logic for the faucet page (src/pages/index.tsx) — kept out of the
// component so it is unit-testable without a DOM.

/** Mirror of the server-side HexAddress rule in lib/types.ts. */
export function isValidAztecAddress(s: string): boolean {
  return /^0x[0-9a-fA-F]{64}$/.test(s);
}

export type DripErrorCode = "bad-request" | "rate-limited" | "drained" | "transient" | undefined;

export function dripErrorMessage(code: DripErrorCode, retryAfterSeconds: number | undefined): string {
  switch (code) {
    case "rate-limited": {
      const mins = Math.max(1, Math.ceil((retryAfterSeconds ?? 0) / 60));
      return `Rate limit reached for your IP. Try again in ~${mins} min.`;
    }
    case "drained":
      return "The faucet's daily stock is depleted. Please try again later.";
    case "transient":
      return "Temporary node hiccup — safe to retry in a moment.";
    case "bad-request":
      return "The address looks invalid. Expected 0x followed by 64 hex characters.";
    default:
      return "Something went wrong on the faucet side. Please retry shortly.";
  }
}

/** "low" | "healthy" | null (null = unknown). Tolerates the server's "unknown" sentinels. */
export function stockLevel(
  l1: { operatorBalanceEth: string; operatorBalanceFeeJuice: string } | undefined,
): "low" | "healthy" | null {
  if (!l1) return null;
  const eth = Number(l1.operatorBalanceEth);
  const fjOk = /^\d+$/.test(l1.operatorBalanceFeeJuice);
  if (!fjOk && !Number.isFinite(eth)) return null;
  const ethLow = Number.isFinite(eth) && eth < 0.05;
  const fjLow = fjOk && BigInt(l1.operatorBalanceFeeJuice) < 1000n * 10n ** 18n;
  return ethLow || fjLow ? "low" : "healthy";
}

export function claimFileName(address: string): string {
  return `quetzal-fj-claim-${address.replace(/^0x/, "").slice(0, 8)}.json`;
}

/** Format an atomic bigint string with the given decimals, trimming zeros. */
export function formatTokenAmount(atomic: string, decimals: number): string {
  const v = BigInt(atomic);
  const base = 10n ** BigInt(decimals);
  const whole = v / base;
  const frac = v % base;
  if (frac === 0n) return whole.toString();
  const fracStr = frac.toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${whole.toString()}.${fracStr}`;
}
