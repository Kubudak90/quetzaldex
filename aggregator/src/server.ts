/**
 * Fastify HTTP server for aggregator reveal ingestion.
 *
 * Endpoints:
 *  - POST /reveal - accepts a RevealPayload JSON body, validates with zod,
 *    enqueues into the in-memory RevealQueue.
 *  - GET /health - returns { ok: true, queueSize: N } for liveness checks.
 *
 * The server itself is stateless; the queue is passed in by the caller so
 * tests can introspect it without scraping the HTTP API.
 */
import Fastify, { type FastifyInstance } from "fastify";
import { z } from "zod";
import { RevealQueue, type RevealPayload } from "./queue.js";
import { registerProofRoute } from "./proof.js";

const RevealSchema = z.object({
  epoch_id: z.number().int().nonnegative(),
  order_nonce: z.string().regex(/^0x[0-9a-fA-F]+$/),
  side: z.boolean(),
  amount_in: z.string().regex(/^\d+$/),
  limit_price: z.string().regex(/^\d+$/),
  submitted_at_block: z.number().int().nonnegative(),
  owner: z.string().regex(/^0x[0-9a-fA-F]+$/),
  // Audit #11 / #2: the routing path is bound into the per-order commitment c_i.
  // Without forwarding it here, zod strips it and multi-hop (non-pool-0) reveals
  // mis-clear (their c_i is recomputed against the pool-0 fallback path). Optional
  // for backward-compat; validateReveals + clearing-cycle fall back to the pool-0
  // direct path when absent (correct only while just pool 0 is seeded).
  path_len: z.number().int().min(2).max(3).optional(),
  path: z.array(z.string().regex(/^0x[0-9a-fA-F]+$/)).length(3).optional(),
  submission_tx_hash: z.string().optional(),
});

export async function buildServer(
  queue: RevealQueue,
  snapshotsDir: string = process.env.SNAPSHOTS_DIR ?? "aggregator/snapshots",
): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  app.post("/reveal", async (req, reply) => {
    const parse = RevealSchema.safeParse(req.body);
    if (!parse.success) {
      return reply.code(400).send({ error: "invalid payload", issues: parse.error.issues });
    }
    const payload: RevealPayload = parse.data;
    queue.enqueue(payload);
    return { ok: true };
  });

  app.get("/health", async () => ({ ok: true, queueSize: queue.size() }));

  // Sub-4 browser claim path: serve hop-fill Merkle proofs for claim_fill.
  registerProofRoute(app, snapshotsDir);

  await app.ready();
  return app;
}

/** Stand-alone entrypoint (used by `pnpm --filter @quetzal/aggregator start`). */
export async function startServer(port: number = Number(process.env.PORT) || 3000): Promise<void> {
  const queue = new RevealQueue();
  const app = await buildServer(queue);
  await app.listen({ port, host: "0.0.0.0" });
  console.log(`aggregator reveal server listening on :${port}`);
}
