/**
 * Cross-component field-order parity guard (Task 9 — clearing-soundness plan).
 *
 * This test pins the output of `computePoolStateCommitment` (aggregator/src/clearing.ts)
 * against a value independently captured from the Noir circuit:
 *
 *   circuits/clearing/src/buckets.nr :: pool_state_commitment
 *
 * The constant CIRCUIT_PINNED_COMMITMENT was obtained by running:
 *
 *   nargo test print_canonical_commitment --show-output
 *
 * on the Noir circuit with the canonical inputs defined below, and recording the
 * printed Field value. The same value must be produced by the pool contract's
 * on-chain recompute (contracts/pool/src/main.nr) because all three components
 * share the identical 25-element Poseidon2 field-order contract.
 *
 * If this assertion EVER fails the JS commitment field order has DRIFTED from
 * the circuit (and the pool contract recompute in contracts/pool/src/main.nr) —
 * every honest clearing would then revert on-chain.  Re-derive both sides before
 * proceeding.
 */

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { computePoolStateCommitment } from "../src/clearing.js";

// Pinned circuit output for the canonical inputs below.
// Hex: 0x1a6686985600f5486294ca5f87f4a4aae8c94ee143be5fb4844521a648e7b0fe
const CIRCUIT_PINNED_COMMITMENT =
  11941281404751935879453980321794172720436913618245103023618331476225260237054n;

describe("computePoolStateCommitment field-order parity guard (Task 9)", () => {
  it("PARITY: JS helper matches pinned Noir circuit output for canonical inputs", async () => {
    // Canonical inputs — identical to what was fed to the circuit's nargo test.
    const sqrtPBefore = 1_000_000_000_000_000_000n; // 1e18

    const beforeStates = [
      {
        reserve_a: 1000n,
        reserve_b: 2000n,
        liquidity: 5000n,
        cum_fee_a_per_share: 0n,
        cum_fee_b_per_share: 0n,
      },
    ];

    // deltas supplies the bucket_id; beforeStates supplies the reserve/fee fields.
    const deltas = [{ bucket_id: 3 }];
    const activeCount = 1;

    const commitment = await computePoolStateCommitment(
      sqrtPBefore,
      beforeStates,
      deltas,
      activeCount,
    );

    assert.equal(
      commitment,
      CIRCUIT_PINNED_COMMITMENT,
      `JS pool_state_commitment DRIFTED from circuit pin!\n` +
        `  computed : ${commitment}\n` +
        `  expected : ${CIRCUIT_PINNED_COMMITMENT}\n` +
        `Re-derive both sides (aggregator clearing.ts + buckets.nr + pool main.nr).`,
    );
  });
});
