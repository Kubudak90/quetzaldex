import { describe, it, expect } from "vitest";
import {
  parseAmount,
  formatAmount,
  pairToPath,
  inputTokenAlias,
  inputDecimals,
} from "./trade-amounts";

describe("parseAmount / formatAmount at explicit decimals", () => {
  it("parses at 6 decimals", () => {
    expect(parseAmount("1", 6)).toBe(1_000_000n);
    expect(parseAmount("1.5", 6)).toBe(1_500_000n);
    expect(parseAmount("1,234.56", 6)).toBe(1_234_560_000n);
  });

  it("parses at 18 decimals (the ETH case the bug got wrong)", () => {
    expect(parseAmount("1", 18)).toBe(10n ** 18n);
    expect(parseAmount("0.5", 18)).toBe(5n * 10n ** 17n);
  });

  it("round-trips format∘parse at 6 and 18", () => {
    expect(formatAmount(parseAmount("12.34", 6), 6)).toBe("12.34");
    expect(formatAmount(parseAmount("12.34", 18), 18)).toBe("12.34");
    expect(formatAmount(10n ** 18n, 18)).toBe("1");
  });

  it("truncates fractional digits beyond the token's precision", () => {
    // 7 fractional digits at 6-decimals drops the last one (no rounding).
    expect(parseAmount("1.2345678", 6)).toBe(1_234_567n);
  });
});

describe("inputTokenAlias / inputDecimals — the token the order amount is denominated in", () => {
  it("sell spends the quote token (path[last]); buy spends the base (path[0])", () => {
    // pair "USDC/ETH" → path ["tUSDC","tETH"]
    expect(inputTokenAlias("USDC/ETH", "sell")).toBe("tETH");
    expect(inputTokenAlias("USDC/ETH", "buy")).toBe("tUSDC");
    expect(pairToPath("USDC/ETH")).toEqual(["tUSDC", "tETH"]);
  });

  it("resolves the input token's TRUE decimals (the core H9 fix)", () => {
    // Selling ETH must parse at 18 decimals — the bug used a fixed 6, escrowing 1e-12 of intent.
    expect(inputDecimals("USDC/ETH", "sell")).toBe(18);
    expect(inputDecimals("USDC/ETH", "buy")).toBe(6);
    expect(inputDecimals("ETH/BTC", "sell")).toBe(8);
    expect(inputDecimals("ETH/BTC", "buy")).toBe(18);
  });

  it("parsing a 1-ETH sell yields 1e18 atomic, not 1e6", () => {
    const dec = inputDecimals("USDC/ETH", "sell");
    expect(parseAmount("1", dec)).toBe(10n ** 18n);
  });
});
