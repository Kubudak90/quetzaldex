import { describe, test, expect } from "vitest";
import { deriveChildren, type DerivedChild } from "./derive-children";

const MASTER = "0x" + "11".repeat(32);

describe("deriveChildren", () => {
  test("returns N entries for n=3", () => {
    const kids = deriveChildren(MASTER, 3);
    expect(kids).toHaveLength(3);
    expect(kids[0]?.index).toBe(0);
    expect(kids[1]?.index).toBe(1);
    expect(kids[2]?.index).toBe(2);
  });

  test("each child has a 0x-prefixed 32-byte hex secret under bn254", () => {
    const kids = deriveChildren(MASTER, 3);
    const P_BN254 = BigInt("0x30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001");
    for (const k of kids) {
      expect(k.secret).toMatch(/^0x[0-9a-f]{64}$/);
      expect(BigInt(k.secret) < P_BN254).toBe(true);
    }
  });

  test("deterministic for the same master + index", () => {
    const a = deriveChildren(MASTER, 3);
    const b = deriveChildren(MASTER, 3);
    expect(a[0]?.secret).toBe(b[0]?.secret);
    expect(a[2]?.secret).toBe(b[2]?.secret);
  });

  test("different indices produce different secrets", () => {
    const kids = deriveChildren(MASTER, 3);
    expect(kids[0]?.secret).not.toBe(kids[1]?.secret);
    expect(kids[1]?.secret).not.toBe(kids[2]?.secret);
  });

  test("n=0 returns []", () => {
    expect(deriveChildren(MASTER, 0)).toEqual([]);
  });
});
