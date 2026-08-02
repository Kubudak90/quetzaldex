import { describe, test, expect, beforeEach } from "vitest";
import {
  loadSession,
  saveSession,
  clearSession,
  hasSession,
  type PersistedSession,
} from "./persistence";

const STORAGE_KEY = "quetzal-onboarded-v1";
const PASS = "correct horse battery staple";

const SAMPLE: PersistedSession = {
  schemaVersion: 1,
  masterSecret: ("0x" + "ab".repeat(32)) as `0x${string}`,
  poolSize: 3,
  network: "alpha-testnet",
  deployedAddresses: [("0x" + "cd".repeat(32)) as `0x${string}`],
  onboardedAt: 1_700_000_000_000,
};

describe("persistence (encrypted at rest — Audit #8)", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  test("round-trips a saved session through the passphrase", async () => {
    await saveSession(SAMPLE, PASS);
    const loaded = await loadSession(PASS);
    expect(loaded).toEqual(SAMPLE);
  });

  test("the master secret is never written to localStorage in plaintext", async () => {
    await saveSession(SAMPLE, PASS);
    const raw = localStorage.getItem(STORAGE_KEY) ?? "";
    expect(raw).not.toContain(SAMPLE.masterSecret);
    // Stored value is a v2 encrypted blob.
    const parsed = JSON.parse(raw) as { v?: number };
    expect(parsed.v).toBe(2);
  });

  test("loadSession returns null when nothing is saved", async () => {
    expect(await loadSession(PASS)).toBeNull();
  });

  test("loadSession with the wrong passphrase returns null", async () => {
    await saveSession(SAMPLE, PASS);
    expect(await loadSession("wrong passphrase")).toBeNull();
  });

  test("loadSession returns null for corrupt JSON", async () => {
    localStorage.setItem(STORAGE_KEY, "{not json");
    expect(await loadSession(PASS)).toBeNull();
  });

  test("hasSession is true after save, false after clear", async () => {
    expect(hasSession()).toBe(false);
    await saveSession(SAMPLE, PASS);
    expect(hasSession()).toBe(true);
    clearSession();
    expect(hasSession()).toBe(false);
  });

  test("clears a saved session", async () => {
    await saveSession(SAMPLE, PASS);
    clearSession();
    expect(await loadSession(PASS)).toBeNull();
  });

  test("legacy plaintext value is cleared and loadSession returns null", async () => {
    // Pre-Audit-#8 shape: the raw PersistedSession as plaintext JSON.
    localStorage.setItem(STORAGE_KEY, JSON.stringify(SAMPLE));
    // hasSession must NOT treat legacy plaintext as a valid (encrypted) session.
    expect(hasSession()).toBe(false);
    // loadSession wipes it and returns null (privacy: never keep plaintext secrets).
    expect(await loadSession(PASS)).toBeNull();
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  test("legacy wrong-schema plaintext is also cleared and returns null", async () => {
    localStorage.setItem(STORAGE_KEY, '{"schemaVersion": 99}');
    expect(await loadSession(PASS)).toBeNull();
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });
});
