// Sub-7a Task 13: runtime singleton — wires loadConfig + RateLimiter +
// L1Bridge + L2 mint helpers + AuditLog into a single cached object the
// API routes consume via getRuntime().
//
// ── Adapted to Task 11 (commit 364522d) + efe7932 deviations ──────────────
//
// L1Bridge ctor signature is now { rpcUrl, privateKey, chainId, aztecNodeUrl }
// (the plan in Task 13 referenced an earlier 2-arg shape that no longer
// exists). chainId comes from config.l1ChainId (added in efe7932).
// aztecNodeUrl reuses config.l2NodeUrl.
//
// L1Bridge.getFeeJuiceBalance() takes NO args — it auto-discovers the L1
// fee-juice ERC20 from the Aztec node and returns `bigint | null` (null on
// lookup failure). Drain detection uses getEthBalance() as the primary L1
// liquidity signal because (a) it's never null, and (b) the operator pays
// ETH for both gas AND the fee-juice deposit. We don't gate on
// getFeeJuiceBalance() in the drain check to avoid spurious 503s when the
// token-lookup side-channel transiently fails.

import { loadConfig, type FaucetConfig } from "./config.js";
import { RateLimiter } from "./rate-limit.js";
import { L1Bridge } from "./l1-bridge.js";
import { mintBatchToPublic, getOperatorL2Balance, type MintResult } from "./l2-mint.js";
import { AuditLog } from "./audit-log.js";
import { Mutex } from "./mutex.js";

// Process-global lock shared by every drip request. The faucet has one
// operator wallet/PXE/L1 signer; the wizard fires N drips concurrently, so the
// on-chain section (bridge + mint) must be serialized to avoid nonce /
// world-state races. Module scope (not per-runtime) so it survives any
// getRuntime() cache reset.
const onChainMutex = new Mutex();

export interface Runtime {
  config: FaucetConfig;
  rateLimiter: RateLimiter;
  l1Bridge: L1Bridge;
  /**
   * Mint tUSDC + tETH to `to` in a SINGLE batched tx (one ClientIVC proof).
   * Returns the one tx hash both mints share.
   */
  mintTokens: (to: `0x${string}`, tUSDCAmount: bigint, tETHAmount: bigint) => Promise<MintResult>;
  checkDrained: () => Promise<boolean>;
  /** Serializes a drip's on-chain section across concurrent requests. */
  withOnChainLock: <T>(fn: () => Promise<T>) => Promise<T>;
  auditLog: AuditLog;
}

let cached: Runtime | null = null;

export function getRuntime(): Runtime {
  if (cached) return cached;
  const config = loadConfig();

  const rateLimiter = new RateLimiter({
    sqlitePath: config.sqlitePath,
    perIpMaxDripsPerWindow: config.perIpMaxDripsPerWindow,
    perIpWindowSeconds: config.perIpWindowSeconds,
    dailyCap: config.globalDailyCap,
  });

  // L1Bridge ctor: { rpcUrl, privateKey, chainId, aztecNodeUrl }.
  // (Plan's older 2-arg signature is gone — see lib/l1-bridge.ts header.)
  const l1Bridge = new L1Bridge({
    rpcUrl: config.l1RpcUrl,
    privateKey: config.l1Pk,
    chainId: config.l1ChainId,
    aztecNodeUrl: config.l2NodeUrl,
  });

  const auditLog = new AuditLog(config.auditLogPath);

  // Sub-9.2 P2 fix attempt: switching to `mint_to_private` had a fundamental
  // ordering problem — the faucet mints BEFORE the user account is deployed,
  // and the user's PXE cannot discover the tagged private-note emission for
  // an address that isn't on-chain yet. So placeOrder fails with
  // "Balance too low" because the user's local note set is empty. (The
  // SDK-side conversion `mintToPrivate` helper itself is fine; the issue is
  // the temporal ordering in the wizard flow.) Reverted to `mintToPublic`.
  //
  // Carry-forward: the SDK already has `client.tokens.publicToPrivate(token, amount)`
  // via `transfer_public_to_private` (see scripts/sub9-e2e-smoke.ts step 5a's
  // call site). The wizard frontend should invoke it after the drip's claim
  // step completes. ~30s extra of user-side proof generation. Less surprising
  // than the mint_to_private timing trap.
  // Both mints go out as ONE BatchCall tx -> one ClientIVC proof for the whole
  // drip (vs one proof per token). Roughly halves the drip's on-chain latency,
  // which matters because the frontend wizard aborts a drip that runs past its
  // timeout (faucet-client.ts). mintBatchToPublic wraps the send in
  // sendWithRetry for dRPC-LB transients during proof-gen.
  const walletOpts = {
    nodeUrl: config.l2NodeUrl,
    operatorSecret: config.l2Secret,
    operatorSalt: config.l2Salt,
    operatorSigningKey: config.l2SigningKey,
  };
  const mintTokens = (
    to: `0x${string}`,
    tUSDCAmount: bigint,
    tETHAmount: bigint,
  ): Promise<MintResult> =>
    mintBatchToPublic(walletOpts, to, [
      { tokenAddress: config.l2TUSDC, amount: tUSDCAmount },
      { tokenAddress: config.l2TETH, amount: tETHAmount },
    ]);

  // Drain detection. Three signals:
  //   1. L1 ETH balance < feeJuiceAmount/100 (very rough heuristic — fee-juice
  //      deposits cost gas, not feeJuiceAmount, so this is a safety floor not
  //      a precise threshold).
  //   2. L2 tUSDC operator balance < tUSDCAmount * drainThresholdMultiplier.
  //   3. L2 tETH operator balance < tETHAmount * drainThresholdMultiplier.
  // L1 fee-juice ERC20 balance is INTENTIONALLY not part of the drain check:
  // L1Bridge.getFeeJuiceBalance() returns `bigint | null` (null on
  // auto-discovery failure), and we don't want a transient node hiccup to
  // gate the whole faucet. If the L1 fee-juice runs dry, bridgeFeeJuice
  // itself will throw and the pipeline turns it into a 503 — same outcome,
  // less brittle.
  // ETH drain floor in wei. Each bridgeTokensPublic + L2 mint pair costs
  // ~0.001 ETH (Sepolia). 0.01 ETH = ~10 drips of gas headroom; below
  // that we mark drained so the operator gets a degraded signal before
  // the next drip would silently fail at L1 tx broadcast.
  const ETH_DRAIN_FLOOR_WEI = 10_000_000_000_000_000n; // 0.01 ETH
  const checkDrained = async (): Promise<boolean> => {
    const ethBal = await l1Bridge.getEthBalance();
    if (ethBal < ETH_DRAIN_FLOOR_WEI) return true;
    const tUSDCBal = await getOperatorL2Balance({
      nodeUrl: config.l2NodeUrl,
      operatorSecret: config.l2Secret,
      operatorSalt: config.l2Salt,
      operatorSigningKey: config.l2SigningKey,
      tokenAddress: config.l2TUSDC,
    });
    if (tUSDCBal < config.tUSDCAmount * BigInt(config.drainThresholdMultiplier)) return true;
    const tETHBal = await getOperatorL2Balance({
      nodeUrl: config.l2NodeUrl,
      operatorSecret: config.l2Secret,
      operatorSalt: config.l2Salt,
      operatorSigningKey: config.l2SigningKey,
      tokenAddress: config.l2TETH,
    });
    if (tETHBal < config.tETHAmount * BigInt(config.drainThresholdMultiplier)) return true;
    return false;
  };

  cached = {
    config,
    rateLimiter,
    l1Bridge,
    mintTokens,
    checkDrained,
    withOnChainLock: (fn) => onChainMutex.runExclusive(fn),
    auditLog,
  };
  return cached;
}

/** Test/teardown helper — clears the singleton. Not used by the live server. */
export function _resetRuntimeForTesting(): void {
  cached = null;
}
