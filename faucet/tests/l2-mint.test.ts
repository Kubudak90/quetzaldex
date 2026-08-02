import { describe, test, expect, vi } from "vitest";
import { L2_TOKEN_DECIMALS, isTransientError, sendWithRetry } from "@/lib/l2-mint";

describe("L2_TOKEN_DECIMALS", () => {
  test("tUSDC has 6 decimals", () => {
    expect(L2_TOKEN_DECIMALS.tUSDC).toBe(6);
  });
  test("tETH has 18 decimals", () => {
    expect(L2_TOKEN_DECIMALS.tETH).toBe(18);
  });
});

describe("isTransientError", () => {
  test("classifies dRPC-LB block-hash hiccups as transient", () => {
    expect(isTransientError("transient failure: Block hash 0x0012… not found")).toBe(true);
    expect(isTransientError("world state out of sync")).toBe(true);
    expect(isTransientError("L1 to L2 message not yet found")).toBe(true);
    expect(isTransientError("fetch failed")).toBe(true);
    expect(isTransientError("Request failed with status code 429")).toBe(true);
  });
  test("treats assertion / logic failures as non-transient", () => {
    expect(isTransientError("Assertion failed: caller is not the minter")).toBe(false);
    expect(isTransientError("amount must be positive")).toBe(false);
  });
});

describe("sendWithRetry", () => {
  const noSleep = (_ms: number) => Promise.resolve();

  test("returns the result on first success without sleeping", async () => {
    const sleep = vi.fn(noSleep);
    const fn = vi.fn(async () => "ok");
    await expect(sendWithRetry(fn, { sleep })).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  test("retries on a transient error then succeeds", async () => {
    const sleep = vi.fn(noSleep);
    let calls = 0;
    const fn = vi.fn(async () => {
      calls++;
      if (calls < 3) throw new Error("Block hash 0xabc not found");
      return "ok";
    });
    await expect(sendWithRetry(fn, { sleep, maxAttempts: 4 })).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  test("re-throws immediately on a non-transient error", async () => {
    const sleep = vi.fn(noSleep);
    const fn = vi.fn(async () => {
      throw new Error("Assertion failed: caller is not the minter");
    });
    await expect(sendWithRetry(fn, { sleep })).rejects.toThrow(/not the minter/);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  test("gives up after maxAttempts persistent transient failures", async () => {
    const sleep = vi.fn(noSleep);
    const fn = vi.fn(async () => {
      throw new Error("world state not found");
    });
    await expect(sendWithRetry(fn, { sleep, maxAttempts: 3 })).rejects.toThrow(/world state/);
    expect(fn).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });
});
