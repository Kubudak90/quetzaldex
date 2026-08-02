// sdk/src/aggregator.test.ts
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { AggregatorApi } from "./aggregator.js";
import { OrderError } from "./errors.js";
import type { QuetzalClient } from "./client.js";

// Minimal stub: directReveal only uses `fetch` — no client methods needed.
const stubClient = {} as unknown as QuetzalClient;

describe("AggregatorApi.directReveal", () => {
  const api = new AggregatorApi(stubClient);

  const samplePayload: Record<string, unknown> = {
    epoch_id: 1,
    order_nonce: "0xdeadbeef",
    side: true,
    amount_in: "1000000",
    limit_price: "3000000000",
    submitted_at_block: 42,
    owner: "0xabcd1234",
  };

  let originalFetch: typeof globalThis.fetch;

  before(() => {
    originalFetch = globalThis.fetch;
  });

  after(() => {
    globalThis.fetch = originalFetch;
  });

  test("returns true when server responds HTTP 200", async () => {
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ ok: true }), { status: 200 }) as unknown as Response;

    const result = await api.directReveal("http://localhost:3001", samplePayload);
    assert.equal(result, true);
  });

  test("returns false when fetch throws a network error", async () => {
    globalThis.fetch = async () => {
      throw new Error("ECONNREFUSED");
    };

    const result = await api.directReveal("http://localhost:3001", samplePayload);
    assert.equal(result, false);
  });

  test("returns false when server responds HTTP 400", async () => {
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ error: "invalid payload" }), { status: 400 }) as unknown as Response;

    const result = await api.directReveal("http://localhost:3001", samplePayload);
    assert.equal(result, false);
  });
});

describe("AggregatorApi.fetchHopProof", () => {
  const api = new AggregatorApi(stubClient);

  const NONCE = "0x007e9a2151e9f1fbcf14b3ead589e99a1b6f6bb1be00b2d652edb01767fc4a19";
  const PROOF = {
    epoch_id: 11,
    fills_root: "0x03747eb4c146a4dd8272cc937c22fb1dbd836a6bf2f650d73f9a33dbb7a56401",
    fills: [
      {
        order_nonce: NONCE,
        hop_index: 0,
        amount_out: "99699958",
        pool_id: 0,
        leaf_index: 0,
        sibling_path: ["0x01", "0x02", "0x03", "0x04", "0x05", "0x06"],
      },
    ],
  };

  let originalFetch: typeof globalThis.fetch;
  let lastUrl: string | undefined;

  before(() => {
    originalFetch = globalThis.fetch;
  });
  after(() => {
    globalThis.fetch = originalFetch;
  });

  test("GETs {base}/proof with order_nonce + epoch_id and returns the parsed proof", async () => {
    globalThis.fetch = async (input: unknown) => {
      lastUrl = String(input);
      return new Response(JSON.stringify(PROOF), { status: 200 }) as unknown as Response;
    };
    const res = await api.fetchHopProof("/api", { orderNonce: BigInt(NONCE), epochId: 11 });
    assert.equal(res.epoch_id, 11);
    assert.equal(res.fills.length, 1);
    assert.equal(res.fills[0]!.amount_out, "99699958");
    assert.equal(res.fills[0]!.sibling_path.length, 6);

    assert.ok(lastUrl?.startsWith("/api/proof?"), `expected /api/proof? got ${lastUrl}`);
    const u = new URL(lastUrl!, "http://stub");
    // bigint nonce is sent unpadded; the server normalizes it back to Fr-canonical.
    assert.equal(u.searchParams.get("order_nonce"), "0x" + BigInt(NONCE).toString(16));
    assert.equal(u.searchParams.get("epoch_id"), "11");
  });

  test("includes hop_index in the query when provided", async () => {
    globalThis.fetch = async (input: unknown) => {
      lastUrl = String(input);
      return new Response(JSON.stringify(PROOF), { status: 200 }) as unknown as Response;
    };
    await api.fetchHopProof("/api", { orderNonce: "0xabc", hopIndex: 1 });
    const u = new URL(lastUrl!, "http://stub");
    assert.equal(u.searchParams.get("order_nonce"), "0xabc");
    assert.equal(u.searchParams.get("hop_index"), "1");
    assert.equal(u.searchParams.get("epoch_id"), null);
  });

  test("throws with the server error detail on non-200", async () => {
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ error: "no fill for nonce 0xabc in epoch-9 snapshot" }), {
        status: 404,
      }) as unknown as Response;
    await assert.rejects(
      () => api.fetchHopProof("/api", { orderNonce: "0xabc" }),
      (err: Error) => {
        assert.ok(err instanceof OrderError, `expected OrderError, got ${err.constructor.name}`);
        assert.match(err.message, /404.*no fill for nonce/);
        return true;
      },
    );
  });

  // L9: malformed-200 (missing fills or wrong shape) must throw OrderError, not TypeError
  test("L9: malformed 200 — missing fills array — throws OrderError", async () => {
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ epoch_id: 5, wrong_key: [] }), {
        status: 200,
      }) as unknown as Response;
    await assert.rejects(
      () => api.fetchHopProof("/api", { orderNonce: "0xabc" }),
      (err: Error) => {
        assert.ok(err instanceof OrderError, `expected OrderError, got ${err.constructor.name}`);
        assert.match(err.message, /malformed hop-proof/);
        return true;
      },
    );
  });

  test("L9: malformed 200 — non-JSON body — throws OrderError", async () => {
    globalThis.fetch = async () =>
      new Response("<html>error</html>", { status: 200 }) as unknown as Response;
    await assert.rejects(
      () => api.fetchHopProof("/api", { orderNonce: "0xabc" }),
      (err: Error) => {
        assert.ok(err instanceof OrderError, `expected OrderError, got ${err.constructor.name}`);
        assert.match(err.message, /malformed hop-proof/);
        return true;
      },
    );
  });

  test("L9: malformed 200 — epoch_id not a number — throws OrderError", async () => {
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ epoch_id: "eleven", fills: [] }), {
        status: 200,
      }) as unknown as Response;
    await assert.rejects(
      () => api.fetchHopProof("/api", { orderNonce: "0xabc" }),
      (err: Error) => {
        assert.ok(err instanceof OrderError, `expected OrderError, got ${err.constructor.name}`);
        assert.match(err.message, /malformed hop-proof/);
        return true;
      },
    );
  });
});
