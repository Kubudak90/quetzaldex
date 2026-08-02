import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { loadConfig, ConfigError } from "@/lib/config";

const MINIMAL_ENV: Record<string, string> = {
  FAUCET_PORT: "3030",
  FAUCET_NODE_ENV: "test",
  FAUCET_L1_RPC_URL: "https://sepolia.example",
  FAUCET_L1_PK: "0x" + "11".repeat(32),
  FAUCET_L1_FEE_JUICE_PORTAL: "0x" + "22".repeat(20),
  FAUCET_L1_CHAIN_ID: "11155111",
  FAUCET_L2_NODE_URL: "https://node.example",
  FAUCET_L2_SECRET: "0x" + "33".repeat(32),
  FAUCET_L2_TUSDC: "0x" + "44".repeat(32),
  FAUCET_L2_TETH: "0x" + "55".repeat(32),
  FAUCET_FEE_JUICE_AMOUNT: "100000000000000000000",
  FAUCET_TUSDC_AMOUNT: "1000000000",
  FAUCET_TETH_AMOUNT: "500000000000000000",
  FAUCET_RECAPTCHA_SECRET_KEY: "test-secret",
  FAUCET_GLOBAL_DAILY_CAP: "500",
  FAUCET_PER_IP_MAX_DRIPS_PER_WINDOW: "4",
  FAUCET_PER_IP_WINDOW_SECONDS: "28800",
  FAUCET_ALLOWED_ORIGINS: "https://quetzaldex.xyz",
  FAUCET_DRAIN_THRESHOLD_MULTIPLIER: "10",
  FAUCET_SQLITE_PATH: ":memory:",
  FAUCET_AUDIT_LOG_PATH: "/dev/null",
};

const savedEnv = { ...process.env };

beforeEach(() => {
  for (const k of Object.keys(MINIMAL_ENV)) delete process.env[k];
});
afterEach(() => {
  process.env = { ...savedEnv };
});

describe("loadConfig", () => {
  test("returns a typed config from a valid env", () => {
    Object.assign(process.env, MINIMAL_ENV);
    const cfg = loadConfig();
    expect(cfg.port).toBe(3030);
    expect(cfg.feeJuiceAmount).toBe(100000000000000000000n);
    expect(cfg.tUSDCAmount).toBe(1_000_000_000n);
    expect(cfg.allowedOrigins.length).toBe(1);
    expect(cfg.drainThresholdMultiplier).toBe(10);
    expect(cfg.l1ChainId).toBe(11155111);
    expect(cfg.perIpMaxDripsPerWindow).toBe(4);
    expect(cfg.perIpWindowSeconds).toBe(28_800);
  });

  test("throws ConfigError when a required key is missing", () => {
    Object.assign(process.env, { ...MINIMAL_ENV });
    delete process.env.FAUCET_L1_PK;
    expect(() => loadConfig()).toThrow(ConfigError);
  });

  test("throws ConfigError when FAUCET_L1_CHAIN_ID is missing", () => {
    Object.assign(process.env, { ...MINIMAL_ENV });
    delete process.env.FAUCET_L1_CHAIN_ID;
    expect(() => loadConfig()).toThrow(ConfigError);
  });

  test("does NOT throw when FAUCET_L1_FEE_JUICE_PORTAL is missing (now optional)", () => {
    Object.assign(process.env, { ...MINIMAL_ENV });
    delete process.env.FAUCET_L1_FEE_JUICE_PORTAL;
    const cfg = loadConfig();
    expect(cfg.l1FeeJuicePortal).toBeUndefined();
  });

  test("parses comma-separated allowed origins + /regex/ entries", () => {
    Object.assign(process.env, {
      ...MINIMAL_ENV,
      FAUCET_ALLOWED_ORIGINS: "https://quetzaldex.xyz,/^https:\\/\\/.*\\.vercel\\.app$/",
    });
    const cfg = loadConfig();
    expect(cfg.allowedOrigins).toHaveLength(2);
    expect(cfg.allowedOrigins[0]).toBe("https://quetzaldex.xyz");
    expect(cfg.allowedOrigins[1]).toBeInstanceOf(RegExp);
  });

  test("rejects single-slash CORS wildcard (degenerate regex)", () => {
    Object.assign(process.env, { ...MINIMAL_ENV, FAUCET_ALLOWED_ORIGINS: "/" });
    const cfg = loadConfig();
    // "/" stays a plain string, not promoted to an empty regex that matches all
    expect(cfg.allowedOrigins).toEqual(["/"]);
  });

  test("rejects two-slash degenerate (//)", () => {
    Object.assign(process.env, { ...MINIMAL_ENV, FAUCET_ALLOWED_ORIGINS: "//" });
    const cfg = loadConfig();
    expect(cfg.allowedOrigins).toEqual(["//"]);
  });

  test("accepts minimal three-char regex /a/ (L15: source anchored)", () => {
    Object.assign(process.env, { ...MINIMAL_ENV, FAUCET_ALLOWED_ORIGINS: "/a/" });
    const cfg = loadConfig();
    expect(cfg.allowedOrigins[0]).toBeInstanceOf(RegExp);
    // L15 fix anchors regex tokens with ^(?: ... )$ at parse time.
    expect((cfg.allowedOrigins[0] as RegExp).source).toBe("^(?:a)$");
  });

  // Captcha secret is an optional server-side toggle, not a required secret.
  test("does NOT throw when FAUCET_RECAPTCHA_SECRET_KEY is missing (optional)", () => {
    Object.assign(process.env, { ...MINIMAL_ENV });
    delete process.env.FAUCET_RECAPTCHA_SECRET_KEY;
    const cfg = loadConfig();
    expect(cfg.recaptchaSecretKey).toBe("");
  });

  test("recaptcha site key + min score load with defaults", () => {
    Object.assign(process.env, { ...MINIMAL_ENV });
    delete process.env.FAUCET_RECAPTCHA_SITE_KEY;
    delete process.env.FAUCET_RECAPTCHA_MIN_SCORE;
    const cfg = loadConfig();
    expect(cfg.recaptchaSiteKey).toBe("");
    expect(cfg.recaptchaMinScore).toBe(0.5);
  });

  test("recaptcha min score parses a supplied value", () => {
    Object.assign(process.env, { ...MINIMAL_ENV, FAUCET_RECAPTCHA_MIN_SCORE: "0.7", FAUCET_RECAPTCHA_SITE_KEY: "site-abc" });
    const cfg = loadConfig();
    expect(cfg.recaptchaMinScore).toBe(0.7);
    expect(cfg.recaptchaSiteKey).toBe("site-abc");
  });

  test("throws ConfigError on malformed FAUCET_RECAPTCHA_MIN_SCORE", () => {
    Object.assign(process.env, { ...MINIMAL_ENV, FAUCET_RECAPTCHA_MIN_SCORE: "high" });
    expect(() => loadConfig()).toThrow(ConfigError);
  });

  test("requireCaptcha defaults to true (secure-by-default) when env unset", () => {
    Object.assign(process.env, { ...MINIMAL_ENV });
    delete process.env.FAUCET_REQUIRE_CAPTCHA;
    const cfg = loadConfig();
    expect(cfg.requireCaptcha).toBe(true);
  });

  test('FAUCET_REQUIRE_CAPTCHA="false" parses to requireCaptcha:false', () => {
    Object.assign(process.env, { ...MINIMAL_ENV, FAUCET_REQUIRE_CAPTCHA: "false" });
    const cfg = loadConfig();
    expect(cfg.requireCaptcha).toBe(false);
  });

  test('any non-"false" value keeps requireCaptcha:true', () => {
    Object.assign(process.env, { ...MINIMAL_ENV, FAUCET_REQUIRE_CAPTCHA: "true" });
    expect(loadConfig().requireCaptcha).toBe(true);
    Object.assign(process.env, { ...MINIMAL_ENV, FAUCET_REQUIRE_CAPTCHA: "1" });
    expect(loadConfig().requireCaptcha).toBe(true);
  });

  // ---- L15: anchored regex negative tests ----

  test("L15: /quetzaldex\\.xyz/ does NOT match attacker subdomain after anchoring", () => {
    Object.assign(process.env, {
      ...MINIMAL_ENV,
      FAUCET_ALLOWED_ORIGINS: "/quetzaldex\\.xyz/",
    });
    const cfg = loadConfig();
    const rx = cfg.allowedOrigins[0] as RegExp;
    // Without anchoring, .test() is a substring match and would return true for attacker URL.
    expect(rx.test("https://quetzaldex.xyz.attacker.com")).toBe(false);
    // Also confirm it does not match via trailing path trick.
    expect(rx.test("https://evil.com/?x=quetzaldex.xyz")).toBe(false);
    // The exact string "quetzaldex.xyz" matches the anchored pattern.
    expect(rx.test("quetzaldex.xyz")).toBe(true);
  });

  test("L15: already-anchored regex /^https:\\/\\/quetzaldex\\.xyz$/ still matches correctly", () => {
    Object.assign(process.env, {
      ...MINIMAL_ENV,
      FAUCET_ALLOWED_ORIGINS: "/^https:\\/\\/quetzaldex\\.xyz$/",
    });
    const cfg = loadConfig();
    const rx = cfg.allowedOrigins[0] as RegExp;
    expect(rx.test("https://quetzaldex.xyz")).toBe(true);
    expect(rx.test("https://quetzaldex.xyz.attacker.com")).toBe(false);
  });

  // ---- L16: asPositiveInt and recaptchaMinScore range tests ----

  test("L16: throws ConfigError when FAUCET_PER_IP_WINDOW_SECONDS is zero", () => {
    Object.assign(process.env, { ...MINIMAL_ENV, FAUCET_PER_IP_WINDOW_SECONDS: "0" });
    expect(() => loadConfig()).toThrow(ConfigError);
  });

  test("L16: throws ConfigError when FAUCET_PER_IP_WINDOW_SECONDS is negative", () => {
    Object.assign(process.env, { ...MINIMAL_ENV, FAUCET_PER_IP_WINDOW_SECONDS: "-1" });
    expect(() => loadConfig()).toThrow(ConfigError);
  });

  test("L16: throws ConfigError when FAUCET_PER_IP_WINDOW_SECONDS is a float", () => {
    Object.assign(process.env, { ...MINIMAL_ENV, FAUCET_PER_IP_WINDOW_SECONDS: "3600.5" });
    expect(() => loadConfig()).toThrow(ConfigError);
  });

  test("L16: throws ConfigError when FAUCET_PER_IP_MAX_DRIPS_PER_WINDOW is zero", () => {
    Object.assign(process.env, { ...MINIMAL_ENV, FAUCET_PER_IP_MAX_DRIPS_PER_WINDOW: "0" });
    expect(() => loadConfig()).toThrow(ConfigError);
  });

  test("L16: throws ConfigError when FAUCET_GLOBAL_DAILY_CAP is negative", () => {
    Object.assign(process.env, { ...MINIMAL_ENV, FAUCET_GLOBAL_DAILY_CAP: "-10" });
    expect(() => loadConfig()).toThrow(ConfigError);
  });

  test("L16: throws ConfigError when FAUCET_RECAPTCHA_MIN_SCORE is below 0", () => {
    Object.assign(process.env, { ...MINIMAL_ENV, FAUCET_RECAPTCHA_MIN_SCORE: "-0.1" });
    expect(() => loadConfig()).toThrow(ConfigError);
  });

  test("L16: throws ConfigError when FAUCET_RECAPTCHA_MIN_SCORE is above 1", () => {
    Object.assign(process.env, { ...MINIMAL_ENV, FAUCET_RECAPTCHA_MIN_SCORE: "1.1" });
    expect(() => loadConfig()).toThrow(ConfigError);
  });

  test("L16: boundary values 0.0 and 1.0 for recaptchaMinScore are accepted", () => {
    Object.assign(process.env, { ...MINIMAL_ENV, FAUCET_RECAPTCHA_MIN_SCORE: "0" });
    expect(loadConfig().recaptchaMinScore).toBe(0);
    Object.assign(process.env, { ...MINIMAL_ENV, FAUCET_RECAPTCHA_MIN_SCORE: "1" });
    expect(loadConfig().recaptchaMinScore).toBe(1);
  });
});
