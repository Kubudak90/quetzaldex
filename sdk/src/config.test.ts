// sdk/src/config.test.ts
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { resolveTokenDecimals } from "./config.js";
import { ConfigError } from "./errors.js";

describe("resolveTokenDecimals", () => {
  test("USDC -> 6", () => {
    assert.equal(resolveTokenDecimals("USDC"), 6);
  });
  test("tUSDC -> 6", () => {
    assert.equal(resolveTokenDecimals("tUSDC"), 6);
  });
  test("aWETH -> 18", () => {
    assert.equal(resolveTokenDecimals("aWETH"), 18);
  });
  test("WBTC -> 8", () => {
    assert.equal(resolveTokenDecimals("WBTC"), 8);
  });
  test("unknown -> throws ConfigError", () => {
    assert.throws(() => resolveTokenDecimals("DOGE"), ConfigError);
  });
});
