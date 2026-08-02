import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mulDiv, SCALE, FEE_NUM, FEE_DEN } from "../src/fixed-point.js";

describe("fixed-point", () => {
  it("mulDiv computes a*b/denom with floor division", () => {
    assert.equal(mulDiv(6n, 7n, 2n), 21n);
    assert.equal(mulDiv(7n, 1n, 2n), 3n, "floors 3.5 -> 3");
    assert.equal(mulDiv(0n, 999n, 7n), 0n);
  });

  it("mulDiv handles operands far beyond 2^64 without overflow", () => {
    const big = 10n ** 40n;
    assert.equal(mulDiv(big, big, big), big);
  });

  it("mulDiv throws on a zero denominator", () => {
    assert.throws(() => mulDiv(1n, 1n, 0n), /division by zero/);
  });

  it("constants have the documented values", () => {
    assert.equal(SCALE, 10n ** 18n);
    assert.equal(FEE_NUM, 9970n);
    assert.equal(FEE_DEN, 10_000n);
    // 0.3% fee: input * 9970/10000 keeps 99.7%.
    assert.equal((1_000_000n * FEE_NUM) / FEE_DEN, 997_000n);
  });
});
