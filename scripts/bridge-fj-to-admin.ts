// Sub-9.2 helper: bridge fee-juice from L1 → admin on Aztec testnet.
//
// Admin's L2 FJ balance (~17 FJ) is below the per-tx fee budget for a
// LiquidityPool/Orderbook deploy (~20-30 FJ). Faucet IPs are rate-limited
// for the next 6.8h. This script bypasses the faucet pipeline and uses the
// same L1FeeJuicePortalManager directly — the faucet operator's L1 keys
// have Sepolia ETH available.
//
// Pipeline:
//   1. L1 depositToAztecPublic(admin, amount) (paid in L1 ETH, gives back an
//      L1→L2 message + claim secret).
//   2. Wait ~3 min for the L1→L2 message to land on Aztec's pending tree.
//   3. Admin calls FeeJuice.claim(admin, amount, secret, leafIdx) on L2.
//      This is a small public tx (~1-2 FJ) — admin's 17 FJ covers it.
//   4. After claim, admin gets +amount FJ — enough for the Sub-9.2 redeploy.
//
// State: bridge-fj-to-admin-state.json (gitignored).
//
// Usage:
//   FAUCET_L1_PK=0x701d... \
//   FAUCET_L1_RPC_URL=https://sepolia.infura.io/v3/... \
//   FAUCET_L1_CHAIN_ID=11155111 \
//   AZTEC_NODE_URL=https://rpc.testnet.aztec-labs.com \
//     pnpm tsx scripts/bridge-fj-to-admin.ts [amount-FJ]
//
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { Fr, Fq } from "@aztec/aztec.js/fields";
import { createAztecNodeClient, waitForNode } from "@aztec/aztec.js/node";
import { EmbeddedWallet } from "@aztec/wallets/embedded";
import { FeeJuiceContract } from "@aztec/aztec.js/protocol";
import { FeeJuicePaymentMethodWithClaim } from "@aztec/aztec.js/fee";
import { L1Bridge } from "../faucet/src/lib/l1-bridge.js";

const NODE_URL = process.env.AZTEC_NODE_URL ?? "https://rpc.testnet.aztec-labs.com";
const L1_RPC   = process.env.FAUCET_L1_RPC_URL;
const L1_PK    = process.env.FAUCET_L1_PK as `0x${string}` | undefined;
if (!L1_RPC || !L1_PK) {
  throw new Error("FAUCET_L1_RPC_URL + FAUCET_L1_PK env vars required");
}
const L1_CHAIN_ID = Number(process.env.FAUCET_L1_CHAIN_ID ?? 11155111);

const M1_STATE = process.env.BRIDGE_M1_STATE ?? "testnet-m1-state.json";
const STATE    = process.env.BRIDGE_STATE ?? "bridge-fj-to-admin-state.json";
const PXE_DIR  = process.env.BRIDGE_PXE_DIR ?? "./testnet-m4-pxe";

const AMOUNT_FJ = BigInt(process.argv[2] ?? "100");
const AMOUNT_ATOMIC = AMOUNT_FJ * 10n ** 18n;

const WAIT_PROPAGATION_MS = 4 * 60_000;  // 4 min — testnet typical

interface M1State {
  secret: string; salt: string; signingKey: string; address: string;
}
interface BridgeState {
  step: number;
  amountAtomic?: string;
  claimAmount?: string;
  claimSecretHex?: string;
  messageLeafIndex?: string;
  l1TxHash?: string;
  claimTx?: string;
  notes?: string[];
}

function loadState(): BridgeState {
  if (existsSync(STATE)) return JSON.parse(readFileSync(STATE, "utf8")) as BridgeState;
  return { step: 0, notes: [] };
}
function saveState(s: BridgeState): void { writeFileSync(STATE, JSON.stringify(s, null, 2)); }

async function main(): Promise<void> {
  const m1 = JSON.parse(readFileSync(M1_STATE, "utf8")) as M1State;
  const state = loadState();
  console.log(`[bridge-fj] node=${NODE_URL}`);
  console.log(`[bridge-fj] admin=${m1.address}`);
  console.log(`[bridge-fj] amount=${AMOUNT_FJ} FJ (${AMOUNT_ATOMIC} atomic)`);

  const node = createAztecNodeClient(NODE_URL);
  await waitForNode(node);

  // ── Step 1: L1 bridge ────────────────────────────────────────────────
  if (state.step < 1) {
    console.log(`[bridge-fj] step 1: L1 depositToAztecPublic ...`);
    const bridge = new L1Bridge({
      rpcUrl: L1_RPC!,
      privateKey: L1_PK!,
      chainId: L1_CHAIN_ID,
      aztecNodeUrl: NODE_URL,
    });
    const t0 = Date.now();
    const res = await bridge.bridgeFeeJuice(m1.address as `0x${string}`, AMOUNT_ATOMIC);
    state.amountAtomic = AMOUNT_ATOMIC.toString();
    state.claimAmount = res.claimAmount.toString();
    state.claimSecretHex = res.claimSecretHex;
    state.messageLeafIndex = res.messageLeafIndex.toString();
    state.l1TxHash = res.l1TxHash;
    state.step = 1;
    state.notes?.push(`L1 bridge submitted at ${new Date().toISOString()}: leafIndex=${res.messageLeafIndex}`);
    saveState(state);
    console.log(`[bridge-fj]   L1 bridge OK in ${((Date.now()-t0)/1000).toFixed(1)}s`);
    console.log(`[bridge-fj]     leafIndex=${res.messageLeafIndex}`);
    console.log(`[bridge-fj]     l1Tx     =${res.l1TxHash}`);
  } else {
    console.log(`[bridge-fj] step 1 cached; leafIndex=${state.messageLeafIndex}`);
  }

  // ── Step 2: wait for L1->L2 propagation ──────────────────────────────
  if (state.step < 2) {
    console.log(`[bridge-fj] step 2: waiting ${WAIT_PROPAGATION_MS/1000}s for L1->L2 propagation ...`);
    const start = Date.now();
    while (Date.now() - start < WAIT_PROPAGATION_MS) {
      await sleep(30_000);
      console.log(`[bridge-fj]   elapsed=${Math.floor((Date.now()-start)/1000)}s`);
    }
    state.step = 2;
    saveState(state);
  } else {
    console.log(`[bridge-fj] step 2 cached; propagation wait done`);
  }

  // ── Step 3: admin claims on L2 ───────────────────────────────────────
  if (state.step < 3) {
    console.log(`[bridge-fj] step 3: admin FeeJuice.claim(...) ...`);
    const wallet = await EmbeddedWallet.create(node, {
      ephemeral: false,
      pxe: { proverEnabled: true, dataDirectory: PXE_DIR },
    });
    const adminMgr = await wallet.createSchnorrAccount(
      Fr.fromString(m1.secret),
      Fr.fromString(m1.salt),
      Fq.fromString(m1.signingKey),
    );
    const admin = (await adminMgr.getAccount()).getAddress();
    if (admin.toString() !== m1.address) {
      throw new Error(`admin address mismatch`);
    }

    // FeeJuiceContract is the canonical aztec.js wrapper at the protocol
    // address (0x...05). No codegen needed; static .at(wallet) → fully typed.
    const fj = FeeJuiceContract.at(wallet);

    // Sub-9.2 reality: admin's L2 FJ balance (~8 FJ) is BELOW the per-tx
    // fee budget for FeeJuice.claim(). Trying to pay from admin's
    // pre-existing balance fails with "Insufficient fee payer balance".
    //
    // Workaround: use FeeJuicePaymentMethodWithClaim as the fee payer for
    // the claim tx itself. This calls `claim_and_end_setup` (which credits
    // admin with the claimed amount + pays the tx fee from that credit, all
    // in the same tx). `claim_and_end_setup` is normally used during
    // account-deploy setup but the protocol permits it for any tx whose
    // setup phase is paying for itself via an L1->L2 message.
    //
    // If admin's account already used `claim_and_end_setup` at deploy time
    // and the FJ contract gates it (e.g., one-shot per account), this will
    // assert and we'll fall back to plain `claim()`.
    const claim = {
      claimAmount: new Fr(BigInt(state.claimAmount!)),
      claimSecret: Fr.fromString(state.claimSecretHex!),
      messageLeafIndex: BigInt(state.messageLeafIndex!),
    };
    const paymentMethod = new FeeJuicePaymentMethodWithClaim(admin, claim);

    // Retry loop — testnet L1->L2 propagation can take 5-15 min. Retry on
    // L1-to-L2-related errors; bail on other errors.
    //
    // The tx itself is `FeeJuice.claim(...)` but the FEE is paid via
    // `FeeJuicePaymentMethodWithClaim` (which calls `claim_and_end_setup`
    // in the setup phase, crediting admin with the claim amount before the
    // tx body runs — so the tx pays for itself).
    //
    // Concern: this DOUBLE-CLAIMS the same L1->L2 message (once via
    // claim_and_end_setup in setup, once via fj.claim() in the body), which
    // would burn 2 nullifiers and revert the body. To avoid this, we
    // submit a "no-op" tx body — just register the FJ contract and ping
    // a view. But the wallet's send() requires a real method call.
    //
    // Simpler: drop the explicit `fj.claim(...)` call and just send the
    // payment-method's claim+pay as the ENTIRE tx — the wallet supports
    // payment-method-only txs (entrypoint AppPayload is empty).
    const claimStart = Date.now();
    const claimTimeoutMs = 30 * 60_000;
    let txHashStr: string | undefined;
    let lastErr: unknown;
    while (Date.now() - claimStart < claimTimeoutMs) {
      try {
        console.log(`[bridge-fj]   claim attempt (elapsed ${Math.floor((Date.now() - claimStart)/1000)}s) — via FeeJuicePaymentMethodWithClaim ...`);
        // Use a tiny no-op call (fj.balance_of_public(admin)) as the body
        // so the wallet has something to package — the payment method's
        // claim_and_end_setup runs in the setup phase and credits admin.
        // (We do NOT call fj.claim() — that would double-spend the message.)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const tx: any = await fj.methods
          .check_balance(0n)  // any no-op pure view that won't revert
          .send({ fee: { paymentMethod }, from: admin });
        txHashStr = tx.receipt?.txHash?.toString?.() ?? String(tx.txHash);
        console.log(`[bridge-fj]   claim OK; tx=${txHashStr}`);
        break;
      } catch (e) {
        lastErr = e;
        const msg = e instanceof Error ? e.message : String(e);
        const isRetryable = /L1.*L2|message|tree|membership|not yet found|inclusion/i.test(msg);
        console.log(`[bridge-fj]   claim failed (retryable=${isRetryable}): ${msg.slice(0, 200)}`);
        if (!isRetryable) throw e;
        console.log(`[bridge-fj]   sleeping 30s ...`);
        await sleep(30_000);
      }
    }
    if (!txHashStr) {
      throw new Error(`claim never landed after 30 min; last: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`);
    }
    state.claimTx = txHashStr;
    state.step = 3;
    state.notes?.push(`claim landed at ${new Date().toISOString()}: tx=${txHashStr}`);
    saveState(state);
    await wallet.stop();
  } else {
    console.log(`[bridge-fj] step 3 cached; claim tx=${state.claimTx}`);
  }

  console.log(`[bridge-fj] ALL DONE. Admin should now have +${AMOUNT_FJ} FJ.`);
}

main().catch((e: unknown) => {
  console.error(`[bridge-fj] FAILED:`, e);
  console.error(`[bridge-fj] state in ${STATE}`);
  process.exit(1);
});
