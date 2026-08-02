import { test } from "node:test";
import { strict as assert } from "node:assert";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import {
  loadDecoyRegistry,
  saveDecoyRegistry,
  recordDecoyBatch,
  isDecoy,
  listDecoys,
} from "./decoy-registry.js";

// Isolate HOME so tests don't pollute the real ~/.quetzal/
const origHome = process.env.HOME;
const testHome = mkdtempSync(join(tmpdir(), "quetzal-decoy-test-"));
process.env.HOME = testHome;

/** Mirror of the norm() helper inside decoy-registry.ts (kept in sync). */
const norm = (h: string): string =>
  "0x" + h.toLowerCase().replace(/^0x/, "").padStart(64, "0");

test("empty registry returns {} for unknown wallet", () => {
  assert.deepEqual(loadDecoyRegistry("0xabc1"), {});
});

test("save + load round trip (keys normalized to canonical padded form on load)", () => {
  saveDecoyRegistry("0xabc2", { "0x10": true, "0x20": false });
  // loadDecoyRegistry normalizes all keys to padded canonical form on load,
  // so unpadded keys saved directly are returned in their canonical form.
  assert.deepEqual(loadDecoyRegistry("0xabc2"), {
    [norm("0x10")]: true,
    [norm("0x20")]: false,
  });
});

test("recordDecoyBatch merges + normalises keys (lowercase + padStart 64)", () => {
  recordDecoyBatch("0xabc3", [
    { nonce: "0xAB", isDecoy: true },
    { nonce: "0xCD", isDecoy: false },
  ]);
  recordDecoyBatch("0xabc3", [{ nonce: "0xEF", isDecoy: true }]);
  assert.deepEqual(loadDecoyRegistry("0xabc3"), {
    [norm("0xAB")]: true,
    [norm("0xCD")]: false,
    [norm("0xEF")]: true,
  });
});

test("isDecoy returns true only for explicit decoy=true entries", () => {
  recordDecoyBatch("0xabc4", [
    { nonce: "0x1", isDecoy: true },
    { nonce: "0x2", isDecoy: false },
  ]);
  assert.equal(isDecoy("0xabc4", "0x1"), true);
  assert.equal(isDecoy("0xabc4", "0x2"), false);
  assert.equal(isDecoy("0xabc4", "0x3"), false);  // unknown nonce
});

test("listDecoys returns only decoy=true nonces (padded canonical form)", () => {
  recordDecoyBatch("0xabc5", [
    { nonce: "0x1", isDecoy: true },
    { nonce: "0x2", isDecoy: false },
    { nonce: "0x3", isDecoy: true },
  ]);
  assert.deepEqual(listDecoys("0xabc5").sort(), [norm("0x1"), norm("0x3")].sort());
});

// L7 + L12: legacy migration — a registry written by pre-fix code (unpadded keys)
// must still be found by padded (Fr.toString-style) lookups after normalize-on-load.
test("L7/L12: legacy unpadded key in persisted registry is found by padded lookup", () => {
  const n = 0xabc123n;
  const unpaddedNonce = "0x" + n.toString(16);          // "0xabc123" — as old code stored it
  const paddedNonce   = "0x" + n.toString(16).padStart(64, "0"); // Fr.toString() form
  // Simulate a registry file written by pre-fix code: store the key unpadded.
  saveDecoyRegistry("0xwallet7l12", { [unpaddedNonce]: true });
  // isDecoy must find it via the normalize-on-load pass even though the key
  // on disk is "0xabc123" and the lookup is the 64-char padded form.
  assert.equal(
    isDecoy("0xwallet7l12", paddedNonce),
    true,
    "normalize-on-load must find a legacy unpadded key via padded lookup",
  );
});

process.on("exit", () => {
  process.env.HOME = origHome;
  rmSync(testHome, { recursive: true, force: true });
});
