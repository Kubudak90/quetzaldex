# Quetzal Frontend Quickstart

Quetzal is a MEV-resistant dark-pool DEX on the Aztec Network. Orders are submitted privately, matched off-chain by a ZK-proved aggregator, and settled on-chain without revealing individual trades. This guide takes you from a fresh clone to placing your first order on testnet in roughly 30 minutes. No prior Aztec knowledge is required.

---

## §1 Install + workspace setup

Clone the repo and install dependencies. Quetzal is a pnpm monorepo — all workspace packages wire automatically.

```bash
git clone https://github.com/your-org/quetzal.git
cd quetzal
pnpm install
```

The SDK lives at `sdk/` and is published to the monorepo workspace as `@quetzal/sdk`. Add it to your own frontend package:

```bash
# inside your frontend package.json
pnpm add @quetzal/sdk
```

Or reference it directly if you are working inside the monorepo:

```json
// package.json
{
  "dependencies": {
    "@quetzal/sdk": "workspace:*"
  }
}
```

---

## §2 Wallet — pick one of three adapters

`QuetzalClient.connect` takes an `AccountSpec` discriminated union. Choose the variant that matches your context.

### A: Schnorr from secret (server-side scripts / CI)

Best for: Node scripts, backend services, automated testing outside the sandbox.

```typescript
import { QuetzalClient } from "@quetzal/sdk";

const client = await QuetzalClient.connect({
  network: "alpha-testnet",
  account: {
    type: "schnorr",
    secret: process.env.AZTEC_PRIVATE_KEY!, // 0x-prefixed 32-byte hex
  },
});
```

Store `AZTEC_PRIVATE_KEY` in your environment; never commit it. The adapter derives a Schnorr key-pair from the raw secret and registers a fresh account if none exists at that address.

### B: External PXE (you manage the PXE + wallet)

Best for: advanced setups where your app already controls a running PXE node and wallet instance.

```typescript
import { QuetzalClient } from "@quetzal/sdk";
import type { Wallet, AztecAddress } from "@aztec/aztec.js";

// wallet + address come from your own PXE / wallet-creation logic
declare const myWallet: Wallet;
declare const myAddress: AztecAddress;

const client = await QuetzalClient.connect({
  network: "alpha-testnet",
  account: {
    type: "external-pxe",
    wallet: myWallet,
    address: myAddress,
  },
});
```

No new PXE is spawned — `QuetzalClient` wraps the wallet you provide.

### C: Aztec Wallet browser provider (production frontend)

Best for: browser apps where the user signs transactions through the Aztec Wallet extension. **Browser context only.**

```typescript
import { QuetzalClient } from "@quetzal/sdk";
import type { AztecBrowserProvider } from "@aztec/aztec.js";

// AztecBrowserProvider is injected by the Aztec Wallet browser extension
declare const provider: AztecBrowserProvider; // e.g. window.aztec

const client = await QuetzalClient.connect({
  network: "alpha-testnet",
  account: {
    type: "aztec-wallet",
    provider,
  },
});
```

The user approves each transaction inside the wallet extension, similar to MetaMask.

### Optional: test-account (sandbox only)

For local sandbox development — uses one of the pre-funded accounts bundled with the sandbox Docker image.

```typescript
const client = await QuetzalClient.connect({
  network: "sandbox",
  account: { type: "test-account", accountIndex: 0 },
});
```

`accountIndex` is 0-based; the sandbox ships with at least 3 pre-funded accounts.

---

## §3 Place your first order

Once the client is connected, placing an order is a single call.

```typescript
import { QuetzalClient, OrderError } from "@quetzal/sdk";

const client = await QuetzalClient.connect({
  network: "alpha-testnet",
  account: { type: "schnorr", secret: process.env.AZTEC_PRIVATE_KEY! },
});

try {
  const result = await client.orders.placeOrder({
    side: "sell",          // "buy" | "sell"
    amount: 1_000_000n,    // base units (bigint) — e.g. 1 tUSDC = 1_000_000n (6 decimals)
    limitPrice: 5_000n,    // worst acceptable execution price in base units
    path: ["tUSDC", "tETH"], // 2-token direct swap; use 3 tokens for a routed hop
  });

  console.log("Order placed!");
  console.log("  txHash :", result.txHash);
  console.log("  nonce  :", result.nonce);
  console.log("  epoch  :", result.epoch);
} catch (e) {
  if (e instanceof OrderError) {
    console.error(`Order failed [${e.code}]:`, e.message);
  } else {
    throw e;
  }
} finally {
  await client.stop();
}
```

**Key fields explained:**

| Field | Type | Notes |
|---|---|---|
| `side` | `"buy" \| "sell"` | Direction relative to the first token in `path` |
| `amount` | `bigint` | Always in base units (no decimal conversion — use `resolveTokenDecimals(alias)` from the SDK if needed) |
| `limitPrice` | `bigint` | Minimum execution price; order is rejected at clearing if market moves past this |
| `path` | `string[]` | 2 or 3 token aliases; valid aliases: `tUSDC`, `aUSDC`, `tETH`, `aWETH`, `tBTC`, `aWBTC` |

`placeOrder` returns `{ txHash, nonce, orderNonce, epoch }`. Save `nonce` and `epoch` — you need them to claim a fill.

**Privacy tip:** For stronger anonymity, use `placeOrderBulk` with decoys. It adds 1–4 dummy notes alongside your real order so an outside observer cannot distinguish which note is genuine:

```typescript
const bulk = await client.orders.placeOrderBulk({
  side: "buy",
  amount: 2_000_000n,
  limitPrice: 4_900n,
  path: ["tUSDC", "tETH"],
  decoyCount: 3, // [0, MAX_DECOYS] — MAX_DECOYS = 4
});
// bulk.realNonce  — your actual order
// bulk.decoyNonces[] — dummy nonces; claimFill skips these automatically
```

> **Note on side + path:** The SDK auto-canonicalizes `path` (lex-sorts endpoints) and flips `side` to preserve semantic intent. This is a privacy mitigation (Sub-6c) -- on-chain observers can't derive direction from path order. Your code stays the same; you don't need to think about it. See [`sdk/README.md`](../sdk/README.md#side-semantics-post-canonical) for the full side-semantics table.

---

## §4 Claim a fill

After the epoch closes and the aggregator posts a clearing proof, you can claim your fill. Pass the `nonce` and `epoch` from the `placeOrder` result.

```typescript
import { QuetzalClient, OrderError } from "@quetzal/sdk";

const client = await QuetzalClient.connect({ /* same as above */ } as any);

// Check when the current epoch closes
const epoch = await client.reads.getCurrentEpoch();
console.log("Epoch closes at block:", epoch.closes_at_block);

// Claim after epoch.closes_at_block has been reached
const claim = await client.orders.claimFill({
  nonce: result.nonce,  // bigint from placeOrder result
  epoch: result.epoch,  // number from placeOrder result
  // filterDecoys: true (default) — skips known decoy nonces automatically
});

if (claim.skipped) {
  // This nonce was a decoy — nothing to claim
  console.log("Skipped:", claim.reason);
} else {
  console.log("Fill claimed, tx:", claim.txHash);
}

await client.stop();
```

`claimFill` is safe to call for decoy nonces — it returns `{ skipped: true, reason: "known decoy (amount_out=0)" }` rather than throwing.

**Cancel before epoch closes:**

```typescript
await client.orders.cancelOrder({ nonce: result.nonce });
```

---

## §5 Bridge deposit (L1 → L2)

> **Operator-script caveat:** `BridgeApi.deposit` is not yet implemented in the SDK — calling it throws `BridgeError` at runtime. Until the SDK implementation ships, use the operator script directly for deposits:
>
> ```bash
> pnpm tsx scripts/testnet-sub5b-bridge.ts --action deposit \
>   --token tUSDC --amount 1000000 --recipient <YOUR_AZTEC_ADDRESS>
> ```
>
> Once messages have landed on L2 (typically 1–3 Aztec blocks after the L1 transaction), call `client.bridge.claim` from your frontend.

After the L1 deposit transaction is confirmed and the message has crossed the bridge, claim the L2 tokens:

```typescript
import { QuetzalClient, BridgeError } from "@quetzal/sdk";
import { Fr } from "@aztec/aztec.js";

const client = await QuetzalClient.connect({ /* ... */ } as any);

try {
  const claimed = await client.bridge.claim({
    token: "tUSDC",
    amount: 1_000_000n,
    isPrivate: true,          // true = credit private note; false = public balance
    secret: Fr.random(),      // must match the secret used in the L1 deposit
    messageIndex: "0x0",      // L2 message index (from operator script output)
  });
  console.log("Claimed on L2:", claimed.l2TxHash);
} catch (e) {
  if (e instanceof BridgeError && e.code === "L1_CLAIM_NOT_READY") {
    // Message hasn't crossed yet — retry after a few blocks
  }
}

await client.stop();
```

**`isPrivate: true`** credits a private Aztec note. **`isPrivate: false`** credits your public balance — visible on-chain.

---

## §6 Bridge exit (L2 → L1)

Withdraw tokens back to Ethereum L1.

```typescript
import { QuetzalClient, BridgeError } from "@quetzal/sdk";

const client = await QuetzalClient.connect({ /* ... */ } as any);

// Single exit
try {
  const exited = await client.bridge.exit({
    token: "tETH",
    amount: 500_000_000_000_000_000n, // 0.5 ETH in wei
    l1Recipient: "0xYourEthereumAddress",
    isPrivate: true,  // spend from private note (default)
    ackRound: true,   // suppress round-amount fingerprint advisory (D2 guard)
    ackDelay: true,   // suppress round-trip correlation warning (C2 guard)
  });
  console.log("Exit initiated:", exited);
} catch (e) {
  if (e instanceof BridgeError && e.code === "OUTBOX_PROOF_MISSING") {
    console.log("Outbox proof not yet available — wait and retry");
  }
}
```

**Split-schedule exit** (privacy-preserving — staggers large withdrawals):

```typescript
const scheduled = await client.bridge.exit({
  token: "tUSDC",
  amount: 10_000_000_000n,
  l1Recipient: "0xYourEthereumAddress",
  splitInto: 5,        // [2, 20] — split into 5 partial exits
  intervalDays: 3,     // [1, 90] — 3 days between each exit
  ackRound: true,
  ackDelay: true,
});
// returns { scheduledExits: ScheduledExit[] }
```

**Process the exit queue** (call periodically, e.g. on page load):

```typescript
const tick = await client.bridge.tick({ autoClaim: true });
console.log(`Processed ${tick.processedCount} scheduled exits`);
```

`tick` advances any exits whose `intervalDays` delay has elapsed and auto-claims L1 side if `autoClaim: true`.

---

## §7 Error handling

All SDK errors extend `QuetzalError` and carry a `code` string for programmatic handling.

```typescript
import {
  QuetzalError,
  OrderError,
  BridgeError,
  ConfigError,
} from "@quetzal/sdk";

try {
  await client.orders.placeOrder({ /* ... */ } as any);
} catch (e) {
  if (e instanceof OrderError) {
    switch (e.code) {
      case "EPOCH_CLOSED":
        // Epoch already closed — wait for next epoch and retry
        break;
      case "INVALID_PATH":
        // Token path is not a registered pool — check client.reads.getPools()
        break;
      case "ESCROW_FAILED":
        // Private escrow note could not be created — check balance or PXE state
        break;
      case "UNKNOWN":
        // Inspect e.message and open an issue
        break;
    }
  } else if (e instanceof BridgeError) {
    switch (e.code) {
      case "L2_TX_FAILED":
        // Aztec transaction reverted — inspect e.message for revert reason
        break;
      case "L1_CLAIM_NOT_READY":
        // Bridge message hasn't crossed yet — retry after a few Aztec blocks
        break;
      case "OUTBOX_PROOF_MISSING":
        // L2→L1 outbox proof not yet generated — wait and retry
        break;
      case "UNKNOWN":
        break;
    }
  } else if (e instanceof ConfigError) {
    switch (e.code) {
      case "MISSING_ENV":
        // Required env var not set (e.g. nodeUrl for mainnet, AZTEC_PRIVATE_KEY)
        break;
      case "UNKNOWN_TOKEN":
        // Token alias not in registry — check §8 for valid aliases
        break;
      case "INVALID_NETWORK":
        // network value is not "alpha-testnet" | "sandbox" | "mainnet"
        break;
      case "UNKNOWN":
        break;
    }
  } else if (e instanceof QuetzalError) {
    // Catch-all for any future QuetzalError subclass
    console.error("Quetzal error:", e.code, e.message);
  } else {
    throw e; // rethrow unexpected errors
  }
}
```

---

## §8 Network selection

| `network` | Default `nodeUrl` | When to use |
|---|---|---|
| `"alpha-testnet"` | `https://node.quetzaldex.xyz` | Shared testnet — use for integration testing and this quickstart (upstream `https://v5.testnet.rpc.aztec-labs.com`) |
| `"sandbox"` | `http://localhost:8080` | Local Docker sandbox — fastest iteration, no real tokens |
| `"mainnet"` | _(none — must supply `nodeUrl`)_ | Production; pass `nodeUrl` explicitly or get `ConfigError("MISSING_ENV")` |

**Override `nodeUrl`** (e.g. point to your own node):

```typescript
const client = await QuetzalClient.connect({
  network: "alpha-testnet",
  nodeUrl: "https://my-custom-rpc.example.com",
  account: { type: "schnorr", secret: process.env.AZTEC_PRIVATE_KEY! },
});
```

**Mainnet** requires explicit `nodeUrl` — see the Sub-5c runbook for mainnet deployment details.

---

## §9 Where to go next

| Resource | What it covers |
|---|---|
| [`sdk/README.md`](../sdk/README.md) | Full API reference — every method, type, and error code |
| `scripts/testnet-sub5b-bridge.ts` | End-to-end L1→L2 deposit + L2→L1 exit operator script |
| `scripts/testnet-*.ts` | Other end-to-end testnet examples (sub3 aggregator, sub4 routing) |
| `LITEPAPER.md` | Protocol architecture and design overview |
| `sdk/src/` | Source of truth for adapter implementations |

**Useful SDK utilities:**

```typescript
import { resolveTokenDecimals, classifyAmount, formatAdvisory } from "@quetzal/sdk";

// Convert human-readable amount → base units
const decimals = resolveTokenDecimals("tUSDC"); // 6
const baseUnits = BigInt(Math.round(1.5 * 10 ** decimals)); // 1_500_000n

// Check if an exit amount looks fingerprint-able before submitting
import { privacy } from "@quetzal/sdk";
const hint = classifyAmount(baseUnits, decimals);
if (hint.classification !== "natural") {
  console.warn(formatAdvisory(hint, decimals, "USDC"));
  // → suggests a rounded amount; consider using hint.suggested instead
}
```

**Need the wallet address?**

```typescript
console.log(client.address.toString()); // AztecAddress hex string
```

**Check LP positions:**

```typescript
const positions = await client.reads.getPositions({ poolId: 0 });
const balance = await client.reads.getBalance("tUSDC");
```

**Always call `client.stop()`** when your component or script is done — it tears down the PXE connection and avoids resource leaks.
