/**
 * Validate a batch of reveals against the on-chain order_acc accumulator.
 * Recomputes c_i for each, sorts by FIFO (submitted_at_block, order_nonce),
 * replays the fold from 0, and accepts ALL reveals only if the replayed
 * accumulator matches the on-chain expected value. If any single reveal is
 * tampered, replay fails and the whole batch is rejected - the daemon then
 * either submits the empty (skip) clearing or aborts and waits for a complete
 * re-broadcast.
 */
import { Fr } from "@aztec/aztec.js/fields";
import { poseidon2Hash } from "@aztec/foundation/crypto/poseidon";
import type { RevealPayload } from "./queue.js";

export interface ValidatedReveal {
  order_nonce: Fr;
  side: boolean;
  amount_in: bigint;
  limit_price: bigint;
  submitted_at_block: number;
  owner: Fr;
  path_len: number;
  path: [bigint, bigint, bigint];
}

/**
 * Audit #2 unified per-order hiding commitment c_i. MUST be byte-identical to:
 *   - contract  submit_order / submit_order_bulk PRIVATE poseidon2_hash
 *   - circuit   binding.nr::c_i_path
 * 10 inputs, in this exact order:
 *   [ owner, side(0/1), amount_in, limit_price, order_nonce,
 *     submitted_at_block, path_len, path[0], path[1], path[2] ]
 *
 * NOTE: Intentionally unaffected by the clearing-soundness layout change
 * (audit #1 pool_state_commitment + audit #3 token_lo/hi). Those fields belong
 * to the per-pool ClearingSwap/PoolClearing public inputs, not the order
 * accumulator. The order-acc replay chain binds individual order preimages only.
 */
export async function computeCi(p: {
  owner: bigint;
  side: boolean;
  amount_in: bigint;
  limit_price: bigint;
  order_nonce: bigint;
  submitted_at_block: number;
  path_len: number;
  path: [bigint, bigint, bigint];
}): Promise<Fr> {
  return poseidon2Hash([
    p.owner,
    p.side ? 1n : 0n,
    p.amount_in,
    p.limit_price,
    p.order_nonce,
    BigInt(p.submitted_at_block),
    BigInt(p.path_len),
    p.path[0],
    p.path[1],
    p.path[2],
  ]);
}

export async function replayOrderAcc(cis: Fr[]): Promise<Fr> {
  let acc: Fr = new Fr(0n);
  for (const ci of cis) {
    acc = await poseidon2Hash([acc.toBigInt(), ci.toBigInt()]);
  }
  return acc;
}

/**
 * Sort reveals by FIFO (submitted_at_block ASC, then order_nonce ASC) - same
 * total ordering as `aggregator/src/clearing.ts::selectBatch`. Replay the
 * order_acc chain. Return parsed ValidatedReveal[] if the folded acc matches
 * `expectedOrderAcc`; otherwise return [].
 */
/**
 * Parse a raw reveal into field elements, or `null` if any field is malformed or
 * out of the field range (Fr.fromString / BigInt throw on those).
 *
 * H3: the reveal zod schemas accept unbounded hex/decimal, so a schema-valid but
 * poisoned reveal (e.g. order_nonce >= field modulus) throws here. Because
 * validateReveals runs AFTER the queue is drained, a throw would destroy every
 * legit reveal in the epoch. A reveal that can't be parsed to field elements can
 * never match the on-chain order_acc anyway, so DROP it and keep the rest.
 */
function parseReveal(r: RevealPayload): ValidatedReveal | null {
  try {
    // Audit #2: path is bound into c_i. Reveals from older clients may omit it;
    // default to a 1-hop direct path of [0,0,0] / path_len=2 so the commitment
    // formula still has well-defined inputs (the contract always supplies real
    // path words, so a mismatch here simply fails the replay — fail-closed).
    const rawPath = (r.path ?? ["0x0", "0x0", "0x0"]).map((s) => BigInt(s));
    const path: [bigint, bigint, bigint] = [
      rawPath[0] ?? 0n,
      rawPath[1] ?? 0n,
      rawPath[2] ?? 0n,
    ];
    return {
      order_nonce: Fr.fromString(r.order_nonce),
      side: r.side,
      amount_in: BigInt(r.amount_in),
      limit_price: BigInt(r.limit_price),
      submitted_at_block: r.submitted_at_block,
      owner: Fr.fromString(r.owner),
      path_len: r.path_len ?? 2,
      path,
    };
  } catch {
    return null;
  }
}

export async function validateReveals(
  reveals: RevealPayload[],
  expectedOrderAcc: Fr,
): Promise<ValidatedReveal[]> {
  const parsed: ValidatedReveal[] = reveals
    .map(parseReveal)
    .filter((p): p is ValidatedReveal => p !== null);

  parsed.sort((a, b) => {
    if (a.submitted_at_block !== b.submitted_at_block) {
      return a.submitted_at_block - b.submitted_at_block;
    }
    const an = a.order_nonce.toBigInt();
    const bn = b.order_nonce.toBigInt();
    if (an < bn) return -1;
    if (an > bn) return 1;
    return 0;
  });

  const cis: Fr[] = [];
  for (const p of parsed) {
    cis.push(await computeCi({
      owner: p.owner.toBigInt(),
      side: p.side,
      amount_in: p.amount_in,
      limit_price: p.limit_price,
      order_nonce: p.order_nonce.toBigInt(),
      submitted_at_block: p.submitted_at_block,
      path_len: p.path_len,
      path: p.path,
    }));
  }
  const replayed = await replayOrderAcc(cis);

  if (replayed.toString() !== expectedOrderAcc.toString()) {
    return [];
  }
  return parsed;
}

/**
 * Self-heal for reveal anchor drift (2026-06-10, observed live on epochs 47+50):
 * the SDK falls back to the MINED block when the OrderNote's true anchor (the
 * PXE simulation block, typically mined-1..mined-3) can't be read — testnet
 * reorgs stall PXE note discovery, so the fallback fires and the whole epoch
 * fails the all-or-nothing replay above.
 *
 * Repair: try per-reveal anchor corrections `block - off, off ∈ 0..maxOffset`,
 * re-sort with the canonical (block ASC, nonce ASC) comparator, fold, and
 * accept ONLY a combination whose fold matches the on-chain order_acc. No
 * trust is added — the acc check still gates settlement; we only search the
 * small drift space the on-chain truth can confirm. The returned list is in
 * the exact order that produced the matching fold (== canonical sort of the
 * corrected reveals), so downstream witness building stays consistent.
 *
 * Limitation: assumes the contract's inclusion order equals the canonical
 * sort under corrected anchors (true for sequentially-placed orders in
 * distinct anchor blocks — the only pattern our scripts and frontend emit).
 */
export async function repairReveals(
  reveals: RevealPayload[],
  expectedOrderAcc: Fr,
  opts: { maxOffset?: number; maxOrders?: number } = {},
): Promise<{ validated: ValidatedReveal[]; corrections: Array<{ order_nonce: string; from: number; to: number }> } | null> {
  const maxOffset = opts.maxOffset ?? 3;
  const maxOrders = opts.maxOrders ?? 6;
  if (reveals.length === 0 || reveals.length > maxOrders) return null;

  const parsed: ValidatedReveal[] = reveals
    .map(parseReveal)
    .filter((p): p is ValidatedReveal => p !== null);

  const offsets = Array.from({ length: maxOffset + 1 }, (_, i) => i);
  const combos = Math.pow(offsets.length, parsed.length);
  for (let combo = 0; combo < combos; combo++) {
    let rem = combo;
    const corrected = parsed.map((p) => {
      const off = offsets[rem % offsets.length]!;
      rem = Math.floor(rem / offsets.length);
      return { ...p, submitted_at_block: p.submitted_at_block - off };
    });
    corrected.sort((a, b) => {
      if (a.submitted_at_block !== b.submitted_at_block) {
        return a.submitted_at_block - b.submitted_at_block;
      }
      const an = a.order_nonce.toBigInt();
      const bn = b.order_nonce.toBigInt();
      return an < bn ? -1 : an > bn ? 1 : 0;
    });
    const cis: Fr[] = [];
    for (const p of corrected) {
      cis.push(await computeCi({
        owner: p.owner.toBigInt(),
        side: p.side,
        amount_in: p.amount_in,
        limit_price: p.limit_price,
        order_nonce: p.order_nonce.toBigInt(),
        submitted_at_block: p.submitted_at_block,
        path_len: p.path_len,
        path: p.path,
      }));
    }
    const replayed = await replayOrderAcc(cis);
    if (replayed.toString() === expectedOrderAcc.toString()) {
      const byNonce = new Map(parsed.map((p) => [p.order_nonce.toString(), p.submitted_at_block]));
      const corrections = corrected
        .filter((c) => byNonce.get(c.order_nonce.toString()) !== c.submitted_at_block)
        .map((c) => ({
          order_nonce: c.order_nonce.toString(),
          from: byNonce.get(c.order_nonce.toString())!,
          to: c.submitted_at_block,
        }));
      return { validated: corrected, corrections };
    }
  }
  return null;
}
