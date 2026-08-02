/**
 * Sub-4 browser claim path: assemble the 7-arg `claim_fill` proof from a persisted
 * hop-fill snapshot. This is the HTTP-servable mirror of the CLI's snapshot →
 * Merkle-proof construction (cli/src/commands/claim.ts loadHopSnapshot /
 * computeHopMerkleProof), factored into a pure function so both the Fastify route
 * (server.ts + main.ts) and the unit tests exercise the exact same logic.
 *
 * The maker calls claim_fill(epoch_id, order_nonce, hop_index, amount_out, pool_id,
 * leaf_index, sibling_path[6]); this returns every populated hop for the nonce with
 * the depth-6 inclusion path harvested by buildHopFillsTree.
 */
import { existsSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import { Fr } from "@aztec/aztec.js/fields";
import { findEpochForNonceHop, readHopSnapshot, snapshotPath } from "./snapshot.js";

export interface HopProofLeaf {
  order_nonce: string; // Fr-canonical 0x hex
  hop_index: number;
  amount_out: string; // decimal bigint string
  pool_id: number;
  leaf_index: number;
  sibling_path: string[]; // length 6, 0x hex
}

export interface ProofResponse {
  epoch_id: number;
  fills_root: string;
  fills: HopProofLeaf[];
}

/** Carries an HTTP status so the Fastify handler can map it without sniffing message text. */
export class ProofError extends Error {
  statusCode: number;
  constructor(statusCode: number, message: string) {
    super(message);
    this.name = "ProofError";
    this.statusCode = statusCode;
  }
}

/**
 * Accept a padded (Fr-canonical 64-hex) OR unpadded (`0x${n.toString(16)}`, as the
 * frontend + decoy-registry store) nonce and normalize to the snapshot's
 * Fr.toString() form, so the leaf lookup matches regardless of leading zeros.
 */
function normalizeNonce(raw: string): string {
  if (typeof raw !== "string" || !/^0x[0-9a-fA-F]+$/.test(raw)) {
    throw new ProofError(400, `invalid order_nonce '${raw}' — expected 0x-prefixed hex Field`);
  }
  try {
    return new Fr(BigInt(raw)).toString();
  } catch {
    throw new ProofError(400, `order_nonce '${raw}' is out of Field range`);
  }
}

export function buildProofResponse(
  snapshotsDir: string,
  params: { orderNonce: string; hopIndex?: number; epochId?: number },
): ProofResponse {
  const nonceHex = normalizeNonce(params.orderNonce);

  const epochId =
    params.epochId !== undefined && params.epochId !== null
      ? params.epochId
      : findEpochForNonceHop(snapshotsDir, nonceHex);
  if (epochId === null || epochId === undefined) {
    throw new ProofError(
      404,
      `no snapshot contains a fill for nonce ${nonceHex} ` +
        `(order not filled yet, or the aggregator wrote no snapshot for it)`,
    );
  }

  if (!existsSync(snapshotPath(snapshotsDir, epochId))) {
    throw new ProofError(404, `no snapshot file for epoch ${epochId}`);
  }
  const snap = readHopSnapshot(snapshotsDir, epochId);
  const hopFills = snap.hop_fills ?? [];

  const matches = hopFills.filter(
    (f) =>
      f.order_nonce === nonceHex &&
      f.amount_out !== "0" &&
      (params.hopIndex === undefined || f.hop_index === params.hopIndex),
  );
  if (matches.length === 0) {
    const hopMsg = params.hopIndex === undefined ? "" : ` hop ${params.hopIndex}`;
    throw new ProofError(
      404,
      `no (non-decoy) fill for nonce ${nonceHex}${hopMsg} in epoch-${epochId} snapshot`,
    );
  }

  const fills: HopProofLeaf[] = matches.map((leaf) => {
    const key = `${leaf.order_nonce}:${leaf.hop_index}`;
    const siblings = snap.hop_paths?.[key];
    if (!siblings || siblings.length !== 6) {
      // Data-integrity fault: the leaf exists but its inclusion path wasn't harvested.
      throw new ProofError(
        500,
        `snapshot epoch-${epochId} is missing a depth-6 sibling path for ${key}`,
      );
    }
    return {
      order_nonce: leaf.order_nonce,
      hop_index: leaf.hop_index,
      amount_out: leaf.amount_out,
      pool_id: leaf.pool_id,
      leaf_index: leaf.leaf_index,
      sibling_path: siblings,
    };
  });

  return { epoch_id: epochId, fills_root: snap.fills_root, fills };
}

/**
 * Register `GET /proof` on a Fastify app. Query params:
 *   - order_nonce  (required, 0x hex; padded or unpadded)
 *   - hop_index    (optional int; default = all populated hops)
 *   - epoch_id     (optional int; default = auto-discover via findEpochForNonceHop)
 * Returns ProofResponse (200) or { error } with the ProofError status (400/404/500).
 * Shared by both server.ts (test entry) and main.ts (live entry) so they can't drift.
 */
export function registerProofRoute(app: FastifyInstance, snapshotsDir: string): void {
  app.get("/proof", async (req, reply) => {
    const q = (req.query ?? {}) as Record<string, string | undefined>;
    const orderNonce = q.order_nonce;
    if (!orderNonce) {
      return reply.code(400).send({ error: "missing required query param 'order_nonce'" });
    }
    let hopIndex: number | undefined;
    if (q.hop_index !== undefined) {
      hopIndex = Number(q.hop_index);
      if (!Number.isInteger(hopIndex)) {
        return reply.code(400).send({ error: `invalid hop_index '${q.hop_index}'` });
      }
    }
    let epochId: number | undefined;
    if (q.epoch_id !== undefined) {
      epochId = Number(q.epoch_id);
      if (!Number.isInteger(epochId)) {
        return reply.code(400).send({ error: `invalid epoch_id '${q.epoch_id}'` });
      }
    }
    try {
      const res = buildProofResponse(snapshotsDir, { orderNonce, hopIndex, epochId });
      return reply.code(200).send(res);
    } catch (e) {
      if (e instanceof ProofError) {
        return reply.code(e.statusCode).send({ error: e.message });
      }
      return reply.code(500).send({ error: e instanceof Error ? e.message : String(e) });
    }
  });
}
