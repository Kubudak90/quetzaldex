import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { buildClearingWitness, type BucketStateForCircuit, type BucketDeltaForCircuit } from "../src/witness.js";
import { SCALE } from "../src/buckets.js";
import { computePoolStateCommitment, deriveAggregateFlows, recoverForwardedFee } from "../src/clearing.js";

describe("buildClearingWitness 42-field Sub-2.5 shape", () => {
  it("C1: emits Prover.toml with 42-field public layout headers", async () => {
    const witness = await buildClearingWitness({
      epoch: { order_acc: 1n, cancel_acc: 0n, order_count: 1, cancel_count: 0 },
      pool: {
        reserve_a: 1000n * SCALE,
        reserve_b: 1000n * SCALE,
        current_sqrt_price_before: SCALE / 5n,
      },
      orders: [{
        side: false, amount_in: SCALE / 100n, limit_price: SCALE,
        order_nonce: 42n, submitted_at_block: 1, owner: 1n,
      }],
      cancellationIndices: [],
      clearing: {
        cleared: true,
        clearingPrice: SCALE,
        fills: [{ orderNonce: 42n, filledIn: SCALE / 100n, amountOut: 0n }],
        newReserveA: 1000n * SCALE,
        newReserveB: 999n * SCALE,
        feeAPerShareIncrement: 0n,
        feeBPerShareIncrement: 0n,
      },
      bucketStatesBefore: [{
        bucket_id: 4,
        reserve_a: 1000n * SCALE, reserve_b: 1000n * SCALE,
        liquidity: SCALE,
        cum_fee_a_per_share: 0n, cum_fee_b_per_share: 0n,
      }],
      bucketStatesAfter: [{
        bucket_id: 4,
        reserve_a: 1000n * SCALE, reserve_b: 999n * SCALE,
        liquidity: SCALE,
        cum_fee_a_per_share: 0n, cum_fee_b_per_share: 0n,
      }],
      bucketDeltas: [{
        bucket_id: 4,
        reserve_a_add: 0n, reserve_a_sub: 0n,
        reserve_b_add: SCALE / 100n, reserve_b_sub: 0n,
        cum_fee_a_per_share_increment: 0n,
        cum_fee_b_per_share_increment: 0n,
      }],
      currentSqrtPriceAfter: SCALE / 5n + SCALE / 1000n,
    });
    assert.match(witness.proverToml, /order_acc\s*=/);
    assert.match(witness.proverToml, /current_sqrt_price_after\s*=/);
    assert.match(witness.proverToml, /active_bucket_count\s*=/);
    assert.match(witness.proverToml, /active_bucket_deltas\s*=/);
    assert.doesNotMatch(witness.proverToml, /lp_supply\s*=/);
    assert.match(witness.proverToml, /bucket_states_before\s*=/);
    assert.match(witness.proverToml, /bucket_states_after\s*=/);
    assert.match(witness.proverToml, /pool_sqrt_p_before\s*=/);
  });
});

describe("buildClearingWitness padding (Sub-2.5)", () => {
  it("C2: pads bucket_states_before/after + active_bucket_deltas to 4 entries", async () => {
    const w = await buildClearingWitness({
      epoch: { order_acc: 0n, cancel_acc: 0n, order_count: 0, cancel_count: 0 },
      pool: { reserve_a: 1000n * SCALE, reserve_b: 1000n * SCALE, current_sqrt_price_before: SCALE },
      orders: [],
      cancellationIndices: [],
      clearing: {
        cleared: false, clearingPrice: 0n, fills: [],
        newReserveA: 1000n * SCALE, newReserveB: 1000n * SCALE,
        feeAPerShareIncrement: 0n, feeBPerShareIncrement: 0n,
      },
      bucketStatesBefore: [],
      bucketStatesAfter: [],
      bucketDeltas: [],
      currentSqrtPriceAfter: SCALE,
    });
    const deltaEntries = (w.proverToml.match(/bucket_id = /g) ?? []).length;
    assert.equal(deltaEntries, 4, "exactly 4 bucket_delta entries (with sentinels)");
    const beforeSection = w.proverToml.split("bucket_states_before = [")[1]?.split("]")[0] ?? "";
    const beforeEntries = (beforeSection.match(/\{ reserve_a/g) ?? []).length;
    assert.equal(beforeEntries, 4, "4 bucket_states_before entries");
    assert.match(w.proverToml, /bucket_id = 65535/);
  });

  it("C3: emits active_bucket_count = bucketDeltas.length", async () => {
    const w = await buildClearingWitness({
      epoch: { order_acc: 0n, cancel_acc: 0n, order_count: 0, cancel_count: 0 },
      pool: { reserve_a: 0n, reserve_b: 0n, current_sqrt_price_before: SCALE },
      orders: [],
      cancellationIndices: [],
      clearing: {
        cleared: false, clearingPrice: 0n, fills: [],
        newReserveA: 0n, newReserveB: 0n,
        feeAPerShareIncrement: 0n, feeBPerShareIncrement: 0n,
      },
      bucketStatesBefore: [
        { bucket_id: 4, reserve_a: 1n, reserve_b: 1n, liquidity: 1n, cum_fee_a_per_share: 0n, cum_fee_b_per_share: 0n },
        { bucket_id: 5, reserve_a: 2n, reserve_b: 2n, liquidity: 2n, cum_fee_a_per_share: 0n, cum_fee_b_per_share: 0n },
      ],
      bucketStatesAfter: [
        { bucket_id: 4, reserve_a: 1n, reserve_b: 1n, liquidity: 1n, cum_fee_a_per_share: 0n, cum_fee_b_per_share: 0n },
        { bucket_id: 5, reserve_a: 2n, reserve_b: 2n, liquidity: 2n, cum_fee_a_per_share: 0n, cum_fee_b_per_share: 0n },
      ],
      bucketDeltas: [
        { bucket_id: 4, reserve_a_add: 0n, reserve_a_sub: 0n, reserve_b_add: 1n, reserve_b_sub: 0n, cum_fee_a_per_share_increment: 0n, cum_fee_b_per_share_increment: 0n },
        { bucket_id: 5, reserve_a_add: 0n, reserve_a_sub: 0n, reserve_b_add: 1n, reserve_b_sub: 0n, cum_fee_a_per_share_increment: 0n, cum_fee_b_per_share_increment: 0n },
      ],
      currentSqrtPriceAfter: SCALE,
    });
    assert.match(w.proverToml, /active_bucket_count = 2/);
  });

  it("C4: throws if bucketDeltas.length > 4", async () => {
    await assert.rejects(
      buildClearingWitness({
        epoch: { order_acc: 0n, cancel_acc: 0n, order_count: 0, cancel_count: 0 },
        pool: { reserve_a: 0n, reserve_b: 0n, current_sqrt_price_before: SCALE },
        orders: [], cancellationIndices: [],
        clearing: {
          cleared: false, clearingPrice: 0n, fills: [],
          newReserveA: 0n, newReserveB: 0n,
          feeAPerShareIncrement: 0n, feeBPerShareIncrement: 0n,
        },
        bucketStatesBefore: Array.from({ length: 5 }, (_, i) => ({
          bucket_id: i, reserve_a: 0n, reserve_b: 0n, liquidity: 0n,
          cum_fee_a_per_share: 0n, cum_fee_b_per_share: 0n,
        })),
        bucketStatesAfter: Array.from({ length: 5 }, (_, i) => ({
          bucket_id: i, reserve_a: 0n, reserve_b: 0n, liquidity: 0n,
          cum_fee_a_per_share: 0n, cum_fee_b_per_share: 0n,
        })),
        bucketDeltas: Array.from({ length: 5 }, (_, i) => ({
          bucket_id: i, reserve_a_add: 0n, reserve_a_sub: 0n, reserve_b_add: 0n, reserve_b_sub: 0n,
          cum_fee_a_per_share_increment: 0n, cum_fee_b_per_share_increment: 0n,
        })),
        currentSqrtPriceAfter: SCALE,
      }),
      /> cap 4/,
    );
  });
});

import { buildClearingWitnessMultiPair } from "../src/witness.js";
import type { HopFill, PoolClearingResult } from "../src/clearing.js";

describe("Sub-4 buildClearingWitnessMultiPair", () => {
  it("W1: empty multi-pair clearing emits 123-field shape headers (audit #1 + #3)", async () => {
    const w = await buildClearingWitnessMultiPair({
      epoch: { order_acc: 0n, cancel_acc: 0n, order_count: 0, cancel_count: 0 },
      orders: [],
      cancellationIndices: [],
      perPoolClearings: [],
      fills: [],
    });
    assert.match(w.proverToml, /order_acc\s*=/);
    assert.match(w.proverToml, /fills_root\s*=/);
    assert.match(w.proverToml, /active_pool_count\s*=\s*0/);
    assert.match(w.proverToml, /active_pool_clearings\s*=/);
    assert.match(w.proverToml, /fill_to_order_index\s*=/);
    assert.match(w.proverToml, /pool_bucket_states_before\s*=/);
    assert.match(w.proverToml, /pool_bucket_states_after\s*=/);
    assert.match(w.proverToml, /pool_sqrt_p_before\s*=/);
    assert.match(w.proverToml, /pool_token_pairs\s*=/);
    assert.doesNotMatch(w.proverToml, /active_pools\s*=/);
    // Audit #3: token_lo + token_hi in per-pool clearings
    assert.match(w.proverToml, /token_lo\s*=/);
    assert.match(w.proverToml, /token_hi\s*=/);
    // Audit #1: pool_state_commitment in each pool's swap struct
    assert.match(w.proverToml, /pool_state_commitment\s*=/);
  });

  it("W2: pads active_pools to 3 with INVALID_POOL_ID sentinels", async () => {
    const w = await buildClearingWitnessMultiPair({
      epoch: { order_acc: 0n, cancel_acc: 0n, order_count: 0, cancel_count: 0 },
      orders: [],
      cancellationIndices: [],
      perPoolClearings: [],
      fills: [],
    });
    // 3 sentinel slots (pool_id = 0xFFFFFFFF = 4294967295)
    const sentinelCount = (w.proverToml.match(/pool_id\s*=\s*4294967295/g) ?? []).length;
    assert.equal(sentinelCount, 3);
    // Audit #3: each pool slot emits token_lo + token_hi (3 each = 6 total)
    const tokenLoCount = (w.proverToml.match(/token_lo\s*=/g) ?? []).length;
    const tokenHiCount = (w.proverToml.match(/token_hi\s*=/g) ?? []).length;
    assert.equal(tokenLoCount, 3, "3 token_lo entries (one per pool slot)");
    assert.equal(tokenHiCount, 3, "3 token_hi entries (one per pool slot)");
    // Audit #1: each pool slot emits pool_state_commitment (3 total)
    const commitmentCount = (w.proverToml.match(/pool_state_commitment\s*=/g) ?? []).length;
    assert.equal(commitmentCount, 3, "3 pool_state_commitment entries (one per pool slot)");
  });

  it("W3: 2-hop fills produce hop_index 0 and 1 entries", async () => {
    const perPool: PoolClearingResult[] = [
      {
        pool_id: 0, clearingPrice: 2_000_000_000_000_000_000n,
        bucketDeltas: [],
        currentSqrtPriceAfter: 1_000_000_000_000_000_000n,
        bucketStatesBefore: [], bucketStatesAfter: [],
      },
      {
        pool_id: 2, clearingPrice: 1_000_000_000_000_000_000n,
        bucketDeltas: [],
        currentSqrtPriceAfter: 1_000_000_000_000_000_000n,
        bucketStatesBefore: [], bucketStatesAfter: [],
      },
    ];
    const fills: HopFill[] = [
      { orderNonce: 42n, hop_index: 0, amountOut: 50n, pool_id: 0, owner: 1n },
      { orderNonce: 42n, hop_index: 1, amountOut: 25n, pool_id: 2, owner: 1n },
    ];
    const w = await buildClearingWitnessMultiPair({
      epoch: { order_acc: 0n, cancel_acc: 0n, order_count: 1, cancel_count: 0 },
      orders: [{ side: false, amount_in: 100n, limit_price: 1n, order_nonce: 42n, submitted_at_block: 1, owner: 1n }],
      cancellationIndices: [],
      perPoolClearings: perPool,
      fills,
    });
    // fills array entries include hop_index = 0 and 1
    assert.match(w.proverToml, /hop_index\s*=\s*0/);
    assert.match(w.proverToml, /hop_index\s*=\s*1/);
    // Audit #3: per-pool entries include token_lo + token_hi
    assert.match(w.proverToml, /token_lo\s*=/);
    assert.match(w.proverToml, /token_hi\s*=/);
    // Audit #1: per-pool swap structs include pool_state_commitment
    assert.match(w.proverToml, /pool_state_commitment\s*=/);
  });
});

// ---------------------------------------------------------------------------
// Audit #1: pool_state_commitment unit tests
// ---------------------------------------------------------------------------
describe("computePoolStateCommitment (audit #1)", () => {
  it("PSC1: canonical-input commitment is non-zero and deterministic (Task 8 pin value)", async () => {
    // These inputs match the circuit's Task 3 / Task 9 cross-check pin test.
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
    const deltas = [{ bucket_id: 3 }];
    const activeCount = 1;

    const commitment1 = await computePoolStateCommitment(
      sqrtPBefore, beforeStates, deltas, activeCount,
    );
    const commitment2 = await computePoolStateCommitment(
      sqrtPBefore, beforeStates, deltas, activeCount,
    );

    // Log the pinned value for Task 9 cross-check against the Noir circuit.
    console.log("[Task 8 pin] pool_state_commitment canonical input:", commitment1.toString());

    assert.notEqual(commitment1, 0n, "commitment must be non-zero");
    assert.equal(commitment1, commitment2, "commitment must be deterministic (two calls equal)");
  });

  it("PSC2: zero active-count yields a deterministic non-zero commitment (hash of [0;25])", async () => {
    const c0a = await computePoolStateCommitment(0n, [], [], 0);
    const c0b = await computePoolStateCommitment(0n, [], [], 0);
    assert.equal(c0a, c0b, "zero-state commitment is deterministic");
    // The hash of [0;25] is non-zero; sentinel pools should carry 0n explicitly
    // in the calldata (the circuit skips inactive slots via active_pool_count guard).
    console.log("[Task 8 pin] zero-state commitment (hash of [0;25]):", c0a.toString());
  });

  it("PSC3: changing sqrtPBefore changes the commitment", async () => {
    const c1 = await computePoolStateCommitment(1n, [], [], 0);
    const c2 = await computePoolStateCommitment(2n, [], [], 0);
    assert.notEqual(c1, c2, "different sqrtPBefore must yield different commitments");
  });
});

// ---------------------------------------------------------------------------
// deriveAggregateFlows: public-input parity helper unit tests
// ---------------------------------------------------------------------------
describe("deriveAggregateFlows (proof public-input parity)", () => {
  it("DAF1: empty bucketDeltas yields all-zero flows", () => {
    const flows = deriveAggregateFlows([], []);
    assert.equal(flows.aToPool, 0n, "aToPool == 0 for empty deltas");
    assert.equal(flows.bToPool, 0n, "bToPool == 0 for empty deltas");
    assert.equal(flows.aFromPool, 0n, "aFromPool == 0 for empty deltas");
    assert.equal(flows.bFromPool, 0n, "bFromPool == 0 for empty deltas");
  });

  it("DAF2: single bucket — correct sums per field", () => {
    const flows = deriveAggregateFlows([{
      reserve_a_add: 100n,
      reserve_a_sub: 20n,
      reserve_b_add: 300n,
      reserve_b_sub: 50n,
      cum_fee_a_per_share_increment: 0n,
      cum_fee_b_per_share_increment: 0n,
    }], [0n]);
    assert.equal(flows.aToPool, 100n, "aToPool = reserve_a_add");
    assert.equal(flows.aFromPool, 20n, "aFromPool = reserve_a_sub");
    assert.equal(flows.bToPool, 300n, "bToPool = reserve_b_add");
    assert.equal(flows.bFromPool, 50n, "bFromPool = reserve_b_sub");
  });

  it("DAF3: multiple buckets — sums correctly", () => {
    const flows = deriveAggregateFlows([
      { reserve_a_add: 100n, reserve_a_sub: 0n, reserve_b_add: 0n, reserve_b_sub: 200n, cum_fee_a_per_share_increment: 0n, cum_fee_b_per_share_increment: 0n },
      { reserve_a_add: 50n,  reserve_a_sub: 10n, reserve_b_add: 75n, reserve_b_sub: 25n, cum_fee_a_per_share_increment: 0n, cum_fee_b_per_share_increment: 0n },
    ], [0n, 0n]);
    assert.equal(flows.aToPool, 150n, "aToPool = 100 + 50");
    assert.equal(flows.aFromPool, 10n, "aFromPool = 0 + 10");
    assert.equal(flows.bToPool, 75n, "bToPool = 0 + 75");
    assert.equal(flows.bFromPool, 225n, "bFromPool = 200 + 25");
  });

  it("DAF5 (M17): to_pool is GROSS -- includes the derived forwarded fee", () => {
    const flows = deriveAggregateFlows(
      [{
        reserve_a_add: 0n, reserve_a_sub: 0n,
        reserve_b_add: 9970n, reserve_b_sub: 100n,
        cum_fee_a_per_share_increment: 0n,
        cum_fee_b_per_share_increment: 30n,
      }],
      [SCALE],
    );
    assert.equal(flows.bToPool, 10000n, "bToPool = 9970 add + 30 forwarded fee");
    assert.equal(flows.bFromPool, 100n, "from_pool untouched by fee");
    assert.equal(flows.aToPool, 0n);
  });

  it("DAF4: witness TOML emits derived (non-zero) flow values when bucket deltas are non-zero", async () => {
    // This is the regression test for the proof public-input parity bug:
    // before the fix, buildClearingWitnessMultiPair always emitted 0 for these
    // fields while clearing-cycle.ts emitted derived sums — causing verify_proof
    // to fail for any clearing with non-empty bucket deltas.
    const perPool = [{
      pool_id: 1,
      clearingPrice: 1_000_000_000_000_000_000n,
      currentSqrtPriceAfter: 1_000_000_000_000_000_000n,
      bucketDeltas: [{
        bucket_id: 2,
        reserve_a_add: 500n,
        reserve_a_sub: 0n,
        reserve_b_add: 0n,
        reserve_b_sub: 400n,
        cum_fee_a_per_share_increment: 0n,
        cum_fee_b_per_share_increment: 0n,
      }],
      bucketStatesBefore: [{
        reserve_a: 0n, reserve_b: 0n, liquidity: 0n,
        cum_fee_a_per_share: 0n, cum_fee_b_per_share: 0n,
      }],
      bucketStatesAfter: [],
    }];
    const w = await buildClearingWitnessMultiPair({
      epoch: { order_acc: 0n, cancel_acc: 0n, order_count: 0, cancel_count: 0 },
      orders: [],
      cancellationIndices: [],
      perPoolClearings: perPool,
      fills: [],
    });
    // aToPool = reserve_a_add = 500; bFromPool = reserve_b_sub = 400
    assert.match(w.proverToml, /a_to_pool = "500"/, "a_to_pool must be derived (500), not 0");
    assert.match(w.proverToml, /b_from_pool = "400"/, "b_from_pool must be derived (400), not 0");
    assert.match(w.proverToml, /a_from_pool = "0"/, "a_from_pool is 0 (no reserve_a_sub)");
    assert.match(w.proverToml, /b_to_pool = "0"/, "b_to_pool is 0 (no reserve_b_add)");
  });
});

// ---------------------------------------------------------------------------
// M17: recoverForwardedFee -- derived LP fee (Noir mul_div floor parity)
// ---------------------------------------------------------------------------
describe("recoverForwardedFee (M17 derived fee)", () => {
  it("RFF1: L == SCALE identity: fee_rec == inc", () => {
    const { feeA, feeB } = recoverForwardedFee(
      [{ cum_fee_a_per_share_increment: 0n, cum_fee_b_per_share_increment: 30n }],
      [SCALE],
    );
    assert.equal(feeA, 0n);
    assert.equal(feeB, 30n, "mul_div(30, SCALE, SCALE) == 30");
  });

  it("RFF2: floor round-trip loses at most rounding dust", () => {
    // stepFee = 7, L = 3e6: inc = floor(7*SCALE/L) = 2_333_333_333_333 (floor),
    // round-trip fee_rec = floor(inc*L/SCALE) = 6 -- one raw unit of dust lost.
    const L = 3_000_000n;
    const inc = (7n * SCALE) / L; // aggregator's cum_fee_inc formula
    const { feeB } = recoverForwardedFee(
      [{ cum_fee_a_per_share_increment: 0n, cum_fee_b_per_share_increment: inc }],
      [L],
    );
    assert.equal(feeB, 6n, "floor(inc*L/SCALE) = 6 <= stepFee 7 (dust 1)");
  });

  it("RFF3: L >> SCALE corner: inc rounds to 0 -> fee_rec 0", () => {
    const L = 5n * SCALE;
    const inc = (3n * SCALE) / L; // = 0
    assert.equal(inc, 0n);
    const { feeB } = recoverForwardedFee(
      [{ cum_fee_a_per_share_increment: 0n, cum_fee_b_per_share_increment: inc }],
      [L],
    );
    assert.equal(feeB, 0n, "nothing credited, nothing forwarded -- still solvent");
  });

  it("RFF4: multi-bucket sums per token", () => {
    const { feeA, feeB } = recoverForwardedFee(
      [
        { cum_fee_a_per_share_increment: 10n, cum_fee_b_per_share_increment: 0n },
        { cum_fee_a_per_share_increment: 5n, cum_fee_b_per_share_increment: 7n },
      ],
      [SCALE, SCALE],
    );
    assert.equal(feeA, 15n);
    assert.equal(feeB, 7n);
  });

  it("RFF5: length mismatch throws", () => {
    assert.throws(
      () => recoverForwardedFee(
        [{ cum_fee_a_per_share_increment: 1n, cum_fee_b_per_share_increment: 1n }],
        [],
      ),
      /recoverForwardedFee/,
    );
  });
});
