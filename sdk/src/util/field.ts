// sdk/src/util/field.ts
// Field-arithmetic helpers shared by SDK + CLI.

/** A random BN254 field element (31 random bytes stay under the field modulus). */
export function randomField(): bigint {
  const buf = new Uint8Array(31);
  // globalThis.crypto works in both the browser and Node >= 19; importing
  // webcrypto from node:crypto breaks in the Vite bundle (the crypto-browserify
  // polyfill has no webcrypto export).
  globalThis.crypto.getRandomValues(buf);
  let n = 0n;
  for (const byte of buf) n = (n << 8n) | BigInt(byte);
  return n;
}

/**
 * Parse a CLI-supplied field value. `BigInt` natively accepts both decimal
 * and `0x`-prefixed hex strings.
 */
export function parseField(raw: string): bigint {
  return BigInt(raw.trim());
}
