// Sub-7a Task 13: POST /api/drip — Next.js Pages API route.
//
// CORS allowlist + body validation + IP extraction live here; the actual
// drip logic is delegated to runDripPipeline so the integration is fully
// unit-testable (see tests/drip-pipeline.test.ts).

import type { NextApiRequest, NextApiResponse } from "next";
import { DripRequestSchema } from "@/lib/types";
import { matchOrigin } from "@/lib/cors";
import { getRuntime } from "@/lib/runtime";
import { metrics } from "@/lib/metrics";
import { runDripPipeline } from "@/lib/drip-pipeline";
import { verifyCaptcha } from "@/lib/captcha";
import { getClientIp } from "@/lib/client-ip";

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
): Promise<void> {
  const rt = getRuntime();

  // CORS: only echo Access-Control-Allow-Origin when the request's Origin
  // header matches the configured allowlist. Block all cross-origin requests
  // from non-allowlisted origins.
  const origin = req.headers.origin ?? "";
  if (origin && !matchOrigin(origin, rt.config.allowedOrigins)) {
    res.status(403).end();
    return;
  }
  if (origin) res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");

  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.status(204).end();
    return;
  }
  if (req.method !== "POST") {
    res.status(405).json({ success: false, error: "method not allowed" });
    return;
  }

  const parsed = DripRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      success: false,
      error: "invalid body: " + parsed.error.issues.map((i) => i.message).join("; "),
    });
    return;
  }

  // Audit #5: the client IP for rate limiting is the LAST X-Forwarded-For entry
  // (the real peer appended by our single reverse-proxy hop). Trusting the first
  // entry let a client spoof its IP via a forged X-Forwarded-For header and
  // bypass the per-IP rate limit. See getClientIp for the full rationale.
  const ip = getClientIp(req);
  const exempt = matchOrigin(origin, rt.config.captchaExemptOrigins);

  const out = await runDripPipeline({
    address: parsed.data.address,
    captchaToken: parsed.data.captchaToken ?? "",
    ip,
    deps: {
      verifyCaptcha: (t) =>
        verifyCaptcha({
          token: t,
          secretKey: rt.config.recaptchaSecretKey,
          requireCaptcha: exempt ? false : rt.config.requireCaptcha,
          minScore: rt.config.recaptchaMinScore,
          expectedAction: "drip",
        }),
      rateLimiter: rt.rateLimiter,
      bridgeFeeJuice: (to, amount) => rt.l1Bridge.bridgeFeeJuice(to, amount),
      mintTokens: (to, tUSDCAmount, tETHAmount) => rt.mintTokens(to, tUSDCAmount, tETHAmount),
      checkDrained: () => rt.checkDrained(),
      withOnChainLock: (fn) => rt.withOnChainLock(fn),
      config: rt.config,
      auditLog: rt.auditLog,
    },
  });

  if (out.status === 200) metrics.dripTotal.inc();
  else if (out.status === 429) metrics.throttledTotal.inc();
  else metrics.dripFailedTotal.inc();

  res.status(out.status).json(out.body);
}
