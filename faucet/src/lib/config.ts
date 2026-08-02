export class ConfigError extends Error {
  constructor(msg: string) { super(`[config] ${msg}`); this.name = "ConfigError"; }
}

export interface FaucetConfig {
  port: number;
  nodeEnv: string;
  l1RpcUrl: string;
  l1Pk: `0x${string}`;
  l1FeeJuicePortal?: `0x${string}`;
  l1ChainId: number;
  l2NodeUrl: string;
  l2Secret: `0x${string}`;
  /**
   * Optional Schnorr salt for recreating an existing deployed operator account.
   * Defaults to Fr.ZERO in l2-mint.ts when undefined.
   */
  l2Salt?: `0x${string}`;
  /**
   * Optional Schnorr signing key for recreating an existing deployed operator
   * account. REQUIRED when the on-chain admin's signing key wasn't derivable
   * from the secret (e.g. the m3-era admin used `Fq.random()` in deploy and
   * the value is persisted in testnet-m1-state.json).
   */
  l2SigningKey?: `0x${string}`;
  l2TUSDC: `0x${string}`;
  l2TETH: `0x${string}`;
  feeJuiceAmount: bigint;
  tUSDCAmount: bigint;
  tETHAmount: bigint;
  recaptchaSecretKey: string;
  recaptchaSiteKey: string;
  recaptchaMinScore: number;
  /**
   * Audit #6: server-side captcha toggle. When false the faucet skips captcha
   * verification entirely (testnet, which has no reCAPTCHA widget). Defaults to
   * true (secure-by-default) so production must explicitly opt out. Replaces the
   * old public-shared bypass key that shipped in the browser bundle.
   */
  requireCaptcha: boolean;
  globalDailyCap: number;
  perIpMaxDripsPerWindow: number;
  perIpWindowSeconds: number;
  allowedOrigins: Array<string | RegExp>;
  captchaExemptOrigins: Array<string | RegExp>;
  drainThresholdMultiplier: number;
  sqlitePath: string;
  auditLogPath: string;
}

function required(name: string): string {
  const v = process.env[name];
  if (!v || v.length === 0) throw new ConfigError(`missing required env ${name}`);
  return v;
}

function asBigint(name: string, raw: string): bigint {
  try { return BigInt(raw); } catch { throw new ConfigError(`${name} not a bigint: ${raw}`); }
}

function asNumber(name: string, raw: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new ConfigError(`${name} not a number: ${raw}`);
  return n;
}

// L16: reject non-positive or non-integer values for security-critical rate-limit knobs.
// A negative window makes rate-limit queries return no rows (rate-limiting silently disabled).
function asPositiveInt(name: string, raw: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    throw new ConfigError(`${name} must be a positive integer, got: ${raw}`);
  }
  return n;
}

// L15: anchor operator-supplied regex tokens at parse time to prevent substring
// matches. /quetzaldex\.xyz/ without anchors would match https://quetzaldex.xyz.attacker.com;
// wrapping with ^(?: ... )$ forces a full-string match.
function parseAllowedOrigins(raw: string): Array<string | RegExp> {
  return raw.split(",").map((s) => s.trim()).filter(Boolean).map((s) => {
    if (s.length >= 3 && s.startsWith("/") && s.endsWith("/")) {
      return new RegExp("^(?:" + s.slice(1, -1) + ")$");
    }
    return s;
  });
}

export function loadConfig(): FaucetConfig {
  if (process.env.HCAPTCHA_SECRET_KEY && !process.env.FAUCET_RECAPTCHA_SECRET_KEY) {
    console.warn(
      "[config] HCAPTCHA_SECRET_KEY is set but IGNORED since the reCAPTCHA migration; rename it to FAUCET_RECAPTCHA_SECRET_KEY or captcha will fail closed.",
    );
  }
  return {
    port: asNumber("FAUCET_PORT", required("FAUCET_PORT")),
    nodeEnv: required("FAUCET_NODE_ENV"),
    l1RpcUrl: required("FAUCET_L1_RPC_URL"),
    l1Pk: required("FAUCET_L1_PK") as `0x${string}`,
    l1FeeJuicePortal: (process.env.FAUCET_L1_FEE_JUICE_PORTAL || undefined) as `0x${string}` | undefined,
    l1ChainId: asNumber("FAUCET_L1_CHAIN_ID", required("FAUCET_L1_CHAIN_ID")),
    l2NodeUrl: required("FAUCET_L2_NODE_URL"),
    l2Secret: required("FAUCET_L2_SECRET") as `0x${string}`,
    l2Salt: (process.env.FAUCET_L2_SALT || undefined) as `0x${string}` | undefined,
    l2SigningKey: (process.env.FAUCET_L2_SIGNING_KEY || undefined) as `0x${string}` | undefined,
    l2TUSDC: required("FAUCET_L2_TUSDC") as `0x${string}`,
    l2TETH: required("FAUCET_L2_TETH") as `0x${string}`,
    feeJuiceAmount: asBigint("FAUCET_FEE_JUICE_AMOUNT", required("FAUCET_FEE_JUICE_AMOUNT")),
    tUSDCAmount: asBigint("FAUCET_TUSDC_AMOUNT", required("FAUCET_TUSDC_AMOUNT")),
    tETHAmount: asBigint("FAUCET_TETH_AMOUNT", required("FAUCET_TETH_AMOUNT")),
    recaptchaSecretKey: process.env.FAUCET_RECAPTCHA_SECRET_KEY ?? "",
    recaptchaSiteKey: process.env.FAUCET_RECAPTCHA_SITE_KEY ?? "",
    recaptchaMinScore: (() => {
      const raw = process.env.FAUCET_RECAPTCHA_MIN_SCORE;
      if (!raw) return 0.5;
      const n = asNumber("FAUCET_RECAPTCHA_MIN_SCORE", raw);
      // L16: clamp/validate into [0,1] — outside this range the score floor is vacuous (<0) or rejects all (>1).
      if (n < 0 || n > 1) throw new ConfigError(`FAUCET_RECAPTCHA_MIN_SCORE must be in [0,1], got: ${raw}`);
      return n;
    })(),
    requireCaptcha: (process.env.FAUCET_REQUIRE_CAPTCHA ?? "true") !== "false",
    // L16: use asPositiveInt — a negative/zero window makes rate-limit queries return no rows
    // (per-IP limiting silently disabled), and zero/negative caps are semantically invalid.
    globalDailyCap: asPositiveInt("FAUCET_GLOBAL_DAILY_CAP", required("FAUCET_GLOBAL_DAILY_CAP")),
    perIpMaxDripsPerWindow: asPositiveInt("FAUCET_PER_IP_MAX_DRIPS_PER_WINDOW", required("FAUCET_PER_IP_MAX_DRIPS_PER_WINDOW")),
    perIpWindowSeconds: asPositiveInt("FAUCET_PER_IP_WINDOW_SECONDS", required("FAUCET_PER_IP_WINDOW_SECONDS")),
    allowedOrigins: parseAllowedOrigins(required("FAUCET_ALLOWED_ORIGINS")),
    captchaExemptOrigins: parseAllowedOrigins(process.env.FAUCET_CAPTCHA_EXEMPT_ORIGINS ?? ""),
    drainThresholdMultiplier: asNumber("FAUCET_DRAIN_THRESHOLD_MULTIPLIER", required("FAUCET_DRAIN_THRESHOLD_MULTIPLIER")),
    sqlitePath: required("FAUCET_SQLITE_PATH"),
    auditLogPath: required("FAUCET_AUDIT_LOG_PATH"),
  };
}
