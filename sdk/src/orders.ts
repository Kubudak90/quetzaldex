// sdk/src/orders.ts
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { Fr } from "@aztec/aztec.js/fields";
import { FunctionCall, FunctionSelector, FunctionType } from "@aztec/aztec.js/abi";
import type { AuthWitness } from "@aztec/aztec.js/authorization";
import type { QuetzalClient } from "./client.js";
import type {
  PlaceOrderInput,
  PlaceOrderResult,
  BulkPlaceOrderInput,
  BulkPlaceOrderResult,
  BulkOrderReveal,
  CurrentEpoch,
  OrderSide,
} from "./types.js";
import { OrderError, ConfigError } from "./errors.js";
import { randomField } from "./util/field.js";
import { recordDecoyBatch, isDecoy } from "./privacy/decoy-registry.js";
import type { HopProofLeaf, HopProofResponse } from "./aggregator.js";

export const MAX_ORDERS_PER_BULK = 5;
export const MAX_DECOYS = MAX_ORDERS_PER_BULK - 1;

// ─── Validators ───────────────────────────────────────────────────────────────

export function validatePlaceOrderInput(input: PlaceOrderInput): void {
  if (input.amount <= 0n) {
    throw new OrderError("INVALID_PATH", "amount must be > 0");
  }
  if (input.limitPrice <= 0n) {
    throw new OrderError("INVALID_PATH", "limitPrice must be > 0");
  }
  if (input.path.length < 2 || input.path.length > 3) {
    throw new OrderError("INVALID_PATH", `path must have 2-3 hops; got ${input.path.length}`);
  }
}

export function validateBulkInput(input: BulkPlaceOrderInput): void {
  validatePlaceOrderInput(input);
  if (input.decoyCount < 0 || input.decoyCount > MAX_DECOYS) {
    throw new OrderError(
      "INVALID_PATH",
      `decoyCount must be in [0, ${MAX_DECOYS}]; got ${input.decoyCount}`,
    );
  }
}

// ─── Sub-6c A2: canonical path normalization ──────────────────────────────────
//
// Path-order leaks side: a sell from USDC->ETH used to store [USDC, ETH];
// a buy of USDC from ETH used to store [ETH, USDC]. On-chain observers could
// derive direction from the redundant path encoding. Sub-6c A1 Noir circuit
// asserts path[0] < path[path_len-1] (canonical); A2 (this) transparently
// canonicalizes SDK callers' paths + flips the `side` bool so the semantic
// intent is preserved while the on-chain path no longer leaks direction.
//
// Post-canonical side semantics:
//   side="buy" (false) -> pay path[0] (canonical low), receive path[last] (high)
//   side="sell" (true) -> pay path[last] (high), receive path[0] (low)

// Mirrors the orderbook contract's `path[0] as u128 < path[last] as u128`
// canonicalization check. The Field-to-u128 cast truncates to the lower 128
// bits; a naive full-bigint compare disagrees with the on-chain ordering for
// many address pairs (see Sub-9.1 findings). Always compare canonical paths
// using the same u128 truncation the contract uses.
const U128_MASK = (1n << 128n) - 1n;

export function canonicalizePath(
  side: OrderSide,
  path: string[],
): { side: OrderSide; path: string[] } {
  if (path.length < 2 || path.length > 3) {
    throw new OrderError("INVALID_PATH", `path length must be 2 or 3; got ${path.length}`);
  }
  const lo = BigInt(path[0]) & U128_MASK;
  const hi = BigInt(path[path.length - 1]) & U128_MASK;
  if (lo === hi) {
    throw new OrderError("INVALID_PATH", "path endpoints must differ (u128-truncated)");
  }
  if (lo < hi) return { side, path };
  return {
    side: side === "buy" ? "sell" : "buy",
    path: [...path].reverse(),
  };
}

// ─── Node "Invalid proof" → actionable error ──────────────────────────────────
//
// On the current Aztec testnet, submitting an app-contract transaction fails at
// node_sendTx with "Invalid tx: Invalid proof": the PXE simulates, generates a
// full ClientIVC proof, and submits it (captured live: a ~190 KB node_sendTx
// whose body carries the proof) — the node then rejects it at proof verification.
// Reproduced (2026-06-14) with a token's transfer_public_to_private; deterministic
// across client 4.3.0 and 4.3.1 (node 4.3.1). RULED OUT: client/node version skew,
// and contract-class mismatch (local artifacts compute to the exact on-chain class
// IDs, which commit to the per-function VKs). NOT yet isolated: which component of
// the client→PXE→node proof-verification stack is at fault — account-deploy proofs
// from the same PXE verify fine, but that does not by itself localize the bug.
// Surfacing the raw string as a toast is useless, so we map it to a clearer message.
// Applied to the shield + submit_order legs.

/**
 * Map a node "Invalid proof" rejection to an actionable OrderError; rethrow
 * anything else unchanged.
 */
export function rethrowSubmitError(e: unknown): never {
  const msg = e instanceof Error ? e.message : String(e);
  if (/invalid\s*proof/i.test(msg)) {
    throw new OrderError(
      "ESCROW_FAILED",
      `The node rejected this transaction's proof ("${msg.slice(0, 80)}"). ` +
        `The responsible component in the client-to-node proof path has not yet been isolated. ` +
        `Retrying immediately is unlikely to help.`,
      e,
    );
  }
  throw e instanceof Error ? e : new Error(msg);
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

function requireContracts(client: QuetzalClient): NonNullable<typeof client.config.contracts> {
  const c = client.config.contracts;
  if (!c) {
    throw new ConfigError(
      "MISSING_ENV",
      "QuetzalClient.config.contracts not set; pass `contracts` to QuetzalClient.connect()",
    );
  }
  return c;
}

interface PathTriple {
  path_len: 2 | 3;
  pathFields: [Fr, Fr, Fr];
}

/**
 * Resolve alias OR hex-address path entries to hex addresses. Tolerates a
 * mixed list (e.g. ["tUSDC", "0xabc…"]) by passing hex inputs through
 * unchanged. Pre-canonicalization step.
 */
function resolveAliasesToHex(client: QuetzalClient, path: string[]): string[] {
  const contracts = requireContracts(client);
  const map: Record<string, string | undefined> = {
    tUSDC: contracts.tUSDC,
    tETH: contracts.tETH,
    tBTC: contracts.tBTC,
  };
  if (path.length < 2 || path.length > 3) {
    throw new OrderError("INVALID_PATH", `path_len must be 2 or 3, got ${path.length}`);
  }
  return path.map((p) => {
    if (p.startsWith("0x")) return p;
    const addr = map[p];
    if (!addr) throw new OrderError("INVALID_PATH", `unknown token alias: ${p}`);
    return addr;
  });
}

/**
 * Pack a 2- or 3-element hex-address path into a (path_len, [Fr;3]) tuple
 * suitable for the orderbook's submit_order ABI. Post-canonicalization step.
 */
function pathHexToFields(hexes: string[]): PathTriple {
  if (hexes.length < 2 || hexes.length > 3) {
    throw new OrderError("INVALID_PATH", `path_len must be 2 or 3, got ${hexes.length}`);
  }
  for (let i = 0; i < hexes.length; i++) {
    for (let j = i + 1; j < hexes.length; j++) {
      if (hexes[i] === hexes[j]) {
        throw new OrderError("INVALID_PATH", `path[${i}] == path[${j}]: ${hexes[i]}`);
      }
    }
  }
  const fields: [Fr, Fr, Fr] = [
    Fr.fromString(hexes[0]!),
    Fr.fromString(hexes[1]!),
    hexes[2] ? Fr.fromString(hexes[2]) : Fr.ZERO,
  ];
  return { path_len: hexes.length as 2 | 3, pathFields: fields };
}

// ─── Public API ───────────────────────────────────────────────────────────────

// ─── Sub-4 browser claim path ─────────────────────────────────────────────────

export interface ClaimFillArgs {
  epochId: number;
  orderNonce: Fr;
  hopIndex: bigint;
  amountOut: bigint;
  poolId: bigint;
  leafIndex: bigint;
  siblingPath: Fr[];
}

/**
 * Marshal one hop-proof leaf (from the aggregator's GET /proof) into the 7 typed
 * claim_fill args. Mirrors the CLI's claimSingleHop construction
 * (cli/src/commands/claim.ts:101-111) EXACTLY — same order, same types — so the
 * browser claim is identical to the on-chain-proven CLI path.
 */
export function hopProofToClaimArgs(leaf: HopProofLeaf, epochId: number): ClaimFillArgs {
  if (leaf.sibling_path.length !== 6) {
    throw new OrderError(
      "INVALID_PATH",
      `claim_fill needs a depth-6 sibling path; got ${leaf.sibling_path.length}`,
    );
  }
  return {
    epochId,
    orderNonce: Fr.fromString(leaf.order_nonce),
    hopIndex: BigInt(leaf.hop_index),
    amountOut: BigInt(leaf.amount_out),
    poolId: BigInt(leaf.pool_id),
    leafIndex: BigInt(leaf.leaf_index),
    siblingPath: leaf.sibling_path.map((s) => Fr.fromString(s)),
  };
}

// ─── L11: extracted pure slot-builder (injectable rng for unit tests) ────────

export interface BulkSlotsResult {
  sides: boolean[];
  amounts: bigint[];
  limits: bigint[];
  nonces: bigint[];
  orderNonces: bigint[];
  pathLens: number[];
  pathArrays: [Fr, Fr, Fr][];
  realOrderNonce: bigint;
  /** Used slots in order_nonce-sorted order. Reveal EVERY one to the aggregator. */
  reveals: BulkOrderReveal[];
}

/**
 * Pure helper extracted from placeOrderBulk; injectable `rng` enables deterministic
 * unit tests without a live PXE.
 *
 * Fills the MAX_ORDERS_PER_BULK slot arrays with the real order at slot 0 plus
 * `decoyCount` decoys, then sorts the USED slots (0..decoyCount) by orderNonce ASC
 * so the on-chain fold order matches the aggregator's replay order. The real order's
 * nonce is captured by VALUE before the sort so it can be identified after the
 * permutation regardless of which slot it lands in.
 *
 * Reveal payload params for ALL used slots (real + decoys). The caller MUST broadcast
 * every one to the aggregator — the order_acc folds them all, so a real-only reveal
 * fails the replay and the whole epoch is skipped. Decoys carry an unfillable limit
 * so they never cross (no fill); they only complete the chain.
 */
export function buildBulkSlots(
  realSide: boolean,
  amount: bigint,
  limitPrice: bigint,
  pathLen: number,
  pathFields: [Fr, Fr, Fr],
  decoyCount: number,
  rng: () => bigint = randomField,
): BulkSlotsResult {
  const SLOTS = MAX_ORDERS_PER_BULK;
  // sell: u128::MAX (no one buys at MAX); buy: 1 wei (pool sqrt_p >> 1).
  // Must be > 0 — the orderbook helper asserts limit_price > 0.
  const UNFILLABLE_HIGH = (1n << 128n) - 1n;
  const UNFILLABLE_LOW = 1n;

  const sides: boolean[] = new Array(SLOTS).fill(false);
  const amounts: bigint[] = new Array(SLOTS).fill(0n);
  const limits: bigint[] = new Array(SLOTS).fill(0n);
  const nonces: bigint[] = new Array(SLOTS).fill(0n);
  const orderNonces: bigint[] = new Array(SLOTS).fill(0n);
  const pathLens: number[] = new Array(SLOTS).fill(0);
  const pathArrays: [Fr, Fr, Fr][] = new Array(SLOTS).fill([Fr.ZERO, Fr.ZERO, Fr.ZERO]);

  // Slot 0: real order
  sides[0] = realSide;
  amounts[0] = amount;
  limits[0] = limitPrice;
  nonces[0] = rng();
  orderNonces[0] = rng();
  pathLens[0] = pathLen;
  pathArrays[0] = pathFields;

  // Decoys: same side/amount, unfillable limit price
  for (let i = 1; i <= decoyCount; i++) {
    sides[i] = realSide;
    amounts[i] = amount;
    limits[i] = realSide ? UNFILLABLE_HIGH : UNFILLABLE_LOW;
    nonces[i] = rng();
    orderNonces[i] = rng();
    pathLens[i] = pathLen;
    pathArrays[i] = pathFields;
  }

  // Capture the real order's nonce by VALUE before sorting (its slot index will
  // change; the nonce value is stable and identifies it post-permutation).
  const realOrderNonce = orderNonces[0]!;

  // Sort used slots by orderNonce ASC so on-chain fold order == aggregator replay order.
  const used = [];
  for (let i = 0; i <= decoyCount; i++) {
    used.push({
      s: sides[i]!, a: amounts[i]!, l: limits[i]!, n: nonces[i]!,
      on: orderNonces[i]!, pl: pathLens[i]!, p: pathArrays[i]!,
    });
  }
  used.sort((x, y) => (x.on < y.on ? -1 : x.on > y.on ? 1 : 0));
  for (let i = 0; i <= decoyCount; i++) {
    const u = used[i]!;
    sides[i] = u.s; amounts[i] = u.a; limits[i] = u.l;
    nonces[i] = u.n; orderNonces[i] = u.on; pathLens[i] = u.pl; pathArrays[i] = u.p;
  }

  const reveals: BulkOrderReveal[] = orderNonces.slice(0, decoyCount + 1).map((on, i) => ({
    orderNonce: on,
    side: sides[i]!,
    amountIn: amounts[i]!,
    limitPrice: limits[i]!,
    pathLen: pathLens[i]!,
    path: [
      pathArrays[i]![0]!.toString(),
      pathArrays[i]![1]!.toString(),
      pathArrays[i]![2]!.toString(),
    ] as [string, string, string],
  }));

  return { sides, amounts, limits, nonces, orderNonces, pathLens, pathArrays, realOrderNonce, reveals };
}

export class OrdersApi {
  constructor(private client: QuetzalClient) {}

  /**
   * Build the maker's private auth-witness authorizing the orderbook to escrow
   * `amount` of `tokenInHex` via `Token.transfer_private_to_public(maker,
   * orderbook, amount, nonce)`. The orderbook calls that with from=maker but
   * msg_sender=orderbook, so the Token's `#[authorize_once("from","_nonce")]`
   * takes the authwit branch (not the self-call fast path). Consumer=tokenIn,
   * caller=orderbook, args [maker, orderbook, amount, nonce] — byte-identical to
   * what the contract verifies and to what embedded-Schnorr auto-captures, so a
   * duplicate is a no-op (PXE getAuthWitness is find-first by message hash).
   * `nonce` MUST equal the `nonce` arg forwarded to submit_order(_bulk).
   */
  private async buildEscrowAuthWit(tokenInHex: string, amount: bigint, nonce: bigint): Promise<AuthWitness> {
    const contracts = requireContracts(this.client);
    const orderbookAddr = AztecAddress.fromStringUnsafe(contracts.orderbook);
    const tokenInAddr = AztecAddress.fromStringUnsafe(tokenInHex);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return await (this.client.wallet as any).createAuthWit(this.client.address, {
      caller: orderbookAddr,
      call: FunctionCall.from({
        name: "transfer_private_to_public",
        to: tokenInAddr,
        selector: await FunctionSelector.fromSignature(
          "transfer_private_to_public((Field),(Field),u128,Field)",
        ),
        type: FunctionType.PRIVATE,
        hideMsgSender: false,
        isStatic: false,
        args: [
          this.client.address.toField(), // from   = maker
          orderbookAddr.toField(),        // to     = orderbook (self.address)
          new Fr(amount),                 // amount (u128 → single Field)
          new Fr(nonce),                  // _nonce = same Field passed to submit_order
        ],
        returnTypes: [],
      }),
    });
  }

  async placeOrder(input: PlaceOrderInput): Promise<PlaceOrderResult> {
    validatePlaceOrderInput(input);
    const contracts = requireContracts(this.client);
    // Sub-9.1 fix: resolve aliases to hex addresses FIRST, then canonicalize.
    // The previous order (canonicalize then resolve) called BigInt() on alias
    // strings ("tUSDC") and threw SyntaxError. Canonicalization needs to
    // compare addresses as bigints, which only works on hex inputs.
    const resolvedPathHex = resolveAliasesToHex(this.client, input.path);
    const canonical = canonicalizePath(input.side, resolvedPathHex);
    const { path_len, pathFields } = pathHexToFields(canonical.path);

    const realSide = canonical.side === "sell"; // false = bid, true = ask

    // The orderbook escrows from the maker's PRIVATE balance, but faucet funds
    // land in the PUBLIC balance — shield the input token public->private first
    // so submit_order can drain it (else: "Balance too low", token/main.nr:625).
    // Input token mirrors the contract: bid escrows path[0], ask escrows path[last].
    const inputTokenHex = realSide
      ? canonical.path[canonical.path.length - 1]!
      : canonical.path[0]!;
    await this.ensurePrivateBalance(inputTokenHex, input.amount);

    const orderNonce = randomField();
    const txNonce = randomField();

    const { loadOrderbookContract } = await import("./internal/contracts.js");
    const OrderbookContract = await loadOrderbookContract();
    const orderbook = await OrderbookContract.at(
      AztecAddress.fromStringUnsafe(contracts.orderbook),
      this.client.wallet,
    );
    // Cast: codegen bindings may lag the Sub-4 7-arg signature
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    // Sub-9.6: aztec.js 4.2.1 .send({from}) returns { receipt: TxReceipt, ...offchainOutput }
    // — already waits for mining by default. The OLD code did `.wait?.()` on this
    // result which silently returned undefined (no wait method present), so
    // both txHash and blockNumber were lost. Aggregator's clearing cycle THEN
    // rejected the reveal as a replay mismatch because submitted_at_block was 0.
    // Sub-9.7 fix: read the current epoch BEFORE submitting. The order enters the
    // epoch open when the tx mines; submit_order asserts block < closes_at_block,
    // so a successful submit is in the epoch read here. Reading AFTER .send()
    // previously threw (post-send PXE world-state hiccup) and the silent catch
    // left epoch=0 → reveal carried epoch_id 0 → the aggregator could not match
    // it to the real epoch → clearing never settled. Retry + surface failure.
    let epoch = 0;
    {
      let lastErr: unknown;
      for (let i = 0; i < 4; i++) {
        try {
          const epochSim = await orderbook.methods.get_epoch().simulate({ from: this.client.address });
          epoch = Number((epochSim as { result: { epoch_id: bigint } }).result.epoch_id);
          lastErr = undefined;
          break;
        } catch (e) {
          lastErr = e;
          await new Promise((r) => setTimeout(r, 1500));
        }
      }
      if (lastErr) {
        // KNOWN CONTRACT BUG (needs orderbook redeploy): get_epoch() reverts with a
        // u32 "pow * 2" overflow (orderbook main.nr order-decode loop) in the
        // utility/simulate path, so the real epoch can't be read here. Fall back to
        // 0 + warn so the order still SUBMITS; the reveal's epoch_id will be wrong
        // → the aggregator can't match/clear it until the contract is redeployed.
        console.warn(
          `[sdk] placeOrder: get_epoch() read failed (likely the orderbook pow*2 u32 overflow); epoch defaulting to 0 — clearing won't match until the orderbook is redeployed with the fix. Detail: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`,
        );
      }
    }

    // Explicit escrow auth-witness: the orderbook calls
    // Token(tokenIn).transfer_private_to_public(maker, orderbook, amount, txNonce)
    // with msg_sender=orderbook != from=maker, so the Token's
    // #[authorize_once("from","_nonce")] takes the AUTHWIT branch. Embedded-Schnorr
    // auto-captures this; we build it EXPLICITLY so non-auto-capturing wallets
    // (e.g. passkey) also work without an extension rebuild. Hash is byte-identical
    // to what the contract verifies, and a duplicate vs auto-capture is a no-op
    // (PXE getAuthWitness is find-first by message hash).
    const escrowAuthWit = await this.buildEscrowAuthWit(inputTokenHex, input.amount, txNonce);

    const sendResult = await (orderbook.methods.submit_order as any)(
      realSide,
      input.amount,
      input.limitPrice,
      txNonce,
      orderNonce,
      BigInt(path_len),
      pathFields,
    ).send({ from: this.client.address, authWitnesses: [escrowAuthWit] }).catch(rethrowSubmitError);
    const receipt = (sendResult as { receipt?: { txHash?: { toString: () => string }; blockNumber?: number } }).receipt;
    const minedBlock = receipt?.blockNumber ?? 0;

    // The orderbook binds `submitted_at_block = get_anchor_block_header().block_number()`
    // (the tx ANCHOR block, fixed at PXE simulation) into c_i — NOT the mined block,
    // which is typically 1+ blocks later. Read the EXACT value back from the on-chain
    // OrderNote (note.nonce == order_nonce) so the reveal's submitted_at_block matches
    // the folded c_i; otherwise the aggregator's order_acc replay mismatches and the
    // order never settles (observed live: epoch 47, 2026-06-10 — one stale read
    // poisoned the whole epoch). The note can lag PXE sync by a few seconds, so
    // RETRY before falling back, and warn loudly on fallback — a wrong anchor is
    // an unclearable order.
    const submittedAtBlock = await this.readAnchorBlock(orderNonce, minedBlock);

    return {
      txHash: receipt?.txHash?.toString() ?? "",
      nonce: txNonce,
      orderNonce,
      epoch,
      blockNumber: minedBlock,
      submittedAtBlock,
      // Expose the CANONICAL side (already folded into c_i above) so reveal
      // producers forward the same side the contract bound, not the raw user side.
      side: realSide,
      // Audit #11: expose the canonical path (already bound into c_i above) so
      // reveal producers forward the SAME path the contract folded.
      path_len,
      path: [pathFields[0].toString(), pathFields[1].toString(), pathFields[2].toString()],
    };
  }

  /**
   * Read the OrderNote's anchor block for a just-placed order, retrying while
   * the PXE catches up. The anchor — NOT the mined block — is folded into the
   * on-chain c_i; a reveal carrying anything else makes the aggregator's
   * order_acc replay mismatch, which strands EVERY order in the epoch
   * (all-or-nothing replay). Fall back to minedBlock only after retries are
   * exhausted, and say so loudly.
   */
  private async readAnchorBlock(orderNonce: bigint, minedBlock: number): Promise<number> {
    let lastErr: unknown;
    for (let attempt = 0; attempt < 6; attempt++) {
      try {
        const mine = (await this.client.reads.getOrders()).find((o) => o.nonce === orderNonce);
        if (mine) return Number(mine.submitted_at_block);
      } catch (e) {
        lastErr = e;
      }
      await new Promise((r) => setTimeout(r, 3000));
    }
    console.warn(
      `[sdk] placeOrder: could not read the OrderNote anchor block after 6 attempts` +
      ` (nonce 0x${orderNonce.toString(16).slice(0, 12)}…); falling back to mined block ${minedBlock}.` +
      ` The reveal's submitted_at_block is likely WRONG — this order (and its whole epoch)` +
      ` may fail the aggregator's order_acc replay and never settle.` +
      (lastErr ? ` Last error: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}` : ""),
    );
    return minedBlock;
  }

  /**
   * Ensure the maker holds at least `amount` of `tokenInHex` in their PRIVATE
   * balance before submitting, shielding the shortfall from PUBLIC if needed.
   *
   * Why this exists: the orderbook escrows via `Token.transfer_private_to_public`
   * (orderbook/main.nr:484), which drains the maker's PRIVATE balance. The
   * faucet, however, mints to the PUBLIC balance (faucet/lib/runtime.ts:
   * `mint_to_private` can't be discovered by the PXE of an account that isn't
   * on-chain yet). With no shield step a fresh user's private balance is empty,
   * so submit_order reverts with
   *   assert(subtracted > 0, "Balance too low")   // token/main.nr:625
   * This transparently moves the shortfall PUBLIC->PRIVATE so the escrow drains
   * cleanly. Costs ONE extra tx (client-side proof) the first time; once the
   * private balance is sufficient, subsequent orders skip the shield.
   */
  private async ensurePrivateBalance(tokenInHex: string, amount: bigint, slots = 1): Promise<void> {
    const { loadTokenContract } = await import("./internal/contracts.js");
    const TokenContract = await loadTokenContract();
    const token = await TokenContract.at(
      AztecAddress.fromStringUnsafe(tokenInHex),
      this.client.wallet,
    );
    const from = this.client.address;
    // balance_of_private is `unconstrained`; balance_of_public is `#[view]`.
    // codegen bindings can lag, so reach them through a cast (mirrors the
    // transfer_public_to_private call site in scripts/sub9-e2e-smoke.ts).
    type Sim = { simulate: (a: { from: AztecAddress }) => Promise<{ result: bigint }> };
    const m = token.methods as unknown as {
      balance_of_private: (o: AztecAddress) => Sim;
      balance_of_public: (o: AztecAddress) => Sim;
      transfer_public_to_private: (
        from: AztecAddress,
        to: AztecAddress,
        amount: bigint,
        nonce: Fr,
      ) => { send: (a: { from: AztecAddress }) => Promise<unknown> };
    };

    const readPrivate = async (): Promise<bigint> =>
      BigInt((await m.balance_of_private(from).simulate({ from })).result);

    const privateBal = await readPrivate();
    if (privateBal >= amount) return;

    const need = amount - privateBal;
    const publicBal = BigInt((await m.balance_of_public(from).simulate({ from })).result);
    if (publicBal < need) {
      throw new OrderError(
        "ESCROW_FAILED",
        `insufficient balance to escrow: need ${amount} of ${tokenInHex} but have ` +
          `${privateBal} private + ${publicBal} public (short ${need - publicBal}). ` +
          `Bridge or fund more of this token before ordering.`,
      );
    }

    // Shield the shortfall PUBLIC->PRIVATE. transfer_public_to_private asserts
    // _nonce == 0 when from == msg_sender (self-shield), so pass Fr.ZERO.
    // aztec.js 4.x `.send({from})` resolves once the tx is mined.
    const n = slots < 1 ? 1 : slots;
    if (n === 1) {
      // Single escrow (placeOrder): one consolidated note is fine — no intra-tx split.
      await m
        .transfer_public_to_private(from, from, need, Fr.ZERO)
        .send({ from })
        .catch(rethrowSubmitError);
    } else {
      // Bulk (placeOrderBulk): submit_order_bulk performs `n` sequential escrows in
      // ONE tx. If they all drain ONE freshly-shielded note, escrow #2..n must
      // discover the prior escrow's just-created TRANSIENT change note, which
      // intermittently races the PXE note-getter during simulation and reverts with
      // "Balance too low" (token/main.nr:625) — observed live 2026-06-14. Shield the
      // shortfall as `n` SEPARATE notes in ONE BatchCall (one tx, n notes) so each
      // escrow consumes its own note with no intra-tx split. Sizes sum to `need`.
      const base = need / BigInt(n);
      const rem = need % BigInt(n);
      const calls = [];
      for (let i = 0; i < n; i++) {
        const chunk = base + (BigInt(i) < rem ? 1n : 0n);
        if (chunk > 0n) calls.push(m.transfer_public_to_private(from, from, chunk, Fr.ZERO));
      }
      const { BatchCall } = (await import("@aztec/aztec.js/contracts")) as unknown as {
        BatchCall: new (wallet: unknown, calls: unknown[]) => { send: (a: { from: AztecAddress }) => Promise<unknown> };
      };
      await new BatchCall(this.client.wallet, calls).send({ from }).catch(rethrowSubmitError);
    }

    // The freshly-created private note can lag PXE sync by a few seconds after
    // the tx mines; poll until the private balance reflects the shield so the
    // subsequent submit_order simulation can discover it.
    for (let attempt = 0; attempt < 8; attempt++) {
      if ((await readPrivate()) >= amount) return;
      await new Promise((r) => setTimeout(r, 2000));
    }
    console.warn(
      `[sdk] ensurePrivateBalance: shielded ${need} of ${tokenInHex} public->private, ` +
        `but private balance still reads < ${amount} after PXE-sync polling. The order ` +
        `may still revert with "Balance too low" if the note isn't discovered in time.`,
    );
  }

  /**
   * Compute escrow params for an order: which token is escrowed, the total amount
   * (incl. decoys), and how many separate notes (slots) the bulk path needs.
   * Mirrors the contract: bid escrows path[0], ask escrows path[last]; a bulk
   * escrows `1 + decoyCount` slots of `amount` each.
   */
  private escrowParamsFor(
    input: PlaceOrderInput,
    decoyCount = 0,
  ): { inputTokenHex: string; totalAmount: bigint; slots: number } {
    const resolvedPathHex = resolveAliasesToHex(this.client, input.path);
    const canonical = canonicalizePath(input.side, resolvedPathHex);
    const realSide = canonical.side === "sell";
    const inputTokenHex = realSide
      ? canonical.path[canonical.path.length - 1]!
      : canonical.path[0]!;
    const slots = decoyCount + 1;
    return { inputTokenHex, totalAmount: input.amount * BigInt(slots), slots };
  }

  /** Read the maker's PRIVATE balance of a token (PXE-local, unconstrained). */
  private async readPrivateBalance(tokenInHex: string): Promise<bigint> {
    const { loadTokenContract } = await import("./internal/contracts.js");
    const TokenContract = await loadTokenContract();
    const token = await TokenContract.at(AztecAddress.fromStringUnsafe(tokenInHex), this.client.wallet);
    const from = this.client.address;
    const m = token.methods as unknown as {
      balance_of_private: (o: AztecAddress) => {
        simulate: (a: { from: AztecAddress }) => Promise<{ result: bigint }>;
      };
    };
    return BigInt((await m.balance_of_private(from).simulate({ from })).result);
  }

  /**
   * Read-only: does the maker already hold enough PRIVATE balance to escrow this
   * order (incl. decoys) without shielding? Drives the frontend's two-phase
   * "Shield → Submit" button so the slow shield stays OUT of the order tx's
   * critical path (which must fit inside the orderbook epoch window — a slow
   * shield+order in one flow can exceed it and revert at _assert_epoch_open).
   */
  async privateBalanceStatus(
    input: PlaceOrderInput,
    decoyCount = 0,
  ): Promise<{ inputToken: string; needed: bigint; privateBalance: bigint; shortfall: bigint; sufficient: boolean }> {
    validatePlaceOrderInput(input);
    requireContracts(this.client);
    const { inputTokenHex, totalAmount } = this.escrowParamsFor(input, decoyCount);
    const privateBalance = await this.readPrivateBalance(inputTokenHex);
    const sufficient = privateBalance >= totalAmount;
    return {
      inputToken: inputTokenHex,
      needed: totalAmount,
      privateBalance,
      shortfall: sufficient ? 0n : totalAmount - privateBalance,
      sufficient,
    };
  }

  /**
   * Shield public->private UP FRONT so a later order escrows from SETTLED notes.
   * Separate from placeOrder/placeOrderBulk (ERC20 wrap pattern): the shield is
   * slow (one proof, or an N-note BatchCall for bulk) and must not sit in the
   * order tx's epoch-window budget. Shields `1 + decoyCount` separate notes for
   * the bulk path. No-op (returns shielded:false) if private balance already
   * suffices.
   */
  async fundPrivateForOrder(
    input: PlaceOrderInput,
    decoyCount = 0,
  ): Promise<{ shielded: boolean; needed: bigint }> {
    validatePlaceOrderInput(input);
    requireContracts(this.client);
    const { inputTokenHex, totalAmount, slots } = this.escrowParamsFor(input, decoyCount);
    const before = await this.readPrivateBalance(inputTokenHex);
    if (before >= totalAmount) return { shielded: false, needed: totalAmount };
    await this.ensurePrivateBalance(inputTokenHex, totalAmount, slots);
    return { shielded: true, needed: totalAmount };
  }

  async placeOrderBulk(input: BulkPlaceOrderInput): Promise<BulkPlaceOrderResult> {
    validateBulkInput(input);
    const contracts = requireContracts(this.client);
    // Sub-6c A3 / Sub-9.1 fix: resolve aliases to hex addresses FIRST, then
    // canonicalize. See placeOrder for rationale. The real order (slot 0)
    // inherits the canonical side; decoys (slots 1..K-1) use an unfillable
    // limit-price so direction is irrelevant for them.
    const resolvedPathHex = resolveAliasesToHex(this.client, input.path);
    const canonical = canonicalizePath(input.side, resolvedPathHex);
    const { path_len, pathFields } = pathHexToFields(canonical.path);

    const realSide = canonical.side === "sell";
    const decoyCount = input.decoyCount;

    // See placeOrder: shield the escrowed input token public->private. Bulk
    // escrows EVERY used slot — submit_order_bulk loops over slots and the real
    // order PLUS each decoy escrows the SAME input token at the SAME amount
    // (decoys reuse amounts[0]). So the maker needs (1 + decoyCount) × amount in
    // their private balance, not just `amount`.
    const inputTokenHex = realSide
      ? canonical.path[canonical.path.length - 1]!
      : canonical.path[0]!;
    // slots = 1 real + decoyCount escrows; shield that many SEPARATE notes so each
    // escrow consumes its own note (avoids the chain-split race — see ensurePrivateBalance).
    await this.ensurePrivateBalance(inputTokenHex, input.amount * BigInt(decoyCount + 1), decoyCount + 1);
    // Decoy-clear fix: see buildBulkSlots JSDoc. Sort used slots by order_nonce ASC
    // so the on-chain fold order == the aggregator's replay order; otherwise the
    // order_acc replay mismatches and the WHOLE epoch is skipped ("skipped:replay-mismatch").
    const SLOTS = MAX_ORDERS_PER_BULK;
    const { sides, amounts, limits, nonces, orderNonces, pathLens, pathArrays, realOrderNonce, reveals } =
      buildBulkSlots(realSide, input.amount, input.limitPrice, path_len, pathFields, decoyCount);

    const { loadOrderbookContract } = await import("./internal/contracts.js");
    const OrderbookContract = await loadOrderbookContract();
    const orderbook = await OrderbookContract.at(
      AztecAddress.fromStringUnsafe(contracts.orderbook),
      this.client.wallet,
    );
    const bulkOrderbook = orderbook as unknown as {
      methods: {
        submit_order_bulk: (
          side: boolean[],
          amount_in: bigint[],
          limit_price: bigint[],
          nonce: bigint[],
          order_nonce: bigint[],
          path_len: number[],
          path: [Fr, Fr, Fr][],
          // aztec.js 4.x `.send({from})` returns a Promise that resolves to
          // { receipt, ...offchainOutput } once mined (see Sub-9.6 note above).
        ) => { send: (args: { from: AztecAddress; authWitnesses?: AuthWitness[] }) => Promise<unknown> };
      };
    };
    // Sub-9.7 fix: read the current epoch BEFORE submit (see placeOrder for the
    // post-send-throw → epoch=0 → unmatched-reveal rationale).
    let epoch = 0;
    {
      let lastErr: unknown;
      for (let i = 0; i < 4; i++) {
        try {
          const epochSim = await orderbook.methods.get_epoch().simulate({ from: this.client.address });
          epoch = Number((epochSim as { result: { epoch_id: bigint } }).result.epoch_id);
          lastErr = undefined;
          break;
        } catch (e) {
          lastErr = e;
          await new Promise((r) => setTimeout(r, 1500));
        }
      }
      if (lastErr) {
        // See placeOrder: known orderbook get_epoch() pow*2 u32 overflow. Warn +
        // fall back to 0 so the order still submits; clearing won't match until
        // the orderbook is redeployed with the overflow fixed.
        console.warn(
          `[sdk] placeOrderBulk: get_epoch() read failed (likely the orderbook pow*2 u32 overflow); epoch defaulting to 0. Detail: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`,
        );
      }
    }

    // Sub-9.6: see placeOrder for the .send() result shape rationale.
    // Explicit escrow auth-witnesses: one per non-zero slot. submit_order_bulk
    // escrows each used slot via Token(tokenIn).transfer_private_to_public(
    // maker, orderbook, amounts[i], nonces[i]) (from=maker != msg_sender=orderbook
    // → authwit branch). Build each EXPLICITLY (see placeOrder) so non-auto-
    // capturing wallets work; tokenIn is shared because every used slot reuses the
    // real slot's canonical path (orders.ts:550,556).
    const escrowAuthWits: AuthWitness[] = [];
    for (let i = 0; i < SLOTS; i++) {
      if (amounts[i]! <= 0n) continue; // skip empty slots — the contract skips them too
      escrowAuthWits.push(await this.buildEscrowAuthWit(inputTokenHex, amounts[i]!, nonces[i]!));
    }

    const sendResult = await bulkOrderbook.methods
      .submit_order_bulk(sides, amounts, limits, nonces, orderNonces, pathLens, pathArrays)
      .send({ from: this.client.address, authWitnesses: escrowAuthWits })
      .catch(rethrowSubmitError);
    const receipt = (sendResult as { receipt?: { txHash?: { toString: () => string }; blockNumber?: number } }).receipt;
    const minedBlock = receipt?.blockNumber ?? 0;
    // submitted_at_block = the ANCHOR block bound into every c_i (all used slots
    // are in ONE tx → ONE block). Read it back from the real order's OrderNote.
    const submittedAtBlock = await this.readAnchorBlock(realOrderNonce, minedBlock);

    // Used slots in the (now order_nonce-sorted) submission order — this is BOTH
    // the on-chain fold order AND the aggregator's replay order, so revealing ALL of
    // them in this order replays the epoch order_acc exactly.
    const usedOrderNonces = orderNonces.slice(0, decoyCount + 1);
    const decoyNonces = usedOrderNonces.filter((n) => n !== realOrderNonce);

    // Record nonces in maker-local decoy registry (real flagged isDecoy:false).
    const entries: Array<{ nonce: string; isDecoy: boolean }> = usedOrderNonces.map((n) => ({
      nonce: `0x${n.toString(16)}`,
      isDecoy: n !== realOrderNonce,
    }));
    recordDecoyBatch(this.client.address.toString(), entries);

    // reveals already built by buildBulkSlots in sorted order (see its JSDoc).

    return {
      txHash: receipt?.txHash?.toString() ?? "",
      realNonce: realOrderNonce,
      decoyNonces,
      epoch,
      blockNumber: minedBlock,
      submittedAtBlock,
      // Canonical side of the REAL order (per-slot sides are on `reveals`).
      side: realSide,
      // Audit #11: canonical path of the real order for the reveal.
      path_len,
      path: [pathFields[0].toString(), pathFields[1].toString(), pathFields[2].toString()],
      reveals,
    };
  }

  /**
   * Sub-4 browser claim path: redeem a filled order's proceeds via Merkle inclusion
   * proof. Fetches the hop-fill proof from the aggregator (same-origin Vercel proxy
   * `${aggregatorUrl}/proof` by default), then submits the 7-arg claim_fill for each
   * populated hop. This replaces the stale 2-arg stub; the on-chain path (select-by-
   * nonce + verify_merkle_proof_64 + self-call payout) is the one the CLI proved live.
   *
   * `epoch` is optional — the aggregator auto-discovers it from its snapshots.
   * Pass `proof` to skip the network fetch (CLI/tests). claim_fill's payout is a
   * self-call (from==orderbook==msg_sender, nonce 0) needing NO authwit.
   */
  async claimFill(opts: {
    nonce: bigint;
    epoch?: number;
    aggregatorUrl?: string;
    proof?: HopProofResponse;
    hopIndex?: number;
    filterDecoys?: boolean;
  }): Promise<{ txHash: string; txHashes: string[]; claimedHops: number; skipped?: true; reason?: string }> {
    const contracts = requireContracts(this.client);
    const filterDecoys = opts.filterDecoys !== false;
    const nonceHex = new Fr(opts.nonce).toString();
    if (filterDecoys && isDecoy(this.client.address.toString(), nonceHex)) {
      return { txHash: "", txHashes: [], claimedHops: 0, skipped: true, reason: "known decoy (amount_out=0)" };
    }

    // Resolve the hop-fill proof: caller-supplied (CLI/tests) or fetched from the
    // aggregator's GET /proof (default same-origin proxy base "/api").
    const proof =
      opts.proof ??
      (await this.client.aggregator.fetchHopProof(opts.aggregatorUrl ?? "/api", {
        orderNonce: opts.nonce,
        hopIndex: opts.hopIndex,
        epochId: opts.epoch,
      }));
    if (proof.fills.length === 0) {
      throw new OrderError(
        "INVALID_PATH",
        `no fill to claim for nonce ${nonceHex} in epoch ${proof.epoch_id}`,
      );
    }

    const { loadOrderbookContract } = await import("./internal/contracts.js");
    const OrderbookContract = await loadOrderbookContract();
    const orderbook = await OrderbookContract.at(
      AztecAddress.fromStringUnsafe(contracts.orderbook),
      this.client.wallet,
    );
    const orderbookDyn = orderbook as unknown as {
      methods: {
        claim_fill: (
          epochId: number,
          orderNonce: Fr,
          hopIndex: bigint,
          amountOut: bigint,
          poolId: bigint,
          leafIndex: bigint,
          siblingPath: Fr[],
        ) => {
          send: (args: { from: AztecAddress }) => Promise<{
            receipt?: { txHash?: { toString: () => string } };
          }>;
        };
      };
    };

    // Claim each populated hop sequentially (2-hop currently disabled in-circuit →
    // normally a single hop). `.send({from})` is awaited in aztec.js 4.x and the
    // real hash is on `.receipt` (a prior `.wait?.()` was a no-op — see cancelOrder).
    const txHashes: string[] = [];
    for (const leaf of proof.fills) {
      const a = hopProofToClaimArgs(leaf, proof.epoch_id);
      const sendResult = await orderbookDyn.methods
        .claim_fill(a.epochId, a.orderNonce, a.hopIndex, a.amountOut, a.poolId, a.leafIndex, a.siblingPath)
        .send({ from: this.client.address });
      const receipt = (sendResult as { receipt?: { txHash?: { toString: () => string } } }).receipt;
      txHashes.push(receipt?.txHash?.toString() ?? "");
    }
    return { txHash: txHashes[0] ?? "", txHashes, claimedHops: txHashes.length };
  }

  async cancelOrder(opts: { nonce: bigint }): Promise<{ txHash: string }> {
    const contracts = requireContracts(this.client);
    const { loadOrderbookContract } = await import("./internal/contracts.js");
    const OrderbookContract = await loadOrderbookContract();
    const orderbook = await OrderbookContract.at(
      AztecAddress.fromStringUnsafe(contracts.orderbook),
      this.client.wallet,
    );
    // authwit nonce MUST be 0n: cancel_order calls transfer_public_to_private
    // with from=orderbook.address; self-call requires nonce==0 (authorize_once).
    const tx = await orderbook.methods
      .cancel_order(opts.nonce, 0n)
      .send({ from: this.client.address });
    // `.send({from})` is awaited (the cancel tx mines); read the real hash from
    // `.receipt`. The prior `.wait?.()` was a no-op (the resolved result has no
    // `.wait`) that always returned an empty hash. (aztec.js 4.x)
    const receipt = (tx as { receipt?: { txHash?: { toString: () => string } } }).receipt;
    return { txHash: receipt?.txHash?.toString() ?? "" };
  }

  /**
   * Plain epoch advance (no clearing proof).  For the verified path that
   * applies a ZK clearing proof, use `closeEpochVerified`.
   */
  async closeEpoch(_opts: { epoch?: number } = {}): Promise<CurrentEpoch> {
    const contracts = requireContracts(this.client);
    const { loadOrderbookContract } = await import("./internal/contracts.js");
    const OrderbookContract = await loadOrderbookContract();
    const orderbook = await OrderbookContract.at(
      AztecAddress.fromStringUnsafe(contracts.orderbook),
      this.client.wallet,
    );
    await orderbook.methods.close_epoch().send({ from: this.client.address });

    const sim = await orderbook.methods.get_epoch().simulate({ from: this.client.address });
    const epoch = (sim as { result: { epoch_id: bigint; closes_at_block: bigint } }).result;
    return {
      epoch_id: Number(epoch.epoch_id),
      closes_at_block: Number(epoch.closes_at_block),
    };
  }

  /**
   * Verified close-epoch: submits a recursive ZK clearing proof + applies clearing.
   * Inputs are the parsed proof / vk / public-inputs payloads (callers normalize
   * file reads in their own layer).
   */
  async closeEpochVerified(opts: {
    proofFields: Fr[];
    vkFields: Fr[];
    publicInputs: unknown;
  }): Promise<CurrentEpoch> {
    const contracts = requireContracts(this.client);
    const { loadOrderbookContract } = await import("./internal/contracts.js");
    const OrderbookContract = await loadOrderbookContract();
    const orderbook = await OrderbookContract.at(
      AztecAddress.fromStringUnsafe(contracts.orderbook),
      this.client.wallet,
    );
    const orderbookDyn = orderbook as unknown as {
      methods: {
        close_epoch_and_clear_verified: (
          publicInputs: unknown,
          proof: Fr[],
          vk: Fr[],
        ) => { send: (args: { from: AztecAddress }) => { wait?: () => Promise<unknown> } };
      };
    };
    await orderbookDyn.methods
      .close_epoch_and_clear_verified(opts.publicInputs, opts.proofFields, opts.vkFields)
      .send({ from: this.client.address });

    const sim = await orderbook.methods.get_epoch().simulate({ from: this.client.address });
    const epoch = (sim as { result: { epoch_id: bigint; closes_at_block: bigint } }).result;
    return {
      epoch_id: Number(epoch.epoch_id),
      closes_at_block: Number(epoch.closes_at_block),
    };
  }
}

export { Fr };
