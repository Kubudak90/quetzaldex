// 4.3.0 migration helper: top up the (already-deployed) admin with fee-juice
// via the Nethermind faucet drip + an L2 claim.
//
// The admin account is ALREADY deployed, so we cannot use the account-deploy
// claim path. Instead we drip via the faucet, wait for the L1->L2 message to
// land, then claim on L2 by sending a no-op tx whose FEE is paid via
// FeeJuicePaymentMethodWithClaim (claim_and_end_setup credits the admin in the
// setup phase). This is the same claim pattern as bridge-fj-to-admin.ts step 3,
// proven in Sub-9.2 — but sourced from the free faucet instead of an L1 bridge.
//
// Static-fee bypass: aztec-labs' node.getCurrentMinFees() does an L1 read that
// 429s. We wrap the node so it returns a fixed min-fee (set via
// STATIC_MAX_FEE_PER_L2_GAS) so the claim tx skips that call.
//
// Usage:
//   AZTEC_NODE_URL=https://rpc.testnet.aztec-labs.com \
//   STATIC_MAX_FEE_PER_L2_GAS=8000000000000 STATIC_MAX_FEE_PER_DA_GAS=1000000000 \
//     pnpm tsx scripts/topup-admin-faucet.ts
//
// State: topup-admin-state.json (gitignored). Delete to re-drip.
//
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { Fr, Fq } from "@aztec/aztec.js/fields";
import { createAztecNodeClient, waitForNode } from "@aztec/aztec.js/node";
import { EmbeddedWallet } from "@aztec/wallets/embedded";
import { FeeJuiceContract } from "@aztec/aztec.js/protocol";
import { FeeJuicePaymentMethodWithClaim } from "@aztec/aztec.js/fee";
import { GasFees } from "@aztec/stdlib/gas";

const NODE_URL = process.env.AZTEC_NODE_URL ?? "https://rpc.testnet.aztec-labs.com";
if (!NODE_URL.includes("testnet")) {
  throw new Error(`AZTEC_NODE_URL must contain 'testnet' (safety check). Got: ${NODE_URL}`);
}
const FAUCET_URL = process.env.FAUCET_URL ?? "https://aztec-faucet.dev-nethermind.xyz/api/drip";
const M1_STATE = process.env.TOPUP_M1_STATE ?? "testnet-m1-state.json";
const STATE    = process.env.TOPUP_STATE ?? "topup-admin-state.json";
const PXE_DIR  = process.env.TOPUP_PXE_DIR ?? "./testnet-m4-pxe";
const WAIT_PROPAGATION_MS = 3 * 60_000;

interface M1State { secret: string; salt: string; signingKey: string; address: string; }
interface TopupState {
  step: number;
  claimAmount?: string;
  claimSecretHex?: string;
  messageLeafIndex?: string;
  l1TxHash?: string;
  claimTx?: string;
}
function loadState(): TopupState {
  if (existsSync(STATE)) return JSON.parse(readFileSync(STATE, "utf8")) as TopupState;
  return { step: 0 };
}
function saveState(s: TopupState): void { writeFileSync(STATE, JSON.stringify(s, null, 2)); }

async function main(): Promise<void> {
  const m1 = JSON.parse(readFileSync(M1_STATE, "utf8")) as M1State;
  const state = loadState();
  console.log(`[topup] node=${NODE_URL}`);
  console.log(`[topup] admin=${m1.address}`);

  const rawNode = createAztecNodeClient(NODE_URL);
  await waitForNode(rawNode);
  const _sL2 = process.env.STATIC_MAX_FEE_PER_L2_GAS;
  const _sDa = process.env.STATIC_MAX_FEE_PER_DA_GAS ?? "0";
  const node: any = _sL2
    ? new Proxy(rawNode as any, {
        get(t, p, r) {
          if (p === "getCurrentMinFees") return async () => new GasFees(BigInt(_sDa), BigInt(_sL2));
          const v = Reflect.get(t, p, r);
          return typeof v === "function" ? v.bind(t) : v;
        },
      })
    : rawNode;
  if (_sL2) console.log(`[topup] STATIC maxFeesPerGas override active: daGas=${_sDa} l2Gas=${_sL2}`);

  // ── Step 1: faucet drip ──────────────────────────────────────────────
  if (state.step < 1) {
    console.log(`[topup] step 1: requesting fee-juice drip from faucet ...`);
    const resp = await fetch(FAUCET_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ address: m1.address, asset: "fee-juice" }),
    });
    const body: any = await resp.json();
    if (!body?.success || !body?.claimData) {
      throw new Error(`faucet drip failed (status ${resp.status}): ${JSON.stringify(body)}`);
    }
    const cd = body.claimData;
    state.claimAmount = cd.claimAmount;
    state.claimSecretHex = cd.claimSecretHex;
    state.messageLeafIndex = cd.messageLeafIndex;
    state.l1TxHash = cd.l1TxHash;
    state.step = 1;
    saveState(state);
    console.log(`[topup]   drip OK; claimAmount=${cd.claimAmount} leafIndex=${cd.messageLeafIndex} l1Tx=${cd.l1TxHash}`);
  } else {
    console.log(`[topup] step 1 cached; leafIndex=${state.messageLeafIndex}`);
  }

  // ── Step 2: wait for L1->L2 propagation ──────────────────────────────
  if (state.step < 2) {
    console.log(`[topup] step 2: waiting ${WAIT_PROPAGATION_MS / 1000}s for L1->L2 propagation ...`);
    const start = Date.now();
    while (Date.now() - start < WAIT_PROPAGATION_MS) {
      await sleep(30_000);
      console.log(`[topup]   elapsed=${Math.floor((Date.now() - start) / 1000)}s`);
    }
    state.step = 2;
    saveState(state);
  }

  // ── Step 3: claim on L2 via FeeJuicePaymentMethodWithClaim ────────────
  if (state.step < 3) {
    console.log(`[topup] step 3: admin claims via FeeJuicePaymentMethodWithClaim ...`);
    const wallet = await EmbeddedWallet.create(node, {
      ephemeral: false,
      pxe: { proverEnabled: true, dataDirectory: PXE_DIR },
    });
    const adminMgr = await wallet.createSchnorrAccount(
      Fr.fromString(m1.secret), Fr.fromString(m1.salt), Fq.fromString(m1.signingKey),
    );
    const admin = (await adminMgr.getAccount()).getAddress();
    if (admin.toString() !== m1.address) throw new Error(`admin address mismatch`);

    const fj = FeeJuiceContract.at(wallet);
    const claim = {
      claimAmount: new Fr(BigInt(state.claimAmount!)),
      claimSecret: Fr.fromString(state.claimSecretHex!),
      messageLeafIndex: BigInt(state.messageLeafIndex!),
    };
    const paymentMethod = new FeeJuicePaymentMethodWithClaim(admin, claim);

    const claimStart = Date.now();
    const claimTimeoutMs = 30 * 60_000;
    let txHashStr: string | undefined;
    let lastErr: unknown;
    while (Date.now() - claimStart < claimTimeoutMs) {
      try {
        console.log(`[topup]   claim attempt (elapsed ${Math.floor((Date.now() - claimStart) / 1000)}s) ...`);
        const tx: any = await fj.methods.check_balance(0n).send({ fee: { paymentMethod }, from: admin });
        txHashStr = tx.receipt?.txHash?.toString?.() ?? String(tx.txHash);
        console.log(`[topup]   claim OK; tx=${txHashStr}`);
        break;
      } catch (e) {
        lastErr = e;
        const msg = e instanceof Error ? e.message : String(e);
        const isRetryable = /L1.*L2|message|tree|membership|not yet found|inclusion|not found|reorg|block hash|world state|dropped|p2p|mempool/i.test(msg);
        console.log(`[topup]   claim failed (retryable=${isRetryable}): ${msg.slice(0, 200)}`);
        if (!isRetryable) throw e;
        await sleep(30_000);
      }
    }
    if (!txHashStr) {
      throw new Error(`claim never landed after 30 min; last: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`);
    }
    state.claimTx = txHashStr;
    state.step = 3;
    saveState(state);
    await wallet.stop();
  } else {
    console.log(`[topup] step 3 cached; claim tx=${state.claimTx}`);
  }

  console.log(`[topup] ALL DONE. Admin topped up by the drip; re-check balance with check-admin-fj.ts.`);
}

main().catch((e: unknown) => {
  console.error(`[topup] FAILED:`, e);
  process.exit(1);
});
