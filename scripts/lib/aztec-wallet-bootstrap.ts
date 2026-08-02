#!/usr/bin/env node
//
// Sub-5c A4: shared Aztec wallet bootstrap helper.
//
// Extracted from scripts/testnet-m1-hello.ts — same observable behaviour,
// wrapped in a state-persisted, resume-safe function that can be called
// from any script (deploy-bridge.ts, testnet-sub5b-bridge.ts, etc.).
//
// State machine:
//   step 1 – generate Schnorr account keys (secret, salt, signingKey)
//   step 2 – POST address to faucet; persist claimData
//   step 3 – mark "waiting for L1->L2 sync" (no-op; deploy loop handles the wait)
//   step 4 – deploy account with FeeJuicePaymentMethodWithClaim (retry loop, 30 min)
//   step 5 – verify account registration
//
// If the state file already has step >= 5 (or deployed=true shorthand),
// the function re-creates the wallet, re-registers the same keys, and
// returns immediately without hitting the network for steps 1-5 again.
//
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { Fr, Fq } from "@aztec/aztec.js/fields";
import { createAztecNodeClient, waitForNode } from "@aztec/aztec.js/node";
import { EmbeddedWallet } from "@aztec/wallets/embedded";
import { FeeJuicePaymentMethodWithClaim } from "@aztec/aztec.js/fee";
import { GasFees } from "@aztec/stdlib/gas";
import { NO_FROM } from "@aztec/aztec.js/account";
import { AztecAddress } from "@aztec/aztec.js/addresses";

// ── Types ──────────────────────────────────────────────────────────────────

export interface WalletBootstrapState {
  step: number;
  secret?: string;       // Fr hex
  salt?: string;         // Fr hex
  signingKey?: string;   // Fq hex
  address?: string;      // AztecAddress hex string
  claimData?: {
    claimAmount: string;
    claimSecretHex: string;
    claimSecretHashHex: string;
    messageHashHex: string;
    messageLeafIndex: string;
    l1TxHash: string;
  };
  accountDeployTx?: string;
  faucetResponses?: Array<{ asset: string; ts: string; httpStatus: number; body: unknown }>;
  deployed?: boolean;
}

export interface BootstrapResult {
  wallet: EmbeddedWallet;
  account: AztecAddress;
  state: WalletBootstrapState;
}

// ── Internal helpers ───────────────────────────────────────────────────────

function loadState(stateFile: string): WalletBootstrapState {
  if (!existsSync(stateFile)) return { step: 0, faucetResponses: [] };
  return JSON.parse(readFileSync(stateFile, "utf8")) as WalletBootstrapState;
}

function saveState(stateFile: string, state: WalletBootstrapState): void {
  writeFileSync(stateFile, JSON.stringify(state, null, 2));
}

async function postFaucet(
  faucetUrl: string,
  address: string,
  asset: "fee-juice",
): Promise<{ httpStatus: number; body: unknown }> {
  const res = await fetch(faucetUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ address, asset }),
  });
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = { raw: text };
  }
  return { httpStatus: res.status, body: parsed };
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Sub-5c A4: shared Aztec wallet bootstrap with state persistence.
 *
 * Behaviour:
 *   - If state file records step >= 5 (all steps complete), re-creates the
 *     EmbeddedWallet and returns immediately without re-hitting the faucet.
 *   - Otherwise walks: faucet drip → claim payload persist → L1→L2 sync wait
 *     (via deploy retry loop) → deploy account via FeeJuicePaymentMethodWithClaim,
 *     persisting state at each step.
 *
 * @param nodeUrl    Aztec node RPC URL
 * @param stateFile  path to JSON state file (resume-safe across process restarts)
 * @param faucetUrl  optional — required when bootstrapping a fresh wallet.
 *                   If omitted AND state.step < 2, throws. If state.step >= 2
 *                   the claim data is already persisted and faucetUrl is unused.
 */
export async function bootstrapAztecWallet(
  nodeUrl: string,
  stateFile: string,
  faucetUrl?: string,
): Promise<BootstrapResult> {
  const tag = `[bootstrap:${stateFile}]`;
  const state = loadState(stateFile);
  console.log(`${tag} starting; resuming from step ${state.step}`);

  const rawNode = createAztecNodeClient(nodeUrl);
  // Opt-in STATIC fee bypass: when STATIC_MAX_FEE_PER_L2_GAS is set, wrap the node so
  // getCurrentMinFees returns a fixed min-fee for ALL sends through wallets built here
  // (not just the account-setup send below). getCurrentMinFees is the only L1-backed hop
  // in a send, and it 429s on saturated nodes (aztec-labs) — this lets any send (e.g. a
  // bridge claim_public) skip it. No-op when the env var is unset.
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
  console.log(`${tag} waiting for node @ ${nodeUrl} ...`);
  await waitForNode(node);
  if (_sL2) console.log(`${tag} STATIC maxFeesPerGas override active (daGas=${_sDa} l2Gas=${_sL2})`);
  const nodeInfo = await node.getNodeInfo();
  console.log(`${tag} node OK; rollupVersion=${nodeInfo.rollupVersion} l1ChainId=${nodeInfo.l1ChainId}`);

  // Testnet's node reports realProofs: true → we MUST enable client-side
  // proving in the PXE. Without this, sendTx returns "Invalid tx: Invalid proof".
  const wallet = await EmbeddedWallet.create(node, {
    ephemeral: true,
    pxe: { proverEnabled: true },
  });

  // ── Step 1: generate Schnorr keys ──────────────────────────────────────
  if (state.step < 1) {
    console.log(`${tag} step 1: generating Schnorr account keypair ...`);
    const secret = Fr.random();
    const salt = Fr.ZERO;
    const signingKey = Fq.random();
    state.secret = secret.toString();
    state.salt = salt.toString();
    state.signingKey = signingKey.toString();
    state.step = 1;
    saveState(stateFile, state);
  }
  const secret = Fr.fromString(state.secret!);
  const salt = Fr.fromString(state.salt!);
  const signingKey = Fq.fromString(state.signingKey!);

  const accountManager = await wallet.createSchnorrAccount(secret, salt, signingKey);
  const address = (await accountManager.getAccount()).getAddress();
  if (!state.address) {
    state.address = address.toString();
    saveState(stateFile, state);
  }
  console.log(`${tag} account address: ${address.toString()}`);

  // ── Step 2: faucet drip ────────────────────────────────────────────────
  if (state.step < 2) {
    if (!faucetUrl) {
      throw new Error(
        `${tag} faucetUrl required for step 2 (no pre-funded claim in state)`,
      );
    }
    console.log(`${tag} step 2: requesting fee-juice drip from faucet ...`);
    const resp = await postFaucet(faucetUrl, address.toString(), "fee-juice");
    console.log(`${tag} drip response: ${JSON.stringify(resp)}`);
    state.faucetResponses = state.faucetResponses ?? [];
    state.faucetResponses.push({ asset: "fee-juice", ts: new Date().toISOString(), ...resp });
    const body = resp.body as { success?: boolean; claimData?: WalletBootstrapState["claimData"] };
    if (!body.success || !body.claimData) {
      throw new Error(`${tag} faucet drip failed: ${JSON.stringify(resp)}`);
    }
    state.claimData = body.claimData;
    state.step = 2;
    saveState(stateFile, state);
    console.log(
      `${tag} step 2 OK; claimAmount=${body.claimData.claimAmount} leafIndex=${body.claimData.messageLeafIndex}`,
    );
  }

  // ── Step 3: mark "waiting for L1->L2 sync" ────────────────────────────
  // No explicit polling here — the deploy retry loop in step 4 handles this.
  if (state.step < 3) {
    console.log(`${tag} step 3: waiting for L1->L2 message to land (~12-15 min) ...`);
    state.step = 3;
    saveState(stateFile, state);
  }

  // ── Step 4: deploy account with FeeJuicePaymentMethodWithClaim ─────────
  if (state.step < 4) {
    console.log(`${tag} step 4: deploying account with fee-juice claim ...`);
    const claim = {
      claimAmount: new Fr(BigInt(state.claimData!.claimAmount)),
      claimSecret: Fr.fromString(state.claimData!.claimSecretHex),
      messageLeafIndex: BigInt(state.claimData!.messageLeafIndex),
    };
    const paymentMethod = new FeeJuicePaymentMethodWithClaim(address, claim);

    // Optional STATIC fee override. When STATIC_MAX_FEE_PER_L2_GAS is set we pass
    // an explicit maxFeesPerGas so the wallet's completeFeeOptions skips the
    // node.getCurrentMinFees() call — that call does an L1 read on the node, which
    // is rate-limited (429) on the otherwise-CONSISTENT aztec-labs node. Lets us
    // deploy against a non-load-balanced node without the 429. Ceiling only: the
    // network charges the real base fee, so a generous value never overpays.
    const staticL2 = process.env.STATIC_MAX_FEE_PER_L2_GAS;
    const staticDa = process.env.STATIC_MAX_FEE_PER_DA_GAS ?? "0";
    const feeOpts: any = staticL2
      ? { paymentMethod, gasSettings: { maxFeesPerGas: new GasFees(BigInt(staticDa), BigInt(staticL2)) } }
      : { paymentMethod };
    if (staticL2) {
      console.log(`${tag}   STATIC maxFeesPerGas override: feePerDaGas=${staticDa} feePerL2Gas=${staticL2}`);
    }

    const start = Date.now();
    const timeoutMs = 30 * 60 * 1000; // 30 min
    let deployed = false;
    let lastErr: unknown;
    while (Date.now() - start < timeoutMs) {
      try {
        console.log(
          `${tag}   attempting deploy ... (elapsed ${Math.floor((Date.now() - start) / 1000)}s)`,
        );
        const deployMethod = await accountManager.getDeployMethod();
        // For self-deployment we pass from: NO_FROM so the wallet routes the fee
        // through the account contract's entrypoint (which is being deployed in this tx).
        const deployResult = await deployMethod.send({ fee: feeOpts, from: NO_FROM });
        console.log(
          `${tag} deploy result: ${JSON.stringify({
            txHash: deployResult.txHash?.toString?.() ?? String(deployResult.txHash),
          })}`,
        );
        state.accountDeployTx = deployResult.txHash?.toString?.() ?? String(deployResult.txHash);
        deployed = true;
        break;
      } catch (e) {
        lastErr = e;
        const msg = e instanceof Error ? e.message : String(e);
        console.log(`${tag}   deploy attempt failed: ${msg.slice(0, 300)}`);
        // L1->L2 message not ready -> retry; otherwise hard-fail.
        // Also retry transient node-consistency errors (e.g. a load-balanced
        // RPC routing consecutive world-state queries to backends at slightly
        // different heights -> "Block hash ... not found / reorg").
        const isRetryable = /L1.*L2|message|tree|membership|claim|block hash|reorg|world state|not found|dropped|p2p|mempool/i.test(msg);
        if (!isRetryable) throw e;
        console.log(`${tag}   retryable; sleeping 30s ...`);
        await sleep(30_000);
      }
    }
    if (!deployed) {
      throw new Error(
        `${tag} account deploy never succeeded after 30 min: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`,
      );
    }
    state.step = 4;
    state.deployed = true;
    saveState(stateFile, state);
    console.log(`${tag} step 4 OK; account deployed`);
  }

  // ── Step 5: verify account registration ───────────────────────────────
  if (state.step < 5) {
    console.log(`${tag} step 5: verifying account registration ...`);
    const accounts = await wallet.getAccounts();
    console.log(`${tag} accounts in wallet: ${accounts.length}`);
    for (const a of accounts) {
      console.log(`${tag}   - ${a.item.toString()} (alias=${a.alias ?? "<none>"})`);
    }
    state.step = 5;
    saveState(stateFile, state);
    console.log(`${tag} step 5 OK; bootstrap COMPLETE`);
  }

  const account = AztecAddress.fromStringUnsafe(state.address!);
  console.log(`${tag} wallet ready; address=${account.toString()}`);
  return { wallet, account, state };
}
