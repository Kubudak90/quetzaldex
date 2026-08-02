# RUNBOOK — Quetzal Faucet

## Service location

- VPS: `161.97.110.1`
- Container: `quetzal-faucet` (docker-compose at `/root/quetzal-faucet/faucet/docker-compose.yml`)
- Port: 3030 (TLS via nginx — `https://faucet.quetzaldex.xyz/`)
- Logs: `docker logs quetzal-faucet` (stdout) + `/root/quetzal-faucet/faucet/data/faucet.log` (audit JSONL)
- Metrics: `curl -s https://faucet.quetzaldex.xyz/api/metrics`


## Reverse proxy + TLS (Caddy)

The VPS already runs Caddy on ports 80/443 with auto-Let's Encrypt for the
existing tenant (`vipteam-api.arcstableswap.app`). Sub-7a adds a Caddy site
block for our subdomain instead of standing up nginx separately:

```bash
# /etc/caddy/Caddyfile (appended):
faucet.quetzaldex.xyz {
    encode gzip
    reverse_proxy localhost:3030
}
```

After edit: `systemctl reload caddy`. Caddy obtains the cert via HTTP-01
within ~5s. The first 100-200ms of the first request may block on cert
issuance; subsequent requests are fast.

The committed `infra/nginx/faucet.quetzaldex.xyz.conf` is a fallback for
nginx-only hosts; the VPS uses Caddy (above) instead.

## Daily health check

Run from any shell:

```
ssh root@161.97.110.1 'curl -s http://localhost:3130/api/health | jq .'
```

Look at:
- `status` — should be `"ok"`. If `"degraded"`, balances are low.
- `l1.operatorBalanceEth` — should be ≥ 0.1 ETH. Refill below 0.05.
- `l1.operatorBalanceFeeJuice` — should be ≥ 1000 (1k × 1e18). Refill below 200.
- `l2.operatorBalanceTUSDC` — should be ≥ 100,000 × 1e6 (100k tUSDC).
- `l2.operatorBalanceTETH` — should be ≥ 50 × 1e18 (50 tETH).
- `rateLimit.totalRequests24h` — sanity check for traffic.

## First-time deploy (one-shot)

Run this once when bringing up a fresh VPS. Subsequent deploys use the "Deploying a new build" section below.

### Prerequisites

The operator's wallets must be pre-funded:

| Resource | Where | Minimum | How to obtain |
|---|---|---|---|
| Sepolia ETH on `FAUCET_L1_PK` EOA | L1 | 0.5 ETH | https://sepoliafaucet.com/ or similar |
| Fee-juice tokens on `FAUCET_L1_PK` | L1 ERC20 | 10000 (× 1e18) | Foundry scripts (see "Refill: L1 fee-juice" below) |
| Fee-juice locked in FeeJuicePortal | L1 | 10000 (× 1e18) | After minting to EOA, approve + bridge into portal |
| tUSDC mint rights | L2 admin | — | Already held by `quetzal.config.json:admin` |
| tETH mint rights | L2 admin | — | Already held by `quetzal.config.json:admin` |
| tUSDC balance on L2 admin | L2 | 1M (× 1e6) | `mint_to_public` from admin to self |
| tETH balance on L2 admin | L2 | 500 (× 1e18) | `mint_to_public` from admin to self |

### Bring-up sequence

```
# 1. Clone on VPS
ssh root@161.97.110.1 'mkdir -p /root/quetzal-faucet && cd /root/quetzal-faucet && git clone https://github.com/Kubudak90/quetzaldex.git .'

# 2. Fill in .env.faucet (paste secrets per template)
ssh root@161.97.110.1 'cp /root/quetzal-faucet/faucet/.env.faucet.example /root/quetzal-faucet/faucet/.env.faucet'
ssh root@161.97.110.1 'nano /root/quetzal-faucet/faucet/.env.faucet'

# Required to fill in:
#   FAUCET_L1_PK                  (Sepolia EOA secret — funded per Prerequisites)
#   FAUCET_L2_SECRET              (= quetzal.config.json:admin secret, from .env.testnet:AZTEC_ACCOUNT_SECRET)
#   FAUCET_RECAPTCHA_SECRET_KEY   (reCAPTCHA v3 server-side secret, from the Google reCAPTCHA dashboard)
#   FAUCET_RECAPTCHA_SITE_KEY     (reCAPTCHA v3 public site key — safe to expose; rendered into the / page)
#   FAUCET_RECAPTCHA_MIN_SCORE    (default 0.5; reject drips scoring below this)
#   FAUCET_REQUIRE_CAPTCHA=true   (production: fail-closed; empty secret rejects all drips)
#   FAUCET_ALLOWED_ORIGINS        (MUST include https://faucet.quetzaldex.xyz — the / page POSTs same-origin)

# 3. Compile Noir + codegen TS bindings (required by faucet build)
ssh root@161.97.110.1 'cd /root/quetzal-faucet && pnpm install && pnpm compile && pnpm codegen'

# 4. Build + start the container
ssh root@161.97.110.1 'cd /root/quetzal-faucet/faucet && docker-compose up -d --build'
ssh root@161.97.110.1 'docker logs -f --tail 30 quetzal-faucet'

# Wait for these log lines:
#   Started PXE connected to chain 11155111 version 1821665230
#   Server started on port 3030

# 5. Local smoke test (port 3030 not yet TLS-fronted)
ssh root@161.97.110.1 'curl -s http://localhost:3130/api/health | jq .'
# Expected: status:"ok", balances populated, rollupVersion:1821665230

# 6. Drip smoke test
# With FAUCET_REQUIRE_CAPTCHA=true there is NO bypass token — Audit #6 removed the
# shared-secret bypass. To smoke the full drip path, either:
#   (a) drive a real drip through the page at https://faucet.quetzaldex.xyz/
#       (the reCAPTCHA v3 token is fetched client-side on submit), or
#   (b) on a NON-PUBLIC instance only, temporarily set FAUCET_REQUIRE_CAPTCHA=false,
#       restart, run an unauthenticated curl drip, then restore =true.
```

### Public-facing setup (DNS + TLS)

See `/Users/huseyinarslan/Desktop/aztec-project/infra/nginx/README.md` for the DNS A-record + nginx + certbot walkthrough. Without this step the faucet is only reachable via `http://161.97.110.1:3130/` (no TLS, no CORS from the public Vercel frontend — Sub-7b won't be able to consume the API).

### Post-deploy validation

```
# Drive a real drip through the page at https://faucet.quetzaldex.xyz/ — with
# FAUCET_REQUIRE_CAPTCHA=true there is NO bypass token (Audit #6 removed it), so the
# reCAPTCHA v3 token must come from the browser flow. A raw curl to /api/drip will be
# rejected unless you temporarily set FAUCET_REQUIRE_CAPTCHA=false on a non-public
# instance. Confirm the page returns success with claimData + tUSDCMint + tETHMint hashes.

# Optional: full chain E2E via scripts/wallet-pool-bootstrap.ts (run from local)
QUETZAL_POOL_MASTER_SECRET=0x$(openssl rand -hex 32) \
QUETZAL_POOL_N=1 \
pnpm tsx scripts/wallet-pool-bootstrap.ts derive
# Note the derived address, hit the faucet for it, then:
pnpm tsx scripts/wallet-pool-bootstrap.ts deploy
```

## Refill: L1 Sepolia ETH

Get more Sepolia ETH from a faucet (e.g. https://sepoliafaucet.com/) and send to `FAUCET_L1_PK`'s address. Aim for ~0.5 ETH refill (~500 drips of headroom).

## Refill: L1 fee-juice (locked in FeeJuicePortal)

Two Foundry scripts under `contracts-l1/script/` (write them as a follow-up if missing — out of scope for this RUNBOOK):
1. `MintFeeJuice.s.sol` — operator EOA mints fee-juice tokens to the faucet's L1 EOA.
2. `SeedFaucetPortal.s.sol` — faucet's L1 EOA approves + locks tokens in the FeeJuicePortal.

## Refill: L2 tUSDC + tETH

Run a minimal Node one-shot from the VPS shell:

```
docker run --rm --env-file /root/quetzal-faucet/faucet/.env.faucet \
  -v /root/quetzal-faucet:/repo \
  quetzal-faucet:latest \
  node /repo/faucet/scripts/refill-l2.mjs tUSDC 100000000000000
```

(`scripts/refill-l2.mjs` is a small wrapper around `mintToPublic` from `src/lib/l2-mint.ts`; write as a follow-up.)

Same pattern for tETH with amount `500000000000000000000` (= 500 tETH).

## Deploying a new build

From local repo root after merge to `main`:

```
ssh root@161.97.110.1 'cd /root/quetzal-faucet && git pull && cd faucet && docker-compose up -d --build'
docker logs -f --tail 50 quetzal-faucet
```

The container will pull, rebuild, restart with zero data loss (`./data/` volume persists).

## Rotating secrets

If `FAUCET_L1_PK` or `FAUCET_L2_SECRET` leaks:

1. Generate fresh keys.
2. Drain old wallets to new ones (send Sepolia ETH + bridge fee-juice + `Token.transfer_public`).
3. Update `.env.faucet` on VPS.
4. `docker-compose restart faucet`.
5. Wipe `data/faucet.sqlite` (optional — rate-limit history is hashed-IP, no PII).

## Forcing a reset

Wipe rate-limit + audit log:

```
ssh root@161.97.110.1 'docker stop quetzal-faucet && rm -f /root/quetzal-faucet/faucet/data/faucet.sqlite /root/quetzal-faucet/faucet/data/faucet.log && docker start quetzal-faucet'
```

## Common failure modes

| Symptom | Probable cause | Fix |
|---|---|---|
| 503 "faucet drained" | One of {L1 ETH, L1 fee-juice, L2 tUSDC, L2 tETH} < 10× per-drip | Refill (see above) |
| 429 from a single user | They legitimately drank within 8h | Wait or raise `FAUCET_PER_IP_COOLDOWN_SECONDS` |
| 503 "L1 RPC unreachable" | drpc.org down or rate-limited | Swap `FAUCET_L1_RPC_URL` to backup (alchemy, infura) |
| 503 on every request | Container died or L2 node 5xx | `docker restart quetzal-faucet`; check `docker logs` |
| `/api/health` returns 503 | startup failure (env, sqlite write, network) | `docker logs quetzal-faucet --tail 100` |
