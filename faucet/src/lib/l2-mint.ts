// Sub-7a Task 12: L2 mint wrapper for operator-mintable tUSDC + tETH.
//
// Boots an EmbeddedWallet against the Aztec testnet node, recreates the
// operator's deterministic Schnorr account from FAUCET_L2_SECRET, and calls
// Token.mint_to_public(recipient, amount) for either tUSDC or tETH.
//
// ── Deviations from Task 12 plan's starting-point implementation ──────────
//
// 1. **Use the codegen'd TokenContract binding directly — NOT
//    `loadContractArtifact(TokenContractArtifactJson)` + untyped
//    `Contract.at`.** The plan's starting-point statically imported the
//    raw JSON artifact and used the untyped Contract base. Cleaner approach
//    used by every other script in this repo (scripts/testnet-m2-token.ts,
//    scripts/deploy-tokens.ts, …) is to import the typed
//    `TokenContract` class from `tests/integration/generated/Token.js`,
//    which itself transitively pulls the JSON artifact. Gives us type-safe
//    `mint_to_public` + `balance_of_public` calls.
//
//    NOTE: this introduces a build-order constraint already imposed
//    everywhere else in the repo:
//      pnpm compile        # produces contracts/*/target/*.json (gitignored)
//      pnpm codegen        # produces tests/integration/generated/*.ts (tracked)
//    On a fresh clone WITHOUT step 1, the JSON file doesn't exist and
//    `next build` / typecheck fail. CI runs both steps; the faucet
//    Dockerfile (Task 17) copies the compiled contracts directory in
//    before `next build`.
//
// 2. **mint_to_public takes bigint directly, not U128Like.** The plan
//    referenced U128Like but the codegen'd signature in
//    tests/integration/generated/Token.ts:184 is:
//      mint_to_public(to: AztecAddressLike, amount: (bigint | number))
//    so we pass `amount: bigint` directly.
//
// 3. **Pass `wallet` to TokenContract.at, not `account`.** The plan cast
//    `account as unknown as Wallet` — EmbeddedWallet extends BaseWallet
//    which IS the Wallet interface, so we pass the wallet itself, the same
//    way scripts/testnet-m2-token.ts:89 does. `account.getAddress()` is
//    only used for the `from:` field of `.send({ from })`.
//
// 4. **`from:` field is required.** The PXE multi-account wallet needs to
//    know which registered account is sending; the codegen'd
//    ContractFunctionInteraction.send takes `{ from: AztecAddress }`.
//    The plan's starting-point omitted `from` — would throw at runtime.
//
// 5. **walletPromise is cached per-process (per nodeUrl+operatorSecret).**
//    EmbeddedWallet.create boots the PXE (~5-10s + LMDB open), so the
//    singleton avoids re-paying on every mint request. `ephemeral: false`
//    persists the wallet DB on disk between server restarts.
//
// 6. **proverEnabled: true is required.** The testnet node reports
//    `realProofs: true` and rejects txs that don't carry real ClientIVC
//    proofs. Same configuration used by every other testnet wallet in
//    this repo (scripts/testnet-m2-token.ts, scripts/lib/aztec-wallet-bootstrap.ts).

import { Fr, Fq } from "@aztec/aztec.js/fields";
import { deriveMasterMessageSigningSecretKey } from "@aztec/stdlib/keys";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { createAztecNodeClient, waitForNode } from "@aztec/aztec.js/node";
import { BatchCall } from "@aztec/aztec.js/contracts";
import { EmbeddedWallet } from "@aztec/wallets/embedded";
import { GasFees } from "@aztec/stdlib/gas";
import { TokenContract } from "../../../tests/integration/generated/Token.js";

// ── Consistent-node + static-fee bypass ─────────────────────────────────────
//
// The dRPC load-balancer (lb.drpc.live) routes successive calls to replicas at
// different block heights, so the PXE's multi-call proof-gen intermittently
// fails with "Block hash not found ... possibly a reorg" (-32702) storms that
// even the retry can't ride out. rpc.testnet.aztec-labs.com is a SINGLE
// consistent node with no such storms — but its getCurrentMinFees does an L1
// read that 429s under load. Overriding getCurrentMinFees with a static
// max-fee lets the faucet use the reliable node. This is exactly the recipe
// the 4.3.0 deploy + topup scripts use (scripts/topup-admin-faucet.ts).
//
// Enabled by FAUCET_STATIC_MAX_FEE_PER_L2_GAS (+ optional _DA_GAS). The static
// value is a max (the operator has ample fee-juice); it must sit at/above the
// network's current min L2 gas fee or txs are rejected as underpriced.
function withStaticFeeBypass(
  node: ReturnType<typeof createAztecNodeClient>,
): ReturnType<typeof createAztecNodeClient> {
  const l2 = process.env.FAUCET_STATIC_MAX_FEE_PER_L2_GAS;
  const da = process.env.FAUCET_STATIC_MAX_FEE_PER_DA_GAS ?? "0";
  if (!l2) return node;
  return new Proxy(node as object, {
    get(target, prop, receiver) {
      if (prop === "getCurrentMinFees") {
        return async () => new GasFees(BigInt(da), BigInt(l2));
      }
      const v = Reflect.get(target, prop, receiver);
      return typeof v === "function" ? v.bind(target) : v;
    },
  }) as ReturnType<typeof createAztecNodeClient>;
}

// ── Transient-failure retry ────────────────────────────────────────────────
//
// The live testnet is fronted by a dRPC load-balancer (node.quetzaldex.xyz →
// dRPC-paid, behind Caddy). The LB occasionally routes a tx send / receipt-wait
// to a replica lagging a block or two, which surfaces as errors like
// "Block hash 0x… not found", "world state", "membership", etc. The tx itself
// usually lands on a retry. WITHOUT a retry, a single such hiccup on the final
// mint_to_public aborts the whole faucet drip — the user's fee-juice already
// bridged but they get no tokens and a 503. We retry the send on transient
// errors only; non-transient errors (e.g. assertion failures) re-throw at once.
//
// Re-minting on retry is harmless here: this is a testnet faucet handing out
// free tokens, so an occasional double-mint (if the original send actually
// landed but the receipt-wait failed transiently) just over-funds the user.
//
// The transient regex mirrors scripts/topup-admin-faucet.ts (proven in Sub-9).
const TRANSIENT_RE =
  /L1.*L2|message|tree|membership|not yet found|inclusion|not found|reorg|block hash|world state|dropped|p2p|mempool|timeout|ECONNRESET|fetch failed|503|502|429/i;

export function isTransientError(message: string): boolean {
  return TRANSIENT_RE.test(message);
}

export interface SendWithRetryOpts {
  /** Max attempts including the first. Default 4. */
  maxAttempts?: number;
  /** Delay between attempts in ms. Default 15_000. */
  delayMs?: number;
  /** Injectable sleep for tests. Default real setTimeout. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Run `fn` (a tx-send thunk), retrying only on transient node errors. Throws
 * immediately on a non-transient error, and re-throws the last error after
 * `maxAttempts` transient failures.
 */
export async function sendWithRetry<T>(
  fn: () => Promise<T>,
  opts: SendWithRetryOpts = {},
): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? 4;
  const delayMs = opts.delayMs ?? 15_000;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const msg = e instanceof Error ? e.message : String(e);
      if (!isTransientError(msg) || attempt === maxAttempts) throw e;
      await sleep(delayMs);
    }
  }
  throw lastErr; // unreachable — loop either returns or throws
}

// Token decimals are baked into the operator-mintable tokens at deploy time.
// These match the constructor arguments used by scripts/deploy-tokens.ts and
// scripts/testnet-m2-token.ts for the live testnet deploys whose addresses
// live in quetzal.config.json (l2.tUSDC, l2.tETH).
export const L2_TOKEN_DECIMALS = { tUSDC: 6, tETH: 18 } as const;

export interface L2MintOpts {
  /** Aztec node JSON-RPC URL (e.g. https://rpc.testnet.aztec-labs.com). */
  nodeUrl: string;
  /**
   * Operator Schnorr secret as hex Fr (32 bytes). Same value as
   * FAUCET_L2_SECRET / quetzal.config.json:admin. The account is assumed to
   * already be deployed on L2 — we don't run `accountManager.deploy()` here.
   */
  operatorSecret: `0x${string}`;
  /**
   * Operator Schnorr salt as hex Fr (32 bytes). Must match what was used at
   * account-creation time. Defaults to Fr.ZERO if not provided.
   */
  operatorSalt?: `0x${string}`;
  /**
   * Operator Schnorr signing key as hex Fq (32 bytes). REQUIRED when
   * recreating an existing deployed account whose deploy used an explicit
   * random signing key — without it, createSchnorrAccount(secret, salt)
   * generates a fresh signing key and derives a DIFFERENT L2 address.
   *
   * Example: the m3-era admin (0x0524b493...) was deployed via
   * scripts/testnet-m1-hello.ts → scripts/lib/aztec-wallet-bootstrap.ts which
   * called `Fq.random()` and persisted the value to testnet-m1-state.json.
   * To reach that same address from the faucet, FAUCET_L2_SIGNING_KEY must
   * carry that persisted value.
   */
  operatorSigningKey?: `0x${string}`;
  /** Token contract address on L2. */
  tokenAddress: `0x${string}`;
}

export interface MintResult {
  txHash: string;
}

// Singleton wallet+account cache. Boot cost is high (~5-10s + LMDB open).
// Keyed by nodeUrl+operatorSecret so multiple operator wallets could coexist
// in theory (we expect exactly one in the faucet today).
type WalletEntry = {
  wallet: EmbeddedWallet;
  operatorAddress: AztecAddress;
};
const walletCache = new Map<string, Promise<WalletEntry>>();

function cacheKey(nodeUrl: string, operatorSecret: `0x${string}`): string {
  // operatorSecret is hex-encoded Fr; safe in a key with no separator collisions.
  return `${nodeUrl}::${operatorSecret}`;
}

/**
 * Internal: boot the EmbeddedWallet + recreate the operator's Schnorr account.
 * Cached per (nodeUrl, operatorSecret). Bootstrapping the wallet is slow
 * (~5-10s) and creates an on-disk LMDB store — we pay it once per process.
 */
async function getWalletEntry(
  nodeUrl: string,
  operatorSecret: `0x${string}`,
  operatorSalt: `0x${string}` | undefined,
  operatorSigningKey: `0x${string}` | undefined,
): Promise<WalletEntry> {
  // Include salt + signingKey in the cache key — different keys derive different
  // L2 addresses, so the cache must distinguish them.
  const key = `${nodeUrl}::${operatorSecret}::${operatorSalt ?? "0"}::${operatorSigningKey ?? "default"}`;
  const existing = walletCache.get(key);
  if (existing) return existing;

  const entryPromise = (async (): Promise<WalletEntry> => {
    const rawNode = createAztecNodeClient(nodeUrl);
    await waitForNode(rawNode);
    const node = withStaticFeeBypass(rawNode);
    const wallet = await EmbeddedWallet.create(node, {
      ephemeral: false,
      pxe: { proverEnabled: true },
    });
    const saltFr = operatorSalt ? Fr.fromString(operatorSalt) : Fr.ZERO;
    const accountManager = operatorSigningKey
      ? await wallet.createSchnorrAccount(
          Fr.fromString(operatorSecret),
          saltFr,
          Fq.fromString(operatorSigningKey),
        )
      : await wallet.createSchnorrAccount(
          Fr.fromString(operatorSecret),
          saltFr,
          // 5.0.0 requires an explicit signing key; derive it deterministically
          // from the secret (rc.2's implicit default) so the address is stable.
          deriveMasterMessageSigningSecretKey(Fr.fromString(operatorSecret)),
        );
    const operatorAddress = (await accountManager.getAccount()).getAddress();
    return { wallet, operatorAddress };
  })().catch((err) => {
    // Don't poison the cache on boot failure — let the next call retry.
    walletCache.delete(key);
    throw err;
  });

  walletCache.set(key, entryPromise);
  return entryPromise;
}

/**
 * Internal: instantiate TokenContract bound to the operator's wallet.
 * The wallet is the SendOptions sender; the `from:` AztecAddress is added
 * at .send() time.
 */
async function getToken(opts: L2MintOpts): Promise<{
  operatorAddress: AztecAddress;
  token: TokenContract;
}> {
  const { wallet, operatorAddress } = await getWalletEntry(
    opts.nodeUrl,
    opts.operatorSecret,
    opts.operatorSalt,
    opts.operatorSigningKey,
  );
  const token = await TokenContract.at(AztecAddress.fromStringUnsafe(opts.tokenAddress), wallet);
  return { operatorAddress, token };
}

/**
 * Mint `amount` (atomic units, no decimal scaling) of the token at
 * `opts.tokenAddress` to `to`. Returns the L2 tx hash on inclusion.
 *
 * `amount` is the on-chain field value — callers MUST scale by
 * L2_TOKEN_DECIMALS[symbol] themselves (e.g. 100 tUSDC → 100_000_000n at
 * 6 decimals). This matches the calling convention of every other
 * mint_to_public callsite in the repo (scripts/testnet-m2-token.ts:96).
 */
export async function mintToPublic(
  opts: L2MintOpts,
  to: `0x${string}`,
  amount: bigint,
): Promise<MintResult> {
  if (amount <= 0n) {
    throw new Error(`[l2-mint] amount must be positive (got ${amount})`);
  }
  const { operatorAddress, token } = await getToken(opts);
  // send() defaults to `wait: undefined` → waits for mining and returns
  // { receipt: TxReceipt, offchainEffects, offchainMessages }. Pre-4.x
  // API used .send().wait(); 4.2.1 collapsed both into a single await.
  // Wrapped in sendWithRetry so a dRPC-LB transient on the final mint doesn't
  // abort a drip whose fee-juice bridge already succeeded (see TRANSIENT_RE).
  const sent = await sendWithRetry(() =>
    token.methods
      .mint_to_public(AztecAddress.fromStringUnsafe(to), amount)
      .send({ from: operatorAddress }),
  );
  return { txHash: sent.receipt.txHash.toString() };
}

/** One token + amount to mint in a {@link mintBatchToPublic} batch. */
export interface BatchMintToken {
  tokenAddress: `0x${string}`;
  amount: bigint;
}

/**
 * Mint several tokens to `to`'s PUBLIC balance in a SINGLE transaction via
 * BatchCall. The wallet groups all the (public) mint_to_public calls into one
 * ExecutionPayload simulated + proven as a single tx — so the faucet pays ONE
 * ClientIVC proof for the whole drip instead of one per token, roughly halving
 * the on-chain latency. Returns the single tx hash shared by all mints.
 *
 * Wrapped in sendWithRetry so a dRPC-LB transient during proof-gen retries the
 * whole batch rather than aborting the drip (see TRANSIENT_RE).
 */
export async function mintBatchToPublic(
  opts: Omit<L2MintOpts, "tokenAddress">,
  to: `0x${string}`,
  tokens: BatchMintToken[],
): Promise<MintResult> {
  if (tokens.length === 0) {
    throw new Error("[l2-mint] mintBatchToPublic: no tokens to mint");
  }
  for (const t of tokens) {
    if (t.amount <= 0n) {
      throw new Error(`[l2-mint] amount must be positive (got ${t.amount})`);
    }
  }
  const { wallet, operatorAddress } = await getWalletEntry(
    opts.nodeUrl,
    opts.operatorSecret,
    opts.operatorSalt,
    opts.operatorSigningKey,
  );
  const recipient = AztecAddress.fromStringUnsafe(to);
  const interactions = await Promise.all(
    tokens.map(async (t) => {
      const token = await TokenContract.at(AztecAddress.fromStringUnsafe(t.tokenAddress), wallet);
      return token.methods.mint_to_public(recipient, t.amount);
    }),
  );
  const sent = await sendWithRetry(() =>
    new BatchCall(wallet, interactions).send({ from: operatorAddress }),
  );
  return { txHash: sent.receipt.txHash.toString() };
}

/**
 * Mint `amount` of the token at `opts.tokenAddress` to `to`'s PRIVATE balance.
 *
 * Sub-9.2 P2 fix: the Orderbook's `submit_order` calls
 * `Token.transfer_private_to_public(maker, orderbook, amount, nonce)` on the
 * escrow leg — which reads the maker's PRIVATE balance. Fresh users from the
 * faucet need a private balance to be tradeable. The previous flow minted
 * publicly + required a wizard-side `transfer_public_to_private` hop,
 * adding ~30s of user-side proof generation and a footgun.
 *
 * `mint_to_private` is a `#[external("private")]` function on Token.nr:
 *   - it asserts `_validate_minter(msg_sender, minter)` (we're the minter)
 *   - it directly creates a UintNote in the recipient's PrivateSet
 *   - **no auth witness needed** since msg_sender IS the minter
 *
 * Same signature shape as `mint_to_public`: `(AztecAddressLike, bigint)`.
 */
export async function mintToPrivate(
  opts: L2MintOpts,
  to: `0x${string}`,
  amount: bigint,
): Promise<MintResult> {
  if (amount <= 0n) {
    throw new Error(`[l2-mint] amount must be positive (got ${amount})`);
  }
  const { operatorAddress, token } = await getToken(opts);
  const sent = await sendWithRetry(() =>
    token.methods
      .mint_to_private(AztecAddress.fromStringUnsafe(to), amount)
      .send({ from: operatorAddress }),
  );
  return { txHash: sent.receipt.txHash.toString() };
}

/**
 * Read the operator's public balance for the token at `opts.tokenAddress`.
 * Used by the drain-detection / Prometheus balance gauge (Task 13).
 *
 * Returns the raw field value (atomic units, no decimal scaling).
 */
export async function getOperatorL2Balance(opts: L2MintOpts): Promise<bigint> {
  const { operatorAddress, token } = await getToken(opts);
  // simulate() returns SimulationResult { result: any, offchainEffects, … };
  // for balance_of_public the field result is a bigint/number. Unwrap
  // defensively in case a future SDK version inlines (matches the
  // safeguard in scripts/testnet-m2-token.ts:109-110).
  const sim = await token.methods
    .balance_of_public(operatorAddress)
    .simulate({ from: operatorAddress });
  const raw =
    typeof sim === "object" && sim !== null && "result" in sim
      ? (sim as { result: bigint | number }).result
      : (sim as unknown as bigint | number);
  return BigInt(raw);
}

/**
 * Test/teardown helper — clears the wallet cache. Not needed in the live
 * faucet (the process lives for the server's lifetime), but useful in
 * integration tests that boot multiple wallets sequentially.
 */
export function _resetCachesForTesting(): void {
  walletCache.clear();
}
