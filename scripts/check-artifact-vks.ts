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
 * Two checks, giving different levels of certainty:
 *   1. Compatibility — when `.aztec-version` is a version we know the expected VK
 *      size for, validate every key against it. This is the strong one: it names
 *      the offending functions outright, whether they are a subset or all of them.
 *   2. Consistency — the fallback when we have no expected size. Mixed sizes prove
 *      that only part of the set was rebuilt, but NOT which part is stale: the
 *      stale artifacts can perfectly well be the majority, so counting them and
 *      calling the minority wrong would be a coin flip dressed up as a verdict.
 *      It therefore reports the split and stops short of assigning blame.
 *
 * Keeping (2) means the check still catches a partial rebuild on an Aztec version
 * this script has never heard of, so it cannot silently rot on the next bump.
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
const version = existsSync(".aztec-version") ? readFileSync(".aztec-version", "utf8").trim() : "";
const expected = EXPECTED_VK_BYTES[version];

// Compatibility check — only possible when we know what the pinned toolchain emits,
// and strictly better than the consistency check when we do: it names the offending
// functions outright, whether they are a subset or all of them.
if (expected !== undefined) {
  const bad = keys.filter((k) => k.bytes !== expected);
  if (bad.length > 0) {
    console.error(`[check-artifact-vks] FAIL: incompatible verification key size for aztec ${version}.`);
    console.error(`  Expected ${expected} bytes; ${bad.length} of ${keys.length} keys differ.`);
    console.error("  Rebuild the affected artifacts with the pinned toolchain and commit them");
    console.error("  (`git add -f contracts/*/target/*.json`), or update EXPECTED_VK_BYTES if the");
    console.error("  toolchain legitimately changed the size.\n");
    for (const k of bad) {
      console.error(`    ${k.contract}::${k.fn} — ${k.bytes} bytes`);
    }
    process.exit(1);
  }
  console.log(`[check-artifact-vks] OK: ${keys.length} private-function keys, all ${expected} bytes (aztec ${version}).`);
  process.exit(0);
}

// Consistency check — the fallback for a toolchain version we have no expected size
// for. It can prove the set is inconsistent, but NOT which group is correct: the
// stale artifacts may well be the majority. So report the split and stop short of a
// verdict rather than guessing.
if (sizes.length > 1) {
  console.error(`[check-artifact-vks] FAIL: mixed verification key sizes: ${sizes.join(", ")} bytes.`);
  console.error("  Artifacts appear to come from different toolchain builds — only some were rebuilt.");
  console.error("  Which group is stale cannot be determined here (no expected size recorded for");
  console.error(`  aztec ${version || "<unknown>"}); rebuild ALL artifacts with the pinned toolchain.\n`);
  for (const s of sizes) {
    console.error(`    ${s} bytes:`);
    for (const k of keys.filter((k) => k.bytes === s)) console.error(`      ${k.contract}::${k.fn}`);
  }
  process.exit(1);
}

console.log(
  `[check-artifact-vks] OK (consistency only): ${keys.length} keys, all ${sizes[0]} bytes. ` +
    `No expected size recorded for aztec ${version || "<unknown>"} — add one to EXPECTED_VK_BYTES.`,
);
