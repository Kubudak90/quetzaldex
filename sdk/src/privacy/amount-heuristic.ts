// cli/src/amount-heuristic.ts
// Sub-6a D1: amount-pattern fingerprinting warn-heuristic.
//
// Detects round-number amounts that signal automation. Returns an
// advisory (suggest perturbed alternative) rather than blocking — the
// maker decides whether to round or accept the fingerprint risk.

/**
 * An amount classification:
 * - "round_unit": exactly 1, 10, 100, 1k, 10k, 100k, 1M of the base unit
 * - "round_tenth": exactly 0.1, 0.5 of the base unit
 * - "round_decimal": fewer than `precisionDigits` non-zero significant digits
 *   in the base-unit representation (e.g., 1.5 USDC = "1500000" has 2 sig digits)
 * - "natural": no obvious round-pattern fingerprint
 */
export type AmountClassification = "round_unit" | "round_tenth" | "round_decimal" | "natural";

export interface HeuristicResult {
  classification: AmountClassification;
  baseUnits: bigint;
  /**
   * A perturbed alternative amount inside +/- `tolerancePct`% of the input.
   * Deterministic per (amount, decimals) pair (no crypto.random) so tests are stable.
   * Always returned for "round_*" classifications; null for "natural".
   */
  suggested: bigint | null;
}

/**
 * Classify an amount + (optionally) suggest a perturbed alternative.
 *
 * @param amount raw on-chain amount in base units (already token-decimal-shifted)
 * @param decimals token decimals (e.g., USDC=6, WETH=18, wBTC=8)
 * @param tolerancePct max abs deviation of the suggested perturbation (default 7)
 * @param precisionDigits round_decimal threshold (default 3 sig digits)
 */
export function classifyAmount(
  amount: bigint,
  decimals: number,
  tolerancePct: number = 7,
  precisionDigits: number = 3,
): HeuristicResult {
  if (amount <= 0n) {
    return { classification: "natural", baseUnits: amount, suggested: null };
  }

  const decimalsBig = BigInt(decimals);
  const oneUnit = 10n ** decimalsBig;

  // round_unit check: amount is exactly 10^k * oneUnit for some k in [0..6]
  // (covers 1, 10, 100, 1k, 10k, 100k, 1M of the base unit)
  for (let k = 0; k <= 6; k++) {
    const candidate = oneUnit * (10n ** BigInt(k));
    if (amount === candidate) {
      return {
        classification: "round_unit",
        baseUnits: amount,
        suggested: perturb(amount, tolerancePct),
      };
    }
  }

  // round_tenth: 0.1 * oneUnit or 0.5 * oneUnit (only meaningful for decimals >= 1)
  if (decimals >= 1) {
    const tenth = oneUnit / 10n;
    const half = oneUnit / 2n;
    if (amount === tenth || amount === half) {
      return {
        classification: "round_tenth",
        baseUnits: amount,
        suggested: perturb(amount, tolerancePct),
      };
    }
  }

  // round_decimal: count significant digits in the decimal representation of `amount`
  // (i.e., total digits minus trailing zeros)
  const str = amount.toString();
  let trailingZeros = 0;
  for (let i = str.length - 1; i >= 0; i--) {
    if (str[i] === "0") trailingZeros++;
    else break;
  }
  const significantDigits = str.length - trailingZeros;
  if (significantDigits <= precisionDigits) {
    return {
      classification: "round_decimal",
      baseUnits: amount,
      suggested: perturb(amount, tolerancePct),
    };
  }

  return { classification: "natural", baseUnits: amount, suggested: null };
}

/**
 * Perturb an amount by a deterministic +/-tolerancePct%. Formula uses the
 * lower bits of the amount as a seed so repeated calls on the same input
 * yield the same suggestion. Tests rely on this determinism.
 */
function perturb(amount: bigint, tolerancePct: number): bigint {
  // Deterministic noise in [-tolerancePct, +tolerancePct]:
  //   noiseBp = (amount % (2*tolerancePct*100 + 1)) - tolerancePct*100
  // result spans -tolerancePct% to +tolerancePct% in basis points (1bp = 0.01%).
  const range = BigInt(2 * tolerancePct * 100 + 1);
  const noiseBp = (amount % range) - BigInt(tolerancePct * 100);
  const delta = (amount * noiseBp) / 10_000n;
  let suggested = amount + delta;
  // Avoid returning the same amount (suggested != amount) so the advisory always
  // proposes a different value.
  if (suggested === amount) suggested = amount + 1n;
  return suggested;
}

/**
 * Resolve the number of decimals for a token alias.
 * Accepts both legacy (tUSDC/tETH/tBTC) and bridged (aUSDC/aWETH/aWBTC) names.
 * Throws on unknown tokens so callers get an explicit error rather than a silent 0.
 */
export function resolveTokenDecimals(alias: string): number {
  // Normalise: strip leading "t" or "a" prefix and lower-case for matching.
  const canonical = alias.replace(/^[ta]/i, "").toLowerCase();
  switch (canonical) {
    case "usdc":
      return 6;
    case "weth":
    case "eth":
      return 18;
    case "wbtc":
    case "btc":
      return 8;
    default:
      throw new Error(
        `resolveTokenDecimals: unknown token alias '${alias}'. ` +
        `Known: tUSDC/aUSDC, tETH/aWETH, tBTC/aWBTC.`,
      );
  }
}

/**
 * Format a heuristic result as a human-readable advisory line.
 * Returns empty string for "natural" (caller can skip the print).
 */
export function formatAdvisory(result: HeuristicResult, decimals: number, ticker: string): string {
  if (result.classification === "natural" || result.suggested === null) return "";
  const oneUnit = 10n ** BigInt(decimals);
  // Render to a human decimal string (truncate trailing zeros after the dot)
  const renderUnits = (raw: bigint): string => {
    const whole = raw / oneUnit;
    const frac = raw % oneUnit;
    if (frac === 0n) return whole.toString();
    const fracStr = frac.toString().padStart(decimals, "0").replace(/0+$/, "");
    return `${whole.toString()}.${fracStr}`;
  };
  const inputStr = renderUnits(result.baseUnits);
  const suggStr = renderUnits(result.suggested);
  return (
    `WARN: amount ${inputStr} ${ticker} looks round (${result.classification}). ` +
    `Suggest perturbing -> ${suggStr} ${ticker} to reduce fingerprint risk.`
  );
}
