/**
 * In-memory reveal queue keyed by (epoch_id, order_nonce). Deduplicates on
 * insertion - second insert with the same key is a no-op (first-write-wins).
 * `drainEpoch(epoch_id)` empties the queue for that epoch and returns the
 * payloads. The daemon calls drainEpoch at clearing time.
 *
 * NB: this is intentionally NOT persistent. An aggregator restart loses
 * in-flight reveals; makers retry by broadcasting on the next epoch. This
 * is acceptable for MVP because the bonded race naturally tolerates dropped
 * aggregators.
 */

export interface RevealPayload {
  epoch_id: number;
  order_nonce: string;       // 0x-prefixed hex
  side: boolean;
  amount_in: string;         // bigint as decimal string
  limit_price: string;       // bigint as decimal string
  submitted_at_block: number;
  owner: string;             // 0x-prefixed hex
  // Audit #2: path is bound into the per-order commitment c_i. path_len is the
  // number of tokens in the route (2 for 1-hop direct, 3 for a 2-hop route);
  // path is exactly 3 token-address words (0x-prefixed hex), sentinel 0x0 for
  // the unused 3rd slot on 1-hop orders. Optional for backward-compat with
  // older reveal producers; validateReveals defaults to a direct path.
  path_len?: number;
  path?: string[];           // length 3, 0x-prefixed hex token addresses
  submission_tx_hash?: string;
}

export class RevealQueue {
  private byEpoch = new Map<number, Map<string, RevealPayload>>();
  private currentEpoch: number | null = null;

  // M3: /reveal is unauthenticated and epoch_id/order_nonce are attacker-controlled,
  // so the queue must be bounded. Cap reveals per epoch (matches the max clearing
  // set) and only accept epochs near the live one (the watcher pushes it via
  // setCurrentEpoch), so a flood of far-future/garbage epoch_ids can't grow the map.
  private static readonly MAX_PER_EPOCH = 512;
  private static readonly EPOCH_WINDOW = 2;

  /** The watcher calls this each poll with the on-chain epoch, so enqueue can reject
   *  reveals far from the live epoch and evict stale/absurd-future epochs. */
  setCurrentEpoch(epoch_id: number): void {
    this.currentEpoch = epoch_id;
    for (const e of this.byEpoch.keys()) {
      if (Math.abs(e - epoch_id) > RevealQueue.EPOCH_WINDOW) this.byEpoch.delete(e);
    }
  }

  enqueue(payload: RevealPayload): void {
    // Reject reveals for epochs far from the live one (unbounded-growth guard).
    if (
      this.currentEpoch !== null &&
      Math.abs(payload.epoch_id - this.currentEpoch) > RevealQueue.EPOCH_WINDOW
    ) {
      return;
    }
    let inner = this.byEpoch.get(payload.epoch_id);
    if (!inner) {
      inner = new Map();
      this.byEpoch.set(payload.epoch_id, inner);
    }
    if (inner.has(payload.order_nonce)) return;            // dedupe (first-write-wins)
    if (inner.size >= RevealQueue.MAX_PER_EPOCH) return;   // per-epoch cap — drop excess
    inner.set(payload.order_nonce, payload);
  }

  drainEpoch(epoch_id: number): RevealPayload[] {
    const inner = this.byEpoch.get(epoch_id);
    if (!inner) return [];
    const out = Array.from(inner.values());
    this.byEpoch.delete(epoch_id);
    return out;
  }

  size(): number {
    let total = 0;
    for (const inner of this.byEpoch.values()) total += inner.size;
    return total;
  }

  /** Reveals queued for exactly `epoch_id`. The clearing/auto-roll gates key on
   *  this, not size(), so a leftover reveal for a stale epoch cannot block the
   *  current epoch from clearing or auto-rolling (H4). */
  sizeForEpoch(epoch_id: number): number {
    return this.byEpoch.get(epoch_id)?.size ?? 0;
  }
}
