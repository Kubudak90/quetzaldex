import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { poseidon2Hash } from "@aztec/foundation/crypto/poseidon";
import { hashUrl } from "./aggregator.js";

describe("hashUrl (M6: chunk long URLs, keep short ones stable)", () => {
  test("a short URL (<=31 bytes) matches the old single-bigint hash (backward-compatible)", async () => {
    const url = "https://node.quetzaldex.xyz"; // 27 bytes
    const bytes = new TextEncoder().encode(url);
    assert.ok(bytes.length <= 31, "precondition: short URL");
    const expected = await poseidon2Hash([BigInt("0x" + Buffer.from(bytes).toString("hex"))]);
    const got = await hashUrl(url);
    assert.equal(got.toString(), expected.toString(), "short-URL hash unchanged");
  });

  test("a URL >= 32 bytes hashes without throwing, deterministically + collision-distinct", async () => {
    const long = "https://aggregator.quetzaldex.xyz/v1/reveal?region=eu-west-1";
    assert.ok(new TextEncoder().encode(long).length >= 32, "precondition: long URL");
    const a = await hashUrl(long); // old code threw here ("greater or equal to field modulus")
    const b = await hashUrl(long);
    assert.equal(a.toString(), b.toString(), "deterministic");
    const other = await hashUrl(long + "x");
    assert.notEqual(a.toString(), other.toString(), "distinct URLs -> distinct hashes");
  });

  test("empty URL hashes to poseidon2([0])", async () => {
    const got = await hashUrl("");
    const expected = await poseidon2Hash([0n]);
    assert.equal(got.toString(), expected.toString());
  });
});
