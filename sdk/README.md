# @quetzal/sdk

Programmatic TypeScript SDK for the Quetzal dark-pool DEX on the Aztec Network.

## Install

```bash
pnpm add @quetzal/sdk
```

In the Quetzal monorepo this is a workspace package; dependencies wire automatically.

## Quick start

```typescript
import { QuetzalClient } from "@quetzal/sdk";

const client = await QuetzalClient.connect({
  network: "alpha-testnet",
  account: {
    type: "schnorr",
    secret: process.env.AZTEC_PRIVATE_KEY!,
  },
});

const result = await client.orders.placeOrder({
  side: "sell",
  amount: 1_234_567n,
  limitPrice: 5_000n,
  path: ["tUSDC", "tETH"],
});

console.log(`order placed, tx ${result.txHash}, nonce ${result.nonce}`);
await client.stop();
```

## Public API

### Client

| Symbol | Type | Description |
|---|---|---|
| `QuetzalClient` | class | Top-level handle — holds wallet, config + 4 lazy API namespaces |
| `QuetzalClient.connect(opts)` | static method | Creates + connects a client; returns `Promise<QuetzalClient>` |
| `client.orders` | `OrdersApi` | Place/claim/cancel orders, bulk submit with decoys |
| `client.bridge` | `BridgeApi` | L1<>L2 bridge: claim, exit, tick |
| `client.reads` | `ReadsApi` | View-only queries (orders, pools, epoch, positions, balance) |
| `client.aggregator` | `AggregatorApi` | Sub-3 aggregator register / unregister / list / broadcastReveal |
| `client.address` | `AztecAddress` | Connected wallet address |
| `client.wallet` | `Wallet` | Underlying Aztec wallet instance |
| `client.config` | `NetworkConfig` | Resolved network config (nodeUrl, contracts, l1) |
| `client.registerContracts()` | method | Register protocol contracts against the wallet PXE; idempotent |
| `client.stop()` | method | Tears down wallet resources |

### QuetzalClientConnectOptions

```typescript
interface QuetzalClientConnectOptions {
  network: NetworkName;         // "alpha-testnet" | "sandbox" | "mainnet"
  account: AccountSpec;
  nodeUrl?: string;             // override; required for "mainnet"
  l1?: NetworkConfigL1;         // optional L1 config for bridge features
  contracts?: QuetzalContracts; // optional deployment metadata; enables auto-registration
}
```

### AccountSpec variants

Pass one of these to `QuetzalClient.connect({ account: ... })`:

```typescript
{ type: "schnorr"; secret: "0x..." }
{ type: "test-account"; accountIndex: number }        // sandbox pre-funded accounts
{ type: "external-pxe"; wallet: Wallet; address: AztecAddress } // bring your own wallet
{ type: "aztec-wallet"; appId?: string }                       // browser extension via @aztec/wallet-sdk discovery (e.g. Celari)
```

### Orders

| Method | Returns |
|---|---|
| `placeOrder(input)` | `{ txHash, nonce, orderNonce, epoch }` |
| `placeOrderBulk(input)` | `{ txHash, realNonce, decoyNonces[], epoch }` |
| `claimFill({ nonce, epoch?, aggregatorUrl?, hopIndex?, filterDecoys?, proof? })` | `{ txHash, txHashes, claimedHops, skipped?, reason? }` |
| `cancelOrder({ nonce })` | `{ txHash }` |
| `closeEpoch({ epoch? })` | `CurrentEpoch` — plain advance, no proof |
| `closeEpochVerified({ proofFields, vkFields, publicInputs })` | `CurrentEpoch` |

`PlaceOrderInput`:

```typescript
interface PlaceOrderInput {
  side: "buy" | "sell";
  amount: bigint;       // base units
  limitPrice: bigint;   // base units
  path: string[];       // 2 or 3 token aliases e.g. ["tUSDC", "tETH"]
}
```

`BulkPlaceOrderInput` extends `PlaceOrderInput` with:

```typescript
{ decoyCount: number }  // in [0, MAX_DECOYS] (MAX_DECOYS = 4, MAX_ORDERS_PER_BULK = 5)
```

`claimFill` skips decoy nonces by default (`filterDecoys` defaults to `true`). Skipped claims return `{ txHash: "", skipped: true, reason: "known decoy (amount_out=0)" }`.

#### Side semantics (post-canonical)

As of Sub-6c, the SDK canonicalizes the `path` array before submitting on-chain. The Noir circuit asserts `path[0] < path[path_len-1]` (lex-sorted endpoints); the SDK auto-reverses + flips `side` when a caller passes a reversed path. This means the on-chain path no longer leaks trade direction.

Post-canonical side semantics:
- `side: "buy"` → maker pays `path[0]` (canonical low), receives `path[path_len-1]` (canonical high)
- `side: "sell"` → maker pays `path[path_len-1]` (canonical high), receives `path[0]` (canonical low)

Backward compat: pass `side` + `path` as you always have; the SDK does the right thing. If you want the canonicalized output directly, use `canonicalizePath(side, path)`.

### Bridge

| Method | Returns |
|---|---|
| `claim({ token, amount, isPrivate, secret?, messageIndex })` | `{ l2TxHash }` |
| `exit({ token, amount, l1Recipient, isPrivate?, splitInto?, intervalDays?, ackRound?, ackDelay?, relayerFee? })` | `{ l2TxHash }` OR `{ scheduledExits: ScheduledExit[] }` |
| `tick({ autoClaim? })` | `{ processedCount }` |

`BridgeClaimInput`:

```typescript
{
  token: string;          // "tUSDC" | "aUSDC" | "tETH" | "aWETH" | "tBTC" | "aWBTC"
  amount: bigint;
  isPrivate: boolean;
  secret?: Fr | string;   // required when isPrivate = true
  messageIndex: Fr | string;
}
```

`BridgeExitInput`:

```typescript
{
  token: string;
  amount: bigint;
  l1Recipient: string;    // 0x-prefixed 20-byte L1 address
  isPrivate?: boolean;    // default true
  splitInto?: number;     // [2, 20] — triggers split-schedule path
  intervalDays?: number;  // [1, 90] — stagger between split exits
  ackRound?: boolean;     // set true to suppress round-amount advisory
  ackDelay?: boolean;     // set true to suppress round-trip-detection warning
  relayerFee?: bigint;    // optional fee queued on Treasury (Sub-5c)
}
```

> **Note on `deposit`:** L1→L2 deposit currently flows through the operator script
> `scripts/testnet-sub5b-bridge.ts`. `BridgeApi.deposit` throws `BridgeError` at runtime —
> use the script for testnet deposits until the SDK implementation ships.

> **Privacy guards:** `exit` runs two automatic checks before submitting. A round-number
> amount fingerprint check (D2) throws unless `ackRound: true`. A round-trip correlation
> check (C2) throws unless `ackDelay: true`. Both are opt-in overrides, not hard blocks.

### Reads

| Method | Signature | Returns |
|---|---|---|
| `getOrders()` | `() => Promise<OrderViewModel[]>` | Resting orders for the connected account |
| `getPools()` | `() => Promise<PoolViewModel[]>` | Configured pool registry (pure-config, no PXE call) |
| `getCurrentEpoch()` | `() => Promise<CurrentEpoch>` | `{ epoch_id, closes_at_block }` |
| `getPositions(opts?)` | `({ poolId?: number }) => Promise<PositionViewModel[]>` | LP positions in a pool (default pool_id 0) |
| `getBalance(token)` | `(string) => Promise<bigint>` | Public token balance; for private balances use the wallet PXE directly |

`OrderViewModel`:

```typescript
{ nonce: bigint; side: boolean; amount_in: bigint; limit_price: bigint; submitted_at_block: bigint }
```

`PoolViewModel`:

```typescript
{ pool_id: number; token_a: string; token_b: string; address: string }
```

`PositionViewModel`:

```typescript
{
  bucket_id: number;
  nonce: bigint;
  lp_share: bigint;
  cum_fee_a_per_share_at_deposit: bigint;
  cum_fee_b_per_share_at_deposit: bigint;
}
```

### Aggregator (Sub-3)

| Method | Signature | Returns |
|---|---|---|
| `register({ url })` | URL hashed with Poseidon2 on-chain | `{ txHash, endpointHash }` |
| `unregister()` | | `{ txHash }` |
| `list()` | | `AggregatorEntry[]` |
| `broadcastReveal({ payload, manifest })` | POST reveal payload to each bonded aggregator | `{ pushed, skipped }` |

`broadcastReveal` params:

```typescript
{
  payload: Record<string, unknown>;   // reveal JSON body (Sub-3 schema)
  manifest: Record<string, string>;   // aggregator addrHex → URL map
}
```

`AggregatorEntry`:

```typescript
{ id: number; address: string; endpointHash: string }
```

Also exported: `hashUrl(url: string): Promise<Fr>` — Poseidon2 hash of a URL string; mirrors the on-chain registration hash.

### Privacy modules

```typescript
import { privacy } from "@quetzal/sdk";
// OR cherry-pick by name:
import { classifyAmount, isDecoy, queryRecentDeposits, buildSplitSchedule } from "@quetzal/sdk";
```

| Function | Description |
|---|---|
| `classifyAmount(amount, decimals, tolerancePct?, precisionDigits?)` | Amount-pattern fingerprint heuristic; returns `HeuristicResult` with `classification` + `suggested` |
| `formatAdvisory(result, decimals, ticker)` | Human-readable advisory string for a `HeuristicResult` |
| `isDecoy(walletAddrHex, nonceHex)` | Local decoy registry lookup — true only for explicitly recorded decoy nonces |
| `recordDecoyBatch(walletAddrHex, entries)` | Merge `{nonce, isDecoy}[]` entries into the maker-local JSON registry |
| `loadDecoyRegistry(walletAddrHex)` | Load the raw decoy registry map from `~/.quetzal/` |
| `listDecoys(walletAddrHex)` | List all nonce strings recorded as decoys |
| `queryRecentDeposits(l1RpcUrl, bridgeAddrs, maker, windowDays)` | Bridge round-trip detector — L1 DepositInitiated event query |
| `isRoundTripRisk(exitAmount, records, tolerancePct?)` | True if exit amount matches a recent deposit within tolerance |
| `buildSplitSchedule(token, total, l1Recipient, splitInto, intervalDays)` | Multi-hop exit scheduler; returns `ScheduledExit[]` |
| `loadBridgeState()` | Load scheduled-exit state from `~/.quetzal/bridge-state.json` |
| `saveBridgeState(state)` | Persist bridge state |
| `resolveTokenDecimals(alias)` | Resolve decimals for tUSDC/aUSDC/tETH/aWETH/tBTC/aWBTC |

`AmountClassification`: `"round_unit" | "round_tenth" | "round_decimal" | "natural"`

### Wallet adapters

```typescript
import {
  SchnorrSecretAdapter,
  ExternalPxeAdapter,
  AztecWalletAdapter,
  TestAccountAdapter,
} from "@quetzal/sdk";
import type { WalletAdapter } from "@quetzal/sdk";
```

Four concrete `WalletAdapter` implementations. Each is constructed by `QuetzalClient.connect` automatically from the `AccountSpec` discriminant — you typically don't need to instantiate them directly.

### Utility exports

```typescript
import { randomField, parseField } from "@quetzal/sdk";      // field arithmetic helpers
import { computeWithdrawContent } from "@quetzal/sdk";        // sha256-content hash for relayer queue
import { NETWORK_DEFAULTS } from "@quetzal/sdk";             // nodeUrl defaults per network
import { VERSION } from "@quetzal/sdk";                      // "0.1.0"
```

Validators (re-exported for CLI / tooling use):

```typescript
import { validatePlaceOrderInput, validateBulkInput } from "@quetzal/sdk";
import { validateBridgeExitInput } from "@quetzal/sdk";
import { MAX_ORDERS_PER_BULK, MAX_DECOYS } from "@quetzal/sdk";
```

### Errors

```typescript
import { QuetzalError, OrderError, BridgeError, ConfigError } from "@quetzal/sdk";

try {
  await client.bridge.exit({ ... });
} catch (e) {
  if (e instanceof BridgeError && e.code === "OUTBOX_PROOF_MISSING") {
    // wait longer + retry
  }
}
```

Error codes:
- `OrderError`: `"EPOCH_CLOSED"` | `"INVALID_PATH"` | `"ESCROW_FAILED"` | `"UNKNOWN"`
- `BridgeError`: `"L2_TX_FAILED"` | `"L1_CLAIM_NOT_READY"` | `"OUTBOX_PROOF_MISSING"` | `"UNKNOWN"`
- `ConfigError`: `"MISSING_ENV"` | `"UNKNOWN_TOKEN"` | `"INVALID_NETWORK"` | `"UNKNOWN"`

All three extend `QuetzalError extends Error` with a `code: string` property.

## Networks

| Network | Default `nodeUrl` | Notes |
|---|---|---|
| `"alpha-testnet"` | `https://node.quetzaldex.xyz` | Aztec alpha-testnet (browser-safe proxy; upstream is `https://v5.testnet.rpc.aztec-labs.com`) |
| `"sandbox"` | `http://localhost:8080` | Local docker sandbox |
| `"mainnet"` | _(none)_ | Pass `nodeUrl` explicitly; see Sub-5c runbook |

For `"mainnet"`, `nodeUrl` is required in `QuetzalClientConnectOptions` — `QuetzalClient.connect` throws `ConfigError("MISSING_ENV")` if it is absent.

## Type exports

All types are exported as TypeScript type-only exports and can be imported from `@quetzal/sdk`:

`AccountSpec`, `QuetzalClientConnectOptions`, `OrderSide`, `NetworkName`, `NetworkConfig`, `NetworkConfigL1`, `QuetzalContracts`, `QuetzalPoolEntry`, `PlaceOrderInput`, `PlaceOrderResult`, `BulkPlaceOrderInput`, `BulkPlaceOrderResult`, `CurrentEpoch`, `ScheduledExit`, `BridgeDepositInput`, `BridgeDepositResult`, `BridgeClaimInput`, `BridgeExitInput`, `BridgeTickInput`, `OrderViewModel`, `PoolViewModel`, `PositionViewModel`, `AggregatorEntry`, `WalletAdapter`

## License

(project license)
