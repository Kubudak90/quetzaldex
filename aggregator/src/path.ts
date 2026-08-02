export interface PoolRegistryEntry {
  pool_id: number;
  token_a: bigint;  // canonical (lower), u128-TRUNCATED — for path resolution only
  token_b: bigint;  // canonical (higher), u128-TRUNCATED
  // FULL field addresses, ordered by the SAME u128 key. The proof-bound token_lo/hi
  // + circuit pool_token_pairs (and the orderbook #3 check) compare FULL fields, not
  // truncated — so these, not token_a/token_b, must feed poolTokenPairs. Optional:
  // callers that build registries from small (full==truncated) test addresses may
  // omit them; consumers fall back to token_a/token_b.
  token_a_full?: bigint; // lower (full)
  token_b_full?: bigint; // higher (full)
}
export type PoolRegistry = PoolRegistryEntry[];

/** Find the pool_id matching unordered (a, b). Returns -1 if not found. */
export function resolvePoolId(reg: PoolRegistry, a: bigint, b: bigint): number {
  const [lo, hi] = a < b ? [a, b] : [b, a];
  for (const p of reg) {
    if (p.token_a === lo && p.token_b === hi) return p.pool_id;
  }
  return -1;
}

/** Resolve per-hop pool_ids for a path. Throws on missing pool. */
export function resolveHopPools(reg: PoolRegistry, path: bigint[]): number[] {
  if (path.length < 2 || path.length > 3) {
    throw new Error(`path length must be 2 or 3, got ${path.length}`);
  }
  const hops: number[] = [];
  for (let i = 0; i + 1 < path.length; i++) {
    const pid = resolvePoolId(reg, path[i]!, path[i + 1]!);
    if (pid < 0) throw new Error(`no pool for hop ${i}: 0x${path[i]!.toString(16)}->0x${path[i + 1]!.toString(16)}`);
    hops.push(pid);
  }
  return hops;
}
