import { describe, it, expect } from "vitest";
import { safeReason } from "../src/lib/safe-error.js";

describe("safeReason (Audit #7 — no raw error leakage)", () => {
  it("never returns any substring of a leaked Quicknode URL/key", () => {
    const secretUrl =
      "https://empty-dark-film.ethereum-sepolia.quiknode.pro/abcdef0123456789secretkey";
    const reason = safeReason(new Error(`getaddrinfo ENOTFOUND for ${secretUrl}`));
    expect(reason).not.toContain("quiknode");
    expect(reason).not.toContain("abcdef0123456789secretkey");
    expect(reason).not.toContain("http");
    expect(reason).toBe("upstream-unreachable");
  });

  it("categorizes timeouts", () => {
    expect(safeReason(new Error("Request timed out after 30000ms"))).toBe("timeout");
    expect(safeReason(new Error("connect ETIMEDOUT 1.2.3.4:443"))).toBe("timeout");
  });

  it("categorizes unreachable upstreams", () => {
    expect(safeReason(new Error("connect ECONNREFUSED 127.0.0.1:8545"))).toBe(
      "upstream-unreachable",
    );
    expect(safeReason(new Error("fetch failed"))).toBe("upstream-unreachable");
  });

  it("categorizes upstream throttling", () => {
    expect(safeReason(new Error("Too Many Requests (429)"))).toBe("upstream-throttled");
  });

  it("falls back to a generic category for unknown errors", () => {
    expect(safeReason(new Error("something weird with secret /etc/passwd"))).toBe("unavailable");
    expect(safeReason("plain string with apikey=SECRET123")).toBe("unavailable");
  });

  it("only ever returns one of the known safe categories", () => {
    const allowed = new Set(["timeout", "upstream-unreachable", "upstream-throttled", "unavailable"]);
    for (const e of [new Error("x"), "y", 42, null, undefined, { a: 1 }]) {
      expect(allowed.has(safeReason(e))).toBe(true);
    }
  });
});
