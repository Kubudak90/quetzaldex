// cli/src/orders/decoy-registry.ts
// Sub-6a B1: maker-local JSON registry of decoy order nonces.
//
// Lives at: ~/.quetzal/decoy-registry-<walletAddrHex>.json
// Format: { "<nonce_hex>": true /* decoy */ | false /* real */ }
//
// Never written to L2. Aggregator, observers, Aztec ledger don't see it.
// Quetzal's privacy model treats real-vs-decoy as the maker's PXE secret.

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface DecoyRegistry {
  [nonceHex: string]: boolean;
}

function registryPath(walletAddrHex: string): string {
  const dir = join(homedir(), ".quetzal");
  mkdirSync(dir, { recursive: true });
  const safeAddr = walletAddrHex.toLowerCase().replace(/[^0-9a-fx]/g, "");
  return join(dir, `decoy-registry-${safeAddr}.json`);
}

export function loadDecoyRegistry(walletAddrHex: string): DecoyRegistry {
  const path = registryPath(walletAddrHex);
  if (!existsSync(path)) return {};
  const raw = JSON.parse(readFileSync(path, "utf8")) as DecoyRegistry;
  // Normalize-on-load: a registry persisted before the padStart(64) fix may
  // hold unpadded keys (e.g. "0xabc"). Re-key every entry through the canonical
  // form so padded lookups (isDecoy, listDecoys) find legacy entries correctly.
  const out: DecoyRegistry = {};
  for (const [k, v] of Object.entries(raw)) {
    out["0x" + k.toLowerCase().replace(/^0x/, "").padStart(64, "0")] = v;
  }
  return out;
}

export function saveDecoyRegistry(walletAddrHex: string, reg: DecoyRegistry): void {
  writeFileSync(registryPath(walletAddrHex), JSON.stringify(reg, null, 2));
}

/** Canonical key: lowercase, strip 0x, zero-pad to 64 hex chars, re-prefix. */
const norm = (h: string): string =>
  "0x" + h.toLowerCase().replace(/^0x/, "").padStart(64, "0");

/** Merge new (nonce, isDecoy) entries into the existing registry. */
export function recordDecoyBatch(
  walletAddrHex: string,
  entries: Array<{ nonce: string; isDecoy: boolean }>,
): void {
  const reg = loadDecoyRegistry(walletAddrHex);
  for (const e of entries) {
    reg[norm(e.nonce)] = e.isDecoy;
  }
  saveDecoyRegistry(walletAddrHex, reg);
}

/** True ONLY when the nonce is explicitly recorded as a decoy. */
export function isDecoy(walletAddrHex: string, nonceHex: string): boolean {
  const reg = loadDecoyRegistry(walletAddrHex);
  return reg[norm(nonceHex)] === true;
}

/** List all decoy nonces (for batch-cancel). */
export function listDecoys(walletAddrHex: string): string[] {
  const reg = loadDecoyRegistry(walletAddrHex);
  return Object.entries(reg).filter(([, v]) => v === true).map(([k]) => norm(k));
}
