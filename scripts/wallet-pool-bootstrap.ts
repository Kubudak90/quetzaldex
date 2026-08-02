#!/usr/bin/env node
//
// WalletPool bootstrap on Aztec testnet.
//
//   subcommand: derive  → compute child addresses, persist seed + per-child state
//                        files. No faucet / network mutation; safe to run first.
//   subcommand: drip    → POST each child address to the Aztec faucet, persist
//                        claimData per child. May hit per-IP rate limit.
//   subcommand: deploy  → for each child whose drip claim is recorded, claim
//                        fee-juice + deploy schnorr account (FeeJuicePaymentMethod-
//                        WithClaim). Resume-safe via per-child state files.
//   subcommand: status  → print each child's address + step.
//
// Usage:
//   pnpm tsx scripts/wallet-pool-bootstrap.ts derive [--n 3]
//   pnpm tsx scripts/wallet-pool-bootstrap.ts drip
//   pnpm tsx scripts/wallet-pool-bootstrap.ts deploy
//   pnpm tsx scripts/wallet-pool-bootstrap.ts status
//
// State files:
//   .env.testnet  ← QUETZAL_POOL_MASTER_SECRET, QUETZAL_POOL_N (idempotent)
//   testnet-pool-state-{i}.json   (one per child, format compatible with
//                                  scripts/lib/aztec-wallet-bootstrap.ts)
//
import { writeFileSync, readFileSync, existsSync, appendFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { Fr, Fq } from "@aztec/aztec.js/fields";
import {
  bootstrapAztecWallet,
  type WalletBootstrapState,
} from "./lib/aztec-wallet-bootstrap.js";

const RPC_URL = process.env.AZTEC_NODE_URL ?? "https://rpc.testnet.aztec-labs.com";
const FAUCET_URL = "https://aztec-faucet.dev-nethermind.xyz/api/drip";
const ENV_PATH = ".env.testnet";

// ── Helpers ────────────────────────────────────────────────────────────────

function readEnv(): Record<string, string> {
  if (!existsSync(ENV_PATH)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(ENV_PATH, "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

function upsertEnv(key: string, value: string): void {
  const env = readEnv();
  if (env[key] === value) return;
  if (env[key] !== undefined) {
    const lines = readFileSync(ENV_PATH, "utf8").split("\n");
    const updated = lines
      .map((l) => (l.startsWith(`${key}=`) ? `${key}=${value}` : l))
      .join("\n");
    writeFileSync(ENV_PATH, updated);
  } else {
    appendFileSync(ENV_PATH, `\n${key}=${value}\n`);
  }
}

const P_BN254 = BigInt(
  "0x30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001",
);

/**
 * Mirror of sdk/src/wallet/pool.ts:deriveChildSecret — kept in lockstep so
 * pool clients built from QUETZAL_POOL_MASTER_SECRET land on the same
 * addresses as this bootstrap script writes.
 */
function deriveChildSecret(masterHex: string, index: number): string {
  const baseBuf = Buffer.concat([
    Buffer.from(masterHex.slice(2), "hex"),
    Buffer.from(index.toString(16).padStart(8, "0"), "hex"),
  ]);
  for (let round = 0; round < 256; round++) {
    const buf = round === 0
      ? baseBuf
      : Buffer.concat([baseBuf, Buffer.from([round])]);
    const digest = createHash("sha256").update(buf).digest("hex");
    const masked = BigInt("0x" + digest) & ((1n << 254n) - 1n);
    if (masked < P_BN254) {
      return "0x" + masked.toString(16).padStart(64, "0");
    }
  }
  throw new Error("deriveChildSecret: exhausted 256 rounds");
}

function stateFile(i: number): string {
  return `testnet-pool-state-${i}.json`;
}

function loadChildState(i: number): WalletBootstrapState {
  if (!existsSync(stateFile(i))) return { step: 0, faucetResponses: [] };
  return JSON.parse(readFileSync(stateFile(i), "utf8")) as WalletBootstrapState;
}

function saveChildState(i: number, state: WalletBootstrapState): void {
  writeFileSync(stateFile(i), JSON.stringify(state, null, 2));
}

// ── Subcommand: derive ────────────────────────────────────────────────────

async function cmdDerive(n: number): Promise<void> {
  const env = readEnv();
  let master = env.QUETZAL_POOL_MASTER_SECRET;
  if (!master) {
    master = "0x" + randomBytes(32).toString("hex");
    upsertEnv("QUETZAL_POOL_MASTER_SECRET", master);
    console.log(`[derive] generated fresh master → .env.testnet`);
  } else {
    console.log(`[derive] reusing QUETZAL_POOL_MASTER_SECRET from .env.testnet`);
  }
  upsertEnv("QUETZAL_POOL_N", String(n));

  // Pre-seed each child state with deterministic schnorr keypair so
  // bootstrapAztecWallet skips its random Fr.random() / Fq.random() path.
  for (let i = 0; i < n; i++) {
    let state = loadChildState(i);
    if (state.step >= 1 && state.secret) {
      console.log(`[derive] child ${i}: state already seeded (step ${state.step}); skip`);
      continue;
    }
    const childHex = deriveChildSecret(master, i);
    // Use a deterministic signing key too: sha256(child || 0x01)
    const signingDigest = createHash("sha256")
      .update(Buffer.concat([
        Buffer.from(childHex.slice(2), "hex"),
        Buffer.from([0x01]),
      ]))
      .digest("hex");
    // Mask to Fq field (fits in 254 bits same as bn254 Fr — safe upper bound)
    const signingMasked = (BigInt("0x" + signingDigest) & ((1n << 254n) - 1n))
      .toString(16)
      .padStart(64, "0");
    // Validate Fr.fromString accepts the secret (catches the rare ≥p case)
    try {
      Fr.fromString(childHex);
      Fq.fromString("0x" + signingMasked);
    } catch (e) {
      throw new Error(
        `[derive] child ${i}: derived key landed >= field modulus; ` +
          `regenerate master and retry (sha256 collision with p is rare). ${e}`,
      );
    }
    state = {
      step: 1,
      secret: childHex,
      salt: Fr.ZERO.toString(),
      signingKey: "0x" + signingMasked,
      faucetResponses: [],
    };
    saveChildState(i, state);
    console.log(`[derive] child ${i}: pre-seeded state → ${stateFile(i)}`);
  }

  console.log(`\n[derive] computing child addresses ...`);
  // bootstrapAztecWallet's address computation happens AFTER step 1 but BEFORE
  // step 2 (faucet). To get the address without dripping, call it with no
  // faucetUrl while state.step is exactly 1 → it'll throw at step 2 but we'll
  // catch it after the address is persisted (line 145-148 of bootstrap helper).
  for (let i = 0; i < n; i++) {
    const state = loadChildState(i);
    if (state.address) {
      console.log(`  child ${i}: ${state.address}  (cached)`);
      continue;
    }
    try {
      // Will throw at step 2 (no faucetUrl) but address is saved at line 147.
      await bootstrapAztecWallet(RPC_URL, stateFile(i));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!/faucetUrl required/.test(msg)) throw e;
    }
    const after = loadChildState(i);
    console.log(`  child ${i}: ${after.address ?? "<missing>"}`);
  }

  console.log(`\n[derive] done.`);
  console.log(`Next: pnpm tsx scripts/wallet-pool-bootstrap.ts drip`);
}

// ── Subcommand: drip ──────────────────────────────────────────────────────

async function cmdDrip(): Promise<void> {
  const env = readEnv();
  const n = Number(env.QUETZAL_POOL_N ?? "3");
  for (let i = 0; i < n; i++) {
    const state = loadChildState(i);
    if (state.step >= 2) {
      console.log(`[drip] child ${i}: already dripped (step ${state.step}); skip`);
      continue;
    }
    if (!state.address) {
      console.error(
        `[drip] child ${i}: no address in state; run 'derive' first`,
      );
      process.exit(1);
    }
    console.log(`[drip] child ${i}: requesting fee-juice for ${state.address} ...`);
    const res = await fetch(FAUCET_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ address: state.address, asset: "fee-juice" }),
    });
    const text = await res.text();
    let body: unknown;
    try { body = JSON.parse(text); } catch { body = { raw: text }; }
    const obj = body as { success?: boolean; claimData?: WalletBootstrapState["claimData"]; error?: string };
    state.faucetResponses = state.faucetResponses ?? [];
    state.faucetResponses.push({ asset: "fee-juice", ts: new Date().toISOString(), httpStatus: res.status, body });
    if (res.status !== 200 || !obj.success || !obj.claimData) {
      console.error(`[drip] child ${i}: faucet failed http=${res.status} ${JSON.stringify(body).slice(0, 400)}`);
      saveChildState(i, state);
      // Rate limit? Keep going to next child or bail?
      if (/rate.*limit|cooldown|too many/i.test(JSON.stringify(body))) {
        console.error(`[drip] rate-limited; stop here. Wait or rotate IP.`);
        process.exit(2);
      }
      continue;
    }
    state.claimData = obj.claimData;
    state.step = 2;
    saveChildState(i, state);
    console.log(`[drip] child ${i}: OK leafIndex=${obj.claimData.messageLeafIndex} amount=${obj.claimData.claimAmount}`);
  }
  console.log(`\n[drip] done. Wait ~12-15 min for L1→L2, then:`);
  console.log(`  pnpm tsx scripts/wallet-pool-bootstrap.ts deploy`);
}

// ── Subcommand: deploy ────────────────────────────────────────────────────

async function cmdDeploy(): Promise<void> {
  const env = readEnv();
  const n = Number(env.QUETZAL_POOL_N ?? "3");
  for (let i = 0; i < n; i++) {
    const state = loadChildState(i);
    if (state.step >= 5) {
      console.log(`[deploy] child ${i}: already deployed; skip`);
      continue;
    }
    if (state.step < 2 || !state.claimData) {
      console.error(`[deploy] child ${i}: no claim data; run 'drip' first`);
      process.exit(1);
    }
    console.log(`[deploy] child ${i}: bootstrapping (claim + deploy + verify) ...`);
    const { wallet } = await bootstrapAztecWallet(RPC_URL, stateFile(i), FAUCET_URL);
    await wallet.stop();
    console.log(`[deploy] child ${i}: OK`);
  }
  console.log(`\n[deploy] all children operational.`);
}

// ── Subcommand: status ────────────────────────────────────────────────────

async function cmdStatus(): Promise<void> {
  const env = readEnv();
  const n = Number(env.QUETZAL_POOL_N ?? "3");
  console.log(`Pool size: ${n}; master in .env.testnet: ${env.QUETZAL_POOL_MASTER_SECRET ? "yes" : "no"}`);
  for (let i = 0; i < n; i++) {
    const state = loadChildState(i);
    console.log(
      `  child ${i}: step=${state.step} addr=${state.address ?? "—"} ` +
        `claim=${state.claimData?.messageLeafIndex ?? "—"} deploy=${state.accountDeployTx ?? "—"}`,
    );
  }
}

// ── Entry ─────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const [sub, ...rest] = process.argv.slice(2);
  switch (sub) {
    case "derive": {
      const nFlag = rest.indexOf("--n");
      const n = nFlag >= 0 ? Number(rest[nFlag + 1]) : 3;
      await cmdDerive(n);
      break;
    }
    case "drip":   await cmdDrip();   break;
    case "deploy": await cmdDeploy(); break;
    case "status": await cmdStatus(); break;
    default:
      console.error(`Usage: wallet-pool-bootstrap.ts <derive|drip|deploy|status>`);
      process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
