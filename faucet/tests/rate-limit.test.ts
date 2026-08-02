import { describe, test, expect, beforeEach } from "vitest";
import { RateLimiter } from "@/lib/rate-limit";

function makeLimiter(opts?: Partial<{
  perIpMaxDripsPerWindow: number;
  perIpWindowSeconds: number;
  dailyCap: number;
}>) {
  return new RateLimiter({
    sqlitePath: ":memory:",
    perIpMaxDripsPerWindow: opts?.perIpMaxDripsPerWindow ?? 4,
    perIpWindowSeconds: opts?.perIpWindowSeconds ?? 28_800,
    dailyCap: opts?.dailyCap ?? 500,
  });
}

let now = 1_700_000_000;
const clock = { now: () => now };

beforeEach(() => { now = 1_700_000_000; });

describe("RateLimiter — per-IP count-in-window", () => {
  test("first N hits from same IP are allowed (default 4 per 8h)", () => {
    const lim = makeLimiter({ perIpMaxDripsPerWindow: 4, perIpWindowSeconds: 28_800 });
    for (let i = 0; i < 4; i++) {
      const r = lim.checkAndRecord("1.2.3.4", clock);
      expect(r.allowed).toBe(true);
      now += 10;
    }
  });

  test("(N+1)-th hit within window is throttled", () => {
    const lim = makeLimiter({ perIpMaxDripsPerWindow: 4, perIpWindowSeconds: 28_800 });
    for (let i = 0; i < 4; i++) {
      lim.checkAndRecord("1.2.3.4", clock);
      now += 10;
    }
    const r = lim.checkAndRecord("1.2.3.4", clock);
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe("per-ip");
    expect(r.retryAfterSeconds).toBeGreaterThan(28_000);
  });

  test("hits older than window do not count", () => {
    const lim = makeLimiter({ perIpMaxDripsPerWindow: 2, perIpWindowSeconds: 100 });
    lim.checkAndRecord("1.2.3.4", clock);
    now += 50;
    lim.checkAndRecord("1.2.3.4", clock);
    now += 60; // first hit now 110s old — out of window
    const r = lim.checkAndRecord("1.2.3.4", clock);
    expect(r.allowed).toBe(true);
  });

  test("retryAfterSeconds = (oldest in-window hit's age subtracted from window)", () => {
    const lim = makeLimiter({ perIpMaxDripsPerWindow: 2, perIpWindowSeconds: 100 });
    lim.checkAndRecord("1.2.3.4", clock);
    now += 10;
    lim.checkAndRecord("1.2.3.4", clock);
    now += 5;
    const r = lim.checkAndRecord("1.2.3.4", clock);
    expect(r.allowed).toBe(false);
    // Oldest hit was 15s ago in a 100s window → retry in 85s.
    expect(r.retryAfterSeconds).toBe(85);
  });

  test("different IPs do not share counts", () => {
    const lim = makeLimiter({ perIpMaxDripsPerWindow: 1, perIpWindowSeconds: 100 });
    lim.checkAndRecord("1.2.3.4", clock);
    const r = lim.checkAndRecord("5.6.7.8", clock);
    expect(r.allowed).toBe(true);
  });
});

describe("RateLimiter — global cap and stats", () => {
  test("global daily cap blocks all requests at the limit", () => {
    const lim = makeLimiter({ dailyCap: 2 });
    expect(lim.checkAndRecord("1.1.1.1", clock).allowed).toBe(true);
    now += 1; expect(lim.checkAndRecord("2.2.2.2", clock).allowed).toBe(true);
    now += 1;
    const r = lim.checkAndRecord("3.3.3.3", clock);
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe("global-cap");
  });

  test("stats: totalRequests24h and throttled24h", () => {
    const lim = makeLimiter({ perIpMaxDripsPerWindow: 1 });
    lim.checkAndRecord("1.1.1.1", clock);
    now += 1; lim.checkAndRecord("1.1.1.1", clock);
    now += 1; lim.checkAndRecord("2.2.2.2", clock);
    const s = lim.stats(clock);
    expect(s.totalRequests24h).toBe(3);
    expect(s.throttled24h).toBe(1);
  });

  test("evictOlderThan24h drops stale rows", () => {
    const lim = makeLimiter();
    lim.checkAndRecord("1.1.1.1", clock);
    now += 86_401;
    lim.evictStale(clock);
    const s = lim.stats(clock);
    expect(s.totalRequests24h).toBe(0);
  });

  // M15: a released reservation must not count toward the caps.
  test("release() frees a reserved slot (global cap restored)", () => {
    const lim = makeLimiter({ dailyCap: 2 }); // distinct IPs so per-IP never trips
    const a = lim.checkAndRecord("1.1.1.1", clock);
    lim.checkAndRecord("2.2.2.2", clock);
    expect(a.allowed).toBe(true);
    expect(typeof a.id).toBe("number");
    expect(lim.checkAndRecord("3.3.3.3", clock).allowed).toBe(false); // cap reached
    lim.release(a.id!);
    expect(lim.checkAndRecord("3.3.3.3", clock).allowed).toBe(true); // capacity restored
  });

  test("release() frees per-IP capacity", () => {
    const lim = makeLimiter({ perIpMaxDripsPerWindow: 1 });
    const a = lim.checkAndRecord("9.9.9.9", clock);
    expect(a.allowed).toBe(true);
    expect(lim.checkAndRecord("9.9.9.9", clock).allowed).toBe(false);
    lim.release(a.id!);
    expect(lim.checkAndRecord("9.9.9.9", clock).allowed).toBe(true);
  });
});
