import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { loadConfig } from "@/lib/config";

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
beforeEach(() => { for (const k of Object.keys(MINIMAL_ENV)) delete process.env[k]; });
afterEach(() => { process.env = { ...savedEnv }; });

describe("captchaExemptOrigins config", () => {
  test("defaults to empty array when env unset", () => {
    Object.assign(process.env, { ...MINIMAL_ENV });
    delete process.env.FAUCET_CAPTCHA_EXEMPT_ORIGINS;
    expect(loadConfig().captchaExemptOrigins).toEqual([]);
  });

  test("parses comma-separated origins + chrome-extension entries", () => {
    Object.assign(process.env, {
      ...MINIMAL_ENV,
      FAUCET_CAPTCHA_EXEMPT_ORIGINS: "chrome-extension://abcdefghijklmnopabcdefghijklmnop,/^chrome-extension:\\/\\/.*$/",
    });
    const cfg = loadConfig();
    expect(cfg.captchaExemptOrigins).toHaveLength(2);
    expect(cfg.captchaExemptOrigins[0]).toBe("chrome-extension://abcdefghijklmnopabcdefghijklmnop");
    expect(cfg.captchaExemptOrigins[1]).toBeInstanceOf(RegExp);
  });
});

import { runDripPipeline, type DripDeps } from "@/lib/drip-pipeline";
import { RateLimiter } from "@/lib/rate-limit";
import { vi } from "vitest";

function mkDeps(overrides: Partial<DripDeps> = {}): DripDeps {
  return {
    verifyCaptcha: vi.fn().mockResolvedValue(true),
    rateLimiter: new RateLimiter({ sqlitePath: ":memory:", perIpMaxDripsPerWindow: 4, perIpWindowSeconds: 28_800, dailyCap: 500 }),
    clock: { now: () => 1_700_000_000 },
    bridgeFeeJuice: vi.fn().mockResolvedValue({
      l1TxHash: "0x" + "aa".repeat(32), messageHashHex: "0x" + "bb".repeat(32),
      messageLeafIndex: 42n, claimSecretHex: "0x" + "cc".repeat(32), claimSecretHashHex: "0x" + "dd".repeat(32),
    }),
    mintTokens: vi.fn().mockResolvedValue({ txHash: "0x" + "ee".repeat(32) }),
    config: { feeJuiceAmount: 100_000_000_000_000_000_000n, tUSDCAmount: 1_000_000_000n, tETHAmount: 500_000_000_000_000_000n, drainThresholdMultiplier: 10 },
    checkDrained: vi.fn().mockResolvedValue(false),
    withOnChainLock: <T,>(fn: () => Promise<T>) => fn(),
    auditLog: { append: vi.fn() },
    ...overrides,
  };
}

describe("exempt origin still rate-limited", () => {
  test("captcha skipped (no token) but second same-IP drip -> 429", async () => {
    const verifyCaptcha = vi.fn().mockResolvedValue(true);
    const deps = mkDeps({ verifyCaptcha, rateLimiter: new RateLimiter({ sqlitePath: ":memory:", perIpMaxDripsPerWindow: 1, perIpWindowSeconds: 28_800, dailyCap: 500 }) });
    const r1 = await runDripPipeline({ address: "0x" + "11".repeat(32), captchaToken: "", ip: "7.7.7.7", deps });
    expect(r1.status).toBe(200);
    const r2 = await runDripPipeline({ address: "0x" + "22".repeat(32), captchaToken: "", ip: "7.7.7.7", deps });
    expect(r2.status).toBe(429);
    expect(verifyCaptcha).toHaveBeenCalledTimes(2);
  });
});
