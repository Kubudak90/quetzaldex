import { describe, it, expect } from "vitest";
import { isValidMasterSecret } from "./master-secret";

describe("isValidMasterSecret (M13)", () => {
  it("accepts a 0x + 64-hex secret (trimmed)", () => {
    const s = "0x" + "a".repeat(64);
    expect(isValidMasterSecret(s)).toBe(true);
    expect(isValidMasterSecret("  " + s + "  ")).toBe(true);
    expect(isValidMasterSecret("0x" + "0123456789abcdefABCDEF".padEnd(64, "0"))).toBe(true);
  });

  it("rejects empty, wrong length, missing 0x, and non-hex", () => {
    expect(isValidMasterSecret("")).toBe(false);
    expect(isValidMasterSecret("0x" + "a".repeat(63))).toBe(false);
    expect(isValidMasterSecret("0x" + "a".repeat(65))).toBe(false);
    expect(isValidMasterSecret("a".repeat(64))).toBe(false);
    expect(isValidMasterSecret("0x" + "g".repeat(64))).toBe(false);
  });
});
