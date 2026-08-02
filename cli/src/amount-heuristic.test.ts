// cli/src/amount-heuristic.test.ts
// Sub-6a D1 unit tests + D3 boundary / resolveTokenDecimals coverage.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
// Sub-6b Task 2.8: this module now lives in @quetzal/sdk; the CLI test file
// is kept to preserve the 74/74 CLI test count while exercising the SDK copy.
import { classifyAmount, formatAdvisory, resolveTokenDecimals } from "@quetzal/sdk/privacy/amount-heuristic";

describe("classifyAmount", () => {
  test("flags 1.0 USDC (1_000_000) as round_unit", () => {
    const r = classifyAmount(1_000_000n, 6);
    assert.equal(r.classification, "round_unit");
    assert.notEqual(r.suggested, null);
  });

  test("flags 10_000 USDC (10_000_000_000) as round_unit", () => {
    const r = classifyAmount(10_000_000_000n, 6);
    assert.equal(r.classification, "round_unit");
  });

  test("flags 1.0 WETH (10^18) as round_unit", () => {
    const r = classifyAmount(10n ** 18n, 18);
    assert.equal(r.classification, "round_unit");
  });

  test("flags 0.5 WETH (5 * 10^17) as round_tenth", () => {
    const r = classifyAmount(5n * 10n ** 17n, 18);
    assert.equal(r.classification, "round_tenth");
  });

  test("flags 0.1 USDC (100_000) as round_tenth", () => {
    const r = classifyAmount(100_000n, 6);
    assert.equal(r.classification, "round_tenth");
  });

  test("flags 1_500_000 USDC as round_decimal (2 sig digits)", () => {
    const r = classifyAmount(1_500_000n, 6); // 1.5 USDC
    assert.equal(r.classification, "round_decimal");
  });

  test("does NOT flag 1_234_567 USDC as round (7 sig digits)", () => {
    const r = classifyAmount(1_234_567n, 6); // 1.234567 USDC
    assert.equal(r.classification, "natural");
    assert.equal(r.suggested, null);
  });

  test("does NOT flag 1_500_001 USDC as round (7 sig digits)", () => {
    const r = classifyAmount(1_500_001n, 6); // 1.500001 USDC
    assert.equal(r.classification, "natural");
  });

  test("returns natural for zero", () => {
    const r = classifyAmount(0n, 6);
    assert.equal(r.classification, "natural");
    assert.equal(r.suggested, null);
  });

  test("returns natural for negative", () => {
    const r = classifyAmount(-1_000_000n, 6);
    assert.equal(r.classification, "natural");
  });

  test("perturbed suggestion differs from input", () => {
    const r = classifyAmount(1_000_000n, 6);
    assert.notEqual(r.suggested, r.baseUnits);
  });

  test("perturbed suggestion within +/-7% default tolerance", () => {
    const amount = 1_000_000n;
    const r = classifyAmount(amount, 6);
    assert.ok(r.suggested !== null);
    const lower = (amount * 93n) / 100n;
    const upper = (amount * 107n) / 100n;
    assert.ok(r.suggested >= lower, `suggested ${r.suggested} < ${lower}`);
    assert.ok(r.suggested <= upper, `suggested ${r.suggested} > ${upper}`);
  });

  test("deterministic: same input yields same suggestion", () => {
    const r1 = classifyAmount(1_000_000n, 6);
    const r2 = classifyAmount(1_000_000n, 6);
    assert.equal(r1.suggested, r2.suggested);
  });

  test("custom tolerancePct=2 narrows the perturbation range", () => {
    const amount = 1_000_000n;
    const r = classifyAmount(amount, 6, 2);
    assert.ok(r.suggested !== null);
    const lower = (amount * 98n) / 100n;
    const upper = (amount * 102n) / 100n;
    assert.ok(r.suggested >= lower);
    assert.ok(r.suggested <= upper);
  });

  test("custom precisionDigits=5 tightens round_decimal threshold", () => {
    // 1_234_500 has 5 sig digits — with threshold=5 flagged round_decimal;
    // with default threshold=3 it would be "natural".
    const looser = classifyAmount(1_234_500n, 6);
    const tighter = classifyAmount(1_234_500n, 6, 7, 5);
    assert.equal(looser.classification, "natural");
    assert.equal(tighter.classification, "round_decimal");
  });
});

describe("formatAdvisory", () => {
  test("formats round_unit USDC", () => {
    const r = classifyAmount(1_000_000n, 6);
    const line = formatAdvisory(r, 6, "USDC");
    assert.match(line, /WARN: amount 1 USDC looks round \(round_unit\)/);
    assert.match(line, /Suggest perturbing -> .* USDC/);
  });

  test("returns empty for natural amounts", () => {
    const r = classifyAmount(1_234_567n, 6);
    assert.equal(formatAdvisory(r, 6, "USDC"), "");
  });

  test("renders 1.5 USDC correctly", () => {
    const r = classifyAmount(1_500_000n, 6);
    const line = formatAdvisory(r, 6, "USDC");
    assert.match(line, /amount 1.5 USDC/);
  });
});

// ---------------------------------------------------------------------------
// D3: boundary classification edges
// ---------------------------------------------------------------------------

describe("classifyAmount boundary edges", () => {
  test("1 base unit BELOW round_unit (999_999) is natural", () => {
    const r = classifyAmount(999_999n, 6);
    assert.equal(r.classification, "natural");
  });

  test("1 base unit ABOVE round_unit (1_000_001) is natural", () => {
    const r = classifyAmount(1_000_001n, 6); // 7 sig digits
    assert.equal(r.classification, "natural");
  });

  test("100 USDC at base (100_000_000) is round_unit", () => {
    const r = classifyAmount(100_000_000n, 6);
    assert.equal(r.classification, "round_unit");
  });

  test("1M USDC at top of round_unit range (10^12) is round_unit", () => {
    const r = classifyAmount(10n ** 12n, 6);
    assert.equal(r.classification, "round_unit");
  });

  test("10M USDC (10^13) is round_decimal (above unit range, 1 sig digit)", () => {
    const r = classifyAmount(10n ** 13n, 6);
    assert.equal(r.classification, "round_decimal");
  });

  test("100 USDC + 1 base unit (100_000_001) is natural (9 sig digits)", () => {
    const r = classifyAmount(100_000_001n, 6);
    assert.equal(r.classification, "natural");
  });

  test("0.5 WETH BOUNDARY: 5*10^17 is round_tenth", () => {
    const r = classifyAmount(5n * 10n ** 17n, 18);
    assert.equal(r.classification, "round_tenth");
  });

  test("0.5 WETH + 1 wei (5*10^17 + 1) is natural", () => {
    const r = classifyAmount(5n * 10n ** 17n + 1n, 18);
    assert.equal(r.classification, "natural");
  });

  test("0.5 WETH - 1 wei (5*10^17 - 1) is natural", () => {
    const r = classifyAmount(5n * 10n ** 17n - 1n, 18);
    assert.equal(r.classification, "natural");
  });

  test("zero-decimal token (decimals=0): 1 is round_unit", () => {
    const r = classifyAmount(1n, 0);
    assert.equal(r.classification, "round_unit");
  });

  test("zero-decimal token: 2 is round_decimal (1 sig digit, skips round_tenth gate)", () => {
    // decimals=0 skips the round_tenth branch; "2" has 1 sig digit -> round_decimal
    const r = classifyAmount(2n, 0);
    assert.equal(r.classification, "round_decimal");
  });

  test("wBTC 8 decimals: 1 BTC (10^8) is round_unit", () => {
    const r = classifyAmount(10n ** 8n, 8);
    assert.equal(r.classification, "round_unit");
  });

  test("wBTC 8 decimals: 0.1 BTC (10^7) is round_tenth", () => {
    const r = classifyAmount(10n ** 7n, 8);
    assert.equal(r.classification, "round_tenth");
  });

  test("perturbation modulo-collision guard: amount=1 (decimals=0) suggestion differs", () => {
    // For amount=1n, decimals=0: delta rounds to 0n, so guard adds +1n -> suggested=2n
    const r = classifyAmount(1n, 0);
    assert.notEqual(r.suggested, r.baseUnits);
  });
});

// ---------------------------------------------------------------------------
// D3: resolveTokenDecimals full coverage
// ---------------------------------------------------------------------------

describe("resolveTokenDecimals", () => {
  test("USDC -> 6", () => {
    assert.equal(resolveTokenDecimals("USDC"), 6);
  });

  test("usdc lowercase -> 6", () => {
    assert.equal(resolveTokenDecimals("usdc"), 6);
  });

  test("tUSDC testnet prefix -> 6", () => {
    assert.equal(resolveTokenDecimals("tUSDC"), 6);
  });

  test("aUSDC Aztec prefix -> 6", () => {
    assert.equal(resolveTokenDecimals("aUSDC"), 6);
  });

  test("WETH -> 18", () => {
    assert.equal(resolveTokenDecimals("WETH"), 18);
  });

  test("ETH (no W) -> 18", () => {
    assert.equal(resolveTokenDecimals("ETH"), 18);
  });

  test("tETH -> 18", () => {
    assert.equal(resolveTokenDecimals("tETH"), 18);
  });

  test("aWETH -> 18", () => {
    assert.equal(resolveTokenDecimals("aWETH"), 18);
  });

  test("WBTC -> 8", () => {
    assert.equal(resolveTokenDecimals("WBTC"), 8);
  });

  test("BTC -> 8", () => {
    assert.equal(resolveTokenDecimals("BTC"), 8);
  });

  test("tWBTC -> 8", () => {
    assert.equal(resolveTokenDecimals("tWBTC"), 8);
  });

  test("unknown token throws with token name in message", () => {
    assert.throws(() => resolveTokenDecimals("DOGE"), /unknown token|unrecognized token|DOGE/i);
  });

  test("empty string throws", () => {
    assert.throws(() => resolveTokenDecimals(""), Error);
  });
});
