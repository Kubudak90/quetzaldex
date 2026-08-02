import { describe, test, expect } from "vitest";
import { validateL2Address } from "@/lib/address";

describe("validateL2Address", () => {
  test("accepts a valid Fr field element (under bn254 modulus)", () => {
    expect(validateL2Address("0x" + "00".repeat(31) + "01")).toBe(true);
  });

  test("rejects non-hex strings", () => {
    expect(validateL2Address("0xnotahex" + "0".repeat(58))).toBe(false);
    expect(validateL2Address("nohexprefix" + "0".repeat(54))).toBe(false);
  });

  test("rejects wrong length", () => {
    expect(validateL2Address("0xab")).toBe(false);
    expect(validateL2Address("0x" + "0".repeat(63))).toBe(false);
    expect(validateL2Address("0x" + "0".repeat(65))).toBe(false);
  });

  test("rejects values >= bn254 Fr modulus", () => {
    expect(validateL2Address("0x30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001")).toBe(false);
    expect(validateL2Address("0x" + "f".repeat(64))).toBe(false);
  });

  test("rejects zero address", () => {
    expect(validateL2Address("0x" + "00".repeat(32))).toBe(false);
  });
});
