import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateSplitOptions } from "./split-validation.js";

const OK = { splitInto: 3, intervalDays: 7, relayerFee: 0n };

describe("validateSplitOptions (M8/M9)", () => {
  it("accepts valid options (including splitInto=1 with a relayer fee)", () => {
    assert.doesNotThrow(() => validateSplitOptions(OK));
    assert.doesNotThrow(() => validateSplitOptions({ splitInto: 1, intervalDays: 3, relayerFee: 500n }));
    assert.doesNotThrow(() => validateSplitOptions({ splitInto: 20, intervalDays: 90, relayerFee: 0n }));
  });

  it("M8: rejects a NaN / fractional / out-of-range splitInto", () => {
    assert.throws(() => validateSplitOptions({ ...OK, splitInto: Number("abc") }), /--split-into/);
    assert.throws(() => validateSplitOptions({ ...OK, splitInto: 2.5 }), /--split-into/);
    assert.throws(() => validateSplitOptions({ ...OK, splitInto: 0 }), /--split-into/);
    assert.throws(() => validateSplitOptions({ ...OK, splitInto: 21 }), /--split-into/);
  });

  it("M8: rejects a NaN / out-of-range intervalDays", () => {
    assert.throws(() => validateSplitOptions({ ...OK, intervalDays: Number("x") }), /--interval-days/);
    assert.throws(() => validateSplitOptions({ ...OK, intervalDays: 0 }), /--interval-days/);
    assert.throws(() => validateSplitOptions({ ...OK, intervalDays: 91 }), /--interval-days/);
  });

  it("M9: rejects a relayer fee combined with --split-into", () => {
    assert.throws(
      () => validateSplitOptions({ splitInto: 5, intervalDays: 7, relayerFee: 500n }),
      /--relayer-fee is not supported with --split-into/,
    );
  });
});
