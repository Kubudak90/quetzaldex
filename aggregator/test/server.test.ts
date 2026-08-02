import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildServer } from "../src/server.js";
import { RevealQueue } from "../src/queue.js";
import type { FastifyInstance } from "fastify";

// Tracked fixtures — aggregator/snapshots/ is gitignored runtime output.
const SNAPSHOTS = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "snapshots");
const FILLED_NONCE = "0x007e9a2151e9f1fbcf14b3ead589e99a1b6f6bb1be00b2d652edb01767fc4a19";

const SAMPLE = {
  epoch_id: 7,
  order_nonce: "0xabc",
  side: false,
  amount_in: "1000",
  limit_price: "2000000000000000000",
  submitted_at_block: 42,
  owner: "0xdeadbeef",
};

describe("aggregator/server", () => {
  let app: FastifyInstance;
  let queue: RevealQueue;

  before(async () => {
    queue = new RevealQueue();
    app = await buildServer(queue);
  });

  after(async () => {
    await app.close();
  });

  it("S1: POST /reveal enqueues a valid payload", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/reveal",
      payload: SAMPLE,
    });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { ok: true });
    assert.equal(queue.size(), 1);
  });

  it("GET /health reports queue size", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { ok: boolean; queueSize: number };
    assert.equal(body.ok, true);
    assert.equal(body.queueSize, 1, "queue still has the previous payload");
  });

  it("S2: malformed payload returns 400", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/reveal",
      payload: { epoch_id: "not-a-number" },
    });
    assert.equal(res.statusCode, 400);
  });

  it("S3: duplicate (epoch_id, order_nonce) is silently dropped by queue dedup", async () => {
    // Drain previous test's queue state, then re-test fresh.
    queue.drainEpoch(7);
    await app.inject({ method: "POST", url: "/reveal", payload: SAMPLE });
    await app.inject({ method: "POST", url: "/reveal", payload: { ...SAMPLE, amount_in: "9999" } });
    assert.equal(queue.size(), 1, "second post with same key must be deduped");
  });
});

describe("aggregator/server — GET /proof", () => {
  let app: FastifyInstance;

  before(async () => {
    app = await buildServer(new RevealQueue(), SNAPSHOTS);
  });
  after(async () => {
    await app.close();
  });

  it("P-HTTP1: returns the 7-arg claim proof for a filled nonce", async () => {
    const res = await app.inject({ method: "GET", url: `/proof?order_nonce=${FILLED_NONCE}` });
    assert.equal(res.statusCode, 200);
    const body = res.json() as {
      epoch_id: number;
      fills_root: string;
      fills: Array<{ amount_out: string; sibling_path: string[] }>;
    };
    assert.equal(body.epoch_id, 11);
    assert.equal(body.fills.length, 1);
    assert.equal(body.fills[0]!.amount_out, "99699958");
    assert.equal(body.fills[0]!.sibling_path.length, 6);
  });

  it("P-HTTP2: unknown nonce → 404", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/proof?order_nonce=0x${"1".repeat(63)}2`,
    });
    assert.equal(res.statusCode, 404);
  });

  it("P-HTTP3: missing order_nonce → 400", async () => {
    const res = await app.inject({ method: "GET", url: "/proof" });
    assert.equal(res.statusCode, 400);
  });
});
