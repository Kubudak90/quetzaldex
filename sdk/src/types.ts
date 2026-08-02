// sdk/src/types.ts

export type OrderSide = "buy" | "sell";

export type NetworkName = "alpha-testnet" | "sandbox" | "mainnet";

export interface QuetzalPoolEntry {
  pool_id: number;
  token_a: string;
  token_b: string;
  address: string;
}

export interface QuetzalContracts {
  orderbook: string;
  tUSDC: string;
  tETH: string;
  tBTC?: string;
  pools: QuetzalPoolEntry[];
  admin?: string;
  aggregatorRegistry?: string;
  treasury?: string;
}

export interface NetworkConfigL1 {
  rpcUrl?: string;
  privateKey?: string;
  makerAddr?: string;
  usdcBridge?: string;
  wethBridge?: string;
  wbtcBridge?: string;
}

export interface NetworkConfig {
  name: NetworkName;
  nodeUrl: string;
  l1?: NetworkConfigL1;
  /**
   * Optional Quetzal protocol deployment metadata.  When present, the SDK
   * APIs (OrdersApi, BridgeApi, ReadsApi, AggregatorApi) can resolve
   * contract addresses + token aliases without the caller passing them on
   * every method call.
   */
  contracts?: QuetzalContracts;
}

export interface ScheduledExit {
  id: string;
  token: string;
  amount: string;
  l1Recipient: string;
  /**
   * H5: the privacy mode requested for this exit. The staggered-exit feature
   * exists to break L2->L1 linkability, so tick() MUST execute a private-requested
   * leg via exit_to_l1_private — dropping this flag silently downgraded every split
   * exit to public. Legacy persisted records lack the field; read as false (public).
   */
  isPrivate: boolean;
  submitAfterUnix: number;
  status: "pending" | "submitted" | "l1_claimable" | "done";
  l2TxHash: string | null;
  l2EpochAtSubmit: number | null;
  createdAtUnix: number;
}

export interface PlaceOrderInput {
  side: OrderSide;
  amount: bigint;
  limitPrice: bigint;
  path: string[];
}

export interface PlaceOrderResult {
  txHash: string;
  nonce: bigint;
  orderNonce: bigint;
  epoch: number;
  blockNumber: number;
  /**
   * The EXACT `submitted_at_block` the orderbook bound into the order's
   * commitment c_i — read back from the on-chain OrderNote after the tx mines.
   * The contract uses `get_anchor_block_header().block_number()` (the tx's ANCHOR
   * block, set at PXE simulation), which is typically 1+ blocks BEFORE the mined
   * block (`blockNumber`/receipt.blockNumber). Reveal producers MUST send THIS
   * value (not blockNumber) as `submitted_at_block`, else the aggregator's
   * order_acc replay mismatches and the order never settles.
   */
  submittedAtBlock: number;
  /**
   * The CANONICAL side bool folded into c_i (false = bid, true = ask), AFTER
   * canonicalizePath may have flipped the caller's requested side for a
   * reverse-lex path. Reveal producers MUST forward THIS (not the raw user side),
   * else the aggregator's order_acc replay mismatches and the order never settles.
   */
  side: boolean;
  /**
   * Audit #11: the canonical routing path bound into the order's commitment c_i
   * (path_len in {2,3}; path is 3 0x-hex token-address words, "0x0" sentinel for
   * the unused 3rd slot on 1-hop orders). Producers MUST forward these into the
   * aggregator reveal so c_i is recomputed against the SAME path the contract
   * bound -- otherwise multi-hop / non-pool-0 orders fail order_acc replay (the
   * aggregator's pool-0 fallback only covers single-pool 1-hop orders).
   */
  path_len: 2 | 3;
  path: [string, string, string];
}

export interface CurrentEpoch {
  epoch_id: number;
  closes_at_block: number;
}

/**
 * Sub-9.3: full epoch state read for the aggregator clearing loop.
 *
 * Mirror of `contracts/orderbook/src/main.nr::EpochState` (subset relevant to
 * off-chain consumers; we drop `state` and `opened_at_block` since they're
 * implied by the open/closing/settled state machine).
 *
 * `order_acc` and `cancel_acc` are returned as 0x-prefixed hex strings so the
 * SDK keeps a single JSON-safe wire shape across boundaries (the aggregator
 * parses them back to `Fr` via `Fr.fromString`).
 */
export interface CurrentEpochFull {
  epoch_id: number;
  closes_at_block: number;
  order_acc: string;       // 0x-prefixed Field hex
  order_count: number;
  cancel_acc: string;      // 0x-prefixed Field hex
  cancel_count: number;
}

export interface BulkPlaceOrderInput extends PlaceOrderInput {
  decoyCount: number;
}

/** One used slot's reveal params (real or decoy). The caller broadcasts EVERY
 * one to the aggregator — the epoch order_acc folds them all, in this exact
 * (order_nonce-sorted) order, so a real-only reveal fails the replay. */
export interface BulkOrderReveal {
  orderNonce: bigint;
  side: boolean;
  amountIn: bigint;
  limitPrice: bigint;
  pathLen: number;
  path: [string, string, string];
}

export interface BulkPlaceOrderResult {
  txHash: string;
  realNonce: bigint;
  decoyNonces: bigint[];
  epoch: number;
  blockNumber: number;
  /** Audit #11: canonical path of the REAL order for the reveal. See PlaceOrderResult. */
  path_len: 2 | 3;
  path: [string, string, string];
  /** EXACT submitted_at_block bound into the real order's c_i (anchor block, read from the OrderNote). See PlaceOrderResult.submittedAtBlock. */
  submittedAtBlock: number;
  /** Canonical side of the REAL order (per-slot sides are on `reveals`). See PlaceOrderResult.side. */
  side: boolean;
  /** All used slots (real + decoys) in submission (order_nonce-sorted) order. Reveal EVERY one. */
  reveals: BulkOrderReveal[];
}
