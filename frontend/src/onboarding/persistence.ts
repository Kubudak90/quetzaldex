// Browser localStorage wrapper for the onboarded session. Schema-versioned so
// future migrations can detect & wipe old shapes without throwing into the UI.
//
// Audit #8: the session contains `masterSecret` (a 0x-hex32 root from which ALL
// child wallet secrets re-derive). It is NO LONGER stored as plaintext — it is
// encrypted at rest with AES-256-GCM under a user passphrase (see crypto-vault.ts).
// `loadSession`/`saveSession` are therefore async and require the passphrase.
import {
  encryptJson,
  decryptJson,
  isEncryptedBlob,
  type EncryptedBlob,
} from "./crypto-vault.js";

const STORAGE_KEY = "quetzal-onboarded-v1";
const CURRENT_SCHEMA = 1 as const;

export interface PersistedSession {
  schemaVersion: typeof CURRENT_SCHEMA;
  /**
   * 0x-prefixed hex32 root. Stays in the user's browser — never sent to any
   * server, and never written to disk in plaintext (Audit #8). WalletPool
   * .fromMaster re-derives the same N child secrets at session-connect time.
   */
  masterSecret: `0x${string}`;
  poolSize: number;
  network: "alpha-testnet";
  /** L2 addresses corresponding to the deployed children, in index order. */
  deployedAddresses: `0x${string}`[];
  /** Unix ms when onboarding completed. */
  onboardedAt: number;
}

/**
 * True iff a v2 encrypted session blob is present. Lets the UI decide between
 * an "unlock" prompt vs. fresh onboarding WITHOUT needing the passphrase. A
 * legacy plaintext value (pre-Audit-#8) is NOT counted as a session — those
 * get wiped on the next loadSession (see below).
 */
export function hasSession(): boolean {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return false;
    const parsed = JSON.parse(raw) as unknown;
    return isEncryptedBlob(parsed);
  } catch {
    return false;
  }
}

/**
 * Decrypts and returns the persisted session, or `null` if there is none, the
 * passphrase is wrong, or the stored blob is corrupt/tampered.
 *
 * Privacy: if the stored value is NOT a v2 encrypted blob (i.e. legacy
 * plaintext from before Audit #8), it is CLEARED and `null` is returned —
 * we never keep plaintext secrets around. Legacy users simply re-onboard
 * (Sub-9.4 already wiped testnet state, so this is acceptable).
 */
export async function loadSession(passphrase: string): Promise<PersistedSession | null> {
  let parsed: unknown;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!isEncryptedBlob(parsed)) {
    // Legacy plaintext (or otherwise-unrecognised value): wipe it, force re-onboard.
    clearSession();
    return null;
  }

  const plain = await decryptJson(parsed as EncryptedBlob, passphrase);
  if (plain === null) return null; // wrong passphrase or tampered ct

  try {
    const session = JSON.parse(plain) as unknown;
    if (
      !session ||
      typeof session !== "object" ||
      (session as { schemaVersion?: number }).schemaVersion !== CURRENT_SCHEMA
    ) {
      return null;
    }
    return session as PersistedSession;
  } catch {
    return null;
  }
}

/**
 * Encrypts the session under `passphrase` and persists the resulting
 * {@link EncryptedBlob} as JSON. The master secret never touches localStorage
 * in plaintext.
 *
 * @throws if Web Crypto is unavailable (caller should surface a "secure
 * storage unsupported" message).
 */
export async function saveSession(s: PersistedSession, passphrase: string): Promise<void> {
  const blob = await encryptJson(JSON.stringify(s), passphrase);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(blob));
}

export function clearSession(): void {
  localStorage.removeItem(STORAGE_KEY);
}
