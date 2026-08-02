# RUNBOOK — Quetzal Bridge UI (Sub-7c)

## What this covers

The browser-side L1↔L2 bridge UI at https://quetzaldex.xyz/bridge.
Consumes Sub-5b/5c TokenBridge contracts on Sepolia + the Sub-7c SDK additions
(`BridgeApi.deposit`, `getMessageReady`, `prepareL1Withdraw`, `util/outbox-proof`).

## Operator smoke test (per release)

Steps for the operator to walk through after each Sub-7c deploy.

1. Connect Aztec WalletPool via Sub-7b wizard (if not already onboarded).
2. Click 'Connect L1' in the top bar → MetaMask popup → approve.
3. Switch MetaMask to Sepolia. Ensure ≥ 0.005 Sepolia ETH for gas.
4. Deposit flow:
   - Bridge → Deposit → choose aUSDC → enter 1000 USDC → submit
   - MetaMask approve tx (signs)
   - MetaMask deposit tx (signs)
   - Wait ~3-15 min for L1→L2 message
   - Bridge → Claim → row should flip from 'Waiting' → 'Ready'
   - Click Claim → L2 tx confirms → row removed
5. Exit flow:
   - Bridge → Exit → choose aUSDC → enter 500 USDC → l1Recipient → submit
   - L2 tx confirms → row added to 'Pending L1 withdraws' panel below the form
   - Wait ~30-90 min for Aztec epoch finalisation on L1
   - Row flips to 'Ready' → click 'Withdraw on L1' → MetaMask sign
   - L1 receipt → row marked 'Complete'

## Failure modes

| Symptom | Diagnosis | Fix |
|---|---|---|
| 'Connect L1' button doesn't open MetaMask | MetaMask not installed or blocked | Install MetaMask, refresh |
| Deposit reverts: "ERC20: insufficient allowance" | Approval tx never landed | Retry; MetaMask may have dropped the first tx |
| Claim row stays 'Waiting' >30 min | Aztec sequencer behind | Check faucet.quetzaldex.xyz/api/health; if degraded, wait |
| ExitTab withdraw row stays 'pending' >2h | Aztec epoch not yet proven on L1 | Wait — Aztec epochs prove every ~30-90 min on testnet |
| 'Withdraw on L1' tx reverts | Stale outbox path (epoch unproven again) | Refresh page; if persistent, capture revert reason + escalate |
| Toast: "unknown token alias" | Pre-Sub-7c D2 deploy still serving | Verify deploy ≥ b6e7df9; clear cache |

## Re-doing onboarding

Wizard reads localStorage and skips to /trade once an onboarding session is
saved. To force re-onboard:

```js
// DevTools console:
localStorage.removeItem("quetzal-onboarded-v1");
localStorage.removeItem("quetzal-pending-claims");
localStorage.removeItem("quetzal-pending-withdraws");
location.reload();
```

## Validation runs

| Date | Sub | Script | Results doc | Verdict |
|---|---|---|---|---|
| 2026-05-28 | 8.3 | `scripts/testnet-bridge-e2e.ts` | [sub8-3-bridge-e2e-results.md](./sub8-3-bridge-e2e-results.md) | _see results doc_ |

`scripts/testnet-bridge-e2e.ts` is the canonical resume-safe round-trip
runner (deposit → claim → exit → outbox-proof → L1 withdraw). Rerun it
after every Sub-7c-touching contract or SDK change. State file
(`testnet-bridge-e2e-state.json`) is gitignored — delete to start fresh.

## Known carry-forwards (Sub-7d)

- Token-alias normalisation now accepts UI ids ("USDC"/"WETH"/"wBTC") + t*/a* aliases, but new tokens require an SDK update.
- bridge.tsx is over 1000 lines; consider splitting into per-tab files.
- The split-into-N scheduled exit path does not yet auto-add pending-withdraw rows on tick.
- Hardcoded `chain: sepolia` in SDK deposit/withdraw calls; mainnet requires a derive-from-l1Wallet.chain refactor.
- L1 nonce drift on parallel drips (Sub-7d carry Task #376).
