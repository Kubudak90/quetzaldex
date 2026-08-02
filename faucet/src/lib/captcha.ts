const RECAPTCHA_SITEVERIFY = "https://www.google.com/recaptcha/api/siteverify";

interface VerifyCaptchaOpts {
  token: string;
  secretKey: string;
  /** Server-side captcha toggle (config.requireCaptcha). When false the faucet
   * skips verification entirely. */
  requireCaptcha: boolean;
  /** reCAPTCHA v3 score floor (config.recaptchaMinScore). */
  minScore: number;
  /** Expected v3 action bound by the page's grecaptcha.execute call. */
  expectedAction: string;
}

interface SiteverifyResponse {
  success: boolean;
  score?: number;
  action?: string;
  "error-codes"?: string[];
}

/**
 * Audit #6: the old implementation accepted a public-shared `bypassKey` that was
 * baked into the browser bundle AND equalled the server's secret — anyone could
 * read it and skip captcha entirely (faucet drain risk). This replaces that with
 * an explicit server-side toggle:
 *
 *   - requireCaptcha === false  → captcha disabled by config (testnet); allow.
 *   - requireCaptcha === true   → captcha REQUIRED. If no secretKey is configured
 *                                 we FAIL CLOSED (return false) rather than letting
 *                                 a misconfiguration silently disable verification.
 *   - otherwise                 → real reCAPTCHA v3 siteverify against opts.token.
 *
 * No secret is ever shipped to the browser.
 */
export async function verifyCaptcha(opts: VerifyCaptchaOpts): Promise<boolean> {
  if (!opts.requireCaptcha) return true; // captcha disabled by server config
  if (!opts.secretKey) return false; // required but unconfigured → fail closed
  try {
    const res = await fetch(RECAPTCHA_SITEVERIFY, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ response: opts.token, secret: opts.secretKey }).toString(),
    });
    if (!res.ok) return false;
    const body = (await res.json()) as SiteverifyResponse;
    if (body.success !== true) return false;
    if (typeof body.score !== "number" || body.score < opts.minScore) return false;
    if (body.action !== opts.expectedAction) return false;
    return true;
  } catch {
    return false;
  }
}
