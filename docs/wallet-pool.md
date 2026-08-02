# Quetzal WalletPool -- N-wallet HD pool for high-throughput makers

Aztec PXE caps unfinalised private submits at approximately 20 per wallet. For a maker who submits orders rapidly (UI-driven trading, batch-with-decoys flows, market-making), this becomes a hard stall after ~4 Sub-6a bulk batches (K=5) or ~20 single-order submissions.

`WalletPool` distributes submissions across N HD-derived child wallets, giving you ~N × 18 capacity (the SDK uses `PXE_TAGGING_CAP = 18`, 2 below Aztec's ~20 for a safety buffer).

## Quick start

```typescript
import { WalletPool } from "@quetzal/sdk";

const pool = await WalletPool.fromMaster({
  masterSecret: process.env.QUETZAL_MASTER_SECRET!, // 0x-prefixed hex32 root
  n: 5,                                              // pool size (1-20)
  network: "alpha-testnet",
});

// Use any of the N wallets transparently
const client = pool.next();
await client.orders.placeOrder({ side: "sell", amount: 1_000_000n, /* ... */ });

// Or pin related ops to the same wallet (placement + claim)
const tradingClient = pool.acquireFor("epoch-42-trade");
const order = await tradingClient.orders.placeOrder({ /* ... */ });
await tradingClient.orders.claimFill({ nonce: order.nonce, epoch: order.epoch });

// When done
await pool.stop();
```

## HD derivation

Children are derived deterministically:

```
childSecret_i = sha256(masterSecret_bytes || u32_be(i))   (top 2 bits masked to fit bn254 field)
```

The same `masterSecret` + same `n` regenerates the same N child addresses across sessions. Store `masterSecret` in browser SecureStorage / OS keyring; do NOT commit it.

## Fee-juice topup

**Each child wallet needs its own fee-juice balance.** The SDK does NOT sponsor fees. Path per network:

- **Alpha-testnet:** drip from `https://faucet.quetzaldex.xyz` once per child address. Faucet enforces a per-IP cooldown (~6 hours). Plan accordingly: drip all N wallets up-front, OR rotate IP for back-to-back drips.
- **Mainnet:** self-fund each child via standard L1->L2 fee-juice flow or sponsored paymaster (out of SDK scope; integrator's responsibility).

## Saturation

When all N children hit `PXE_TAGGING_CAP=18`, `pool.next()` throws:

```typescript
try {
  const client = pool.next();
  await client.orders.placeOrder(/* ... */);
} catch (e) {
  if (e instanceof Error && e.message.includes("WalletPoolExhausted")) {
    // wait ~6-10s for testnet finalization OR grow pool
    showUiToast("Trading paused: waiting for confirmations...");
  } else {
    throw e;
  }
}
```

Recovery options:
1. Wait for finalization (testnet: ~6-10s; mainnet: depends on epoch length)
2. Grow pool (create a new `WalletPool` with larger `n` -- same `masterSecret` gets a stable address set; previously-funded children re-appear)
3. Adjust UX (rate-limit submissions to match available capacity)

## Capacity guide

| `n` | Theoretical capacity (unfinalised slots) | Fee-juice cost (testnet drips) |
|---|---|---|
| 1  | 18  | 1x |
| 3  | 54  | 3x |
| 5  | 90  | 5x |
| 10 | 180 | 10x |
| 20 | 360 | 20x (faucet rate-limit makes this multi-day) |

Default recommendation: `n = 3` (conservative, fits within a single 8-hour faucet window if back-to-back drips are spaced).

## Frontend integration pattern

```typescript
// One pool per session; persist `masterSecret` in SecureStorage
const masterSecret = await getOrCreateMasterSecret();
const pool = await WalletPool.fromMaster({
  masterSecret,
  n: 3,
  network: "alpha-testnet",
});

// Bind to user actions
function onPlaceOrder(side: "buy" | "sell", amount: bigint /* ... */) {
  return pool.next().orders.placeOrder({ /* ... */ });
}

// Read aggregated balances for UI
const totalUsdc = await pool.getAggregatedBalance("tUSDC");
```

## Limitations

- **Per-IP faucet cooldown** caps how fast you can spin up new child wallets on testnet
- **No auto-rebalance** between children -- if one child has more aUSDC than others, the pool doesn't move funds around
- **Read aggregation is best-effort** -- `getAllOrders()` queries all children in parallel; if one PXE is slow, the call blocks on the slowest

## See also

- [`AUDIT.md` T-17](../contracts-l1/AUDIT.md) -- pool exhaustion threat model
- [Sub-6c design spec](./superpowers/specs/2026-05-24-quetzal-subproject-06c-trade-direction-walletpool-design.md)
