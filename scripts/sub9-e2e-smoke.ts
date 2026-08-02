#!/usr/bin/env node
//
// Sub-9.1 Phase B: programmatic end-to-end public-flow smoke test.
//
// Simulates what a fresh public user would do via the wizard at
// https://aztec-project.vercel.app — but driven from a script so we can
// observe each step's blockers in detail.
//
// State-persisted to sub9-e2e-state.json for resumability.
//
// Steps:
//   1. Generate fresh master secret + derive child[0] via WalletPool pattern.
//   2. Drip via faucet (POST /api/drip with bypass key) — captures claimData
//      + tUSDCMint + tETHMint receipts.
//   3. Claim + deploy account on testnet using FeeJuicePaymentMethodWithClaim.
//   4. Verify the wallet is registered (PXE accounts list + on-chain class).
//   5. Submit a small private order via QuetzalClient.orders.placeOrder.
//      Default path: tUSDC → tETH (pool 0, which has 5K tUSDC seeded liquidity).
//   6. Broadcast reveal to the prod aggregator at AGG_URL.
//   7. Poll aggregator /health for queueSize + lastEpochSeen advancement.
//   8. Poll reads.getOrders() to observe order fill / removal.
//   9. Verify pool 0 reserves shifted vs the pre-test snapshot.
//
// SAFETY: refuses to run unless AZTEC_NODE_URL contains 'testnet'.
//
// Usage:
//   AZTEC_NODE_URL=https://rpc.testnet.aztec-labs.com \
//   FAUCET_BYPASS_KEY=<bypass> pnpm tsx scripts/sub9-e2e-smoke.ts
//
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { Fr, Fq } from "@aztec/aztec.js/fields";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { createAztecNodeClient, waitForNode } from "@aztec/aztec.js/node";
import { EmbeddedWallet } from "@aztec/wallets/embedded";
import { FeeJuicePaymentMethodWithClaim } from "@aztec/aztec.js/fee";
import { NO_FROM } from "@aztec/aztec.js/account";
import { QuetzalClient, deriveChildSecret } from "../sdk/src/index.js";

// ─── Config ───────────────────────────────────────────────────────────────

const NODE_URL = process.env.AZTEC_NODE_URL ?? "https://rpc.testnet.aztec-labs.com";
if (!NODE_URL.includes("testnet")) {
  throw new Error(
    `AZTEC_NODE_URL must contain 'testnet' (safety check). Got: ${NODE_URL}`,
  );
}
const FAUCET_URL  = process.env.FAUCET_URL ?? "https://faucet.quetzaldex.xyz";
const FAUCET_BYPASS_KEY = process.env.FAUCET_BYPASS_KEY;
if (!FAUCET_BYPASS_KEY) {
  throw new Error(
    "FAUCET_BYPASS_KEY env var required (the hCaptcha bypass key — fetch from VPS faucet .env.faucet).",
  );
}
const AGG_URL     = process.env.AGG_URL ?? "https://aggregator.quetzaldex.xyz";
const CONFIG      = "quetzal.config.json";
const STATE       = "sub9-e2e-state.json";
const PXE_DIR     = process.env.SMOKE_PXE_DIR ?? "./sub9-e2e-pxe";

// Order parameters. Path is tUSDC -> tETH (pool 0). amount/limit chosen to
// fit comfortably inside pool 0's 5K tUSDC seed liquidity:
//   side="buy" canonical = pay tUSDC, receive tETH
//   amount    = 1 tUSDC (atomic units = 1e6)
//   limit     = 1e15 (price-id ratio interpretation; conservative high bound
//               so a fill happens if any match is possible)
// Env-overridable so the smoke can exercise both directions (a fresh one-sided
// pool only crosses the direction that pays the seeded token OUT of the pool).
const ORDER_SIDE: "buy" | "sell" =
  (process.env.SMOKE_ORDER_SIDE as "buy" | "sell" | undefined) ?? "buy";
const ORDER_PATH               = (process.env.SMOKE_ORDER_PATH ?? "tUSDC,tETH").split(",");
const ORDER_AMOUNT             = BigInt(process.env.SMOKE_ORDER_AMOUNT ?? "1000000");          // default 1 tUSDC
const ORDER_LIMIT_PRICE        = BigInt(process.env.SMOKE_ORDER_LIMIT ?? "1000000000000000"); // default 1e15

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
  tUSDCMint?: { txHash: string; amount: string };
  tETHMint?:  { txHash: string; amount: string };
  accountDeployTx?: string;
  poolBeforeOrder?: { reserve_a: string; reserve_b: string; current_sqrt_price: string };
  poolAfterOrder?:  { reserve_a: string; reserve_b: string; current_sqrt_price: string };
  submittedOrder?: {
    txHash: string;
    nonce: string;
    orderNonce: string;
    epoch: number;
    blockNumber: number;
    submittedAtBlock?: number;
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
function dec0xHex(buf: Buffer): string { return "0x" + buf.toString("hex"); }

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

// ─── Main ────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  if (!existsSync(CONFIG)) throw new Error(`${CONFIG} not found`);
  const config = JSON.parse(readFileSync(CONFIG, "utf8")) as QuetzalConfigJSON;
  const state = loadState();

  console.log(`[sub9-e2e] starting; resuming from step ${state.step}`);
  console.log(`[sub9-e2e] node=${NODE_URL}`);
  console.log(`[sub9-e2e] faucet=${FAUCET_URL}`);
  console.log(`[sub9-e2e] aggregator=${AGG_URL}`);

  const node = createAztecNodeClient(NODE_URL);
  console.log(`[sub9-e2e] waiting for node ...`);
  await waitForNode(node);
  const nodeInfo = await node.getNodeInfo();
  console.log(`[sub9-e2e] node OK; rollupVersion=${nodeInfo.rollupVersion}`);

  // ── Step 1: generate master + child[0] ─────────────────────────────────
  if (state.step < 1) {
    console.log(`[sub9-e2e] step 1: generating fresh master secret + child[0] ...`);
    const masterFr = Fr.random();
    state.masterSecret = masterFr.toString();
    const child0 = deriveChildSecret(state.masterSecret, 0);
    state.childSecret = child0;
    state.childSalt = Fr.ZERO.toString();
    state.childSigningKey = Fq.random().toString();
    state.step = 1;
    saveState(state);
    console.log(`[sub9-e2e]   master = ${state.masterSecret}`);
    console.log(`[sub9-e2e]   child  = ${state.childSecret}`);
  } else {
    console.log(`[sub9-e2e] step 1 cached; child secret=${state.childSecret}`);
  }

  // Build PXE / wallet once — we need it for both the deploy and the reads.
  // Persistent PXE so contract registrations carry across steps.
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
  console.log(`[sub9-e2e]   child address: ${address.toString()}`);

  // ── Step 2: drip from faucet ───────────────────────────────────────────
  if (state.step < 2) {
    console.log(`[sub9-e2e] step 2: POST ${FAUCET_URL}/api/drip ...`);
    const body = { address: address.toString(), captchaToken: FAUCET_BYPASS_KEY };
    // Faucet drip is slow (~2-4 min: ClientIVC proof gen + L1 receipt waits).
    // Use node:https directly so we can set long socket timeouts; built-in
    // fetch headers timeout is 5min in some Node versions.
    const httpsMod = await import("node:https");
    const urlMod = await import("node:url");
    const u = new urlMod.URL(`${FAUCET_URL}/api/drip`);
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
      blocker(state, `faucet drip failed: HTTP ${res.status} ${text.slice(0, 400)}`);
      throw new Error(`faucet HTTP ${res.status}: ${text}`);
    }
    const pb = parsed as { success?: boolean; claimData?: SmokeState["claimData"]; tUSDCMint?: SmokeState["tUSDCMint"]; tETHMint?: SmokeState["tETHMint"] };
    if (!pb.success || !pb.claimData) {
      blocker(state, `faucet drip success=false: ${text.slice(0, 400)}`);
      throw new Error(`faucet drip not success: ${text}`);
    }
    state.claimData = pb.claimData;
    state.tUSDCMint = pb.tUSDCMint;
    state.tETHMint = pb.tETHMint;
    state.step = 2;
    saveState(state);
    console.log(`[sub9-e2e]   drip OK; claimAmount=${pb.claimData.claimAmount} leafIndex=${pb.claimData.messageLeafIndex}`);
    console.log(`[sub9-e2e]   tUSDC mint: ${pb.tUSDCMint?.amount} (tx ${pb.tUSDCMint?.txHash})`);
    console.log(`[sub9-e2e]   tETH  mint: ${pb.tETHMint?.amount}  (tx ${pb.tETHMint?.txHash})`);
  } else {
    console.log(`[sub9-e2e] step 2 cached; faucet drip already done`);
  }

  // ── Step 3: claim + deploy account ────────────────────────────────────
  if (state.step < 3) {
    console.log(`[sub9-e2e] step 3: deploying account with fee-juice claim ...`);
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
        console.log(`[sub9-e2e]   deploy attempt (elapsed ${Math.floor((Date.now() - start)/1000)}s) ...`);
        const deployMethod = await accountManager.getDeployMethod();
        const deployResult = await deployMethod.send({ fee: { paymentMethod }, from: NO_FROM });
        const txHashStr = deployResult.txHash?.toString?.() ?? String(deployResult.txHash);
        state.accountDeployTx = txHashStr;
        deployed = true;
        console.log(`[sub9-e2e]   deploy OK; tx=${txHashStr}`);
        break;
      } catch (e) {
        lastErr = e;
        const msg = e instanceof Error ? e.message : String(e);
        console.log(`[sub9-e2e]   deploy attempt failed: ${msg.slice(0, 300)}`);
        const isRetryable = /L1.*L2|message|tree|membership|claim/i.test(msg);
        if (!isRetryable) {
          blocker(state, `deploy non-retryable: ${msg.slice(0, 300)}`);
          throw e;
        }
        console.log(`[sub9-e2e]   retryable; sleeping 30s ...`);
        await sleep(30_000);
      }
    }
    if (!deployed) {
      blocker(state, `account deploy timed out after 30 min; last: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`);
      throw new Error(`deploy never succeeded after 30 min`);
    }
    state.step = 3;
    saveState(state);
  } else {
    console.log(`[sub9-e2e] step 3 cached; deploy tx=${state.accountDeployTx}`);
  }

  // ── Step 4: verify wallet registration ────────────────────────────────
  if (state.step < 4) {
    console.log(`[sub9-e2e] step 4: verifying wallet registration ...`);
    const accounts = await wallet.getAccounts();
    console.log(`[sub9-e2e]   PXE has ${accounts.length} account(s)`);
    for (const a of accounts) {
      console.log(`[sub9-e2e]   - ${a.item.toString()}`);
    }
    if (accounts.length === 0) {
      blocker(state, "wallet.getAccounts() returned empty after deploy");
    }
    state.step = 4;
    saveState(state);
  } else {
    console.log(`[sub9-e2e] step 4 cached`);
  }

  // ── Step 5: submit order via QuetzalClient ────────────────────────────
  // QuetzalClient.connect re-creates its own wallet adapter; we'll use
  // "external-pxe" to share our existing wallet so contract classes already
  // registered + PXE state carry over.
  console.log(`[sub9-e2e] connecting QuetzalClient (external-pxe, sharing wallet) ...`);
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
  console.log(`[sub9-e2e]   client connected; address=${client.address.toString()}`);

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
      console.log(`[sub9-e2e]   pool 0 before: reserve_a=${state.poolBeforeOrder.reserve_a} reserve_b=${state.poolBeforeOrder.reserve_b} sqrt_p=${state.poolBeforeOrder.current_sqrt_price}`);
    } catch (e) {
      noteAdd(state, `pool 0 pre-snapshot failed: ${(e as Error).message?.slice(0, 200)}`);
    }
    saveState(state);

    // Sub-9.1 finding: the faucet drips tUSDC + tETH via mint_to_public, but
    // orderbook.submit_order calls Token.transfer_private_to_public on the
    // escrow leg → requires PRIVATE balance.
    //
    // Sub-9.2 (Phase C attempt + revert): tried switching faucet to
    // `mint_to_private` to avoid this hop, but found a fundamental ordering
    // problem — the mint happens BEFORE the user account is deployed, and
    // the user's PXE cannot discover tagged private-note emission for an
    // unregistered address. Reverted; the public→private hop stays in the
    // wizard for now.
    //
    // After canonicalization on Sub-9's testnet addrs, side="buy" tUSDC->tETH
    // flips to side="sell" tETH->tUSDC → input token (escrow) is tUSDC
    // (path[path_len-1] when realSide=true). So move some public tUSDC
    // into private balance before placing the order.
    if (process.env.SKIP_TRANSFER) {
      console.log(`[sub9-e2e] step 5a: SKIPPED (SKIP_TRANSFER set; reusing existing private tUSDC)`);
    } else try {
      // Escrow token = the order's INPUT: side=buy pays path[0], side=sell pays path[last].
      const escrowKey = ORDER_SIDE === "buy" ? ORDER_PATH[0]! : ORDER_PATH[ORDER_PATH.length - 1]!;
      const escrowAddr = (config as unknown as Record<string, string>)[escrowKey];
      if (!escrowAddr) throw new Error(`config missing token address for ${escrowKey}`);
      console.log(`[sub9-e2e] step 5a: transfer_public_to_private(${escrowKey}, amount=${ORDER_AMOUNT}) ...`);
      const { loadTokenContract } = await import("../sdk/src/internal/contracts.js");
      const TokenContract = await loadTokenContract();
      const tUSDCContract = await TokenContract.at(AztecAddress.fromStringUnsafe(escrowAddr), wallet);
      // Token's transfer_public_to_private asserts _nonce == 0 when from == msg_sender.
      const nonce = Fr.ZERO;
      const tx = await (tUSDCContract.methods as unknown as {
        transfer_public_to_private: (from: AztecAddress, to: AztecAddress, amount: bigint, nonce: Fr) => {
          send: (opts: { from: AztecAddress }) => unknown;
        };
      }).transfer_public_to_private(client.address, client.address, ORDER_AMOUNT, nonce).send({ from: client.address });
      void tx;
      console.log(`[sub9-e2e]   public->private moved ${ORDER_AMOUNT} atomic`);
      noteAdd(state, `transfer_public_to_private(escrow token, ${ORDER_AMOUNT}) submitted`);
      saveState(state);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      blocker(state, `transfer_public_to_private failed: ${msg.slice(0, 400)}`);
      throw e;
    }

    console.log(`[sub9-e2e] step 5: placeOrder side=${ORDER_SIDE} path=${ORDER_PATH.join("->")} amount=${ORDER_AMOUNT} limit=${ORDER_LIMIT_PRICE} ...`);
    try {
      const result = await client.orders.placeOrder({
        side: ORDER_SIDE,
        path: ORDER_PATH,
        amount: ORDER_AMOUNT,
        limitPrice: ORDER_LIMIT_PRICE,
      });
      // Read current block (best-effort) to use for submitted_at_block in reveal.
      let submittedAtBlock: number | undefined;
      try {
        const info = await node.getNodeInfo() as unknown as Record<string, unknown>;
        // Aztec node info doesn't always have blockNumber; query via the L2 tip instead.
        if (typeof info.blockNumber === "number") submittedAtBlock = info.blockNumber;
        else {
          const nodeAny = node as unknown as { getBlockNumber?: () => Promise<number> };
          if (typeof nodeAny.getBlockNumber === "function") {
            submittedAtBlock = await nodeAny.getBlockNumber();
          }
        }
      } catch { /* best-effort */ }
      state.submittedOrder = {
        txHash: result.txHash,
        nonce: nonceToHex(result.nonce),
        orderNonce: nonceToHex(result.orderNonce),
        epoch: result.epoch,
        blockNumber: result.blockNumber,
        // Use the SDK's OrderNote-read ANCHOR block (get_anchor_block_header) + canonical
        // path — NOT the mined/node block — so the reveal's c_i matches on-chain order_acc.
        // (Prior bug: used node.getBlockNumber() + dropped path → replay mismatch, never settled.)
        submittedAtBlock: (result as { submittedAtBlock?: number }).submittedAtBlock ?? submittedAtBlock,
        path_len: (result as { path_len?: 2 | 3 }).path_len,
        path: (result as { path?: [string, string, string] }).path,
      } as typeof state.submittedOrder;
      console.log(`[sub9-e2e]   order submitted: tx=${result.txHash} epoch=${result.epoch} block=${result.blockNumber}`);
      console.log(`[sub9-e2e]   orderNonce=${state.submittedOrder.orderNonce} (canonical side="${ORDER_SIDE === "buy" ? "buy" : "sell"}" → contract side bool = false on canonical tUSDC<tETH)`);
      state.step = 5;
      saveState(state);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      blocker(state, `placeOrder failed: ${msg.slice(0, 400)}`);
      console.error(`[sub9-e2e]   placeOrder ERROR: ${msg}`);
      throw e;
    }
  } else {
    console.log(`[sub9-e2e] step 5 cached; order tx=${state.submittedOrder?.txHash}`);
  }

  // ── Step 6: broadcast reveal ───────────────────────────────────────────
  if (state.step < 6) {
    console.log(`[sub9-e2e] step 6: broadcasting reveal to aggregator ...`);
    // Compute the contract side bool from the canonical side. canonicalizePath
    // in the SDK uses u128 truncation (matching the contract). For Sub-9's
    // testnet token addresses, full-bigint says tUSDC < tETH but u128 says
    // tUSDC > tETH → SDK flips. So caller's "buy" (tUSDC→tETH) becomes
    // realSide = (canonical.side === "sell") → realSide = true (ask).
    const U128_MASK = (1n << 128n) - 1n;
    const tUSDC_u = BigInt(config.tUSDC) & U128_MASK;
    const tETH_u  = BigInt(config.tETH)  & U128_MASK;
    const noFlip  = tUSDC_u < tETH_u;
    // After canonicalization:
    //   noFlip  → SDK keeps side as input.side
    //   flipped → SDK toggles input.side
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
      // Audit #11: forward the canonical path if the stored order carries it, so the
      // aggregator recomputes c_i against the bound path. (pool-0 smoke also works
      // via the aggregator's pool-0 fallback when these are absent.)
      path_len: (state.submittedOrder as { path_len?: 2 | 3 }).path_len,
      path: (state.submittedOrder as { path?: [string, string, string] }).path,
    };
    state.revealPayload = payload;
    saveState(state);
    console.log(`[sub9-e2e]   payload: ${JSON.stringify(payload)}`);
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
    console.log(`[sub9-e2e]   reveal OK; body=${text}`);
    state.step = 6;
    saveState(state);
  } else {
    console.log(`[sub9-e2e] step 6 cached`);
  }

  // ── Step 7: poll aggregator /health ───────────────────────────────────
  if (state.step < 7) {
    console.log(`[sub9-e2e] step 7: polling aggregator /health ...`);
    const start = Date.now();
    let firstLastEpochSeen: number | undefined;
    while (Date.now() - start < POLL_HEALTH_TIMEOUT_MS) {
      try {
        const res = await fetch(`${AGG_URL}/health`);
        const j = (await res.json()) as Record<string, unknown>;
        const sample = { at: new Date().toISOString(), ...j };
        state.aggregatorHealthSamples!.push(sample);
        saveState(state);
        console.log(`[sub9-e2e]   health: ${JSON.stringify(j)}`);
        const lastEpoch = (j as { lastEpochSeen?: number }).lastEpochSeen;
        if (firstLastEpochSeen === undefined) firstLastEpochSeen = lastEpoch;
        if (typeof lastEpoch === "number" && firstLastEpochSeen !== undefined && lastEpoch > firstLastEpochSeen) {
          console.log(`[sub9-e2e]   lastEpochSeen advanced ${firstLastEpochSeen} -> ${lastEpoch}; breaking poll loop`);
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
    console.log(`[sub9-e2e] step 7 cached`);
  }

  // ── Step 8: poll for order fill ───────────────────────────────────────
  if (state.step < 8) {
    console.log(`[sub9-e2e] step 8: polling reads.getOrders() ...`);
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
        console.log(`[sub9-e2e]   orders (${orders.length}): ${JSON.stringify(seri)}`);
        // If the resting order set drops below 1 we treat it as filled/swept.
        if (orders.length === 0) {
          console.log(`[sub9-e2e]   order no longer resting → likely filled/cleared`);
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
    console.log(`[sub9-e2e] step 8 cached`);
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
      console.log(`[sub9-e2e]   pool 0 after: ${JSON.stringify(state.poolAfterOrder)}`);
      if (state.poolBeforeOrder) {
        const dA = BigInt(state.poolAfterOrder.reserve_a) - BigInt(state.poolBeforeOrder.reserve_a);
        const dB = BigInt(state.poolAfterOrder.reserve_b) - BigInt(state.poolBeforeOrder.reserve_b);
        console.log(`[sub9-e2e]   pool 0 delta: dA=${dA} dB=${dB}`);
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
  console.log(`[sub9-e2e] SMOKE COMPLETE; final step=${state.step}; blockers=${state.blockers.length}`);
  if (state.blockers.length) {
    console.log(`[sub9-e2e] BLOCKERS:`);
    for (const b of state.blockers) console.log(`  - ${b}`);
  } else {
    console.log(`[sub9-e2e] no blockers recorded`);
  }

  await wallet.stop();
  await client.stop();
}

void dec0xHex; // silence unused

main().catch((e) => {
  console.error(`[sub9-e2e] FAILED:`, e);
  console.error(`[sub9-e2e] state persisted to ${STATE}; re-run to resume`);
  process.exit(1);
});
