// Sub-7a Task 13: pure-functional drip pipeline.
//
// All side-effects come in via injected `deps` so this module is fully
// unit-testable without a live L1/L2 stack. The HTTP route + the runtime
// singleton handle the wiring (see /pages/api/drip.ts + lib/runtime.ts).
//
// The pipeline shape is unchanged from the Task 13 plan. The L1Bridge type
// surface that landed in Task 11 (commit 364522d) has a `claimAmount: bigint`
// field on BridgeFeeJuiceResult beyond the plan's 5 fields and l1TxHash is
// `string | undefined` (lookup can fail). The pipeline:
//   - uses deps.config.feeJuiceAmount for the response.claimAmount (the
//     bridged amount is canonical — the result's claimAmount is just an echo);
//   - the *adapter* in lib/runtime.ts must throw if l1TxHash is undefined so
//     the pipeline's catch block converts it into a 503 (matches the spec:
//     "missing l1TxHash means audit signal lost → treat as L1 confirmation
//     failure").

import { validateL2Address } from "./address.js";
import { safeReason } from "./safe-error.js";
import type { RateLimiter, Clock } from "./rate-limit.js";
import type { DripResponse } from "./types.js";
import type { BridgeFeeJuiceResult } from "./l1-bridge.js";
import type { MintResult } from "./l2-mint.js";
import type { AuditLog } from "./audit-log.js";

export interface DripDeps {
  verifyCaptcha: (token: string) => Promise<boolean>;
  rateLimiter: RateLimiter;
  clock?: Clock;
  bridgeFeeJuice: (recipient: `0x${string}`, amount: bigint) => Promise<BridgeFeeJuiceResult>;
  /**
   * Mint tUSDC + tETH to `to` in a SINGLE batched tx. Returns the one tx hash
   * both mints share (see runtime.mintTokens / l2-mint.mintBatchToPublic).
   */
  mintTokens: (to: `0x${string}`, tUSDCAmount: bigint, tETHAmount: bigint) => Promise<MintResult>;
  checkDrained: () => Promise<boolean>;
  /**
   * Serializes the on-chain section (bridge + mint) across concurrent drips so
   * the single operator wallet/PXE doesn't race on tx nonce / world-state when
   * the wizard fires N drips at once. See runtime.withOnChainLock / mutex.ts.
   */
  withOnChainLock: <T>(fn: () => Promise<T>) => Promise<T>;
  config: {
    feeJuiceAmount: bigint;
    tUSDCAmount: bigint;
    tETHAmount: bigint;
    drainThresholdMultiplier: number;
  };
  auditLog: Pick<AuditLog, "append">;
}

export interface DripPipelineInput {
  address: string;
  captchaToken: string;
  ip: string;
  deps: DripDeps;
}

export interface DripPipelineOutput {
  status: number;
  body: DripResponse;
}

export async function runDripPipeline(input: DripPipelineInput): Promise<DripPipelineOutput> {
  const { address, captchaToken, ip, deps } = input;
  const clock: Clock = deps.clock ?? { now: () => Math.floor(Date.now() / 1000) };
  const ts = clock.now();

  if (!validateL2Address(address)) {
    deps.auditLog.append({ ts, ip, address, success: false, error: "invalid-address" });
    return { status: 400, body: { success: false, error: "invalid address", code: "bad-request" } };
  }

  const ok = await deps.verifyCaptcha(captchaToken);
  if (!ok) {
    deps.auditLog.append({ ts, ip, address, success: false, error: "invalid-captcha" });
    return { status: 400, body: { success: false, error: "invalid captcha", code: "bad-request" } };
  }

  const rl = deps.rateLimiter.checkAndRecord(ip, clock);
  if (!rl.allowed) {
    deps.auditLog.append({ ts, ip, address, success: false, error: `rate-limit:${rl.reason}` });
    if (rl.reason === "global-cap") {
      return { status: 503, body: { success: false, error: "faucet drained (global cap)", code: "drained" } };
    }
    return {
      status: 429,
      body: { success: false, error: "rate-limited", code: "rate-limited", retryAfterSeconds: rl.retryAfterSeconds },
    };
  }

  try {
    // M14: run the drain check INSIDE the try so a transient checkDrained() RPC
    // failure falls through to the sanitized 503 (+ audit) below instead of escaping
    // as an unsanitized throw. A genuine `true` still returns the drained 503 — and
    // releases the rate-limit reservation (M15) so a non-dispensing drip doesn't
    // permanently consume per-IP / global-cap capacity.
    if (await deps.checkDrained()) {
      if (rl.id !== undefined) deps.rateLimiter.release(rl.id);
      deps.auditLog.append({ ts, ip, address, success: false, error: "drained" });
      return { status: 503, body: { success: false, error: "faucet drained", code: "drained" } };
    }

    // Serialize the on-chain writes (L1 bridge + L2 batched mint) across
    // concurrent drips — the wizard fires N at once and they share one
    // operator wallet/PXE. The cheap checks above (captcha, rate-limit,
    // drain) run unlocked so malformed/throttled requests reject promptly.
    const { bridged, mint, l1TxHash } = await deps.withOnChainLock(async () => {
      const bridged = await deps.bridgeFeeJuice(address as `0x${string}`, deps.config.feeJuiceAmount);
      // Pipeline-side narrowing: the L1Bridge type allows l1TxHash to be
      // undefined (the post-bridge event-log lookup is best-effort). For the
      // happy-path drip we require the L1 tx hash so the audit trail + the
      // user response have a usable signal. Missing → treat as transient L1
      // failure (caught below, surfaces as 503). Surface it as a definite
      // string so the narrowing survives the closure boundary.
      if (!bridged.l1TxHash) {
        throw new Error("L1 tx hash unavailable from bridge result");
      }
      const l1TxHash: string = bridged.l1TxHash;
      // Both mints in ONE batched tx -> one ClientIVC proof (see deps.mintTokens).
      const mint = await deps.mintTokens(
        address as `0x${string}`,
        deps.config.tUSDCAmount,
        deps.config.tETHAmount,
      );
      return { bridged, mint, l1TxHash };
    });

    deps.auditLog.append({
      ts,
      ip,
      address,
      success: true,
      claimAmount: deps.config.feeJuiceAmount.toString(),
      mintTxs: { tUSDC: mint.txHash, tETH: mint.txHash },
    });

    return {
      status: 200,
      body: {
        success: true,
        claimData: {
          claimAmount: deps.config.feeJuiceAmount.toString(),
          claimSecretHex: bridged.claimSecretHex,
          claimSecretHashHex: bridged.claimSecretHashHex,
          messageHashHex: bridged.messageHashHex,
          messageLeafIndex: bridged.messageLeafIndex.toString(),
          l1TxHash,
        },
        tUSDCMint: { txHash: mint.txHash, amount: deps.config.tUSDCAmount.toString() },
        tETHMint: { txHash: mint.txHash, amount: deps.config.tETHAmount.toString() },
      },
    };
  } catch (e) {
    // M15: the drip did not dispense — release the reserved rate-limit slot so a
    // transient failure (incl. a thrown drain check) doesn't consume the user's quota.
    if (rl.id !== undefined) deps.rateLimiter.release(rl.id);
    // Audit #7/#6: NEVER echo the raw error to the client — upstream errors have
    // leaked full RPC URLs + embedded API keys. The raw message stays in the
    // server-side audit log only; the client gets a coarse, non-sensitive
    // category from safeReason (no substring of the original message).
    const msg = e instanceof Error ? e.message : String(e);
    deps.auditLog.append({
      ts,
      ip,
      address,
      success: false,
      error: `pipeline:${msg.slice(0, 200)}`,
    });
    return {
      status: 503,
      body: { success: false, error: `transient failure (${safeReason(e)})`, code: "transient" },
    };
  }
}
