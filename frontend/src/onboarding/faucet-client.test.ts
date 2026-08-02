import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import {
  dripFaucet,
  FaucetRateLimitedError,
  FaucetDrainedError,
  FaucetTransientError,
  FaucetTimeoutError,
  FaucetNetworkError,
  type DripResult,
} from "./faucet-client";

const baseFetch = global.fetch;
const validAddr = "0x" + "11".repeat(32) as `0x${string}`;

const happyResponse = {
  success: true,
  claimData: {
    claimAmount: "100000000000000000000",
    claimSecretHex: "0x" + "aa".repeat(32),
    claimSecretHashHex: "0x" + "bb".repeat(32),
    messageHashHex: "0x" + "cc".repeat(32),
    messageLeafIndex: "92847362",
    l1TxHash: "0x" + "dd".repeat(32),
  },
  tUSDCMint: { txHash: "0x" + "ee".repeat(32), amount: "1000000000" },
  tETHMint: { txHash: "0x" + "ff".repeat(32), amount: "500000000000000000" },
};

beforeEach(() => { vi.useRealTimers(); });
afterEach(() => { global.fetch = baseFetch; });

describe("dripFaucet", () => {
  test("happy path returns DripResult with l2Address + claimData + mints", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => happyResponse,
    }) as unknown as typeof fetch;

    const r = await dripFaucet({
      faucetUrl: "https://faucet.example",
      address: validAddr,
    });
    expect(r.l2Address).toBe(validAddr);
    // Audit #6: the request body must carry the address and must NOT carry a
    // bypass/captcha token (server governs captcha via FAUCET_REQUIRE_CAPTCHA).
    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    const sentBody = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
    expect(sentBody.address).toBe(validAddr);
    expect(sentBody.captchaToken).toBeUndefined();
    expect(r.claimData.l1TxHash).toBe(happyResponse.claimData.l1TxHash);
    expect(r.tUSDCMint.txHash).toBe(happyResponse.tUSDCMint.txHash);
    expect(r.tETHMint.txHash).toBe(happyResponse.tETHMint.txHash);
  });

  test("429 → FaucetRateLimitedError with retryAfterSeconds", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      json: async () => ({ success: false, error: "rate-limited", retryAfterSeconds: 7200 }),
    }) as unknown as typeof fetch;

    await expect(dripFaucet({ faucetUrl: "https://x", address: validAddr }))
      .rejects.toBeInstanceOf(FaucetRateLimitedError);

    try {
      await dripFaucet({ faucetUrl: "https://x", address: validAddr });
    } catch (e) {
      expect(e).toBeInstanceOf(FaucetRateLimitedError);
      expect((e as FaucetRateLimitedError).retryAfterSeconds).toBe(7200);
    }
  });

  test("503 code:drained → FaucetDrainedError", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({ success: false, error: "faucet drained", code: "drained" }),
    }) as unknown as typeof fetch;

    await expect(dripFaucet({ faucetUrl: "https://x", address: validAddr }))
      .rejects.toBeInstanceOf(FaucetDrainedError);
  });

  test("503 code:transient → FaucetTransientError (retryable, not 'drained')", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({ success: false, error: "transient failure: Block hash not found", code: "transient" }),
    }) as unknown as typeof fetch;

    const p = dripFaucet({ faucetUrl: "https://x", address: validAddr });
    await expect(p).rejects.toBeInstanceOf(FaucetTransientError);
    await expect(p).rejects.not.toBeInstanceOf(FaucetDrainedError);
  });

  test("503 with no code defaults to FaucetDrainedError (back-compat)", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({ success: false, error: "faucet drained" }),
    }) as unknown as typeof fetch;

    await expect(dripFaucet({ faucetUrl: "https://x", address: validAddr }))
      .rejects.toBeInstanceOf(FaucetDrainedError);
  });

  test("network throw → FaucetNetworkError", async () => {
    global.fetch = vi.fn().mockRejectedValue(new TypeError("Failed to fetch")) as unknown as typeof fetch;

    await expect(dripFaucet({ faucetUrl: "https://x", address: validAddr }))
      .rejects.toBeInstanceOf(FaucetNetworkError);
  });

  test("AbortSignal cancels the request", async () => {
    global.fetch = vi.fn().mockImplementation((_url, init) => {
      return new Promise((_resolve, reject) => {
        (init as RequestInit | undefined)?.signal?.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        });
      });
    }) as unknown as typeof fetch;

    const ctrl = new AbortController();
    const p = dripFaucet({ faucetUrl: "https://x", address: validAddr, signal: ctrl.signal });
    ctrl.abort();
    await expect(p).rejects.toThrow();
  });
});
