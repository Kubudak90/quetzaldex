// sdk/src/client.test.ts
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { QuetzalClient } from "./client.js";
import { ConfigError } from "./errors.js";

describe("QuetzalClient.connect", () => {
  test("rejects unknown network with ConfigError", async () => {
    await assert.rejects(
      () =>
        QuetzalClient.connect({
          network: "imaginary-net" as never,
          account: { type: "schnorr", secret: "0x" + "11".repeat(32) },
        }),
      ConfigError,
    );
  });

  test("requires nodeUrl for mainnet (default is empty)", async () => {
    await assert.rejects(
      () =>
        QuetzalClient.connect({
          network: "mainnet",
          account: { type: "schnorr", secret: "0x" + "11".repeat(32) },
        }),
      ConfigError,
    );
  });
});
