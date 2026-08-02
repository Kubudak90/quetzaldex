// crypto-vault.ts — at-rest encryption for the onboarding session (Audit #8).
//
// The persisted onboarding session contains `masterSecret`: a 0x-hex32 root
// from which ALL child wallet secrets are deterministically re-derived. Audit
// finding #8 flagged that this was previously written to localStorage as
// PLAINTEXT — any XSS, malicious browser extension or shared-machine access
// would drain the entire WalletPool. This module wraps that data in
// AES-256-GCM, with the key derived from a user passphrase via PBKDF2. The
// passphrase is never persisted; it is supplied once per page load and kept in
// memory for the session only.
//
// Implementation notes:
//   * 100% Web Crypto (browser-native `crypto.subtle`). No dependencies.
//   * AES-GCM provides authenticated encryption — a tampered ciphertext (or a
//     wrong passphrase) fails the GCM auth-tag check, which we surface as a
//     `null` decrypt result rather than leaking *why* it failed.
//   * PBKDF2 with 210_000 SHA-256 iterations (OWASP 2023 floor) slows brute
//     force against a stolen blob.

/**
 * Versioned encrypted envelope stored (as JSON) in localStorage. `salt`, `iv`
 * and `ct` are base64-encoded byte strings. `v: 2` distinguishes this shape
 * from the legacy `v: 1` plaintext `PersistedSession` so callers can detect &
 * wipe pre-Audit-#8 plaintext.
 */
export interface EncryptedBlob {
  v: 2;
  kdf: "PBKDF2";
  hash: "SHA-256";
  iter: number;
  /** base64 of the 16-byte PBKDF2 salt. */
  salt: string;
  /** base64 of the 12-byte AES-GCM IV/nonce. */
  iv: string;
  /** base64 of the AES-GCM ciphertext (includes the appended auth tag). */
  ct: string;
}

const PBKDF2_ITERATIONS = 210_000;
const SALT_BYTES = 16;
const IV_BYTES = 12; // 96-bit nonce — the recommended size for AES-GCM.

/**
 * Returns the SubtleCrypto instance or throws a clear, user-surfaceable error
 * if the runtime can't do Web Crypto (e.g. an insecure non-localhost http://
 * origin, or an ancient browser). Callers should catch this and tell the user
 * their browser doesn't support secure storage.
 */
function requireSubtle(): SubtleCrypto {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error(
      "Secure storage unavailable: this browser/origin does not provide Web Crypto (crypto.subtle). " +
        "Use a modern browser over HTTPS (or localhost).",
    );
  }
  return subtle;
}

// --- base64 <-> ArrayBuffer helpers --------------------------------------
// Avoid Node Buffer so this stays browser-native. We round-trip through a
// binary (latin1) string, which btoa/atob handle byte-for-byte.

function bufToB64(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function b64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Returns a plain `ArrayBuffer` view of `bytes`. The Web Crypto types (under
 * TS's strict lib) want `BufferSource` backed by a concrete `ArrayBuffer`, not
 * the `ArrayBufferLike` (potentially SharedArrayBuffer) that a bare
 * `Uint8Array` advertises. `.slice()` always allocates a fresh `ArrayBuffer`.
 */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/**
 * Derives a 256-bit AES-GCM key from a passphrase + salt via PBKDF2/SHA-256.
 * The derived key is non-extractable (`extractable: false`) so it can't be
 * read back out of the CryptoKey once created.
 */
async function deriveKey(
  subtle: SubtleCrypto,
  passphrase: string,
  salt: Uint8Array,
  iterations: number,
): Promise<CryptoKey> {
  const baseKey = await subtle.importKey(
    "raw",
    toArrayBuffer(new TextEncoder().encode(passphrase)),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return subtle.deriveKey(
    { name: "PBKDF2", salt: toArrayBuffer(salt), iterations, hash: "SHA-256" },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/**
 * Encrypts a UTF-8 plaintext string under a passphrase, returning a
 * self-describing {@link EncryptedBlob}. Each call uses a fresh random salt and
 * IV, so encrypting the same plaintext twice yields different blobs.
 *
 * @throws if Web Crypto is unavailable (see {@link requireSubtle}).
 */
export async function encryptJson(plain: string, passphrase: string): Promise<EncryptedBlob> {
  const subtle = requireSubtle();
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const key = await deriveKey(subtle, passphrase, salt, PBKDF2_ITERATIONS);
  const ct = await subtle.encrypt(
    { name: "AES-GCM", iv: toArrayBuffer(iv) },
    key,
    toArrayBuffer(new TextEncoder().encode(plain)),
  );
  return {
    v: 2,
    kdf: "PBKDF2",
    hash: "SHA-256",
    iter: PBKDF2_ITERATIONS,
    salt: bufToB64(salt),
    iv: bufToB64(iv),
    ct: bufToB64(ct),
  };
}

/**
 * Decrypts an {@link EncryptedBlob} with a passphrase, returning the original
 * UTF-8 plaintext. Returns `null` (never throws) on ANY decrypt failure —
 * wrong passphrase, tampered ciphertext (GCM auth-tag mismatch), or malformed
 * base64. This is "fail closed": the caller learns only that the blob could
 * not be unlocked, not whether it was the wrong passphrase vs. tampering.
 *
 * Note: a genuinely unavailable Web Crypto runtime DOES throw (via
 * {@link requireSubtle}) so the caller can distinguish "browser can't decrypt
 * at all" from "couldn't unlock this blob".
 */
export async function decryptJson(blob: EncryptedBlob, passphrase: string): Promise<string | null> {
  const subtle = requireSubtle();
  try {
    const salt = b64ToBytes(blob.salt);
    const iv = b64ToBytes(blob.iv);
    const ct = b64ToBytes(blob.ct);
    const key = await deriveKey(subtle, passphrase, salt, blob.iter);
    const pt = await subtle.decrypt({ name: "AES-GCM", iv: toArrayBuffer(iv) }, key, toArrayBuffer(ct));
    return new TextDecoder().decode(pt);
  } catch {
    // Wrong passphrase, tampered ct, or bad base64 — all collapse to null.
    return null;
  }
}

/**
 * Structural guard: is `x` a v2 EncryptedBlob? Used by persistence to tell an
 * encrypted blob apart from legacy plaintext without needing the passphrase.
 */
export function isEncryptedBlob(x: unknown): x is EncryptedBlob {
  if (!x || typeof x !== "object") return false;
  const b = x as Record<string, unknown>;
  return (
    b.v === 2 &&
    b.kdf === "PBKDF2" &&
    b.hash === "SHA-256" &&
    typeof b.iter === "number" &&
    typeof b.salt === "string" &&
    typeof b.iv === "string" &&
    typeof b.ct === "string"
  );
}
