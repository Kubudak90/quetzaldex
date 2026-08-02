#!/usr/bin/env node
//
// Sub-9.7: Nethermind-faucet variant of the Sub-9.1 public-flow smoke.
//
// WHY THIS EXISTS
// ───────────────
// Our faucet at https://faucet.quetzaldex.xyz returns 500 because the Aztec
// Labs node's L1 RPC tier is HTTP 429 throttled inside the faucet's
// deposit-to-aztec flow. The error is upstream (verified: our viem 2.50.4,
// the trace shows viem 2.38.2 = Aztec Labs node infrastructure).
//
// Nethermind's PUBLIC Aztec faucet at https://aztec-faucet.dev-nethermind.xyz
// uses a different L1 RPC provider and is alive. We route around the problem:
//
//   1. Drip fee-juice from Nethermind → claim+deploy account on testnet.
//   2. Admin (testnet-m1-state.json) DIRECT-MINTS tUSDC + tETH to the new
//      user's public balance via Token.mint_to_public.
//   3. Continue the normal smoke (public→private hop → placeOrder → reveal
//      → poll → fill check).
//
// Nethermind's faucet only knows about fee-juice; it has no concept of our
// protocol's tUSDC / tETH. The admin-mint step (2.5) bridges that gap.
//
// State-persisted to sub9-e2e-smoke-nethermind-state.json for resumability.
//
// Steps (1-9 mirror sub9-e2e-smoke.ts; 2.5 is new):
//   1.   Generate fresh master + child[0].
//   2.   Drip fee-juice via Nethermind faucet.
//   3.   Claim + deploy account.
//   4.   Verify wallet registration.
//   2.5. Admin direct-mints tUSDC + tETH to user (public).
//   5a.  public→private hop (tUSDC).
//   5.   placeOrder via QuetzalClient.
//   6.   Broadcast reveal.
//   7.   Poll aggregator /health.
//   8.   Poll order fill.
//   9.   Pool 0 post-snapshot.
//
// SAFETY: refuses to run unless AZTEC_NODE_URL contains 'testnet'.
//
// Usage:
//   set -a && source .env.testnet && set +a
//   pnpm tsx scripts/sub9-e2e-smoke-nethermind.ts
//
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { Fr, Fq } from "@aztec/aztec.js/fields";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { createAztecNodeClient, waitForNode } from "@aztec/aztec.js/node";
import { EmbeddedWallet } from "@aztec/wallets/embedded";
import { GasFees } from "@aztec/stdlib/gas";
import { FeeJuicePaymentMethodWithClaim } from "@aztec/aztec.js/fee";
import { NO_FROM } from "@aztec/aztec.js/account";
import { QuetzalClient, deriveChildSecret } from "../sdk/src/index.js";
import { TokenContract } from "../tests/integration/generated/Token.js";

// ─── Config ───────────────────────────────────────────────────────────────

const NODE_URL = process.env.AZTEC_NODE_URL ?? "https://rpc.testnet.aztec-labs.com";
if (!NODE_URL.includes("testnet")) {
  throw new Error(
    `AZTEC_NODE_URL must contain 'testnet' (safety check). Got: ${NODE_URL}`,
  );
}
// Nethermind public Aztec faucet — fee-juice only.
const NETHERMIND_FAUCET_URL =
  process.env.NETHERMIND_FAUCET_URL ?? "https://aztec-faucet.dev-nethermind.xyz";
const AGG_URL     = process.env.AGG_URL ?? "https://aggregator.quetzaldex.xyz";
const CONFIG      = "quetzal.config.json";
const M1_STATE    = "testnet-m1-state.json";
const STATE       = "sub9-e2e-smoke-nethermind-state.json";
const PXE_DIR     = process.env.SMOKE_PXE_DIR ?? "./sub9-e2e-smoke-nethermind-pxe";
// Admin PXE: re-use the post-Sub-9 redeploy PXE (testnet-m4-pxe) which has
// all the new tUSDC/tETH/orderbook/pool contract classes + instances already
// registered. Same pattern as scripts/seed-lp.ts.
const ADMIN_PXE_DIR = process.env.ADMIN_PXE_DIR ?? "./testnet-m4-pxe";

// Order parameters (same as the standard smoke).
//   side="buy" canonical = pay tUSDC, receive tETH
//   amount    = 1 tUSDC (1e6 atomic)
//   limit     = 1e15 (conservative high price-id bound)
const ORDER_SIDE: "buy" | "sell" = "buy";
const ORDER_PATH               = ["tUSDC", "tETH"];
const ORDER_AMOUNT             = 1_000_000n;          // 1 tUSDC
const ORDER_LIMIT_PRICE        = 1_000_000_000_000_000n; // 1e15

// Admin mint amounts. We need enough public tUSDC on the user to:
//   (a) cover the public→private hop (1 tUSDC), and
//   (b) leave a comfortable cushion for any future probing.
// tUSDC decimals = 6 → 5_000_000_000 atomic = 5K tUSDC.
// tETH  decimals = 18 → 2_000_000_000_000_000_000 atomic = 2 tETH.
const ADMIN_MINT_TUSDC = 5_000_000_000n;             // 5K tUSDC
const ADMIN_MINT_TETH  = 2_000_000_000_000_000_000n; // 2 tETH

const POLL_HEALTH_INTERVAL_MS  = 15_000;
const POLL_HEALTH_TIMEOUT_MS   = 8 * 60_000;          // 8 min
const POLL_ORDERS_INTERVAL_MS  = 30_000;
const POLL_ORDERS_TIMEOUT_MS   = 10 * 60_000;         // 10 min

// ─── State + helpers ──────────────────────────────────────────────────────

interface SmokeState {
  step: number;
  masterSecret?: string;
  childSecret?: string;
  childAddress?: string;
  childSalt?: string;          // Fr.ZERO always — keep explicit for re-derive
  childSigningKey?: string;
  faucet?: {
    request: { address: string; ts: string };
    response: { httpStatus: number; body: unknown };
  };
  claimData?: {
    claimAmount: string;
    claimSecretHex: string;
    claimSecretHashHex: string;
    messageHashHex: string;
    messageLeafIndex: string;
    l1TxHash: string;
  };
  accountDeployTx?: string;
  // Sub-9.7: admin direct-mints, NOT faucet-driven mints.
  adminMintTUSDC?: { txHash: string; amount: string; ts: string };
  adminMintTETH?:  { txHash: string; amount: string; ts: string };
  poolBeforeOrder?: { reserve_a: string; reserve_b: string; current_sqrt_price: string };
  poolAfterOrder?:  { reserve_a: string; reserve_b: string; current_sqrt_price: string };
  submittedOrder?: {
    txHash: string;
    nonce: string;
    orderNonce: string;
    epoch: number;
    blockNumber: number;
    submittedAtBlock?: number;
    path_len?: number;
    path?: [string, string, string];
  };
  revealPayload?: Record<string, unknown>;
  revealResult?:  { httpStatus: number; ok: boolean };
  aggregatorHealthSamples?: Array<Record<string, unknown>>;
  orderObservations?: Array<{ at: string; orders: unknown[] }>;
  notes: string[];
  blockers: string[];
}

function loadState(): SmokeState {
  if (existsSync(STATE)) return JSON.parse(readFileSync(STATE, "utf8")) as SmokeState;
  return { step: 0, notes: [], blockers: [], aggregatorHealthSamples: [], orderObservations: [] };
}
function saveState(s: SmokeState): void {
  writeFileSync(STATE, JSON.stringify(s, null, 2));
}
function noteAdd(s: SmokeState, msg: string): void {
  s.notes.push(`${new Date().toISOString()} ${msg}`);
}
function blocker(s: SmokeState, msg: string): void {
  s.blockers.push(`${new Date().toISOString()} ${msg}`);
  saveState(s);
}

// Best-effort bigint→0x-padded-32 hex for the reveal payload.
function nonceToHex(n: bigint): string {
  let hex = n.toString(16);
  if (hex.length < 64) hex = hex.padStart(64, "0");
  return "0x" + hex;
}

interface QuetzalConfigJSON {
  nodeUrl: string;
  admin: string;
  tUSDC: string;
  tETH: string;
  tBTC?: string;
  orderbook: string;
  treasury: string;
  aggregatorRegistry: string;
  pools: Array<{ pool_id: number; address: string; token_a: string; token_b: string }>;
  l1?: unknown;
}

interface M1StateJSON {
  step: number;
  secret: string;
  salt: string;
  signingKey: string;
  address: string;
}

// Best-effort txHash extraction from aztec.js .send() result. aztec.js 4.2.1
// exposes the receipt under `.receipt.txHash` after the default-wait .send();
// the seed-lp.ts pattern also handles a top-level `.txHash` shape.
function extractTxHash(sent: unknown): string {
  const s = sent as {
    receipt?: { txHash?: { toString?: () => string } | string };
    txHash?: { toString?: () => string } | string;
  };
  const r = s.receipt?.txHash ?? s.txHash;
  if (!r) return "";
  if (typeof r === "string") return r;
  if (typeof r === "object" && typeof r.toString === "function") return r.toString();
  return String(r);
}

// ─── Main ────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  if (!existsSync(CONFIG)) throw new Error(`${CONFIG} not found`);
  if (!existsSync(M1_STATE)) throw new Error(`${M1_STATE} not found — admin wallet needed for direct-mint step`);
  const config = JSON.parse(readFileSync(CONFIG, "utf8")) as QuetzalConfigJSON;
  const m1 = JSON.parse(readFileSync(M1_STATE, "utf8")) as M1StateJSON;
  if (m1.step < 5) {
    throw new Error(`testnet-m1-state.json indicates admin not deployed (step=${m1.step})`);
  }
  if (m1.address.toLowerCase() !== config.admin.toLowerCase()) {
    throw new Error(`m1 admin address mismatch vs config: ${m1.address} vs ${config.admin}`);
  }
  const state = loadState();

  console.log(`[smoke-nm] starting; resuming from step ${state.step}`);
  console.log(`[smoke-nm] node=${NODE_URL}`);
  console.log(`[smoke-nm] faucet=${NETHERMIND_FAUCET_URL} (Nethermind, fee-juice only)`);
  console.log(`[smoke-nm] aggregator=${AGG_URL}`);
  console.log(`[smoke-nm] admin=${config.admin}`);

  const _rawNode = createAztecNodeClient(NODE_URL);
  console.log(`[smoke-nm] waiting for node ...`);
  await waitForNode(_rawNode);
  // STATIC fee override (see redeploy-testnet.ts): bypass aztec-labs' 429'd
  // getCurrentMinFees by wrapping the node to return a fixed min-fee.
  const _sL2 = process.env.STATIC_MAX_FEE_PER_L2_GAS;
  const _sDa = process.env.STATIC_MAX_FEE_PER_DA_GAS ?? "0";
  const node: any = _sL2
    ? new Proxy(_rawNode as any, {
        get(t, p, r) {
          if (p === "getCurrentMinFees") {
            return async () => new GasFees(BigInt(_sDa), BigInt(_sL2));
          }
          const v = Reflect.get(t, p, r);
          return typeof v === "function" ? v.bind(t) : v;
        },
      })
    : _rawNode;
  if (_sL2) console.log(`[smoke-nm] STATIC maxFeesPerGas override active: daGas=${_sDa} l2Gas=${_sL2}`);
  const nodeInfo = await node.getNodeInfo();
  console.log(`[smoke-nm] node OK; rollupVersion=${nodeInfo.rollupVersion}`);

  // ── Step 1: generate master + child[0] ─────────────────────────────────
  if (state.step < 1) {
    console.log(`[smoke-nm] step 1: generating fresh master secret + child[0] ...`);
    const masterFr = Fr.random();
    state.masterSecret = masterFr.toString();
    const child0 = deriveChildSecret(state.masterSecret, 0);
    state.childSecret = child0;
    state.childSalt = Fr.ZERO.toString();
    state.childSigningKey = Fq.random().toString();
    state.step = 1;
    saveState(state);
    console.log(`[smoke-nm]   master = ${state.masterSecret}`);
    console.log(`[smoke-nm]   child  = ${state.childSecret}`);
  } else {
    console.log(`[smoke-nm] step 1 cached; child secret=${state.childSecret}`);
  }

  // Build user PXE / wallet (persistent so contract registrations carry).
  const wallet = await EmbeddedWallet.create(node, {
    ephemeral: false,
    pxe: { proverEnabled: true, dataDirectory: PXE_DIR },
  });
  const secret     = Fr.fromString(state.childSecret!);
  const salt       = Fr.fromString(state.childSalt!);
  const signingKey = Fq.fromString(state.childSigningKey!);
  const accountManager = await wallet.createSchnorrAccount(secret, salt, signingKey);
  const address = (await accountManager.getAccount()).getAddress();
  if (!state.childAddress) {
    state.childAddress = address.toString();
    saveState(state);
  }
  console.log(`[smoke-nm]   child address: ${address.toString()}`);

  // ── Step 2: drip fee-juice from Nethermind ─────────────────────────────
  if (state.step < 2) {
    console.log(`[smoke-nm] step 2: POST ${NETHERMIND_FAUCET_URL}/api/drip (Nethermind, fee-juice) ...`);
    const body = { address: address.toString(), asset: "fee-juice" };
    // Use node:https directly so we can set long socket timeouts. Nethermind's
    // drip flow is similar to ours: bridge fee-juice from L1 → ~2-4 min wait.
    const httpsMod = await import("node:https");
    const urlMod = await import("node:url");
    const u = new urlMod.URL(`${NETHERMIND_FAUCET_URL}/api/drip`);
    const payload = JSON.stringify(body);
    const { status: respStatus, text } = await new Promise<{ status: number; text: string }>((resolve, reject) => {
      const req = httpsMod.request(
        {
          method: "POST",
          hostname: u.hostname,
          port: u.port || 443,
          path: u.pathname,
          protocol: u.protocol,
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(payload).toString(),
          },
          timeout: 15 * 60_000,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (d) => chunks.push(d));
          res.on("end", () => {
            resolve({
              status: res.statusCode ?? 0,
              text: Buffer.concat(chunks).toString("utf8"),
            });
          });
          res.on("error", reject);
        },
      );
      req.on("error", reject);
      req.on("timeout", () => {
        req.destroy(new Error("socket timeout after 15 min"));
      });
      req.write(payload);
      req.end();
    });
    const res = { status: respStatus, ok: respStatus >= 200 && respStatus < 300 };
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }
    state.faucet = {
      request: { address: address.toString(), ts: new Date().toISOString() },
      response: { httpStatus: res.status, body: parsed },
    };
    if (!res.ok) {
      blocker(state, `Nethermind faucet drip failed: HTTP ${res.status} ${text.slice(0, 400)}`);
      throw new Error(`Nethermind faucet HTTP ${res.status}: ${text}`);
    }
    const pb = parsed as { success?: boolean; claimData?: SmokeState["claimData"] };
    if (!pb.success || !pb.claimData) {
      blocker(state, `Nethermind faucet drip success=false: ${text.slice(0, 400)}`);
      throw new Error(`Nethermind faucet drip not success: ${text}`);
    }
    state.claimData = pb.claimData;
    state.step = 2;
    saveState(state);
    console.log(`[smoke-nm]   Nethermind drip OK; claimAmount=${pb.claimData.claimAmount} leafIndex=${pb.claimData.messageLeafIndex}`);
    console.log(`[smoke-nm]   claimSecretHex prefix: ${pb.claimData.claimSecretHex.slice(0, 18)}...`);
  } else {
    console.log(`[smoke-nm] step 2 cached; Nethermind faucet drip already done`);
  }

  // ── Step 3: claim + deploy account ────────────────────────────────────
  if (state.step < 3) {
    console.log(`[smoke-nm] step 3: deploying account with fee-juice claim ...`);
    const claim = {
      claimAmount: new Fr(BigInt(state.claimData!.claimAmount)),
      claimSecret: Fr.fromString(state.claimData!.claimSecretHex),
      messageLeafIndex: BigInt(state.claimData!.messageLeafIndex),
    };
    const paymentMethod = new FeeJuicePaymentMethodWithClaim(address, claim);
    const start = Date.now();
    const timeoutMs = 30 * 60_000;
    let deployed = false;
    let lastErr: unknown;
    while (Date.now() - start < timeoutMs) {
      try {
        console.log(`[smoke-nm]   deploy attempt (elapsed ${Math.floor((Date.now() - start)/1000)}s) ...`);
        const deployMethod = await accountManager.getDeployMethod();
        const deployResult = await deployMethod.send({ fee: { paymentMethod }, from: NO_FROM });
        const txHashStr = deployResult.txHash?.toString?.() ?? String(deployResult.txHash);
        state.accountDeployTx = txHashStr;
        deployed = true;
        console.log(`[smoke-nm]   deploy OK; tx=${txHashStr}`);
        break;
      } catch (e) {
        lastErr = e;
        const msg = e instanceof Error ? e.message : String(e);
        // Aztec Labs node's L1 RPC (Quicknode tier) is HTTP 429 throttled.
        // The PXE-side L1 reads during the deploy (getTimestampForSlot, message
        // tree lookups) can hit the limit. These ARE transient — wait + retry.
        // Sub-9.7 finding: this is the SAME root cause that blocks our faucet,
        // and routing the faucet around it via Nethermind doesn't help the
        // user's subsequent deploy because the user's PXE still talks to the
        // Aztec Labs node which holds the throttled L1 RPC connection.
        const cause = (e as { cause?: { message?: string }; message?: string }).cause;
        const causeMsg = cause?.message ?? "";
        const isRetryable = /L1.*L2|message|tree|membership|claim|429|Too Many Requests/i.test(msg)
          || /429|Too Many Requests/i.test(causeMsg);
        console.log(`[smoke-nm]   deploy attempt failed (retryable=${isRetryable}): ${msg.slice(0, 200)}`);
        if (!isRetryable) {
          blocker(state, `deploy non-retryable: ${msg.slice(0, 300)}`);
          throw e;
        }
        // For 429s, back off a bit longer (Quicknode windows tend to be ~60s+).
        const backoff = /429|Too Many Requests/i.test(msg + " " + causeMsg) ? 90_000 : 30_000;
        console.log(`[smoke-nm]   retryable; sleeping ${backoff/1000}s ...`);
        await sleep(backoff);
      }
    }
    if (!deployed) {
      blocker(state, `account deploy timed out after 30 min; last: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`);
      throw new Error(`deploy never succeeded after 30 min`);
    }
    state.step = 3;
    saveState(state);
  } else {
    console.log(`[smoke-nm] step 3 cached; deploy tx=${state.accountDeployTx}`);
  }

  // ── Step 4: verify wallet registration ────────────────────────────────
  if (state.step < 4) {
    console.log(`[smoke-nm] step 4: verifying wallet registration ...`);
    const accounts = await wallet.getAccounts();
    console.log(`[smoke-nm]   PXE has ${accounts.length} account(s)`);
    for (const a of accounts) {
      console.log(`[smoke-nm]   - ${a.item.toString()}`);
    }
    if (accounts.length === 0) {
      blocker(state, "wallet.getAccounts() returned empty after deploy");
    }
    state.step = 4;
    saveState(state);
  } else {
    console.log(`[smoke-nm] step 4 cached`);
  }

  // ── Step 2.5 (NEW): admin direct-mints tUSDC + tETH to user (public) ──
  //
  // Nethermind faucet doesn't know about our protocol's tokens. Bridge the
  // gap by having the admin (testnet-m1) call Token.mint_to_public(user, …).
  // Admin is the minter for both tUSDC and tETH (verified in seed-lp.ts).
  //
  // Step 4.5 — between step 4 and step 5. MUST be a fractional float (4.5), NOT
  // 45: encoding it as 45 made it > the later step thresholds (5,6,7,8) so the
  // order/reveal/poll steps were silently skipped ("cached"). Use real 4.5.
  if (state.step < 4.5) {
    console.log(`[smoke-nm] step 2.5: admin direct-mints tUSDC + tETH to user (public balance) ...`);

    // Open a SEPARATE PXE for the admin so their state is isolated from the user's.
    // We re-use testnet-m4-pxe which already has both tUSDC + tETH contract
    // classes/instances registered (per the seed-lp pattern).
    const adminWallet = await EmbeddedWallet.create(node, {
      ephemeral: false,
      pxe: { proverEnabled: true, dataDirectory: ADMIN_PXE_DIR },
    });
    try {
      const adminSecret     = Fr.fromString(m1.secret);
      const adminSalt       = Fr.fromString(m1.salt);
      const adminSigningKey = Fq.fromString(m1.signingKey);
      const adminManager = await adminWallet.createSchnorrAccount(adminSecret, adminSalt, adminSigningKey);
      const adminAddr = (await adminManager.getAccount()).getAddress();
      if (adminAddr.toString().toLowerCase() !== config.admin.toLowerCase()) {
        throw new Error(`admin re-derive mismatch: got ${adminAddr.toString()} expected ${config.admin}`);
      }
      console.log(`[smoke-nm]   admin recreated: ${adminAddr.toString()}`);

      const userAddr = AztecAddress.fromStringUnsafe(state.childAddress!);

      // ── tUSDC mint (5K atomic = 5_000_000_000) ──
      if (!state.adminMintTUSDC) {
        console.log(`[smoke-nm]   mint_to_public(tUSDC, ${ADMIN_MINT_TUSDC} atomic = 5K tUSDC) → user ...`);
        const tUSDCAddr = AztecAddress.fromStringUnsafe(config.tUSDC);
        const tUSDC = await TokenContract.at(tUSDCAddr, adminWallet);
        const t0 = Date.now();
        const sent = await tUSDC.methods.mint_to_public(userAddr, ADMIN_MINT_TUSDC).send({ from: adminAddr });
        const txHashStr = extractTxHash(sent);
        const dt = ((Date.now() - t0) / 1000).toFixed(1);
        console.log(`[smoke-nm]   tUSDC mint OK (${dt}s); txHash=${txHashStr}`);
        state.adminMintTUSDC = {
          txHash: txHashStr,
          amount: ADMIN_MINT_TUSDC.toString(),
          ts: new Date().toISOString(),
        };
        noteAdd(state, `admin minted ${ADMIN_MINT_TUSDC} tUSDC atomic to ${userAddr.toString()}`);
        saveState(state);
      } else {
        console.log(`[smoke-nm]   tUSDC mint cached: ${state.adminMintTUSDC.txHash}`);
      }

      // ── tETH mint (2 atomic = 2e18) ──
      if (!state.adminMintTETH) {
        console.log(`[smoke-nm]   mint_to_public(tETH, ${ADMIN_MINT_TETH} atomic = 2 tETH) → user ...`);
        const tETHAddr = AztecAddress.fromStringUnsafe(config.tETH);
        const tETH = await TokenContract.at(tETHAddr, adminWallet);
        const t0 = Date.now();
        const sent = await tETH.methods.mint_to_public(userAddr, ADMIN_MINT_TETH).send({ from: adminAddr });
        const txHashStr = extractTxHash(sent);
        const dt = ((Date.now() - t0) / 1000).toFixed(1);
        console.log(`[smoke-nm]   tETH mint OK (${dt}s); txHash=${txHashStr}`);
        state.adminMintTETH = {
          txHash: txHashStr,
          amount: ADMIN_MINT_TETH.toString(),
          ts: new Date().toISOString(),
        };
        noteAdd(state, `admin minted ${ADMIN_MINT_TETH} tETH atomic to ${userAddr.toString()}`);
        saveState(state);
      } else {
        console.log(`[smoke-nm]   tETH mint cached: ${state.adminMintTETH.txHash}`);
      }

      console.log(`[smoke-nm]   admin-mint: tUSDC 5K, tETH 2 to user`);
    } finally {
      await adminWallet.stop();
    }

    state.step = 4.5;
    saveState(state);
  } else {
    console.log(`[smoke-nm] step 2.5 cached; admin mints done`);
  }

  // ── Step 5: submit order via QuetzalClient ────────────────────────────
  console.log(`[smoke-nm] connecting QuetzalClient (external-pxe, sharing user wallet) ...`);
  const client = await QuetzalClient.connect({
    network: "alpha-testnet",
    nodeUrl: NODE_URL,
    account: { type: "external-pxe", wallet, address },
    l1: config.l1 as never,
    contracts: {
      orderbook: config.orderbook,
      tUSDC: config.tUSDC,
      tETH: config.tETH,
      tBTC: config.tBTC,
      pools: config.pools,
      treasury: config.treasury,
      aggregatorRegistry: config.aggregatorRegistry,
    },
  });
  console.log(`[smoke-nm]   client connected; address=${client.address.toString()}`);

  // Snapshot pool 0 state before
  if (state.step < 5) {
    try {
      const { loadLiquidityPoolContract } = await import("../sdk/src/internal/contracts.js");
      const LiquidityPoolContract = await loadLiquidityPoolContract();
      const pool0 = await LiquidityPoolContract.at(
        AztecAddress.fromStringUnsafe(config.pools[0]!.address),
        wallet,
      );
      const sim = await pool0.methods.get_pool_state().simulate({ from: client.address });
      const r = (sim as { result: Record<string, bigint | number> }).result;
      state.poolBeforeOrder = {
        reserve_a: BigInt(r.reserve_a as bigint).toString(),
        reserve_b: BigInt(r.reserve_b as bigint).toString(),
        current_sqrt_price: BigInt(r.current_sqrt_price as bigint).toString(),
      };
      console.log(`[smoke-nm]   pool 0 before: reserve_a=${state.poolBeforeOrder.reserve_a} reserve_b=${state.poolBeforeOrder.reserve_b} sqrt_p=${state.poolBeforeOrder.current_sqrt_price}`);
    } catch (e) {
      noteAdd(state, `pool 0 pre-snapshot failed: ${(e as Error).message?.slice(0, 200)}`);
    }
    saveState(state);

    // Step 5a — public→private hop on tUSDC. After canonicalization on Sub-9's
    // testnet addrs, side="buy" tUSDC->tETH flips to side="sell" tETH->tUSDC
    // → input token (escrow) is tUSDC (path[path_len-1] when realSide=true).
    // The admin-mint above gave us 5K tUSDC PUBLIC; move ORDER_AMOUNT into
    // PRIVATE so submit_order's transfer_private_to_public escrow leg sees
    // the balance.
    try {
      console.log(`[smoke-nm] step 5a: transfer_public_to_private(tUSDC, amount=${ORDER_AMOUNT}) ...`);
      const { loadTokenContract } = await import("../sdk/src/internal/contracts.js");
      const TokenContractDyn = await loadTokenContract();
      const tUSDCContract = await TokenContractDyn.at(AztecAddress.fromStringUnsafe(config.tUSDC), wallet);
      // Token's transfer_public_to_private asserts _nonce == 0 when from == msg_sender.
      const nonce = Fr.ZERO;
      const tx = await (tUSDCContract.methods as unknown as {
        transfer_public_to_private: (from: AztecAddress, to: AztecAddress, amount: bigint, nonce: Fr) => {
          send: (opts: { from: AztecAddress }) => unknown;
        };
      }).transfer_public_to_private(client.address, client.address, ORDER_AMOUNT, nonce).send({ from: client.address });
      void tx;
      console.log(`[smoke-nm]   tUSDC public->private moved ${ORDER_AMOUNT} atomic`);
      noteAdd(state, `transfer_public_to_private(tUSDC, ${ORDER_AMOUNT}) submitted`);
      saveState(state);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      blocker(state, `transfer_public_to_private failed: ${msg.slice(0, 400)}`);
      throw e;
    }

    console.log(`[smoke-nm] step 5: placeOrder side=${ORDER_SIDE} path=${ORDER_PATH.join("->")} amount=${ORDER_AMOUNT} limit=${ORDER_LIMIT_PRICE} ...`);
    try {
      const result = await client.orders.placeOrder({
        side: ORDER_SIDE,
        path: ORDER_PATH,
        amount: ORDER_AMOUNT,
        limitPrice: ORDER_LIMIT_PRICE,
      });
      // Use the EXACT submitted_at_block the orderbook bound into c_i — the SDK
      // reads it back from the on-chain OrderNote (the tx ANCHOR block, NOT the
      // mined/current block). The old "current block" read mismatched c_i, so the
      // aggregator's order_acc replay rejected the reveal and nothing settled.
      // Also carry path_len + path so the aggregator recomputes c_i over the same
      // canonical path the contract folded (omitting it → default [0,0,0] → mismatch).
      state.submittedOrder = {
        txHash: result.txHash,
        nonce: nonceToHex(result.nonce),
        orderNonce: nonceToHex(result.orderNonce),
        epoch: result.epoch,
        blockNumber: result.blockNumber,
        submittedAtBlock: result.submittedAtBlock,
        path_len: result.path_len,
        path: result.path,
      };
      console.log(`[smoke-nm]   order submitted: tx=${result.txHash} epoch=${result.epoch} block=${result.blockNumber}`);
      console.log(`[smoke-nm]   orderNonce=${state.submittedOrder.orderNonce}`);
      if (!result.txHash || result.epoch === 0 || result.blockNumber === 0) {
        noteAdd(state, `WARN placeOrder result has zero values (txHash="${result.txHash}" epoch=${result.epoch} block=${result.blockNumber}) — Sub-9.6 SDK fix may not be in effect`);
      }
      state.step = 5;
      saveState(state);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      blocker(state, `placeOrder failed: ${msg.slice(0, 400)}`);
      console.error(`[smoke-nm]   placeOrder ERROR: ${msg}`);
      throw e;
    }
  } else {
    console.log(`[smoke-nm] step 5 cached; order tx=${state.submittedOrder?.txHash}`);
  }

  // ── Step 6: broadcast reveal ───────────────────────────────────────────
  if (state.step < 6) {
    console.log(`[smoke-nm] step 6: broadcasting reveal to aggregator ...`);
    // SDK canonicalizes via u128 truncation; mirror it here.
    const U128_MASK = (1n << 128n) - 1n;
    const tUSDC_u = BigInt(config.tUSDC) & U128_MASK;
    const tETH_u  = BigInt(config.tETH)  & U128_MASK;
    const noFlip  = tUSDC_u < tETH_u;
    const sideAfterCanon: "buy" | "sell" = noFlip
      ? ORDER_SIDE
      : (ORDER_SIDE === "buy" ? "sell" : "buy");
    const realSide = sideAfterCanon === "sell"; // false=bid, true=ask

    const payload = {
      epoch_id: state.submittedOrder!.epoch,
      order_nonce: state.submittedOrder!.orderNonce,
      side: realSide,
      amount_in: ORDER_AMOUNT.toString(),
      limit_price: ORDER_LIMIT_PRICE.toString(),
      submitted_at_block: state.submittedOrder!.submittedAtBlock ?? state.submittedOrder!.blockNumber,
      owner: address.toString(),
      submission_tx_hash: state.submittedOrder!.txHash,
      // Audit #11: forward the canonical path the contract bound into c_i.
      path_len: state.submittedOrder!.path_len,
      path: state.submittedOrder!.path,
    };
    state.revealPayload = payload;
    saveState(state);
    console.log(`[smoke-nm]   payload: ${JSON.stringify(payload)}`);
    const res = await fetch(`${AGG_URL}/reveal`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const text = await res.text();
    state.revealResult = { httpStatus: res.status, ok: res.ok };
    saveState(state);
    if (!res.ok) {
      blocker(state, `reveal POST failed: HTTP ${res.status} ${text.slice(0, 400)}`);
      throw new Error(`reveal HTTP ${res.status}: ${text}`);
    }
    console.log(`[smoke-nm]   reveal OK; body=${text}`);
    state.step = 6;
    saveState(state);
  } else {
    console.log(`[smoke-nm] step 6 cached`);
  }

  // ── Step 7: poll aggregator /health ───────────────────────────────────
  if (state.step < 7) {
    console.log(`[smoke-nm] step 7: polling aggregator /health ...`);
    const start = Date.now();
    let firstLastEpochSeen: number | undefined;
    while (Date.now() - start < POLL_HEALTH_TIMEOUT_MS) {
      try {
        const res = await fetch(`${AGG_URL}/health`);
        const j = (await res.json()) as Record<string, unknown>;
        const sample = { at: new Date().toISOString(), ...j };
        state.aggregatorHealthSamples!.push(sample);
        saveState(state);
        console.log(`[smoke-nm]   health: ${JSON.stringify(j)}`);
        const lastEpoch = (j as { lastEpochSeen?: number }).lastEpochSeen;
        if (firstLastEpochSeen === undefined) firstLastEpochSeen = lastEpoch;
        if (typeof lastEpoch === "number" && firstLastEpochSeen !== undefined && lastEpoch > firstLastEpochSeen) {
          console.log(`[smoke-nm]   lastEpochSeen advanced ${firstLastEpochSeen} -> ${lastEpoch}; breaking poll loop`);
          break;
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        noteAdd(state, `health poll error: ${msg.slice(0, 200)}`);
        saveState(state);
      }
      await sleep(POLL_HEALTH_INTERVAL_MS);
    }
    state.step = 7;
    saveState(state);
  } else {
    console.log(`[smoke-nm] step 7 cached`);
  }

  // ── Step 8: poll for order fill ───────────────────────────────────────
  if (state.step < 8) {
    console.log(`[smoke-nm] step 8: polling reads.getOrders() ...`);
    const start = Date.now();
    while (Date.now() - start < POLL_ORDERS_TIMEOUT_MS) {
      try {
        const orders = await client.reads.getOrders();
        const seri = orders.map((o) => ({
          nonce: o.nonce.toString(),
          side: o.side,
          amount_in: o.amount_in.toString(),
          limit_price: o.limit_price.toString(),
          submitted_at_block: o.submitted_at_block.toString(),
        }));
        state.orderObservations!.push({ at: new Date().toISOString(), orders: seri });
        saveState(state);
        console.log(`[smoke-nm]   orders (${orders.length}): ${JSON.stringify(seri)}`);
        if (orders.length === 0) {
          console.log(`[smoke-nm]   order no longer resting → likely filled/cleared`);
          break;
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        noteAdd(state, `getOrders error: ${msg.slice(0, 200)}`);
        saveState(state);
      }
      await sleep(POLL_ORDERS_INTERVAL_MS);
    }
    state.step = 8;
    saveState(state);
  } else {
    console.log(`[smoke-nm] step 8 cached`);
  }

  // ── Step 9: pool 0 post-snapshot ──────────────────────────────────────
  if (state.step < 9) {
    try {
      const { loadLiquidityPoolContract } = await import("../sdk/src/internal/contracts.js");
      const LiquidityPoolContract = await loadLiquidityPoolContract();
      const pool0 = await LiquidityPoolContract.at(
        AztecAddress.fromStringUnsafe(config.pools[0]!.address),
        wallet,
      );
      const sim = await pool0.methods.get_pool_state().simulate({ from: client.address });
      const r = (sim as { result: Record<string, bigint | number> }).result;
      state.poolAfterOrder = {
        reserve_a: BigInt(r.reserve_a as bigint).toString(),
        reserve_b: BigInt(r.reserve_b as bigint).toString(),
        current_sqrt_price: BigInt(r.current_sqrt_price as bigint).toString(),
      };
      console.log(`[smoke-nm]   pool 0 after: ${JSON.stringify(state.poolAfterOrder)}`);
      if (state.poolBeforeOrder) {
        const dA = BigInt(state.poolAfterOrder.reserve_a) - BigInt(state.poolBeforeOrder.reserve_a);
        const dB = BigInt(state.poolAfterOrder.reserve_b) - BigInt(state.poolBeforeOrder.reserve_b);
        console.log(`[smoke-nm]   pool 0 delta: dA=${dA} dB=${dB}`);
        if (dA === 0n && dB === 0n) {
          noteAdd(state, "pool 0 reserves unchanged — clearing likely didn't run yet");
        }
      }
    } catch (e) {
      noteAdd(state, `pool 0 post-snapshot failed: ${(e as Error).message?.slice(0, 200)}`);
    }
    state.step = 9;
    saveState(state);
  }

  console.log("");
  console.log(`[smoke-nm] SMOKE COMPLETE; final step=${state.step}; blockers=${state.blockers.length}`);
  if (state.blockers.length) {
    console.log(`[smoke-nm] BLOCKERS:`);
    for (const b of state.blockers) console.log(`  - ${b}`);
  } else {
    console.log(`[smoke-nm] no blockers recorded`);
  }

  await wallet.stop();
  await client.stop();
}

main().catch((e) => {
  console.error(`[smoke-nm] FAILED:`, e);
  console.error(`[smoke-nm] state persisted to ${STATE}; re-run to resume`);
  process.exit(1);
});
