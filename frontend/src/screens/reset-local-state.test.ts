import { describe, it, expect } from "vitest";
import {
  resettableKeys,
  MASTER_SECRET_KEY,
  PENDING_CLAIMS_KEY,
  PENDING_WITHDRAWS_KEY,
} from "./reset-local-state";

const ALL = [
  "quetzal-network",
  "quetzal-ui-theme",
  MASTER_SECRET_KEY,
  PENDING_CLAIMS_KEY,
  PENDING_WITHDRAWS_KEY,
  "quetzal:orders:0xabc", // colon-namespaced order journal — NOT a "quetzal-" key
  "some-other-app-key",
];

describe("resettableKeys (H10: never nuke money-critical secrets by surprise)", () => {
  it("preserves the master secret in BOTH modes (the UI promises it is kept)", () => {
    expect(resettableKeys(ALL, { wipePendingSecrets: false })).not.toContain(MASTER_SECRET_KEY);
    expect(resettableKeys(ALL, { wipePendingSecrets: true })).not.toContain(MASTER_SECRET_KEY);
  });

  it("keeps pending claim/withdraw secrets by default (no opt-in)", () => {
    const k = resettableKeys(ALL, { wipePendingSecrets: false });
    expect(k).not.toContain(PENDING_CLAIMS_KEY);
    expect(k).not.toContain(PENDING_WITHDRAWS_KEY);
    expect(k).toEqual(["quetzal-network", "quetzal-ui-theme"]);
  });

  it("removes pending secrets ONLY when explicitly opted in (still never the master secret)", () => {
    const k = resettableKeys(ALL, { wipePendingSecrets: true });
    expect(k).toContain(PENDING_CLAIMS_KEY);
    expect(k).toContain(PENDING_WITHDRAWS_KEY);
    expect(k).not.toContain(MASTER_SECRET_KEY);
  });

  it("only ever touches quetzal- prefixed keys (leaves foreign + colon-namespaced keys)", () => {
    const k = resettableKeys(ALL, { wipePendingSecrets: true });
    expect(k).not.toContain("some-other-app-key");
    expect(k).not.toContain("quetzal:orders:0xabc");
  });
});
