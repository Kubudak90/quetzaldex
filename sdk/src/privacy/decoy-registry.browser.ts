// sdk/src/privacy/decoy-registry.browser.ts
// Browser-compatible shim for decoy-registry.ts.
// Swapped in by Vite alias during frontend production build.
// Uses localStorage instead of node:fs so it can run in a browser context.

export interface DecoyRegistry {
  [nonceHex: string]: boolean;
}

function storageKey(walletAddrHex: string): string {
  const safe = walletAddrHex.toLowerCase().replace(/[^0-9a-fx]/g, "");
  return `quetzal:decoy-registry:${safe}`;
}

export function loadDecoyRegistry(walletAddrHex: string): DecoyRegistry {
  try {
    const raw = localStorage.getItem(storageKey(walletAddrHex));
    if (!raw) return {};
    const parsed = JSON.parse(raw) as DecoyRegistry;
    // Normalize-on-load: a registry persisted before the padStart(64) fix may
    // hold unpadded keys (e.g. "0xabc"). Re-key so padded lookups find them.
    const out: DecoyRegistry = {};
    for (const [k, v] of Object.entries(parsed)) {
      out["0x" + k.toLowerCase().replace(/^0x/, "").padStart(64, "0")] = v;
    }
    return out;
  } catch {
    return {};
  }
}

export function saveDecoyRegistry(walletAddrHex: string, reg: DecoyRegistry): void {
  try {
    localStorage.setItem(storageKey(walletAddrHex), JSON.stringify(reg));
  } catch {
    // Silently ignore quota errors — decoy privacy is best-effort in browser.
  }
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
  return Object.entries(reg)
    .filter(([, v]) => v === true)
    .map(([k]) => norm(k));
}
