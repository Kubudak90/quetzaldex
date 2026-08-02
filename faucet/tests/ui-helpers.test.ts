import { describe, test, expect } from "vitest";
import {
  isValidAztecAddress,
  dripErrorMessage,
  claimFileName,
  formatTokenAmount,
  stockLevel,
} from "@/lib/ui-helpers";

describe("isValidAztecAddress", () => {
  test("accepts 0x + 64 hex", () => {
    expect(isValidAztecAddress("0x" + "ab".repeat(32))).toBe(true);
  });
  test("rejects short / non-hex / missing prefix", () => {
    expect(isValidAztecAddress("0x123")).toBe(false);
    expect(isValidAztecAddress("ab".repeat(33))).toBe(false);
    expect(isValidAztecAddress("0x" + "zz".repeat(32))).toBe(false);
  });
});

describe("dripErrorMessage", () => {
  test("rate-limited includes retry minutes", () => {
    const m = dripErrorMessage("rate-limited", 1200);
    expect(m).toContain("20");
  });
  test("drained / transient / bad-request / unknown all give friendly text", () => {
    for (const code of ["drained", "transient", "bad-request", undefined] as const) {
      expect(dripErrorMessage(code, undefined).length).toBeGreaterThan(10);
    }
  });
});

describe("claimFileName", () => {
  test("uses first 8 hex chars of the address", () => {
    expect(claimFileName("0x2253611df01455a48400476b293f2ac86f38fd8977a78e7cfff7ac467b85fce2"))
      .toBe("quetzal-fj-claim-2253611d.json");
  });
});

describe("stockLevel", () => {
  test("missing l1 block → null (unknown)", () => {
    expect(stockLevel(undefined)).toBe(null);
  });
  test('"unknown" fee juice + healthy eth → healthy (no BigInt crash)', () => {
    expect(
      stockLevel({ operatorBalanceEth: "1.5", operatorBalanceFeeJuice: "unknown" }),
    ).toBe("healthy");
  });
  test('"unknown" + "unknown" → null (unknown)', () => {
    expect(
      stockLevel({ operatorBalanceEth: "unknown", operatorBalanceFeeJuice: "unknown" }),
    ).toBe(null);
  });
  test("low eth → low", () => {
    expect(
      stockLevel({
        operatorBalanceEth: "0.01",
        operatorBalanceFeeJuice: (5000n * 10n ** 18n).toString(),
      }),
    ).toBe("low");
  });
  test("low fee juice (numeric) → low", () => {
    expect(
      stockLevel({
        operatorBalanceEth: "1.5",
        operatorBalanceFeeJuice: (999n * 10n ** 18n).toString(),
      }),
    ).toBe("low");
  });
});

describe("formatTokenAmount", () => {
  test("formats atomic amounts with decimals", () => {
    expect(formatTokenAmount("1000000000", 6)).toBe("1000");
    expect(formatTokenAmount("500000000000000000", 18)).toBe("0.5");
    expect(formatTokenAmount("50000000000000000000", 18)).toBe("50");
  });
});
