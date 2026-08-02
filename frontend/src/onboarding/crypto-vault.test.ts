import { describe, test, expect } from "vitest";
import {
  encryptJson,
  decryptJson,
  isEncryptedBlob,
  type EncryptedBlob,
} from "./crypto-vault";

// happy-dom (the configured vitest environment) exposes Node's webcrypto as
// globalThis.crypto, including crypto.subtle — so these run without any extra
// setup. If a future environment lacks it, encryptJson/decryptJson will throw
// the clear "Secure storage unavailable" error from requireSubtle().

const PASS = "correct horse battery staple";
const PLAIN = JSON.stringify({ masterSecret: "0x" + "ab".repeat(32), poolSize: 3 });

describe("crypto-vault", () => {
  test("round-trip: encrypt then decrypt returns the original plaintext", async () => {
    const blob = await encryptJson(PLAIN, PASS);
    const out = await decryptJson(blob, PASS);
    expect(out).toBe(PLAIN);
  });

  test("blob has the expected v2 shape", async () => {
    const blob = await encryptJson(PLAIN, PASS);
    expect(blob.v).toBe(2);
    expect(blob.kdf).toBe("PBKDF2");
    expect(blob.hash).toBe("SHA-256");
    expect(blob.iter).toBe(210_000);
    expect(typeof blob.salt).toBe("string");
    expect(typeof blob.iv).toBe("string");
    expect(typeof blob.ct).toBe("string");
    expect(isEncryptedBlob(blob)).toBe(true);
  });

  test("wrong passphrase returns null (does not throw)", async () => {
    const blob = await encryptJson(PLAIN, PASS);
    const out = await decryptJson(blob, "wrong passphrase");
    expect(out).toBeNull();
  });

  test("tampered ciphertext returns null (GCM auth-tag mismatch)", async () => {
    const blob = await encryptJson(PLAIN, PASS);
    // Flip one base64 char in the ciphertext. Pick a char that actually changes
    // so we don't accidentally produce identical bytes.
    const orig = blob.ct;
    const idx = Math.floor(orig.length / 2);
    const replacement = orig[idx] === "A" ? "B" : "A";
    const tampered: EncryptedBlob = {
      ...blob,
      ct: orig.slice(0, idx) + replacement + orig.slice(idx + 1),
    };
    expect(tampered.ct).not.toBe(orig);
    const out = await decryptJson(tampered, PASS);
    expect(out).toBeNull();
  });

  test("two encryptions of the same plaintext produce different salt/iv/ct", async () => {
    const a = await encryptJson(PLAIN, PASS);
    const b = await encryptJson(PLAIN, PASS);
    expect(a.salt).not.toBe(b.salt);
    expect(a.iv).not.toBe(b.iv);
    expect(a.ct).not.toBe(b.ct);
    // ...but both still decrypt to the same plaintext.
    expect(await decryptJson(a, PASS)).toBe(PLAIN);
    expect(await decryptJson(b, PASS)).toBe(PLAIN);
  });

  test("isEncryptedBlob rejects non-blob shapes", () => {
    expect(isEncryptedBlob(null)).toBe(false);
    expect(isEncryptedBlob("string")).toBe(false);
    expect(isEncryptedBlob({ v: 1, masterSecret: "0xdead" })).toBe(false);
    expect(isEncryptedBlob({ v: 2, kdf: "PBKDF2" })).toBe(false);
  });
});
