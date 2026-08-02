# @quetzal/faucet

Self-serve faucet for Quetzal testnet, with a public web page plus a JSON API. Drips 100 fee-juice + 1000 tUSDC + 0.5 tETH per request, gated by reCAPTCHA v3 + per-IP 8h cooldown.

Lives on VPS `161.97.110.1:3130`, exposed at `https://faucet.quetzaldex.xyz/` (TLS via nginx). Consumed by the public page directly and by `@quetzal/frontend`'s Sub-7b onboarding wizard via CORS-restricted POST.

## Endpoints

- `/` — public faucet page (address form + claim package + status strip; same-origin POST to `/api/drip`).
- `POST /api/drip` — drip request; body `{ address, captchaToken }` → response shape mirrors `WalletBootstrapState.claimData` for swap-compatibility with Nethermind's faucet.
- `GET /api/config` — public UI config; `{ requireCaptcha, recaptchaSiteKey, amounts, globalDailyCap }` so page copy can't drift from the env.
- `GET /api/health` — service health; `status: "ok" | "degraded"`.
- `GET /api/metrics` — Prometheus exposition.

See `docs/superpowers/specs/2026-05-27-quetzal-subproject-07a-custom-faucet-design.md` for the full design.

## Local development

```
cp .env.faucet.example .env.faucet
# fill in: FAUCET_L1_PK, FAUCET_L1_FEE_JUICE_PORTAL (optional), FAUCET_L2_SECRET,
#         FAUCET_RECAPTCHA_SECRET_KEY + FAUCET_RECAPTCHA_SITE_KEY (optional),
#         FAUCET_REQUIRE_CAPTCHA (Audit #6; "false" on testnet)

pnpm install
pnpm -F @quetzal/faucet dev   # http://localhost:3030
```

## Tests

```
pnpm -F @quetzal/faucet test           # unit suite (fast, no network)
pnpm -F @quetzal/faucet typecheck

# opt-in live testnet (consumes operator funds):
set -a; source faucet/.env.faucet; set +a
RUN_INTEGRATION_TESTS=1 pnpm -F @quetzal/faucet test tests/drip.integration.test.ts
```

## Production deploy

See `aggregator/ops/RUNBOOK-faucet.md`.

## Acknowledgements

Architecture inspired by [NethermindEth/aztec-faucet](https://github.com/NethermindEth/aztec-faucet) (MIT). This package is a clean re-implementation tuned to Quetzal's needs (Sub-7a brief).
