import { describe, test, expect, beforeEach } from "vitest";
import { readFileSync, mkdtempSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AuditLog } from "@/lib/audit-log";

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "faucet-audit-"));
  path = join(dir, "faucet.log");
});

describe("AuditLog", () => {
  test("writes one JSONL line per record with sha256-hashed IP", () => {
    const log = new AuditLog(path);
    log.append({
      ts: 1_700_000_000,
      ip: "1.2.3.4",
      address: "0x" + "11".repeat(32),
      success: true,
      claimAmount: "100000000000000000000",
      mintTxs: { tUSDC: "0xabc", tETH: "0xdef" },
    });
    log.append({
      ts: 1_700_000_010,
      ip: "1.2.3.4",
      address: "0x" + "22".repeat(32),
      success: false,
      error: "captcha",
    });
    const lines = readFileSync(path, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    const r0 = JSON.parse(lines[0]!) as {
      ipHash: string;
      ip: unknown;
      success: boolean;
    };
    expect(r0.ipHash).toMatch(/^[0-9a-f]{64}$/);
    expect(r0.ip).toBeUndefined();
    expect(r0.success).toBe(true);
    const r1 = JSON.parse(lines[1]!) as { ipHash: string; error: string };
    expect(r1.ipHash).toBe(r0.ipHash);
    expect(r1.error).toBe("captcha");
  });

  test("creates parent directory if missing", () => {
    const nested = join(dir, "nested", "deep", "faucet.log");
    const log = new AuditLog(nested);
    log.append({ ts: 1, ip: "x", address: "x", success: true });
    expect(existsSync(nested)).toBe(true);
  });
});
