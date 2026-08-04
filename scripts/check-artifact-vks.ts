#!/usr/bin/env tsx
/**
 * Guard against a stale committed contract artifact.
 *
 * This exists because of a real 13-day outage. `contracts/*​/target/*.json` are
 * tracked (force-added past the `target/` ignore rule), so a local `nargo compile`
 * modifies them and it is easy to leave that modification uncommitted. When that
 * happened during the 4.3.1 -> 5.0.0 migration, two of five artifacts kept their
 * pre-5.0 private-function verification keys (4576 bytes where the v5 toolchain
 * emits 5216). The developer working tree was fine; every build from a clean
 * checkout died at PXE contract registration with:
 *
 *     verification key has wrong size: expected 5216, got 4576
 *
 * — which names neither the contract nor the function, so the days went into
 * auditing Noir rather than build outputs.
 *
 * Recompiling in CI would need the whole Aztec toolchain (see the note in
 * .github/workflows/ci.yml). This is the cheap 99%: read what is committed and
 * check the verification keys are the right size, with no toolchain at all.
 *
 * Two layers, because they fail differently:
 *   1. Self-consistency — every private function across every artifact must carry
 *      the same VK size. This catches the *actual* failure mode (a subset of
 *      artifacts rebuilt, the rest stale) even for an Aztec version this script
 *      has never heard of, so it cannot rot on the next bump.
 *   2. Absolute size — when `.aztec-version` is a version we know the expected
 *      size for, enforce it. This additionally catches "everything is uniformly
 *      stale", which layer 1 cannot see.
 *
 * Usage: tsx scripts/check-artifact-vks.ts
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

/** Private-function verification key size, in bytes, per Aztec toolchain version. */
const EXPECTED_VK_BYTES: Record<string, number> = {
  "5.0.0": 5216,
};

const CONTRACTS_DIR = "contracts";

interface Key {
  contract: string;
  fn: string;
  bytes: number;
}

function collectKeys(): Key[] {
  const keys: Key[] = [];
  for (const contract of readdirSync(CONTRACTS_DIR)) {
    const targetDir = join(CONTRACTS_DIR, contract, "target");
    if (!existsSync(targetDir)) continue;
    for (const file of readdirSync(targetDir)) {
      if (!file.endsWith(".json")) continue;
      const artifact = JSON.parse(readFileSync(join(targetDir, file), "utf8")) as {
        functions?: { name?: string; verification_key?: string }[];
      };
      for (const fn of artifact.functions ?? []) {
        // Only private functions carry a verification_key; public/unconstrained
        // ones omit the field entirely.
        if (!fn.verification_key) continue;
        keys.push({
          contract,
          fn: fn.name ?? "<unnamed>",
          bytes: Buffer.from(fn.verification_key, "base64").length,
        });
      }
    }
  }
  return keys;
}

const keys = collectKeys();

if (keys.length === 0) {
  console.error("[check-artifact-vks] FAIL: no verification keys found under contracts/*/target/.");
  console.error("  Contract artifacts are missing from the checkout. They are tracked but sit");
  console.error("  under an ignored path — make sure they were committed with `git add -f`.");
  process.exit(1);
}

const sizes = [...new Set(keys.map((k) => k.bytes))].sort((a, b) => a - b);

// Layer 1: every artifact must agree with every other one.
if (sizes.length > 1) {
  const majority = sizes
    .map((s) => ({ size: s, count: keys.filter((k) => k.bytes === s).length }))
    .sort((a, b) => b.count - a.count)[0].size;
  console.error(`[check-artifact-vks] FAIL: mixed verification key sizes: ${sizes.join(", ")} bytes.`);
  console.error("  Some artifacts were rebuilt and others were not — the odd ones out are stale.");
  console.error("  Recompile everything and commit the result (`git add -f contracts/*/target/*.json`).\n");
  for (const k of keys.filter((k) => k.bytes !== majority)) {
    console.error(`    ${k.contract}::${k.fn} — ${k.bytes} bytes (most artifacts are ${majority})`);
  }
  process.exit(1);
}

// Layer 2: if we know what this toolchain should emit, enforce the absolute size.
const version = existsSync(".aztec-version") ? readFileSync(".aztec-version", "utf8").trim() : "";
const expected = EXPECTED_VK_BYTES[version];
const actual = sizes[0];

if (expected === undefined) {
  console.log(
    `[check-artifact-vks] OK (consistency only): ${keys.length} keys, all ${actual} bytes. ` +
      `No expected size recorded for aztec ${version || "<unknown>"} — add one to EXPECTED_VK_BYTES.`,
  );
  process.exit(0);
}

if (actual !== expected) {
  console.error(
    `[check-artifact-vks] FAIL: every artifact carries ${actual}-byte keys, but aztec ${version} emits ${expected}.`,
  );
  console.error("  All artifacts are uniformly stale — recompile and commit them, or update");
  console.error("  EXPECTED_VK_BYTES if the toolchain legitimately changed the size.");
  process.exit(1);
}

console.log(`[check-artifact-vks] OK: ${keys.length} private-function keys, all ${actual} bytes (aztec ${version}).`);
