// sdk/src/index.ts
// @quetzal/sdk — programmatic API for the Quetzal dark-pool DEX on Aztec.

export { QuetzalClient } from "./client.js";
export type { AccountSpec, QuetzalClientConnectOptions } from "./client.js";

export {
  OrdersApi,
  MAX_ORDERS_PER_BULK,
  MAX_DECOYS,
  validatePlaceOrderInput,
  validateBulkInput,
  canonicalizePath,
  hopProofToClaimArgs,
} from "./orders.js";
export type { ClaimFillArgs } from "./orders.js";

export { BridgeApi, validateBridgeExitInput } from "./bridge.js";
export { ReadsApi } from "./reads.js";
export { FeesApi, type FeeJuiceClaim } from "./fees.js";
export { AggregatorApi, hashUrl } from "./aggregator.js";
export {
  PoolsApi,
  PoolError,
  computeDeposit,
  computeBucketBounds,
  computeAllBucketBounds,
  depositRegime,
} from "./pools.js";

export type {
  OrderSide,
  NetworkName,
  NetworkConfig,
  NetworkConfigL1,
  QuetzalContracts,
  QuetzalPoolEntry,
  PlaceOrderInput,
  PlaceOrderResult,
  BulkPlaceOrderInput,
  BulkPlaceOrderResult,
  BulkOrderReveal,
  ScheduledExit,
  CurrentEpoch,
  CurrentEpochFull,
} from "./types.js";

export type {
  BridgeDepositInput,
  BridgeDepositResult,
  BridgeClaimInput,
  BridgeExitInput,
  BridgeTickInput,
  PrepareL1WithdrawInput,
  PrepareL1WithdrawResult,
} from "./bridge.js";

export type { OrderViewModel, PoolViewModel, PositionViewModel } from "./reads.js";
export type { AggregatorEntry, HopProofLeaf, HopProofResponse } from "./aggregator.js";
export type {
  PoolState,
  BucketState,
  PositionView,
  DepositInput,
  DepositResult,
  WithdrawInput,
  WithdrawResult,
  DepositEstimate,
  DepositRegime,
} from "./pools.js";

export {
  QuetzalError,
  OrderError,
  BridgeError,
  ConfigError,
} from "./errors.js";

export { resolveTokenDecimals, NETWORK_DEFAULTS } from "./config.js";

// Wallet adapters — exported here for convenience; also reachable via wallet/* sub-paths.
export type { WalletAdapter } from "./wallet/adapter.js";
export { SchnorrSecretAdapter } from "./wallet/schnorr.js";
export { ExternalPxeAdapter } from "./wallet/pxe.js";
export { AztecWalletAdapter } from "./wallet/aztec-wallet.js";
export { TestAccountAdapter } from "./wallet/test-account.js";
export { WalletPool, PXE_TAGGING_CAP, deriveChildSecret } from "./wallet/pool.js";
export type { WalletPoolOptions } from "./wallet/pool.js";

// Utility surface (re-exported so CLI / front-end can drop the local copies)
export { randomField, parseField } from "./util/field.js";
export { computeWithdrawContent, computeL2ToL1MessageLeaf } from "./util/sha256-content.js";
export { resolveOutboxScope } from "./bridge.js";
export {
  buildOutboxProof,
  OutboxProofShapeError,
  OutboxProofNotReadyError,
} from "./util/outbox-proof.js";
export type { OutboxProof, OutboxL1Source, OutboxMessageScope } from "./util/outbox-proof.js";

// Privacy sub-modules — convenient namespace import
export * as privacy from "./privacy/index.js";

export const VERSION = "0.1.0";
