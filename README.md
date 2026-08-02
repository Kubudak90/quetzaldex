# Quetzal

[![CI](https://github.com/Kubudak90/quetzaldex/actions/workflows/ci.yml/badge.svg)](https://github.com/Kubudak90/quetzaldex/actions/workflows/ci.yml)
[![Aztec](https://img.shields.io/badge/aztec-5.0.0-7c5cff)](https://docs.aztec.network)
[![Testnet](https://img.shields.io/badge/network-alpha--testnet-D4FF28)](https://quetzaldex.xyz)

**A private dark-pool exchange with ZK-verified batch clearing, built on [Aztec](https://aztec.network).**

Orders are hidden until they can no longer be exploited; every epoch clears at one
uniform price discovered against concentrated-liquidity pools; and a zero-knowledge
proof — verified on-chain before funds move — guarantees the clearing was computed
honestly from exactly the orders that were committed. No front-running, no
sandwiching, no trusted operator.

📖 **[Read the Litepaper](LITEPAPER.md)** for the full protocol design.

## Live (Aztec alpha-testnet)

| | |
|---|---|
| **App** | https://quetzaldex.xyz |
| **Faucet** | https://faucet.quetzaldex.xyz |
| **Docs** | https://docs.quetzaldex.xyz |
| **X** | https://x.com/Quetzaldex |

What's running: onboarding wizard (wallet + tokens + fee juice in one flow), private
trading on 3 pairs (USDC/ETH, USDC/BTC, ETH/BTC), L1↔L2 bridging (Sepolia USDC/WETH),
LP deposits/withdrawals, a public faucet with reCAPTCHA v3, and a permissionless
clearing-aggregator daemon. The full pipeline — hidden commit → off-chain reveal →
multi-pool uniform-price clearing → UltraHonk proof → on-chain verified settlement
with conservation checks → the maker redeeming the proven fill — is validated with
live testnet transactions, including adversarial cases that must (and do) revert.

## How it works

```
 trader                 orderbook (L2)            aggregator             pools (L2)
   │  commit c_i ──────────► epoch N                  │                     │
   │  reveal (off-chain) ─────────────────────────────►                     │
   │                        epoch N closes            │                     │
   │                            │   replay + clear + ZK prove               │
   │                            ◄── close_epoch_and_clear_verified ─────────┤
   │  claim fill ◄──────────────┘                                           │
```

- **Commit-reveal orderbook** — orders enter epochs as Poseidon commitments folded
  into an on-chain accumulator; the chain sees that an order exists, nothing else.
  Decoy orders obscure even the count.
- **Permissionless aggregators** — bonded operators receive reveals off-chain,
  compute one clearing price per pool per epoch, and prove it. The accumulator
  replay + circuit make dropping, injecting, or mutating orders unprovable.
- **Concentrated liquidity** — 16 geometric price buckets per pool; batch net
  demand is traced through the bucket structure exactly as the contract executes it.
- **ZK-verified settlement** — one transaction verifies the proof against a pinned
  VK, applies per-bucket deltas, and independently enforces flow conservation
  (aggregate flows must equal the sum of bucket deltas).

## Repository layout

| Path | What it is |
|---|---|
| `contracts/` | Noir (Aztec) contracts — orderbook, concentrated pool, hybrid token, aggregator registry, treasury |
| `circuits/clearing/` | The clearing circuit (Noir → UltraHonk) |
| `contracts-l1/` | Foundry project — L1 token bridges (UUPS + AccessControl + timelocks) |
| `aggregator/` | Clearing daemon — reveal queue, multi-pool price discovery, witness builder, prover orchestration |
| `sdk/` | TypeScript SDK — orders (incl. decoys), pools, bridge, reads, wallet glue |
| `cli/` | Operator/trader CLI |
| `frontend/` | The app (React + Vite, deployed on Vercel) |
| `faucet/` | Faucet service + public drip page (Next.js, reCAPTCHA v3) |
| `scripts/` | Deploy, ops, e2e and validation runners |
| `tests/` | Cross-package integration tests |
| `docs/` | Ops playbooks + [`mainnet-lessons.md`](docs/mainnet-lessons.md) (production-readiness lessons) |

## Quickstart (development)

```bash
# One-time toolchain: Aztec sandbox + nargo and Foundry (for L1/anvil).
# Pin the Aztec/nargo version to .aztec-version (currently 5.0.0) — pnpm test:noir
# reads that file to pick its Docker tag, so anything else fails to compile.
# https://docs.aztec.network/guides/getting_started

pnpm install

# Compile Noir contracts + run TXE tests (no sandbox needed)
pnpm compile && pnpm test:noir

# Generate TS bindings, then run JS/TS suites
pnpm codegen
pnpm test

# Faucet service tests
cd faucet && pnpm exec vitest run

# Aggregator tests
cd aggregator && npm test
```

To run against a network you need a deployed contract set (`quetzal.config.json`
is the canonical address book — the committed one points at the live alpha-testnet
deployment). Deployment and operator procedures live in `docs/deploy.md` and
`docs/on-call-playbook.md`.

## Status & roadmap

This is **testnet software** (no external audit yet). What has been proven live,
the current limitations, and the roadmap (escrow refunds, threshold-encrypted
reveals, multi-aggregator competition, mainnet track) are laid out in the
[Litepaper](LITEPAPER.md) §6–7. Production-readiness lessons from the hardening
cycle are documented in [`docs/mainnet-lessons.md`](docs/mainnet-lessons.md).

## License

MIT.
