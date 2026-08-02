import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildProofResponse, ProofError } from "../src/proof.js";

// Real on-chain-proven fixture: epoch-11.json carries the order whose claim_fill
// was proven end-to-end (nonce 0x007e9a21…, amount_out 99699958, pool 0, leaf 0).
// These live under test/fixtures because aggregator/snapshots/ is the RUNTIME
// output directory and is gitignored — pointing the test there passed locally
// off stale run output and failed on a fresh clone.
const SNAPSHOTS = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "snapshots");

const NONCE = "0x007e9a2151e9f1fbcf14b3ead589e99a1b6f6bb1be00b2d652edb01767fc4a19";
const FILLS_ROOT = "0x03747eb4c146a4dd8272cc937c22fb1dbd836a6bf2f650d73f9a33dbb7a56401";
const SIBLINGS = [
  "0x20be000d93b852c82d4e02c94e9e61fa3a0e79949aac3af4010620651d416134",
  "0x2b531be43bcdbfb0014cd8842cf18be46bcb09cfbcccb467cf5f27190a80e480",
  "0x0c8d11fe4e37bac6ca7f730a6dd8cf8e5b5eb43a0ba455682556c7e9edc8bf8b",
  "0x2616182a5261077406bad05306c3ac575664f3934af8f35572a6303909002247",
  "0x09b61b4d3868115549b3746d1d92583c079884ebffe17d5167bf385ed6408e84",
  "0x18fac0ce38899869988418ed1fd8a172091f9af56ba5f90d16c5ee49522e3ca6",
];

describe("aggregator/proof — buildProofResponse", () => {
  it("P1: builds the 7-arg claim proof for a filled nonce (auto-discovers epoch)", () => {
    const res = buildProofResponse(SNAPSHOTS, { orderNonce: NONCE });
    assert.equal(res.epoch_id, 11);
    assert.equal(res.fills_root, FILLS_ROOT);
    assert.equal(res.fills.length, 1);
    const f = res.fills[0]!;
    assert.equal(f.order_nonce, NONCE);
    assert.equal(f.hop_index, 0);
    assert.equal(f.amount_out, "99699958");
    assert.equal(f.pool_id, 0);
    assert.equal(f.leaf_index, 0);
    assert.deepEqual(f.sibling_path, SIBLINGS);
  });

  it("P2: normalizes an unpadded nonce (browser passes 0x{toString(16)})", () => {
    // The frontend/decoy-registry store nonces as `0x${n.toString(16)}` (no leading
    // zeros); the snapshot stores the Fr-canonical 64-hex form. Must still match.
    const unpadded = "0x" + BigInt(NONCE).toString(16);
    assert.notEqual(unpadded, NONCE, "guard: this case must actually be unpadded");
    const res = buildProofResponse(SNAPSHOTS, { orderNonce: unpadded });
    assert.equal(res.fills.length, 1);
    assert.equal(res.fills[0]!.order_nonce, NONCE);
  });

  it("P3: honors an explicit epoch_id", () => {
    const res = buildProofResponse(SNAPSHOTS, { orderNonce: NONCE, epochId: 11 });
    assert.equal(res.epoch_id, 11);
    assert.equal(res.fills[0]!.amount_out, "99699958");
  });

  it("P4: filters by hop_index when provided", () => {
    const res = buildProofResponse(SNAPSHOTS, { orderNonce: NONCE, hopIndex: 0 });
    assert.equal(res.fills.length, 1);
    assert.equal(res.fills[0]!.hop_index, 0);
  });

  it("P5: unknown nonce → ProofError 404 (not filled / no snapshot)", () => {
    assert.throws(
      () => buildProofResponse(SNAPSHOTS, { orderNonce: "0x" + "1".repeat(63) + "2" }),
      (e: unknown) => e instanceof ProofError && e.statusCode === 404,
    );
  });

  it("P6: a hop with no fill → ProofError 404", () => {
    assert.throws(
      () => buildProofResponse(SNAPSHOTS, { orderNonce: NONCE, hopIndex: 1 }),
      (e: unknown) => e instanceof ProofError && e.statusCode === 404,
    );
  });

  it("P7: malformed nonce → ProofError 400", () => {
    assert.throws(
      () => buildProofResponse(SNAPSHOTS, { orderNonce: "not-a-field" }),
      (e: unknown) => e instanceof ProofError && e.statusCode === 400,
    );
  });
});
