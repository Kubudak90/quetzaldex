/**
 * Sub-8.1.next prep — aggregator L2 wallet bootstrap.
 *
 * NOT INVOKED BY THE MVP. The MVP runs the watcher with an ephemeral read-only
 * Schnorr wallet (no fee-juice required). This script is staged for when the
 * clearing-tx submission path is wired (Sub-8.1.next): the aggregator needs
 * a funded L2 wallet to send `Orderbook.close_epoch_and_clear_verified` txs.
 *
 * Flow:
 *   1. Generate fresh 32-byte secret (or accept --secret arg for re-runs)
 *   2. Hit faucet.quetzaldex.xyz/api/drip with FAUCET_HCAPTCHA_BYPASS_KEY
 *   3. Persist state to aggregator-wallet-state.json (idempotent re-runs)
 *   4. Print the derived address + claim data
 *
 * After this runs, the operator must MANUALLY:
 *   - Run `pnpm tsx scripts/wallet-pool-bootstrap.ts claim` (or equivalent)
 *     against the derived secret to actually claim fee-juice + deploy the
 *     account on L2. (Same flow Sub-7b uses.)
 *
 * Usage:
 *   FAUCET_URL=https://faucet.quetzaldex.xyz \
 *   FAUCET_BYPASS_KEY=$(ssh root@194.163.136.1 'grep BYPASS_KEY /root/quetzal-faucet/faucet/.env.faucet | cut -d= -f2') \
 *   pnpm tsx aggregator/ops/bootstrap-wallet.ts
 *
 * Re-run with --use-existing to skip the drip step (e.g. after a partial
 * failure).
 */
import { writeFileSync, existsSync, readFileSync } from "node:fs";
import { randomBytes, createHash } from "node:crypto";

const STATE_PATH = "aggregator-wallet-state.json";

interface WalletState {
  secret: string;        // 0x… 32-byte hex
  // address is derived inside the embedded PXE; we don't compute it here to
  // avoid pulling in aztec.js at script-run time. The operator gets the
  // address from the subsequent `claim` step.
  drippedAt?: string;
  dripResponse?: Record<string, unknown>;
}

function loadOrCreateState(): WalletState {
  if (existsSync(STATE_PATH)) {
    const raw = JSON.parse(readFileSync(STATE_PATH, "utf8")) as WalletState;
    console.log(`reusing existing wallet state at ${STATE_PATH}`);
    return raw;
  }
  const secretBytes = randomBytes(32);
  const secret = "0x" + secretBytes.toString("hex");
  // Print the first 8 hex chars of sha256(secret) so the operator can
  // identify which wallet this is in logs without ever logging the secret.
  const tag = createHash("sha256").update(secret).digest("hex").slice(0, 8);
  console.log(`generated fresh wallet (tag ${tag})`);
  const state: WalletState = { secret };
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
  console.log(`persisted state to ${STATE_PATH} — chmod 600 it`);
  return state;
}

async function dripFromFaucet(secret: string): Promise<Record<string, unknown>> {
  const faucetUrl = process.env.FAUCET_URL ?? "https://faucet.quetzaldex.xyz";
  const bypassKey = process.env.FAUCET_BYPASS_KEY;
  if (!bypassKey) {
    throw new Error("FAUCET_BYPASS_KEY not set — copy from VPS .env.faucet");
  }
  // Derive a "wallet address" stand-in: faucet drips against a 32-byte
  // identifier; here we use the secret's hash (same shape the wallet pool
  // bootstrap uses). The actual on-chain address comes out of `claim`.
  const ident = "0x" + createHash("sha256").update(secret).digest("hex");
  console.log(`dripping for identifier ${ident.slice(0, 18)}...`);
  const res = await fetch(`${faucetUrl}/api/drip`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ address: ident, captchaToken: bypassKey }),
  });
  const body = (await res.json()) as Record<string, unknown>;
  if (!res.ok) {
    throw new Error(`faucet drip failed (${res.status}): ${JSON.stringify(body)}`);
  }
  console.log("drip accepted; response:", JSON.stringify(body, null, 2));
  return body;
}

async function main(): Promise<void> {
  const useExisting = process.argv.includes("--use-existing");
  const state = loadOrCreateState();

  if (useExisting && state.drippedAt) {
    console.log(`drip already ran at ${state.drippedAt}; skipping`);
    return;
  }

  try {
    const resp = await dripFromFaucet(state.secret);
    state.dripResponse = resp;
    state.drippedAt = new Date().toISOString();
    writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
    console.log("");
    console.log("=================================================================");
    console.log("Drip request submitted. Faucet response saved to", STATE_PATH);
    console.log("");
    console.log("Next steps (manual):");
    console.log("  1. Wait ~2-4 min for the faucet's L2 proof gen + claim cycle");
    console.log("  2. Use `pnpm tsx scripts/wallet-pool-bootstrap.ts deploy`");
    console.log("     (or equivalent) against this secret to deploy the account");
    console.log("  3. Update /root/quetzal-aggregator/aggregator/.env.aggregator");
    console.log("     AGGREGATOR_L2_SECRET to the value in", STATE_PATH);
    console.log("  4. Optionally register with AggregatorRegistry");
    console.log("=================================================================");
  } catch (e) {
    console.error("drip failed:", e instanceof Error ? e.message : String(e));
    console.error("");
    console.error("State preserved at", STATE_PATH);
    console.error("Re-run with --use-existing after fixing FAUCET_BYPASS_KEY");
    process.exit(1);
  }
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
