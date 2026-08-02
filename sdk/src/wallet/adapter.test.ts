// sdk/src/wallet/adapter.test.ts
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { SchnorrSecretAdapter } from "./schnorr.js";
import type { WalletAdapter } from "./adapter.js";
import { ConfigError } from "../errors.js";

describe("SchnorrSecretAdapter", () => {
  test("rejects empty secret with ConfigError", () => {
    assert.throws(
      () => new SchnorrSecretAdapter({ secret: "", nodeUrl: "http://localhost:8080" }),
      ConfigError,
    );
  });
  test("rejects secret without 0x prefix with ConfigError", () => {
    assert.throws(
      () => new SchnorrSecretAdapter({ secret: "11".repeat(32), nodeUrl: "http://localhost:8080" }),
      ConfigError,
    );
  });
  test("constructs with valid 0x-prefixed secret + nodeUrl + exposes connect/stop interface", () => {
    const adapter: WalletAdapter = new SchnorrSecretAdapter({
      secret: "0x" + "11".repeat(32),
      nodeUrl: "http://localhost:8080",
    });
    assert.equal(typeof adapter.connect, "function");
    assert.equal(typeof adapter.stop, "function");
  });
});
