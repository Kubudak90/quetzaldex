// GET /api/config — PUBLIC UI configuration for the faucet page.
// Exposes only non-secret values: the reCAPTCHA v3 SITE key (public by
// design), the drip amounts (so UI copy can't drift from env) and the global
// daily cap (so the page can show remaining capacity next to
// /api/health's totalRequests24h). CORS mirrors drip.ts's allowlist echo so
// the main app origin may also read it.

import type { NextApiRequest, NextApiResponse } from "next";
import { matchOrigin } from "@/lib/cors";
import { getRuntime } from "@/lib/runtime";

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
): Promise<void> {
  const rt = getRuntime();

  const origin = req.headers.origin ?? "";
  if (origin && !matchOrigin(origin, rt.config.allowedOrigins)) {
    res.status(403).end();
    return;
  }
  if (origin) res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");

  if (req.method !== "GET") {
    res.status(405).json({ error: "method not allowed" });
    return;
  }

  res.status(200).json({
    requireCaptcha: rt.config.requireCaptcha,
    recaptchaSiteKey: rt.config.recaptchaSiteKey,
    amounts: {
      tUSDC: rt.config.tUSDCAmount.toString(),
      tETH: rt.config.tETHAmount.toString(),
      feeJuice: rt.config.feeJuiceAmount.toString(),
    },
    globalDailyCap: rt.config.globalDailyCap,
  });
}
