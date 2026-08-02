# Quetzal Litepaper

**A private dark-pool exchange with ZK-verified batch clearing, built on Aztec.**

*Version 0.1 — June 2026 · Live on Aztec alpha-testnet at [quetzaldex.xyz](https://quetzaldex.xyz)*

---

## Abstract

Quetzal is a decentralized exchange in which **order flow is private until the moment it can no longer be exploited**. Traders commit hidden orders into epoch-based batches on Aztec's private L2; a permissionless aggregator network discovers a single uniform clearing price per epoch against concentrated-liquidity pools; and a zero-knowledge circuit proves — on-chain, before any funds move — that the clearing was computed honestly from exactly the orders that were committed. Nobody, including the aggregator, can front-run, sandwich, or selectively censor what they cannot see or forge.

Quetzal is live on Aztec alpha-testnet with the full pipeline validated end-to-end on chain: hidden order submission, multi-pool price discovery, ZK proof generation, verified settlement with conservation checks, and the maker redeeming the proven fill.

---

## 1. The problem: public order flow is a tax

On transparent venues every pending order is a billboard. The mempool reveals intent before execution, and an entire extraction industry — front-running, sandwiching, selective inclusion — prices that information against the trader. "MEV protection" products mostly relocate trust: a private relay sees your flow instead of the public, and you must trust it not to act on what it sees.

Two properties are needed simultaneously and rarely delivered together:

1. **Pre-trade privacy** — nobody can act on an order before it executes, because nobody can see it.
2. **Verifiable execution** — when execution happens, it is *provably* faithful to the hidden orders, so privacy cannot become a cover for operator cheating.

Quetzal's thesis: batch auctions give you fairness, ZK proofs give you verifiability, and a privacy-native L2 gives you hiding — combine all three and the trust gap closes.

## 2. Protocol overview

A trade on Quetzal moves through four stages:

```
 trader                 orderbook (L2)            aggregator             pools (L2)
   │  commit c_i ──────────► epoch N                  │                     │
   │  reveal (off-chain) ─────────────────────────────►                     │
   │                        epoch N closes            │                     │
   │                            │   replay + clear + ZK prove               │
   │                            ◄── close_epoch_and_clear_verified ─────────┤
   │  claim fill ◄──────────────┘   (proof verified on-chain,               │
   │                                 reserves updated, conservation checked)│
```

1. **Commit.** The trader's wallet submits a hiding commitment of the order into the current epoch of the on-chain orderbook. The chain learns only that *an* order exists — not its side, size, price, or owner.
2. **Reveal — to the aggregator only.** The order's plaintext is sent off-chain to bonded aggregators. The public still sees nothing.
3. **Clear.** When the epoch closes, the aggregator computes one uniform clearing price per pool from the batch's aggregate demand crossed against concentrated AMM liquidity, then generates a ZK proof of that computation.
4. **Settle.** A single on-chain transaction verifies the proof against a pinned verification key, replays the order commitments, applies the per-bucket reserve deltas, and enforces conservation. Traders claim fills at the proven price.

There is no continuous order matching, no resting public book, and no per-order execution to reorder. Within an epoch, **everyone trades at the same price** — the canonical defense against ordering games.

## 3. Architecture

### 3.1 Commit-reveal orderbook

The orderbook contract maintains epochs of fixed block length. Submitting an order folds a **hiding commitment** into a running Poseidon accumulator:

```
c_i  = poseidon2(owner, side, amount_in, limit_price, order_nonce,
                 submitted_at_block, path_len, path)
acc' = poseidon2(acc, c_i)
```

The accumulator binds the *exact multiset and order* of committed orders. At clearing time, the revealed orders must replay to the same accumulator — an aggregator cannot drop, inject, or mutate a single order without the replay (and the circuit, which re-derives the accumulator from its public inputs) failing.

Orders bind their **routing path** (token pair / hop) into the commitment, so an order for one pool cannot be redirected to another. Wallets may pad submissions with **decoy orders** (bulk submission, unfillable limit prices) so even the *count* of real orders is obscured.

Token escrow happens at commit time via Aztec's private token notes — funds move from the trader's private balance into the orderbook escrow without revealing amounts publicly.

### 3.2 Permissionless aggregator network (DAR)

Aggregators are not appointed; they **register and bond**. The `AggregatorRegistry` contract escrows a bond and stores a hash of the aggregator's reveal endpoint. Wallets discover live aggregators by enumerating the registry, verifying each registered endpoint hash against a URL manifest, and broadcasting reveals to every bonded endpoint.

The design separates *liveness* trust from *correctness* trust:

- **Correctness requires no trust.** The accumulator replay plus the clearing circuit make a dishonest clear unprovable, and the contract rejects anything unproven. This is not theoretical — the live deployment's adversarial acceptance suite confirms that fabricated pool states, mis-pointed pool ids, and mismatched aggregate flows each revert on-chain with their exact designed error messages.
- **Liveness is open competition.** Any party can bond, run the open-source daemon, and clear epochs. If one aggregator censors or stalls, another can clear the same epoch — reveals are broadcast to all of them.

What an aggregator *does* learn is the plaintext of revealed orders for the epochs it serves. It cannot act on that knowledge inside the protocol (uniform price, provable inclusion), and the bond creates a slashing surface for future protocol versions.

### 3.3 Batch clearing over concentrated liquidity

Each trading pair has an on-chain **concentrated-liquidity pool**: 16 geometric price buckets above a configured floor price, each holding its own reserves and liquidity, with a global sqrt-price tracking the active bucket — a compact, circuit-friendly variant of the familiar tick-based CLMM design.

Price discovery asks one question: **at what price does the batch's net demand exactly match what the pool will absorb?** For a candidate price *p*, the engine nets all eligible orders (asks with limit ≤ *p*, bids with limit ≥ *p*) into a single net flow, then traces that flow through the bucket structure — walking the sqrt-price across bucket boundaries exactly as the on-chain contract would — to determine the pool's response. A guarded search over a bounded price band converges to the clearing price *p\**; orders that don't cross at *p\** simply don't fill and their escrow carries to the next epoch.

Multi-pool epochs clear **all active pools in one settlement**: each order routes to the pool its committed path designates, every pool gets its own price discovery, and one proof covers the joint outcome. The first live multi-pool settlement (3 pools, 3 fills, one transaction) was validated on testnet on 2026-06-10.

LPs earn fees through per-share fee accumulators (`cum_fee_per_share`) tracked per bucket — deposit into a bucket, accrue fees in both tokens proportional to liquidity share, withdraw with accumulated fees.

### 3.4 ZK-verified settlement

The clearing computation is expressed as a Noir circuit and proven with UltraHonk. The circuit's public inputs bind:

- the epoch's order accumulator (so the proof speaks for exactly the committed orders),
- the pools' before-state commitments (so the proof speaks for the real reserves),
- the clearing price(s), per-order fills, and per-bucket reserve deltas.

`close_epoch_and_clear_verified` verifies the proof against a **pinned verification key** and then applies the deltas — with an additional, independent on-chain check: **flow binding**. The aggregate token flows in and out of each pool must equal the sum of the per-bucket deltas the proof committed to (`a_to_pool == Σ reserve_a_add`, etc.). Even a valid-looking proof cannot move funds that don't reconcile. Conservation was verified live: after settlement, each pool's aggregate reserves equal the sum of its bucket reserves exactly.

Traders then claim fills privately; the payout is the circuit-proven `payout_at_price` — not a number the aggregator gets to choose.

### 3.5 Operational self-healing

Running a privacy DEX against a young L2 taught us that correctness guarantees must extend to *operations*. The deployment ships with battle-tested guards, each born from a real incident on testnet:

- **Anchor-drift repair.** Reveal metadata can drift when L2 reorgs stall private-state sync. The daemon searches bounded corrections and accepts only a combination that the on-chain accumulator confirms — self-healing without weakening the trust model.
- **Fee pre-flight.** Settlement is gated on the fee-payer's balance *before* the reveal queue is consumed, so a broke operator wallet delays clearing instead of stranding orders.
- **Race-free keep-alive.** Empty expired epochs are auto-rolled to keep the book open, with an in-flight guard so keep-alive can never race an active clearing.
- **Independent watchdog.** An external health-watch alerts on stuck epochs, failed rolls, fee drain, and faucet stock — silence is treated as a failure mode, not as success.

## 4. Privacy model

| Information | Who sees it |
|---|---|
| Order existence (commitment) | Public (on-chain), unlinkable to content |
| Order content (side, size, price, owner) | Trader + bonded aggregators, only after reveal |
| Trader balances / escrow amounts | Private (Aztec notes); owner only |
| Number of real orders in an epoch | Obscured by decoys (public sees total incl. decoys) |
| Clearing price, aggregate per-pool flows | Public at settlement |
| Individual fill amounts | Private claim; payout proven by circuit |

**Trust assumptions, stated plainly.** Quetzal does not pretend the aggregator is blind: it sees revealed plaintext for the epochs it clears, in exchange for which the protocol makes that knowledge *unusable* inside the system (uniform price, accumulator-bound inclusion, proof-gated settlement). External collusion (an aggregator leaking flow to an off-protocol actor) is mitigated by aggregator competition and bonding, and is the target of further hardening (threshold-encrypted reveals) on the roadmap. Aztec itself provides the privacy substrate: private execution, note encryption, and client-side proving.

## 5. Bridged assets and fees

**Hybrid bridged tokens.** Testnet assets (tUSDC, tETH, tBTC) are hybrid: mintable for testing *and* bridgeable from Sepolia L1 through audited UUPS bridge contracts (per-token TVL caps, governance and emergency-pause timelocks, deposit→claim flow with secret-hash binding). The same token contracts are the trading assets — no wrapper hop between bridging and trading.

**Fee juice.** Aztec transactions are paid in fee juice bridged from L1. The Quetzal faucet provisions new users in one request: test tokens minted directly to the recipient plus a fee-juice claim that an onboarding wallet redeems automatically — solving the "need gas to get gas" cold-start without custodial workarounds.

**Protocol fees.** Pool swap fees accrue to LPs via per-share accumulators; a treasury contract receives the protocol's share. Fee parameters are deploy-time configuration.

## 6. What is live and what is validated

Running now on Aztec alpha-testnet (`quetzaldex.xyz`):

- **App** — onboarding wizard (wallet + faucet + fee-juice claim), private trading UI, bridge UI (USDC/WETH), LP and history views; responsive down to phone widths.
- **Protocol** — orderbook with epochs + accumulator; 3 concentrated pools (USDC/ETH, USDC/BTC, ETH/BTC); aggregator registry with one bonded aggregator; clearing daemon with multi-pool support.
- **Faucet** — public drip page with reCAPTCHA v3, per-IP and daily caps, claim-package download.
- **Validated on-chain** (not simulated — live testnet transactions):
  - the **complete lifecycle in one run** — order placed, revealed, cleared, and the fill redeemed by its maker via `claim_fill` against the on-chain fills root, with the private balance moving by exactly the proven `amount_out`;
  - first honest settle-with-fills, and later the first **multi-pool** settlement (3 pools / 3 fills / one proof);
  - flow-binding conservation after settlement, cross-checked against the pool's own reserve deltas;
  - adversarial acceptance: fabricated pool state, wrong pool id, and mismatched flows all revert with exact errors;
  - L1↔L2 bridge deposit and claim with on-chain balance deltas;
  - faucet drip end-to-end through the public page.

**Known limitations, honestly.**

- Single bonded aggregator today (the network is permissionless; competition is configuration, not code).
- Escrow refunds for orders stranded by failed epochs are manual; a first-class refund path is roadmap.
- Short epochs (~minutes) chosen for testnet feedback; mainnet wants longer epochs and demand-driven keep-alive (fee-burn economics are documented in `docs/mainnet-lessons.md`).
- wBTC bridging is temporarily hidden in the UI pending an L1 bridge upgrade.
- The clearing circuit and contracts have been internally audited and adversarially tested, but **no external audit yet** — this is testnet software.

## 7. Roadmap

**v0.2 — robustness:** stranded-escrow refunds; longer/demand-driven epochs; metrics-based monitoring; multi-aggregator deployments and failover drills; wBTC bridge repair.

**v0.3 — decentralization of the reveal path:** aggregator slashing conditions; threshold-encrypted reveals so no single aggregator sees plaintext alone; fee-market for clearing rights.

**Mainnet track:** external audits (circuit + contracts + bridges); mainnet fee economics (see `docs/mainnet-lessons.md` for the full lessons-learned checklist driving this list); governance hardening with real timelock delays; deposit caps and staged rollout.

## 8. Links

- App: **https://quetzaldex.xyz**
- Faucet: **https://faucet.quetzaldex.xyz**
- Docs: **https://docs.quetzaldex.xyz**
- Source: **https://github.com/Kubudak90/quetzaldex**
- Built on **[Aztec](https://aztec.network)** (alpha-testnet, protocol 5.0.0)

---

*This document describes testnet software under active development. Nothing here is an offer of securities or financial advice. Parameters cited reflect the current alpha-testnet deployment and may change.*
