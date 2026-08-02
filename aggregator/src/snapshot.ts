/**
 * Per-epoch snapshot store for the Week 5d-4 settlement Merkle tree.
 *
 * The aggregator writes one JSON file per closed epoch under `<dir>/epoch-<N>.json`;
 * the CLI's `quetzal claim` reads it back to construct the inclusion proof.
 */
import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { Fr } from "@aztec/aztec.js/fields";
import type { JsFillEntry, MerkleTreeOutput } from "./merkle.js";

export interface SnapshotInput {
  epoch_id: number;
  fills: JsFillEntry[];
  tree: MerkleTreeOutput;
}

export interface SnapshotLeafJson {
  order_nonce: string;   // 0x-prefixed Field hex
  amount_out: string;    // decimal bigint string
  leaf_hash: string;     // 0x-prefixed Field hex
}

export interface SnapshotPathJson {
  siblings: string[];    // length 5, 0x-prefixed
  leaf_index: number;
}

export interface SnapshotJson {
  epoch_id: number;
  fills_root: string;
  leaves: SnapshotLeafJson[];
  paths: Record<string, SnapshotPathJson>;
}

/** In-memory snapshot returned by readSnapshot — same fields, with paths as a Map. */
export interface Snapshot {
  epoch_id: number;
  fills_root: string;
  leaves: SnapshotLeafJson[];
  paths: Map<string, { siblings: Fr[]; leaf_index: number }>;
}

export function snapshotPath(dir: string, epoch_id: number): string {
  return join(dir, `epoch-${epoch_id}.json`);
}

export function writeSnapshot(dir: string, snap: SnapshotInput): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const leaves: SnapshotLeafJson[] = [];
  for (let i = 0; i < snap.tree.leaves.length; i++) {
    const populated = snap.fills[i];
    leaves.push({
      order_nonce: populated ? populated.order_nonce.toString() : new Fr(0n).toString(),
      amount_out: populated ? populated.amount_out.toString() : "0",
      leaf_hash: snap.tree.leaves[i]!.toString(),
    });
  }
  const paths: Record<string, SnapshotPathJson> = {};
  for (const [nonce, path] of snap.tree.paths) {
    paths[nonce] = {
      siblings: path.siblings.map((s) => s.toString()),
      leaf_index: path.leaf_index,
    };
  }
  const json: SnapshotJson = {
    epoch_id: snap.epoch_id,
    fills_root: snap.tree.root.toString(),
    leaves,
    paths,
  };
  writeFileSync(snapshotPath(dir, snap.epoch_id), JSON.stringify(json, null, 2));
}

export function readSnapshot(dir: string, epoch_id: number): Snapshot {
  const raw = JSON.parse(readFileSync(snapshotPath(dir, epoch_id), "utf8")) as SnapshotJson;
  const paths = new Map<string, { siblings: Fr[]; leaf_index: number }>();
  for (const [nonce, p] of Object.entries(raw.paths)) {
    paths.set(nonce, {
      siblings: p.siblings.map((s) => Fr.fromString(s)),
      leaf_index: p.leaf_index,
    });
  }
  return {
    epoch_id: raw.epoch_id,
    fills_root: raw.fills_root,
    leaves: raw.leaves,
    paths,
  };
}

/**
 * Linear scan over `<dir>/epoch-*.json`; returns the epoch_id whose snapshot
 * carries `order_nonce_hex` as a populated path, or null. The CLI uses this when
 * the maker doesn't pass --epoch explicitly.
 */
export function findEpochForNonce(dir: string, order_nonce_hex: string): number | null {
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir).filter((f) => /^epoch-\d+\.json$/.test(f));
  for (const f of files) {
    const raw = JSON.parse(readFileSync(join(dir, f), "utf8")) as SnapshotJson;
    if (raw.paths[order_nonce_hex]) return raw.epoch_id;
  }
  return null;
}

// ─── Sub-4 hop-fill snapshot (depth-6 / 64-leaf / 4-field) ────────────────────
// This is the format claim_fill actually needs: per-(order_nonce,hop_index) the
// 4 leaf-preimage fields + leaf_index + the depth-6 sibling path. It REPLACES the
// legacy 2-field SnapshotJson at epoch-<N>.json (which carried empty paths and
// could not back a hop claim). Shape matches the CLI's expected HopSnapshotJson
// (cli/src/commands/claim.ts) so `quetzal claim` reads it directly.

export interface HopFillLeafJson {
  order_nonce: string;   // 0x-prefixed Field hex
  hop_index: number;     // 0 or 1
  amount_out: string;    // decimal bigint string (verbatim from clearing.fills)
  pool_id: number;
  leaf_index: number;    // position in the 64-leaf tree (0..63)
}

export interface HopSnapshotJson {
  epoch_id: number;
  fills_root: string;
  hop_fills: HopFillLeafJson[];
  /** keyed by `${order_nonce}:${hop_index}` → 6 sibling hashes (0x hex). */
  hop_paths: Record<string, string[]>;
}

export interface HopSnapshotInput {
  epoch_id: number;
  fills_root: string;
  hop_fills: HopFillLeafJson[];
  /** keyed by `${order_nonce}:${hop_index}` (as produced by buildHopFillsTree). */
  paths: Map<string, { siblings: Fr[]; leaf_index: number }>;
}

// ── In-memory nonce→epoch index for findEpochForNonceHop ─────────────────────
// Populated lazily on first scan; updated by writeHopSnapshot so subsequent
// lookups hit the map without touching the filesystem.
let _hopIndexDir: string | null = null;
const _hopIndex = new Map<string, number>();

function _loadHopIndex(dir: string): void {
  if (_hopIndexDir === dir) return; // already loaded for this dir
  _hopIndex.clear();
  if (!existsSync(dir)) { _hopIndexDir = dir; return; }
  const files = readdirSync(dir).filter((f) => /^epoch-\d+\.json$/.test(f));
  for (const f of files) {
    try {
      const raw = JSON.parse(readFileSync(join(dir, f), "utf8")) as Partial<HopSnapshotJson>;
      if (typeof raw.epoch_id !== "number") continue;
      for (const hf of raw.hop_fills ?? []) {
        if (hf.amount_out !== "0") _hopIndex.set(hf.order_nonce, raw.epoch_id);
      }
    } catch { /* skip unparseable files */ }
  }
  _hopIndexDir = dir;
}

/** Reset the in-memory hop-epoch index. Call only from tests. */
export function _resetHopIndexForTest(): void {
  _hopIndex.clear();
  _hopIndexDir = null;
}

export function writeHopSnapshot(dir: string, snap: HopSnapshotInput): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const hop_paths: Record<string, string[]> = {};
  for (const [key, p] of snap.paths) {
    hop_paths[key] = p.siblings.map((s) => s.toString());
  }
  const json: HopSnapshotJson = {
    epoch_id: snap.epoch_id,
    fills_root: snap.fills_root,
    hop_fills: snap.hop_fills,
    hop_paths,
  };
  writeFileSync(snapshotPath(dir, snap.epoch_id), JSON.stringify(json, null, 2));
  // Update in-memory index so findEpochForNonceHop doesn't need a rescan.
  if (_hopIndexDir === null || _hopIndexDir === dir) {
    _hopIndexDir = dir;
    for (const hf of snap.hop_fills) {
      if (hf.amount_out !== "0") _hopIndex.set(hf.order_nonce, snap.epoch_id);
    }
  }
}

export function readHopSnapshot(dir: string, epoch_id: number): HopSnapshotJson {
  return JSON.parse(readFileSync(snapshotPath(dir, epoch_id), "utf8")) as HopSnapshotJson;
}

/**
 * Returns the epoch_id whose hop snapshot carries a POPULATED (amount_out != "0")
 * fill for `order_nonce_hex`, or null.
 *
 * Fast path: consults an in-memory nonce→epoch index (populated lazily on first
 * call and kept up-to-date by writeHopSnapshot). Falls back to a full directory
 * rescan only on index miss, so a burst of /proof requests does not block the
 * event loop with repeated readdirSync + readFileSync calls.
 */
export function findEpochForNonceHop(dir: string, order_nonce_hex: string): number | null {
  if (!existsSync(dir)) return null;
  // Ensure the index covers this dir.
  _loadHopIndex(dir);
  // Fast path: index hit.
  const cached = _hopIndex.get(order_nonce_hex);
  if (cached !== undefined) return cached;
  // Slow path: full rescan (handles snapshots written by another process).
  const files = readdirSync(dir).filter((f) => /^epoch-\d+\.json$/.test(f));
  for (const f of files) {
    let raw: Partial<HopSnapshotJson>;
    try {
      raw = JSON.parse(readFileSync(join(dir, f), "utf8")) as Partial<HopSnapshotJson>;
    } catch {
      continue;
    }
    const hf = raw.hop_fills?.find(
      (h) => h.order_nonce === order_nonce_hex && h.amount_out !== "0",
    );
    if (hf && typeof raw.epoch_id === "number") {
      // Update index for future calls.
      _hopIndex.set(order_nonce_hex, raw.epoch_id);
      return raw.epoch_id;
    }
  }
  return null;
}
