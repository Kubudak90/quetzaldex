// sdk/src/wallet/pool.test.ts
// Sub-6c B4: unit tests for WalletPool.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { WalletPool, PXE_TAGGING_CAP, deriveChildSecret } from "./pool.js";
import { ConfigError } from "../errors.js";

describe("WalletPool — input validation", () => {
  test("rejects masterSecret without 0x prefix", async () => {
    await assert.rejects(
      () => WalletPool.fromMaster({
        masterSecret: "11".repeat(32),
        n: 3,
        network: "alpha-testnet",
        nodeUrl: "http://localhost:8080",
      }),
      ConfigError,
    );
  });

  test("rejects masterSecret of wrong length", async () => {
    await assert.rejects(
      () => WalletPool.fromMaster({
        masterSecret: "0xabcd",
        n: 3,
        network: "alpha-testnet",
        nodeUrl: "http://localhost:8080",
      }),
      ConfigError,
    );
  });

  test("rejects n = 0", async () => {
    await assert.rejects(
      () => WalletPool.fromMaster({
        masterSecret: "0x" + "11".repeat(32),
        n: 0,
        network: "alpha-testnet",
        nodeUrl: "http://localhost:8080",
      }),
      ConfigError,
    );
  });

  test("rejects n > 20", async () => {
    await assert.rejects(
      () => WalletPool.fromMaster({
        masterSecret: "0x" + "11".repeat(32),
        n: 21,
        network: "alpha-testnet",
        nodeUrl: "http://localhost:8080",
      }),
      ConfigError,
    );
  });
});

describe("deriveChildSecret", () => {
  test("deterministic: same input yields same output", () => {
    const a = deriveChildSecret("0x" + "11".repeat(32), 0);
    const b = deriveChildSecret("0x" + "11".repeat(32), 0);
    assert.equal(a, b);
  });

  test("distinct indices yield distinct outputs", () => {
    const a = deriveChildSecret("0x" + "11".repeat(32), 0);
    const b = deriveChildSecret("0x" + "11".repeat(32), 1);
    assert.notEqual(a, b);
  });
});

describe("PXE_TAGGING_CAP", () => {
  test("is 18 (2 below Aztec's ~20 for safety buffer)", () => {
    assert.equal(PXE_TAGGING_CAP, 18);
  });
});

describe("WalletPool — saturation semantics", () => {
  test("saturated wallet is skipped by next()", () => {
    const a = makeStubChild(0);
    const b = makeStubChild(1);
    a.pendingTx = PXE_TAGGING_CAP; // saturate
    const pool = WalletPool.__forTesting__([a, b]);
    const picked = pool.next();
    assert.equal(picked.address.toString(), b.client.address.toString());
  });

  test("WalletPoolExhausted thrown when all saturated", () => {
    const a = makeStubChild(0);
    const b = makeStubChild(1);
    a.pendingTx = PXE_TAGGING_CAP;
    b.pendingTx = PXE_TAGGING_CAP;
    const pool = WalletPool.__forTesting__([a, b]);
    assert.throws(() => pool.next(), /WalletPoolExhausted/);
  });

  test("acquireFor tag is stable across calls", () => {
    const a = makeStubChild(0);
    const b = makeStubChild(1);
    const pool = WalletPool.__forTesting__([a, b]);
    const first = pool.acquireFor("session-xyz");
    const second = pool.acquireFor("session-xyz");
    assert.equal(first.address.toString(), second.address.toString());
  });
});

describe("WalletPool — round-robin behavior", () => {
  test("next() round-robins across children when all under cap", () => {
    const a = makeStubChild(0);
    const b = makeStubChild(1);
    const c = makeStubChild(2);
    const pool = WalletPool.__forTesting__([a, b, c]);
    const first = pool.next();
    const second = pool.next();
    const third = pool.next();
    const fourth = pool.next();
    assert.equal(first.address.toString(), a.client.address.toString());
    assert.equal(second.address.toString(), b.client.address.toString());
    assert.equal(third.address.toString(), c.client.address.toString());
    assert.equal(fourth.address.toString(), a.client.address.toString()); // wraps around
  });
});

describe("WalletPool — size + addresses", () => {
  test("size reflects children count", () => {
    const pool = WalletPool.__forTesting__([makeStubChild(0), makeStubChild(1), makeStubChild(2)]);
    assert.equal(pool.size, 3);
  });

  test("addresses lists all child addresses", () => {
    const pool = WalletPool.__forTesting__([makeStubChild(0), makeStubChild(1)]);
    assert.deepEqual(pool.addresses, ["0xstub0", "0xstub1"]);
  });
});

describe("deriveChildSecret — format", () => {
  test("returns 0x-prefixed hex32 (66 chars)", () => {
    const s = deriveChildSecret("0x" + "ff".repeat(32), 5);
    assert.ok(s.startsWith("0x"));
    assert.equal(s.length, 66);
  });
});

// Test stub: minimal PoolChild satisfying the structural shape used by next/acquireFor.
function makeStubChild(index: number): { client: { address: { toString: () => string }; stop: () => Promise<void>; orders: object; bridge: object }; index: number; pendingTx: number } {
  return {
    client: {
      address: { toString: () => `0xstub${index}` },
      stop: async () => {},
      orders: {},
      bridge: {},
    },
    index,
    pendingTx: 0,
  };
}
