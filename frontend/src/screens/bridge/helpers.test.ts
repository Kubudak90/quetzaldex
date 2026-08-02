import { describe, it, expect } from "vitest";
import { isValidL1Address, parseAmount } from "./helpers";
import { tokenDecimals } from "../../sdk/use-l2-balance";

describe("bridge amounts use per-token decimals (M10)", () => {
  it("tokenDecimals + parseAmount round-trip for USDC(6) and WETH(18)", () => {
    expect(tokenDecimals("USDC")).toBe(6);
    expect(tokenDecimals("WETH")).toBe(18);
    // A "1" WETH deposit must be 1e18 atomic, not 1e6 (the old fixed-6 bug).
    expect(parseAmount("1", tokenDecimals("USDC"))).toBe(1_000_000n);
    expect(parseAmount("1", tokenDecimals("WETH"))).toBe(10n ** 18n);
    expect(parseAmount("0.5", tokenDecimals("WETH"))).toBe(5n * 10n ** 17n);
  });
});

describe("isValidL1Address (H8: block exits to a non-address)", () => {
  it("accepts a well-formed 20-byte hex address", () => {
    expect(isValidL1Address("0x9Aa12B3C4d5E6f7890aB1c2D3e4F5067890aBcDe")).toBe(true);
    expect(isValidL1Address("0x" + "0".repeat(40))).toBe(true);
    expect(isValidL1Address("0xABCDEF0123456789abcdef0123456789ABCDEF01")).toBe(true);
  });

  it("rejects empty / whitespace", () => {
    expect(isValidL1Address("")).toBe(false);
    expect(isValidL1Address("   ")).toBe(false);
  });

  it("rejects wrong length (short/long) and missing 0x", () => {
    expect(isValidL1Address("0x1234")).toBe(false);
    expect(isValidL1Address("0x" + "a".repeat(39))).toBe(false);
    expect(isValidL1Address("0x" + "a".repeat(41))).toBe(false);
    expect(isValidL1Address("9Aa12B3C4d5E6f7890aB1c2D3e4F5067890aBcDe")).toBe(false);
  });

  it("rejects non-hex characters", () => {
    expect(isValidL1Address("0x" + "g".repeat(40))).toBe(false);
    expect(isValidL1Address("0x9Aa12B3C4d5E6f7890aB1c2D3e4F5067890aBcZZ")).toBe(false);
  });
});
