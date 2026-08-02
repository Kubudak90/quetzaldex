# Quetzal — deploy

## Live

- **Production:** [quetzaldex.xyz](https://quetzaldex.xyz)
- **Repo:** [github.com/Kubudak90/quetzal](https://github.com/Kubudak90/quetzal) (public)
- **Vercel project:** `kubudak90s-projects/aztec-project` (id `prj_GpQRnDgJn9AX5jrsuqK5Jz20tyzG`)

## CI/CD

Vercel ↔ GitHub git integration auto-deploy:

- **Push to `main`** → production deploy → `quetzaldex.xyz`
- **PR open** → preview deploy → unique `aztec-project-<sha>-kubudak90s-projects.vercel.app`
- **PR close (merge / abandon)** → preview cleaned up

No manual `vercel deploy` needed anymore.

## Build settings

From `vercel.json` (monorepo root):

| Setting | Value |
|---|---|
| Framework | Vite |
| Install command | `pnpm install --frozen-lockfile=false` |
| Build command | `pnpm -F @quetzal/frontend build` |
| Output directory | `frontend/dist` |
| SPA rewrite | `/*` → `/index.html` |
| Asset cache | `/assets/*` 1y immutable |

`.vercelignore` excludes monorepo bloat: `contracts/`, `contracts-l1/`, `circuits/`, `tools/`, `aggregator/`, `tests/`, `docs/`, `frontend/_design-source/`, local state, secrets. Vercel only sees: `frontend/` + `sdk/` + `cli/` (workspace deps).

## Local dev

```bash
pnpm install
pnpm -F @quetzal/frontend dev        # http://localhost:5173
pnpm -F @quetzal/frontend build      # production build into frontend/dist/
pnpm -F @quetzal/frontend preview    # serve frontend/dist on http://localhost:4173
```

## Manual deploy (bypass git)

```bash
vercel deploy --prod         # production
vercel deploy                # preview
vercel inspect <url>         # check build logs + status
vercel git disconnect        # break the git integration if needed
```

## Custom domain

Set up in Vercel dashboard → Project → Settings → Domains. Then point DNS:

```
quetzal.fi.        IN  A     76.76.21.21
www.quetzal.fi.    IN  CNAME cname.vercel-dns.com.
```

Production is served from the `quetzaldex.xyz` custom domain; the `*.vercel.app` alias remains as a fallback.

## Secrets

The frontend has **no build-time env vars**. All user-side configuration (wallet master secret, network choice, RPC overrides) lives in browser `localStorage` after first-launch wizard.

If you ever need build-time secrets (analytics keys, etc.), add via:

```bash
vercel env add VARIABLE_NAME production    # interactive prompt
vercel env ls                              # list all
vercel env pull .env.local                 # sync down for local dev
```

## CI gate

GitHub Actions runs on every `main` push + PR (`.github/workflows/ci.yml`, ~1m20s):

| Step | What it gates |
|---|---|
| `pnpm -F @quetzal/sdk typecheck` | SDK type drift |
| `pnpm -F @quetzal/frontend typecheck` | Frontend type drift |
| `pnpm -F @quetzal/sdk test` | SDK unit suite (~98 tests, node:test) |
| `pnpm -F @quetzal/cli test` | CLI unit suite (~74 tests, node:test) |
| `pnpm -F @quetzal/frontend build` | Same build Vercel runs |

**Not gated on CI** (intentional — would push CI from <2min to >15min):
- CLI typecheck — depends on `contracts/*/target/*.json` (gitignored Noir artifacts); typecheck still runs locally pre-commit
- L1 Foundry tests — needs `forge install` + Solidity toolchain
- L2 Noir TXE tests — needs Docker + `nargo` via aztec-up
- Integration tests under `tests/` — needs deployed contracts on Aztec sandbox

For periodic full-stack gating, add a separate cron-triggered workflow.

## Faucet service

The Sub-7a Quetzal Faucet runs on the operator VPS (`161.97.110.1:3130`, exposed at `https://faucet.quetzaldex.xyz/`), separate from the Vercel-hosted frontend.

| | |
|---|---|
| Endpoint | `POST https://faucet.quetzaldex.xyz/api/drip` |
| Source | `faucet/` (workspace package `@quetzal/faucet`) |
| Image | `quetzal-faucet:latest` (Docker, multi-stage Node 22 build) |
| Restart policy | `unless-stopped` (docker-compose) |
| Persistence | `./data/{faucet.sqlite, faucet.log}` (volume-mounted) |
| Playbook | `aggregator/ops/RUNBOOK-faucet.md` |

Deploy: `ssh root@161.97.110.1 'cd /root/quetzal-faucet && git pull && cd faucet && docker-compose up -d --build'`.

### One-time setup (DNS + TLS)

See `infra/nginx/README.md` for the operator walkthrough. Steps:
1. Add Vercel DNS A record: `faucet.quetzaldex.xyz` → `161.97.110.1`.
2. Install nginx + certbot on VPS.
3. Copy `infra/nginx/faucet.quetzaldex.xyz.conf` to `/etc/nginx/sites-available/`.
4. Run `certbot --nginx -d faucet.quetzaldex.xyz`.

Status as of 2026-05-27: nameservers propagated (`ns1/ns2.vercel-dns.com`); A record + cert still pending operator action.

## Production deploys log

- `2026-05-27` — initial deploy `dpl_Bb9hcxxud84qrMEQHar6igbUuu1U` (44.8 MB upload, ~3min build, Washington East)
- `2026-05-27` — Sub-7a faucet **deployment pending operator action**. All committable artifacts shipped: 54 tests pass (53 unit + 1 opt-in integration), `pnpm -F @quetzal/faucet build` succeeds, Docker multi-stage Dockerfile + compose written, nginx + TLS template at `infra/nginx/faucet.quetzaldex.xyz.conf`, operator playbook at `aggregator/ops/RUNBOOK-faucet.md`. Operator next steps: (1) fund wallets per Prerequisites, (2) Vercel DNS A record `faucet.quetzaldex.xyz` → `161.97.110.1`, (3) follow first-time-deploy sequence in RUNBOOK + nginx README.
- `2026-05-28` — Sub-7b onboarding wizard live. Shipped — operator E2E pending against https://quetzaldex.xyz + https://faucet.quetzaldex.xyz. Wall-time per onboard ~6 min (median).
- `2026-05-28` — Sub-7c bridge UI live. End-to-end L1→L2 deposit + claim + L2→L1 exit + withdraw shipped. MetaMask connect in TopBar; wagmi + viem bundled. Operator E2E pending; smoke checklist in `aggregator/ops/RUNBOOK-bridge.md`.
