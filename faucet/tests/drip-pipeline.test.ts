import { describe, test, expect, vi } from "vitest";
import { runDripPipeline, type DripDeps } from "@/lib/drip-pipeline";
import { RateLimiter } from "@/lib/rate-limit";

function mkDeps(overrides: Partial<DripDeps> = {}): DripDeps {
  return {
    verifyCaptcha: vi.fn().mockResolvedValue(true),
    rateLimiter: new RateLimiter({ sqlitePath: ":memory:", perIpMaxDripsPerWindow: 4, perIpWindowSeconds: 28_800, dailyCap: 500 }),
    clock: { now: () => 1_700_000_000 },
    bridgeFeeJuice: vi.fn().mockResolvedValue({
      l1TxHash: "0x" + "aa".repeat(32),
      messageHashHex: "0x" + "bb".repeat(32),
      messageLeafIndex: 42n,
      claimSecretHex: "0x" + "cc".repeat(32),
      claimSecretHashHex: "0x" + "dd".repeat(32),
    }),
    mintTokens: vi.fn().mockResolvedValue({ txHash: "0x" + "ee".repeat(32) }),
    config: {
      feeJuiceAmount: 100_000_000_000_000_000_000n,
      tUSDCAmount: 1_000_000_000n,
      tETHAmount: 500_000_000_000_000_000n,
      drainThresholdMultiplier: 10,
    },
    checkDrained: vi.fn().mockResolvedValue(false),
    withOnChainLock: <T,>(fn: () => Promise<T>) => fn(),
    auditLog: { append: vi.fn() },
    ...overrides,
  };
}

describe("runDripPipeline", () => {
  test("happy path returns success + composite response", async () => {
    const deps = mkDeps();
    const result = await runDripPipeline({
      address: "0x" + "11".repeat(32),
      captchaToken: "valid",
      ip: "1.1.1.2",
      deps,
    });
    expect(result.status).toBe(200);
    expect(result.body.success).toBe(true);
    if (result.body.success) {
      expect(result.body.claimData.l1TxHash).toMatch(/^0x[0-9a-f]+$/);
      expect(result.body.tUSDCMint.amount).toBe("1000000000");
      expect(result.body.tETHMint.amount).toBe("500000000000000000");
      // Both mints ride in ONE batched tx, so they share the single tx hash.
      expect(result.body.tUSDCMint.txHash).toBe("0x" + "ee".repeat(32));
      expect(result.body.tETHMint.txHash).toBe(result.body.tUSDCMint.txHash);
    }
    // mintTokens is called exactly once (one batched proof, not two).
    expect(deps.mintTokens).toHaveBeenCalledTimes(1);
    expect(deps.mintTokens).toHaveBeenCalledWith("0x" + "11".repeat(32), 1_000_000_000n, 500_000_000_000_000_000n);
  });

  test("invalid address -> 400", async () => {
    const result = await runDripPipeline({
      address: "not-hex",
      captchaToken: "valid",
      ip: "1.1.1.1",
      deps: mkDeps(),
    });
    expect(result.status).toBe(400);
    expect(result.body.success).toBe(false);
  });

  test("invalid captcha -> 400", async () => {
    const result = await runDripPipeline({
      address: "0x" + "11".repeat(32),
      captchaToken: "stale",
      ip: "1.1.1.1",
      deps: mkDeps({ verifyCaptcha: vi.fn().mockResolvedValue(false) }),
    });
    expect(result.status).toBe(400);
    if (!result.body.success) {
      expect(result.body.error).toMatch(/captcha/i);
    }
  });

  test("rate-limited -> 429 with retryAfter", async () => {
    const deps = mkDeps({
      rateLimiter: new RateLimiter({ sqlitePath: ":memory:", perIpMaxDripsPerWindow: 1, perIpWindowSeconds: 28_800, dailyCap: 500 }),
    });
    await runDripPipeline({ address: "0x" + "11".repeat(32), captchaToken: "v", ip: "5.5.5.5", deps });
    const r2 = await runDripPipeline({ address: "0x" + "22".repeat(32), captchaToken: "v", ip: "5.5.5.5", deps });
    expect(r2.status).toBe(429);
    if (!r2.body.success) {
      expect(r2.body.retryAfterSeconds).toBeGreaterThan(0);
    }
  });

  test("drained -> 503", async () => {
    const result = await runDripPipeline({
      address: "0x" + "11".repeat(32),
      captchaToken: "v",
      ip: "1.1.1.9",
      deps: mkDeps({ checkDrained: vi.fn().mockResolvedValue(true) }),
    });
    expect(result.status).toBe(503);
    if (!result.body.success) {
      expect(result.body.error).toMatch(/drained/i);
      expect(result.body.code).toBe("drained");
    }
  });

  test("L1 bridge throw -> 503 + audit log includes error", async () => {
    const auditAppend = vi.fn();
    const result = await runDripPipeline({
      address: "0x" + "11".repeat(32),
      captchaToken: "v",
      ip: "9.9.9.9",
      deps: mkDeps({
        bridgeFeeJuice: vi.fn().mockRejectedValue(new Error("ECONNREFUSED")),
        auditLog: { append: auditAppend },
      }),
    });
    expect(result.status).toBe(503);
    expect(auditAppend).toHaveBeenCalled();
    // A node/bridge throw is a temporary hiccup, not exhaustion.
    if (!result.body.success) expect(result.body.code).toBe("transient");
  });

  test("Audit #6: raw upstream error (URL/key) is NOT echoed to the client", async () => {
    const auditAppend = vi.fn();
    const secret = "https://rpc.example.com/v1/SUPER_SECRET_API_KEY_abc123";
    const result = await runDripPipeline({
      address: "0x" + "11".repeat(32),
      captchaToken: "v",
      ip: "9.9.9.8",
      deps: mkDeps({
        bridgeFeeJuice: vi.fn().mockRejectedValue(new Error(`fetch failed to ${secret}`)),
        auditLog: { append: auditAppend },
      }),
    });
    expect(result.status).toBe(503);
    if (!result.body.success) {
      // Client body must carry ONLY a coarse category — no substring of the raw error.
      expect(result.body.error).not.toContain("SUPER_SECRET");
      expect(result.body.error).not.toContain("rpc.example.com");
      expect(result.body.error).toMatch(/transient failure \((timeout|upstream-unreachable|upstream-throttled|unavailable)\)/);
    }
    // ...but the server-side audit log DOES capture the raw message for ops.
    const logged = auditAppend.mock.calls.map((c) => JSON.stringify(c[0])).join("");
    expect(logged).toContain("rpc.example.com");
  });

  // M14: the drain check runs INSIDE the try, so a transient checkDrained() RPC
  // failure becomes the sanitized 503 instead of an unsanitized throw that leaks.
  test("M14: a checkDrained() failure is sanitized to a 503, not thrown", async () => {
    const result = await runDripPipeline({
      address: "0x" + "11".repeat(32),
      captchaToken: "v",
      ip: "9.9.9.7",
      deps: mkDeps({
        checkDrained: vi.fn().mockRejectedValue(new Error("rpc://user:SUPER_SECRET@rpc.example.com down")),
      }),
    });
    expect(result.status).toBe(503);
    if (!result.body.success) {
      expect(result.body.code).toBe("transient");
      expect(result.body.error).not.toContain("SUPER_SECRET");
    }
  });

  // M15: a drained drip must release its rate-limit reservation so a non-dispensing
  // request does not permanently consume per-IP / global-cap capacity.
  test("M15: a drained drip releases its reservation (capacity not consumed)", async () => {
    const rateLimiter = new RateLimiter({
      sqlitePath: ":memory:",
      perIpMaxDripsPerWindow: 100,
      perIpWindowSeconds: 28_800,
      dailyCap: 1, // one slot total
    });
    const result = await runDripPipeline({
      address: "0x" + "11".repeat(32),
      captchaToken: "v",
      ip: "9.9.9.6",
      deps: mkDeps({ rateLimiter, checkDrained: vi.fn().mockResolvedValue(true) }),
    });
    expect(result.status).toBe(503);
    if (!result.body.success) expect(result.body.code).toBe("drained");
    // The single slot was released, so a fresh reservation is still allowed.
    expect(rateLimiter.checkAndRecord("8.8.8.8", { now: () => 1_700_000_000 }).allowed).toBe(true);
    rateLimiter.close();
  });
});
