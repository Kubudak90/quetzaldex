import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { verifyCaptcha } from "@/lib/captcha";

const baseFetch = global.fetch;

beforeEach(() => { vi.restoreAllMocks(); });
afterEach(() => { global.fetch = baseFetch; });

const BASE = { token: "tok", secretKey: "sec", requireCaptcha: true, minScore: 0.5, expectedAction: "drip" };

function mockSiteverify(body: unknown, ok = true) {
  global.fetch = vi.fn().mockResolvedValue({ ok, json: async () => body }) as unknown as typeof fetch;
  return global.fetch as unknown as ReturnType<typeof vi.fn>;
}

describe("verifyCaptcha (reCAPTCHA v3)", () => {
  test("returns true without calling Google when requireCaptcha is false", async () => {
    const spy = mockSiteverify({});
    expect(await verifyCaptcha({ ...BASE, requireCaptcha: false, token: "", secretKey: "" })).toBe(true);
    expect(spy).not.toHaveBeenCalled();
  });

  test("fail-closed: required but no secret configured", async () => {
    const spy = mockSiteverify({});
    expect(await verifyCaptcha({ ...BASE, secretKey: "" })).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  test("accepts success with score >= minScore and matching action", async () => {
    mockSiteverify({ success: true, score: 0.9, action: "drip" });
    expect(await verifyCaptcha(BASE)).toBe(true);
  });

  test("accepts score exactly equal to minScore (floor is inclusive)", async () => {
    mockSiteverify({ success: true, score: 0.5, action: "drip" });
    expect(await verifyCaptcha(BASE)).toBe(true);
  });

  test("rejects when score below minScore", async () => {
    mockSiteverify({ success: true, score: 0.3, action: "drip" });
    expect(await verifyCaptcha(BASE)).toBe(false);
  });

  test("rejects when action does not match", async () => {
    mockSiteverify({ success: true, score: 0.9, action: "login" });
    expect(await verifyCaptcha(BASE)).toBe(false);
  });

  test("rejects when success is false", async () => {
    mockSiteverify({ success: false, "error-codes": ["invalid-input-response"] });
    expect(await verifyCaptcha(BASE)).toBe(false);
  });

  test("rejects when siteverify responds non-OK", async () => {
    mockSiteverify({ success: true, score: 0.9, action: "drip" }, false);
    expect(await verifyCaptcha(BASE)).toBe(false);
  });

  test("rejects when fetch throws (network)", async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error("boom")) as unknown as typeof fetch;
    expect(await verifyCaptcha(BASE)).toBe(false);
  });

  test("posts secret+response to the Google endpoint", async () => {
    const spy = mockSiteverify({ success: true, score: 1, action: "drip" });
    await verifyCaptcha(BASE);
    const [url, init] = spy.mock.calls[0]!;
    expect(url).toBe("https://www.google.com/recaptcha/api/siteverify");
    expect(String((init as RequestInit).body)).toContain("secret=sec");
    expect(String((init as RequestInit).body)).toContain("response=tok");
  });
});
