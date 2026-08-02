import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { resolvePoolId, resolveHopPools, type PoolRegistry } from "../src/path.js";

const REGISTRY: PoolRegistry = [
  { pool_id: 0, token_a: 0x111n, token_b: 0x222n },
  { pool_id: 1, token_a: 0x111n, token_b: 0x333n },
  { pool_id: 2, token_a: 0x222n, token_b: 0x333n },
];

describe("Sub-4 aggregator path resolver", () => {
  it("resolves canonical pair regardless of input order", () => {
    assert.equal(resolvePoolId(REGISTRY, 0x111n, 0x222n), 0);
    assert.equal(resolvePoolId(REGISTRY, 0x222n, 0x111n), 0);
    assert.equal(resolvePoolId(REGISTRY, 0x222n, 0x333n), 2);
    assert.equal(resolvePoolId(REGISTRY, 0x333n, 0x222n), 2);
  });
  it("returns -1 for unknown pair", () => {
    assert.equal(resolvePoolId(REGISTRY, 0x111n, 0x444n), -1);
  });
  it("resolveHopPools resolves a 1-hop path", () => {
    const hops = resolveHopPools(REGISTRY, [0x111n, 0x222n]);
    assert.deepEqual(hops, [0]);
  });
  it("resolveHopPools resolves a 2-hop path", () => {
    const hops = resolveHopPools(REGISTRY, [0x111n, 0x222n, 0x333n]);
    assert.deepEqual(hops, [0, 2]);
  });
  it("resolveHopPools throws on unknown hop", () => {
    assert.throws(
      () => resolveHopPools(REGISTRY, [0x111n, 0x222n, 0x444n]),
      /no pool for hop 1/,
    );
  });
});
