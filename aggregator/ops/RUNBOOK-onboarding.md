# RUNBOOK — Quetzal Frontend Onboarding (Sub-7b)

## What this covers

The browser-side wizard that funds + deploys N child wallets for a new visitor
of quetzaldex.xyz. Consumes Sub-7a faucet, runs entirely client-side.

## Operator smoke test (per release)

```bash
# 1. Clear localStorage in a fresh browser tab
#    DevTools → Application → Storage → Clear site data

# 2. Verify the public faucet is healthy:
curl -s https://faucet.quetzaldex.xyz/api/health | jq '.status'
# Expected: "ok"

# 3. Run the wizard:
#    Open https://quetzaldex.xyz → Set up wallet → WalletPool → generate master
#    → N=3 → watch ~5-10 min

# 4. Confirm landing at /trade with WalletPool connected:
#    - URL shows /trade
#    - Header shows 3 wallets in dropdown
#    - /wallet route shows 3 child cards with non-zero balances
```

## Failure modes

| Symptom in wizard | Diagnosis | Fix |
|---|---|---|
| One child shows "Rate-limited" | Per-IP cap (4/8h) hit by this IP within window | Use different IP or wait |
| All children stuck on "Dripping fee-juice" >5min | Sub-7a /api/drip pipeline slow (Aztec testnet RPC flakiness) | Check `curl -s https://faucet.quetzaldex.xyz/api/health`; if degraded, contact operator |
| All children stuck on "Reading L1→L2 message" | Aztec sequencer not yet ingested the bridge tx | Wait — claim-deploy retries every 30s for 30min |
| "Drained" error | Operator balances low | `ssh root@161.97.110.1 'curl -s http://localhost:3130/api/health'` — top up per RUNBOOK-faucet.md |
| `localStorage` corrupt → wizard re-runs forever | Schema mismatch or bad data | DevTools → Application → Storage → Clear site data |

## Re-onboarding (after master change)

The wizard reads localStorage on mount and skips straight to /trade when found.
To force a new onboarding for testing:

```js
// DevTools Console:
localStorage.removeItem("quetzal-onboarded-v1");
location.reload();
```
