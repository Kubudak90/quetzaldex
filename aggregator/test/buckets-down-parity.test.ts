import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { nextSqrtPDown, nextSqrtPUp, SCALE } from "../src/buckets.js";

// R6 regression: the off-chain nextSqrtPDown MUST be byte-identical to the
// circuit's next_sqrt_p_down (circuits/clearing/src/buckets.nr:112-118), which
// the clearing circuit asserts with NO tolerance
// (circuits/clearing/src/main.nr:413, `assert(sqrt_p_chain == current_sqrt_price_after)`).
//
// The circuit does TWO floors:
//   denom = L + mul_div(delta_a, sqrt_p, SCALE)   // inner floor
//   result = mul_div(sqrt_p, L, denom)            // outer floor
// The old JS did ONE floor over the whole expression
//   (sqrt_p * L * SCALE) / (L * SCALE + delta_a * sqrt_p)
// which has an EXACT denominator. They agree only when sqrt_p == SCALE (price 1.0)
// — exactly the value the prior DOWN test pinned — and diverge at every other price,
// making buy-heavy (price-DOWN) epochs unprovable.

/** Reference: the circuit's exact two-step integer form (source of truth). */
function circuitNextSqrtPDown(L: bigint, sqrtP: bigint, deltaA: bigint): bigint {
  const denom = L + (deltaA * sqrtP) / SCALE; // inner floor
  return (sqrtP * L) / denom; // outer floor
}

describe("R6: nextSqrtPDown parity with the clearing circuit", () => {
  it("matches the circuit's two-step form at price != 1.0 (the buy-heavy case)", () => {
    // price ~= 3  => sqrt_p = floor(sqrt(3) * 1e18)
    const sqrtP = 1_732_050_807_568_877_293n;
    const L = 50_000_000_000_000n; // 5e13
    const deltaA = 100_000_000n; // 1e8

    // The circuit-correct value (what the on-chain assert demands).
    const expected = 1_732_044_807_589_688_049n;
    assert.equal(circuitNextSqrtPDown(L, sqrtP, deltaA), expected, "reference sanity");

    // The off-chain math MUST equal it. The old single-floor JS returns
    // 1_732_044_807_589_661_830n (26_219 low) -> unprovable epoch.
    assert.equal(nextSqrtPDown(L, sqrtP, deltaA), expected);
  });

  it("matches the circuit across a sweep of non-unit prices and deltas", () => {
    const Ls = [7_000_000_000_000n, 5e13, 1_234_567_890_123n].map(BigInt);
    const sqrtPs = [
      1_500_000_000_000_000_000n, // price 2.25
      1_118_033_988_749_894_848n, // price 1.25
      2_236_067_977_499_789_696n, // price 5.0
      999_999_999_999_999_983n, // just below 1.0
    ];
    const deltas = [1n, 333_333n, 100_000_000n, 999_999_999_999n];
    for (const L of Ls) {
      for (const sqrtP of sqrtPs) {
        for (const dA of deltas) {
          assert.equal(
            nextSqrtPDown(L, sqrtP, dA),
            circuitNextSqrtPDown(L, sqrtP, dA),
            `diverged at L=${L} sqrtP=${sqrtP} dA=${dA}`,
          );
        }
      }
    }
  });

  it("still agrees at price 1.0 (the case the old test pinned)", () => {
    const L = 50_000_000_000_000n;
    const dA = 100_000_000n;
    assert.equal(nextSqrtPDown(L, SCALE, dA), circuitNextSqrtPDown(L, SCALE, dA));
  });

  it("UP direction is unaffected (single-floor is already circuit-exact there)", () => {
    const L = 50_000_000_000_000n;
    const sqrtP = 1_732_050_807_568_877_293n;
    const dB = 100_000_000n;
    // circuit next_sqrt_p_up = sqrt_p + mul_div(delta_b, SCALE, L)
    const expected = sqrtP + (dB * SCALE) / L;
    assert.equal(nextSqrtPUp(L, sqrtP, dB), expected);
  });
});
