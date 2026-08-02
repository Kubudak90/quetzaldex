import { readFileSync } from "node:fs";
import { Fr } from "@aztec/aztec.js/fields";

/** Honk proof size in Fr field elements (empirically 500 for bb 4.2.1 UltraHonk). */
export const HONK_PROOF_FIELDS = 500;
/** Honk proof size in bytes (each Fr serialises as 32 bytes, big-endian). */
export const HONK_PROOF_BYTES = HONK_PROOF_FIELDS * 32;

/** Honk VK size in Fr field elements (empirically 115 for bb 4.2.1 UltraHonk). */
export const HONK_VK_FIELDS = 115;
/** Honk VK size in bytes. */
export const HONK_VK_BYTES = HONK_VK_FIELDS * 32;

/**
 * Read `bb prove`'s binary proof output and parse it as a Fr[] matching the
 * shape `circuits/clearing/main.nr`'s `fn main` `proof: [Field; 456]` argument
 * expects. The orderbook's close_epoch_and_clear_verified takes this array
 * directly.
 */
export function readProofAsFields(path: string): Fr[] {
  const buf = readFileSync(path);
  if (buf.length !== HONK_PROOF_BYTES) {
    throw new Error(`expected ${HONK_PROOF_BYTES}-byte proof, got ${buf.length} (${path})`);
  }
  const fields: Fr[] = [];
  for (let i = 0; i < HONK_PROOF_FIELDS; i++) {
    fields.push(Fr.fromBuffer(buf.subarray(i * 32, (i + 1) * 32)));
  }
  return fields;
}

/**
 * Read `bb write_vk`'s binary VK output and parse it as a Fr[127] for passing
 * as a calldata argument to close_epoch_and_clear_verified. The size was
 * empirically 4064 bytes (127 fields) for the 5d-2 production clearing circuit
 * under bb 4.2.1 UltraHonk; if a future bb/Aztec version changes the size, the
 * HONK_VK_FIELDS constant updates.
 */
export function readVkAsFields(path: string): Fr[] {
  const buf = readFileSync(path);
  if (buf.length !== HONK_VK_BYTES) {
    throw new Error(`expected ${HONK_VK_BYTES}-byte vk, got ${buf.length} (${path})`);
  }
  const fields: Fr[] = [];
  for (let i = 0; i < HONK_VK_FIELDS; i++) {
    fields.push(Fr.fromBuffer(buf.subarray(i * 32, (i + 1) * 32)));
  }
  return fields;
}

/** Read the 32-byte vk_hash file as a single Fr. */
export function readVkHash(path: string): Fr {
  const buf = readFileSync(path);
  if (buf.length !== 32) {
    throw new Error(`expected 32-byte vk_hash, got ${buf.length} (${path})`);
  }
  return Fr.fromBuffer(buf);
}
