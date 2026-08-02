# Quetzal Docs

Production documentation site for Quetzal — MEV-resistant dark-pool DEX on Aztec Network.

Live at: **[docs.quetzaldex.xyz](https://docs.quetzaldex.xyz)**

## Stack

- [Next.js 14](https://nextjs.org) + [Nextra 2](https://nextra.site) (docs theme)
- MDX content under `pages/`
- Deployed as its own Vercel project — separate from the main app at `quetzaldex.xyz`

## Local dev

```bash
pnpm install --ignore-workspace
pnpm dev
# → http://localhost:3000
```

`--ignore-workspace` is required because the repo's root `pnpm-workspace.yaml` does not include `docs-site/` (intentional — docs deploys are independent).

## Build

```bash
pnpm install --ignore-workspace
pnpm build
```

## Deploy

This directory is a separate Vercel project named `quetzal-docs`. To deploy:

```bash
cd docs-site
vercel deploy --prod --yes
```

The custom domain `docs.quetzaldex.xyz` is attached via Vercel Domains UI (subdomain of the apex domain `quetzaldex.xyz`, which lives on the main `aztec-project` Vercel project's account).

### Vercel project settings

- **Framework preset:** Next.js
- **Build command:** `pnpm build`
- **Install command:** `pnpm install --ignore-workspace`
- **Output directory:** `.next` (default)
- **Root directory:** `docs-site`
- **Node version:** 22+

## Content structure

```
pages/
├── index.mdx                       Home
├── getting-started/
│   ├── index.mdx                   Overview + wizard walkthrough
│   ├── faucet.mdx                  Get test tokens
│   └── wallet.mdx                  Wallet pool concept
├── trading/
│   ├── index.mdx                   How clearing works
│   └── multi-hop.mdx               2-hop multi-pair routing
├── bridge.mdx                      L1↔L2 bridge
├── lp.mdx                          Concentrated liquidity buckets
├── architecture.mdx                System overview + trust model
├── reference/
│   ├── sdk.mdx                     @quetzal/sdk quickstart + API
│   ├── contracts.mdx               Testnet contract addresses
│   └── api.mdx                     Aggregator + Faucet HTTP APIs
└── faq.mdx                         Common questions
```

## Editing

- All pages are MDX. Front-matter is the YAML at the top.
- Sidebar order is controlled by `_meta.json` files.
- Theme + brand: `theme.config.tsx`.
- The TESTNET ALPHA banner is configured in `theme.config.tsx` under `banner.key` — change the key to force-invalidate the user's localStorage "dismissed" state on a relaunch.

## Updating content

Pull factual content from `quetzal.config.json`, the project memory under `~/.claude/projects/-Users-huseyinarslan-Desktop-aztec-project/memory/`, or from the SDK / aggregator / faucet source. Don't invent. Mark in-progress items as "work in progress".
