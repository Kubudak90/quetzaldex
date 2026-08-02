/**
 * The clearing circuit indexes active pools by SLOT, not by global pool id:
 * block B resolves a fill's slot from its hop token pair and asserts
 * `fills[f].pool_id == pool_slot`, and blocks C2/D index the active-pool arrays
 * with that same value. The engine tags fills with the GLOBAL pool id, and the
 * two coincide only when the active set is the prefix 0..k — which is why every
 * epoch whose only active pool was pool 1 died in `nargo execute` with
 * "fill pool_id != resolved pool slot" (live, v5 testnet) while pool-0-only
 * epochs cleared fine.
 */
import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { remapFillPoolIdsToSlots } from "../src/clearing-cycle.js";

describe("remapFillPoolIdsToSlots — fills carry the circuit's SLOT index", () => {
  it("the regression: a lone pool 1 becomes slot 0", () => {
    const fills = [{ pool_id: 1 }, { pool_id: 1 }];
    remapFillPoolIdsToSlots(fills, [{ pool_id: 1 }]);
    assert.deepEqual(fills, [{ pool_id: 0 }, { pool_id: 0 }]);
  });

  it("slots follow the ascending pool-id order the witness sorts by", () => {
    const fills = [{ pool_id: 2 }, { pool_id: 0 }, { pool_id: 1 }];
    // Deliberately unsorted: the witness sorts perPoolClearings by pool_id, so
    // the slot map must too — not take the caller's array order.
    remapFillPoolIdsToSlots(fills, [{ pool_id: 2 }, { pool_id: 0 }, { pool_id: 1 }]);
    assert.deepEqual(fills, [{ pool_id: 2 }, { pool_id: 0 }, { pool_id: 1 }]);
  });

  it("a non-prefix active set is compacted (pools 1 and 2 -> slots 0 and 1)", () => {
    const fills = [{ pool_id: 2 }, { pool_id: 1 }];
    remapFillPoolIdsToSlots(fills, [{ pool_id: 1 }, { pool_id: 2 }]);
    assert.deepEqual(fills, [{ pool_id: 1 }, { pool_id: 0 }]);
  });

  it("the prefix case is a no-op (why this bug hid behind pool 0)", () => {
    const fills = [{ pool_id: 0 }, { pool_id: 1 }];
    remapFillPoolIdsToSlots(fills, [{ pool_id: 0 }, { pool_id: 1 }]);
    assert.deepEqual(fills, [{ pool_id: 0 }, { pool_id: 1 }]);
  });

  it("throws when a fill references a pool that is not active", () => {
    assert.throws(
      () => remapFillPoolIdsToSlots([{ pool_id: 2 }], [{ pool_id: 0 }, { pool_id: 1 }]),
      /fill references pool 2, which is not among the active pools \[0, 1\]/,
    );
  });
});
