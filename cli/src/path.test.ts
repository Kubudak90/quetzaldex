import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { parsePath, canonicalize } from "./path.js";

describe("Sub-4 CLI path parsing + canonicalization", () => {
  it("parses 1-hop comma list", () => {
    const out = parsePath("tUSDC,tETH", { tUSDC: "0x111", tETH: "0x222" });
    assert.equal(out.path_len, 2);
    assert.equal(out.path[0], "0x111");
    assert.equal(out.path[1], "0x222");
    assert.equal(out.path[2], "0x0");
  });

  it("parses 2-hop comma list", () => {
    const out = parsePath("tUSDC,tETH,tBTC",
      { tUSDC: "0x111", tETH: "0x222", tBTC: "0x333" });
    assert.equal(out.path_len, 3);
    assert.deepEqual(out.path, ["0x111", "0x222", "0x333"]);
  });

  it("rejects 4+ hop paths", () => {
    assert.throws(() => parsePath("a,b,c,d", { a: "0x1", b: "0x2", c: "0x3", d: "0x4" }),
      /path_len must be 2 or 3/);
  });

  it("rejects 1-token paths", () => {
    assert.throws(() => parsePath("tUSDC", { tUSDC: "0x111" }),
      /path_len must be 2 or 3/);
  });

  it("rejects unknown token alias", () => {
    assert.throws(() => parsePath("tUSDC,tXYZ", { tUSDC: "0x111" }),
      /unknown token alias: tXYZ/);
  });

  it("rejects duplicate tokens in path", () => {
    assert.throws(() => parsePath("tUSDC,tUSDC", { tUSDC: "0x111" }),
      /path\[0\] == path\[1\]/);
  });

  it("canonicalize returns lex-ordered pair", () => {
    // 0x111 < 0x222 as bigint
    assert.deepEqual(canonicalize("0x222", "0x111"), ["0x111", "0x222"]);
    assert.deepEqual(canonicalize("0x111", "0x222"), ["0x111", "0x222"]);
  });
});
