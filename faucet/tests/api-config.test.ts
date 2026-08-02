import { describe, test, expect, vi } from "vitest";

// Mock the runtime BEFORE importing the handler (module-level getRuntime call).
vi.mock("@/lib/runtime", () => ({
  getRuntime: () => ({
    config: {
      requireCaptcha: true,
      recaptchaSiteKey: "site-key-public",
      tUSDCAmount: 1000000000n,
      tETHAmount: 500000000000000000n,
      feeJuiceAmount: 50000000000000000000n,
      globalDailyCap: 100,
      allowedOrigins: ["https://quetzaldex.xyz"],
    },
  }),
}));

import handler from "@/pages/api/config";
import type { NextApiRequest, NextApiResponse } from "next";

function mockRes() {
  const res: Partial<NextApiResponse> & { body?: unknown; statusCode?: number } = {};
  res.setHeader = vi.fn() as never;
  res.status = ((code: number) => { res.statusCode = code; return res; }) as never;
  res.json = ((body: unknown) => { res.body = body; return res; }) as never;
  res.end = vi.fn() as never;
  return res as NextApiResponse & { body?: { requireCaptcha: boolean; recaptchaSiteKey: string; amounts: Record<string, string>; globalDailyCap: number }; statusCode?: number };
}

describe("GET /api/config", () => {
  test("returns public UI config (no secret)", async () => {
    const res = mockRes();
    await handler({ method: "GET", headers: {} } as NextApiRequest, res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      requireCaptcha: true,
      recaptchaSiteKey: "site-key-public",
      amounts: { tUSDC: "1000000000", tETH: "500000000000000000", feeJuice: "50000000000000000000" },
      globalDailyCap: 100,
    });
    expect(JSON.stringify(res.body)).not.toContain("secret");
  });

  test("rejects non-GET", async () => {
    const res = mockRes();
    await handler({ method: "POST", headers: {} } as NextApiRequest, res);
    expect(res.statusCode).toBe(405);
  });
});
