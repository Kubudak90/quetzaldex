import { describe, it, expect } from "vitest";
import type { NextApiRequest } from "next";
import { getClientIp } from "../src/lib/client-ip.js";

function reqWith(headers: Record<string, string | string[] | undefined>): NextApiRequest {
  return {
    headers,
    socket: { remoteAddress: "10.0.0.1" },
  } as unknown as NextApiRequest;
}

describe("getClientIp (Audit #5 — XFF spoof hardening)", () => {
  it("returns the LAST X-Forwarded-For entry (real peer appended by our proxy)", () => {
    expect(getClientIp(reqWith({ "x-forwarded-for": "1.2.3.4, 5.6.7.8" }))).toBe("5.6.7.8");
  });

  it("ignores spoofed earlier XFF entries (a client cannot append after the proxy)", () => {
    // Attacker sets `X-Forwarded-For: 66.66.66.66, 9.9.9.9`; the proxy then
    // appends the real peer 5.6.7.8. Only the last entry may be trusted.
    expect(getClientIp(reqWith({ "x-forwarded-for": "66.66.66.66, 9.9.9.9, 5.6.7.8" }))).toBe(
      "5.6.7.8",
    );
  });

  it("handles a single XFF entry", () => {
    expect(getClientIp(reqWith({ "x-forwarded-for": "5.6.7.8" }))).toBe("5.6.7.8");
  });

  it("trims whitespace and ignores empty trailing entries", () => {
    expect(getClientIp(reqWith({ "x-forwarded-for": "1.2.3.4, 5.6.7.8 ," }))).toBe("5.6.7.8");
  });

  it("uses the closest proxy value when XFF is surfaced as an array", () => {
    expect(getClientIp(reqWith({ "x-forwarded-for": ["7.7.7.7", "1.1.1.1, 5.6.7.8"] }))).toBe(
      "5.6.7.8",
    );
  });

  it("falls back to X-Real-IP only when no XFF is present", () => {
    expect(getClientIp(reqWith({ "x-real-ip": "9.9.9.9" }))).toBe("9.9.9.9");
  });

  it("falls back to socket.remoteAddress when no proxy headers are present", () => {
    expect(getClientIp(reqWith({}))).toBe("10.0.0.1");
  });
});
