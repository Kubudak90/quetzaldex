import { resolveTokenDecimals } from "@quetzal/sdk";

// Order-amount fixed-point helpers for the Trade screen.
//
// H9: the order amount is denominated in the INPUT token's smallest unit, and
// tokens have different decimals on-chain (USDC=6, ETH/WETH=18, BTC/wBTC=8). The
// old screen-local parseAmount/formatAmount defaulted to 6 decimals for every
// token, so a sell of "1" ETH escrowed 1e6 atomic = 1e-12 ETH (a dust order),
// while the private-balance check trivially passed. `decimals` is now REQUIRED at
// every call site so no path can silently fall back to 6.

/** Parse a display amount string (e.g. "1,234.56") to bigint at `decimals`. */
export function parseAmount(s: string, decimals: number): bigint {
  const clean = s.replace(/,/g, "").trim();
  if (!clean || clean === ".") return 0n;
  const [whole = "0", frac = ""] = clean.split(".");
  const fracPadded = frac.padEnd(decimals, "0").slice(0, decimals);
  try {
    return BigInt(whole + fracPadded);
  } catch {
    return 0n;
  }
}

/** Format a raw bigint amount at `decimals` to a display string. */
export function formatAmount(raw: bigint, decimals: number): string {
  const s = raw.toString().padStart(decimals + 1, "0");
  const whole = s.slice(0, s.length - decimals) || "0";
  const frac = s.slice(s.length - decimals).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}

/** "USDC/ETH" → ["tUSDC", "tETH"], "ETH/BTC" → ["tETH", "tBTC"] */
export function pairToPath(pair: string): string[] {
  return pair.split("/").map((tok) => "t" + tok);
}

/**
 * The token whose smallest unit the order amount is denominated in. A buy spends
 * the base (path[0]); a sell spends the quote (path[last]) — matching the SDK/CLI
 * convention (the order escrows `amount` of the input token atomically) and the
 * resting-order label logic (`pair.split("/")[side ? 1 : 0]`).
 */
export function inputTokenAlias(pair: string, side: "buy" | "sell"): string {
  const path = pairToPath(pair);
  return side === "sell" ? path[path.length - 1]! : path[0]!;
}

/** True decimals of the order's input token (throws ConfigError for unknown tokens). */
export function inputDecimals(pair: string, side: "buy" | "sell"): number {
  return resolveTokenDecimals(inputTokenAlias(pair, side));
}
