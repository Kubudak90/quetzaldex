# RUNBOOK — Quetzal Aggregator (Sub-8.1)

## Service location

- VPS: `161.97.110.1`
- Container: `quetzal-aggregator` (docker-compose at `/root/quetzal-aggregator/aggregator/docker-compose.yml`)
- Port: 3001 host → 3000 container (Caddy reverse-proxies HTTPS at
  `https://aggregator.quetzaldex.xyz/` once DNS is wired)
- Public endpoint (current): `http://161.97.110.1:3102/health` — no TLS
  yet. DNS A record `aggregator.quetzaldex.xyz → 161.97.110.1` must be
  added via Vercel domains; Caddyfile is already configured for the
  vhost (issued on first request once DNS resolves).
- Logs: `docker logs quetzal-aggregator` (stdout, JSON-line format)
- Data: `/root/quetzal-aggregator/aggregator/data/` (snapshot JSONLs persist
  across restarts; bind-mount, safe for `tar`-style backups)
- L2 read-only wallet address (current deploy):
  `0x2cce3e9c086406a8b974abcd37ee258a6c08d88b260381b299a14ad16e070713`
  Derived from `AGGREGATOR_L2_SECRET` in `.env.aggregator`; never funded
  in the MVP (read-only via PXE simulate()).

## What's wired (MVP scope)

This is the **reveal-server-only MVP**. The container:

1. Accepts `POST /reveal` payloads from makers, validates the schema, and
   enqueues them in-memory (deduped by `(epoch_id, order_nonce)`).
2. Reports queue size + watcher status via `GET /health`.
3. Runs a background epoch-watcher that polls `Orderbook.get_epoch()` every
   `WATCHER_INTERVAL_MS` (default 15s) and logs the current epoch + block.

**The container submits real `close_epoch_and_clear_verified` clearing txs.**
With `CLEARING_ENABLED=1`, an epoch that closes with matching reveals in the
queue runs the full cycle: compute fills → write the hop snapshot → `nargo
execute` + `bb prove` (both binaries ship in the image, which is why it FROMs
`aztecprotocol/aztec:<.aztec-version>`) → submit the settle on chain. The whole
place → reveal → clear → claim lifecycle is proven on testnet.

### The submitter must be a BONDED aggregator

Clearing is submitted by the dedicated clearing wallet
`0x028b13c6839fcba3b2ba21e50ea79b586636b74f450993bfa0370071a97801c0`, which is
registered in `AggregatorRegistry` with a 1000 tUSDC bond. This is the single
most common way to break clearing:

| Symptom | Cause |
|---|---|
| `Assertion failed: caller is not a bonded aggregator` | `AGGREGATOR_L2_SECRET/SALT/SIGNING_KEY` resolve to an unbonded account (e.g. admin) |
| `Assertion failed: grace: only bonded aggregator may close non-empty epoch` | same, on the auto-roll `close_epoch` path |

Everything upstream — reveal, fill computation, snapshot, proof — succeeds
first, so the failure only shows at submit time and looks like a chain problem.
Check which account the container registered (`docker logs quetzal-aggregator |
grep 'Registered account'`) and bond it with
`pnpm exec tsx scripts/bond-aggregator.ts` (idempotent) if needed.

## Reverse proxy + TLS (Caddy)

Adds a Caddy site block to `/etc/caddy/Caddyfile` (already present on VPS):

```
aggregator.quetzaldex.xyz {
    encode gzip
    reverse_proxy localhost:3001
}
```

After edit: `systemctl reload caddy`. Caddy obtains the cert via HTTP-01
within ~5s once the DNS A record is in place.

For the soft launch before DNS is wired, `http://161.97.110.1:3102/health`
works directly.

## Daily health check

```bash
# Local from VPS:
ssh root@161.97.110.1 'curl -s http://localhost:3102/health | jq .'

# Public (after DNS):
curl -s https://aggregator.quetzaldex.xyz/health | jq .
```

Expected (with watcher enabled):

```json
{
  "ok": true,
  "service": "quetzal-aggregator",
  "queueSize": 0,
  "watcher": {
    "status": "polling",
    "lastEpochSeen": 42,
    "lastBlockSeen": 12345,
    "lastError": null,
    "lastPollAt": "2026-05-28T17:00:00.000Z"
  }
}
```

`watcher.status` field:

- `polling`: healthy, epoch reads succeeding
- `idle`: watcher hasn't run a poll yet (cold-start window)
- `disabled`: env missing (`AZTEC_NODE_URL` or `ORDERBOOK_ADDRESS` or
  `AGGREGATOR_L2_SECRET` not set) — reveal server still works
- `error`: bootstrap or last poll failed; see `watcher.lastError`

If `watcher.status === "error"` with `lastError` mentioning "public bytecode
has not been transpiled", the Noir artifact in `contracts/orderbook/target/`
needs to be regenerated against the testnet rollup version. Run `pnpm
compile` from the monorepo root + rebuild the image. The reveal server keeps
working through this.

## First-time deploy (one-shot)

```bash
# 1. Clone on VPS
ssh root@161.97.110.1 'mkdir -p /root/quetzal-aggregator && cd /root/quetzal-aggregator && git clone https://github.com/Kubudak90/quetzaldex.git .'

# 2. Fill in .env.aggregator
ssh root@161.97.110.1 'cp /root/quetzal-aggregator/aggregator/.env.aggregator.example /root/quetzal-aggregator/aggregator/.env.aggregator'
ssh root@161.97.110.1 "sed -i 's|0xREPLACE_ME_RUN_openssl_rand_hex_32|0x$(openssl rand -hex 32)|' /root/quetzal-aggregator/aggregator/.env.aggregator"

# 3. Install workspace deps + compile Noir artifacts (optional; required for epoch watcher)
ssh root@161.97.110.1 'cd /root/quetzal-aggregator && pnpm install'
# (pnpm compile is optional — only needed for the on-chain epoch poll path)

# 4. Build + start the container
ssh root@161.97.110.1 'cd /root/quetzal-aggregator/aggregator && docker compose up -d --build'
ssh root@161.97.110.1 'docker logs -f --tail 30 quetzal-aggregator'

# Wait for these log lines:
#   {"msg":"http server listening","port":3000}
#   {"msg":"epoch watcher: PXE bootstrap complete"} (only if watcher env wired)

# 5. Local smoke test
ssh root@161.97.110.1 'curl -s http://localhost:3102/health | jq .'

# 6. Add Caddy vhost
ssh root@161.97.110.1 'printf "\n# Sub-8.1 Quetzal Aggregator\naggregator.quetzaldex.xyz {\n    encode gzip\n    reverse_proxy localhost:3001\n}\n" >> /etc/caddy/Caddyfile && systemctl reload caddy'

# 7. After DNS is wired (Vercel domains → A 161.97.110.1):
curl -s https://aggregator.quetzaldex.xyz/health | jq .
```

## Deploying a new build

```bash
ssh root@161.97.110.1 'cd /root/quetzal-aggregator && git pull && cd aggregator && docker compose up -d --build'
docker logs -f --tail 50 quetzal-aggregator
```

The `./data` bind-mount survives the rebuild; in-flight queue state does NOT
(it's in-memory only — see queue.ts docstring).

## Failure modes

| Symptom | Likely cause | Fix |
|---|---|---|
| `/health` returns `watcher.status: "disabled"` | env vars missing | Check `.env.aggregator` has `AZTEC_NODE_URL` + `ORDERBOOK_ADDRESS` + `AGGREGATOR_L2_SECRET` |
| `/health` returns `watcher.status: "error"` with "public bytecode" message | Noir artifact missing or version skew (CURRENT STATE on 2026-05-28 — testnet rollup version 1821665230 needs a re-compile + transpile of `contracts/orderbook/`) | Run `pnpm compile` on a box with `nargo` installed + transpile against the matching aztec.js version. Then SCP the JSON artifacts to the VPS at `/root/quetzal-aggregator/contracts/*/target/` and `docker compose up -d --build`. Reveal server keeps working regardless. |
| `/health` returns `watcher.status: "error"` with "greater or equal to field modulus" | `AGGREGATOR_L2_SECRET` is too large for BN254 Fr | Regenerate so the first byte is `< 0x30` (safe upper bound): `openssl rand -hex 31 \| sed 's/^/00/'` |
| `/health` returns `watcher.lastError: "Failed to fetch"` | L2 RPC unreachable | Check `AZTEC_NODE_URL` resolves + testnet is up |
| `/health` returns `watcher.lastError: "Cannot find module ... tests/integration/generated/Orderbook.js"` | `QUETZAL_CONTRACTS_DIR` is unset and SDK is using cwd-relative path | Add `QUETZAL_CONTRACTS_DIR=/repo/tests/integration/generated` to `.env.aggregator` then `docker compose down && docker compose up -d` (restart doesn't re-read env-file). |
| Container restart-loop | Port collision or env-file missing | `docker logs quetzal-aggregator --tail=100` to see the fatal line |
| `POST /reveal` returns 400 | Payload schema mismatch | See `RevealSchema` in `src/main.ts` — check `order_nonce` is `0x...` hex |
| Queue size drops to 0 unexpectedly | Container restarted (in-memory only) | Reveals are queue-on-broadcast; makers retry next epoch |

## Mainnet readiness checklist (NOT READY)

This MVP is testnet-only. Before mainnet:

- [ ] **Persistent reveal queue** (currently in-memory; restart loses in-flight)
- [x] **Funded L2 wallet** — the bonded clearing wallet `0x028b13c6…`; custody is still a single operator key, which is the open mainnet item
- [x] **Real clearing tx submission** wired and proven on testnet
- [ ] **Prometheus metrics endpoint** exposed (currently logs-only)
- [ ] **Alertmanager rules** for watcher.status going from `polling` → `error`
- [ ] **Multi-aggregator deployment** + bonded registry registration (Sub-3 race)
- [ ] **Rate-limit on `/reveal`** to prevent log-flood DoS
- [ ] **CORS allowlist** matching the production frontend origin
- [ ] **Audit log** of every accepted reveal (currently debug-log-only)
- [ ] **Snapshot retention policy** (currently unbounded JSONL accumulation in `data/`)
- [ ] **Onbox audit + Slither-equivalent** for the on-chain submission path
- [ ] **Key rotation procedure** for the L2 wallet secret

## Verification (Sub-8.5: soft-launch direct-reveal path)

After deploying the Sub-8.5 frontend (which wires `VITE_AGGREGATOR_URL`), you
can verify reveals are landing in the aggregator queue by:

```bash
# 1. Place an order via the UI at https://quetzaldex.xyz/trade
#    Watch DevTools Network tab — you should see a POST to
#    http://161.97.110.1:3102/reveal returning HTTP 200.

# 2. Query the queue size from the VPS:
ssh root@161.97.110.1 'curl -s http://localhost:3102/health | jq ".queueSize"'
# Expected: increments by 1 per order placed.

# 3. Send a test reveal manually:
curl -X POST -H "Content-Type: application/json" \
  -d '{
    "epoch_id": 1,
    "order_nonce": "0xdeadbeefdeadbeef",
    "side": true,
    "amount_in": "1000000",
    "limit_price": "3000000000",
    "submitted_at_block": 42,
    "owner": "0xabcdef1234567890"
  }' \
  http://161.97.110.1:3102/reveal
# Expected: {"ok":true}
```

**Important**: The Sub-8.5 soft-launch path uses `client.aggregator.directReveal`
(not `broadcastReveal`). `directReveal` bypasses the on-chain `AggregatorRegistry`
and POSTs directly to the URL in `VITE_AGGREGATOR_URL`. This is intentional:
the browser posts reveals through the same-origin proxy rather than discovering
an aggregator on chain. The clearing wallet *is* bonded-registered (see "The
submitter must be a BONDED aggregator" above) — registry-based `broadcastReveal`
discovery is what remains unwired, not the bond.

## On-call playbook (current MVP)

If `/health` is unreachable:

```bash
ssh root@161.97.110.1
docker ps -a | grep aggregator
docker logs quetzal-aggregator --tail=200
# If container is dead:
cd /root/quetzal-aggregator/aggregator && docker compose up -d
# If watcher is stuck in error:
docker compose restart aggregator
```

If reveals are accumulating but never clearing (expected in MVP):

That's the MVP state. Sub-8.1.next wires the clearing loop. In the meantime
the orderbook's on-chain `force_close_epoch` (if exposed by the contract)
lets the admin manually advance epochs without aggregator help.

---

## Sub-9.3 — Multi-pair clearing loop wired (2026-05-29)

**Status:** OPERATIONAL on Aztec testnet. First successful aggregator-driven
`close_epoch()` tx on testnet:
`0x1a45a5ab718347c9f272c2af3a836c4d036251b62920dff6ad718d233432eaec`
(epoch 0 → 1 advance, 2026-05-29 06:37 UTC).

### What's new vs Sub-8.1 MVP

1. `aggregator/src/clearing-cycle.ts` — full multi-pair (Sub-4 shape)
   orchestrator: drain queue → validate against on-chain order_acc → read
   per-pool state (16 buckets) → computeClearingMultiPair → witness builder →
   shell out to `nargo execute` + `bb prove` → close_epoch_and_clear_verified.
2. Watcher reads L2 block-now (via `aztecNode.getBlockNumber`) instead of
   relying on the orderbook's `closes_at_block`. `wouldClear: true` now
   actually fires after the epoch window expires.
3. Background cycle runs in setImmediate so it doesn't block the next poll;
   module-level mutex prevents concurrent cycles.
4. No-cross fallback: when validated reveals exist but the clearing doesn't
   cross (e.g. pool has no liquidity), the cycle falls back to plain
   `close_epoch()` to advance the epoch rather than leave orders stuck.

### Dockerfile change

Runtime base switched from `node:22-trixie-slim` to `aztecprotocol/aztec:5.0.0`
which bakes in `nargo` + `bb` (the alternative — bespoke toolchain install —
breaks on every Aztec release). Image size: ~600MB → ~2.4GB. First VPS
rebuild took ~25 minutes (mostly the node_modules copy + image export).
Subsequent rebuilds with cached deps are ~3-5 min.

### New env vars (see .env.aggregator.example)

| var | purpose | default |
|---|---|---|
| `CLEARING_ENABLED` | gate the full close_epoch path | (off) |
| `POOL_USDC_ETH_ADDRESS` | pool 0 contract addr | none |
| `POOL_USDC_BTC_ADDRESS` | pool 1 contract addr | none |
| `POOL_ETH_BTC_ADDRESS` | pool 2 contract addr | none |
| `TBTC_ADDRESS` | tBTC L2 token addr | none |
| `AGGREGATOR_L2_SALT` | reach pre-deployed wallet (admin reuse) | `Fr.ZERO` |
| `AGGREGATOR_L2_SIGNING_KEY` | reach pre-deployed wallet | derived |
| `SNAPSHOTS_DIR` | fills snapshot output | `/repo/aggregator/data/snapshots` |
| `CIRCUIT_DIR` | nargo project dir | `/repo/circuits/clearing` |
| `NARGO_BIN` | nargo binary | `/usr/src/noir/noir-repo/target/release/nargo` |
| `BB_BIN` | bb binary | `/usr/src/barretenberg/ts/build/amd64-linux/bb` |
| `PROVE_DEADLINE_MS` | per-prove deadline | 300000 |
| `PXE_DATA_DIRECTORY` | persistent PXE store | (ephemeral) |

### Operator concern: the clearing wallet is a single operator key

The aggregator submits as the dedicated bonded wallet `0x028b13c6…` (no longer
admin — admin stays the token minter and the faucet's operator, which it must be
because `Token.minter` is `PublicImmutable`). It pays ~10-30 FJ per
clearing/close_epoch tx.

**Still open for mainnet:** it is one un-rotated key with no custody story, and a
single point of failure if compromised. Multi-aggregator competition (Sub-3) would
remove the single point; it is registered but not yet raced.

### Operator concern: pool 0 has zero liquidity after Sub-9.2 redeploy

Sub-9.2 redeployed pools but did not re-run `seed-lp.ts`. As a result, pool 0
(tUSDC/tETH) reports `reserve_a = 0, reserve_b = 0` for both u128-canonical
sides. The Sub-9.3 cycle handles this gracefully via the no-cross fallback
(calls `close_epoch()` to advance), but **no user order can actually FILL
against pool 0 until reseed**. Operator todo:

```bash
rm -f seed-lp-state-{0,1,2}.json
AZTEC_NODE_URL=https://v5.testnet.rpc.aztec-labs.com SEED_LP_POOL=0 pnpm exec tsx scripts/seed-lp.ts
# Repeat for pools 1, 2 if those user orders are expected.
```

After reseed, the cycle's `computeClearingMultiPair` will cross orders and
`close_epoch_and_clear_verified` will fire (instead of plain `close_epoch()`).

### Sub-9.3 carry-forwards

1. **Reveal payload `submitted_at_block` discrepancy**: the SDK reports the
   L2 head when an order is placed, but the contract stores the *anchor block*
   (typically `head - 1` or `head - small_delta`). The reveal validation
   replays c_i against the reported block, which mismatches the contract's
   stored value. Workaround (this session): fuzz-scan a small window around
   the reported value to find the right block. **Sub-9.4 proper fix:** have
   the SDK's `placeOrder` return `result.anchorBlock` from the tx receipt
   (the same value the contract sees), so the reveal payload carries the
   correct value first time. Alternative: the aggregator reads the maker's
   OrderNote via `get_orders(owner)` and uses the on-chain stored value.
2. **`getOrders` arithmetic overflow** (carryover from Sub-9.2): the
   orderbook's `get_orders(owner)` view fn throws
   `Assertion failed: attempt to multiply with overflow 'pow * 2'` for the
   smoke user. Looks like a u32→Field overflow in the path serializer.
3. **`resolvePoolId` in `aggregator/src/path.ts` uses full bigint**: Sub-9.3
   added `buildU128PoolRegistry` + `resolvePoolIdU128` in clearing-cycle.ts
   to work around. The legacy path.ts helpers should be aligned next.
4. **bb prove path not yet exercised in production**: the cycle wires it,
   but it has not yet been triggered with a non-trivial clearing because
   pool liquidity is zero. Once pools are reseeded + a smoke user submits
   an in-the-money order, bb prove fires for real. First-prove will be
   slow (~30-120s on the VPS).
5. **Snapshot hop-fill paths not yet persisted**: `clearing-cycle.ts` writes
   the 2-field tree snapshot (compatible with `cli/src/commands/claim`)
   but does not yet emit the 4-field hop-fill tree paths needed for
   the multi-pair `claim_fill` flow. Carryforward.
6. **No Sub-3 bonded race**: the clearing wallet IS bonded-registered in
   `AggregatorRegistry`, but only one operator runs, so the multi-aggregator
   race shipped in Sub-3 is never exercised.

### Verifying the close_epoch path

```bash
# 1. Confirm cycle wired
curl -s http://161.97.110.1:3102/health | jq .
# Expect: watcher.status=polling, watcher.lastEpochSeen >= 1 after first close

# 2. Tail the structured logs
sshpass -p '<vps-pw>' ssh root@161.97.110.1 'docker logs -f quetzal-aggregator --tail=20'

# 3. Re-broadcast a reveal (after the smoke); verify the cycle fires
curl -X POST -H "Content-Type: application/json" \
  -d '{ "epoch_id":<...>, "order_nonce":"<...>", "side":<...>, ... }' \
  http://161.97.110.1:3102/reveal

# Expect log progression:
#   epoch poll (wouldClear:true)
#   draining reveals
#   reveals validated
#   pool states read
#   {clearing did not cross OR clearing computed}
#   {close_epoch() OR close_epoch_and_clear_verified} submitted
```


## Sub-9.4 — EPOCH=10 redeploy for public-DEX UX (2026-05-29)

Sub-9.3 left the orderbook with `EPOCH_LENGTH=100`. Empirical testnet block
rate runs ~95-240s/block, so each epoch took anywhere from ~2.5h up to many
hours. Median user wait-for-fill ≈ 75 min — unusable for public DEX UX.

Sub-9.4 redeploys the orderbook + treasury + 3 pools with `EPOCH_LENGTH=10`.
Empirical effect: median epoch span ≈ 15-30 min depending on testnet block
rate, average user wait ≈ 8-15 min. UX-acceptable for public testnet launch.

### Addresses (live)

| Contract             | Address                                                              |
|----------------------|----------------------------------------------------------------------|
| orderbook            | `0x1744f34ce7b612a6c288ac53a7ba08af90c58c435f8b05ae7c4e3dcbded81a38` |
| treasury             | `0x29c6c88866c8f9002f800340ab983f09974873384e5e8ea1ee1fbcc40142418e` |
| pool 0 USDC/ETH      | `0x0cd94fcc272b8d0a6aefb6158cb9b391efeb2734bd5bc7598a7864f5564949a0` |
| pool 1 USDC/BTC      | `0x15d463454956baa3f7ab8e8ef1de94b2805cb8b3f86ca6ceb4206dbdf6f094c6` |
| pool 2 ETH/BTC       | `0x1b0715f1d07a05ed00215ea1234734282b6d709c16aba8c86016fdfdb4efea63` |
| tUSDC (UNCHANGED)    | `0x0525a0e5a940daf669e98d5b98c46f85f4782b6f4c5af2e5d69db808375c349c` |
| tETH  (UNCHANGED)    | `0x2efbaf6bd19c028cc8782a2d9e6b7b660a66476c890abe47aeaa06ec7a471ab5` |
| tBTC  (UNCHANGED)    | `0x02c078075c3cbbc6c135f3ef4e4ae85e9765a56995e0aff4f638d44294638afc` |
| AggregatorRegistry   | `0x2d102fd64a3d5b2fb9ad831cdd3a55cb2b360ef8edb06aafa2a0f3460dd63cff` |
| epoch_length         | `10`                                                                |
| vk_hash              | `0x2aae33dd4ea01690b07b5a74e293fde5512be5d4ed1853705f95d1628454edaa` |

Sub-9.2 era addrs preserved under `quetzal.config.json::m4_postSub92_legacy`.

### Deploy sequence

1. Bridged 300 FJ from L1 → admin (admin had ~13 FJ remaining after Sub-9.2).
   - `pnpm tsx scripts/bridge-fj-to-admin.ts 300`
   - L1 tx: 0xd5de69cf43b0d59534104c13be151afb96045f7032aa9fca8ebc2c8c696ffb69
   - L2 claim tx: 0x0e2fc1aea906e131fe82d04dbf4a1bf4b9b95c54baef1683c549651c2dd20525
2. `EPOCH_LENGTH=10 pnpm tsx scripts/redeploy-orderbook-only.ts`
   - 3 pool deploys + Orderbook + Treasury + set_treasury + 3× set_orderbook +
     mint_to_public + seed_public. ~25 min total. ~80 FJ burn.
3. Patched 5 Vercel env vars
   (VITE_QUETZAL_ORDERBOOK/TREASURY/POOL_USDC_ETH/POOL_USDC_BTC/POOL_ETH_BTC)
   + `vercel deploy --prod --yes`.
   - Deploy URL: https://aztec-project-2xzglic36-kubudak90s-projects.vercel.app
4. Patched 6 VPS aggregator env vars
   (ORDERBOOK/TREASURY/POOL/POOL_USDC_ETH/POOL_USDC_BTC/POOL_ETH_BTC ADDRESS)
   + `docker compose up -d --force-recreate`. lastEpochSeen reset 1→0.
5. Reseeded 3 pools via seed-lp.ts pool 0/1/2.
   - bucket[8].liquidity:  pool 0 = 15.4e18 (2 tETH), pool 1 = 76.9M (10M atomic tBTC),
     pool 2 = 15.4e18 (2 tETH).
6. Force-closed empty epoch 0 (blocks 96120 → 96128 → past) via
   `scripts/force-close-epoch.ts` to unstick the orderbook. The aggregator
   doesn't fire close on empty epochs — it only fires when queue has reveals.
   - tx: 0x18f24cd4e024609ab19f353a7fc41463e03d5c5444b5d95a36ec469f47cc44fa
   - Epoch advanced 0 → 1.
7. Smoke run: order placed → reveal posted → aggregator drained reveal at
   close window → order_acc replay mismatch (smoke SDK bug, see below) →
   cycle skipped:replay-mismatch. Pool 0 reserves unchanged.

### Sub-9.4 smoke gotcha (carryforward, not Sub-9.4 deploy issue)

The Sub-9 e2e smoke (`scripts/sub9-e2e-smoke.ts`) places an order and posts
a reveal to the aggregator. The reveal payload's `submitted_at_block` field
is filled from a `node.getBlockNumber()` call BEFORE submit, so it's off by
1-2 blocks from the actual landing block. The orderbook's `order_acc`
hash-chain folds in the real `self.context.block_number()` at submit time,
so the smoke's reveal replay fails Poseidon equality vs on-chain.

In addition the SDK's `placeOrder` returns `epoch=0 block=0` for the
receipt fields because `tx.wait?.()` returns undefined on testnet; smoke
serialises `epoch_id=0` into the reveal even though the actual epoch is
>0. Re-posting the reveal with a corrected `epoch_id` lets the aggregator
drain it but the `submitted_at_block` mismatch still trips replay.

Net effect for Sub-9.4:
- Sub-9.4 deploy pipeline VERIFIED end-to-end (deploy → wire → seed → run).
- Aggregator clearing-cycle plumbing exercised (drain, replay, log).
- `close_epoch_and_clear_verified` NOT yet exercised on the new orderbook.
- `close_epoch()` fallback exercised via the manual force-close (epoch 0→1).

Resolving the smoke replay drift is **Sub-9.5 scope**: SDK should return
real receipt block, smoke should rebuild submitted_at_block from the on-chain
`get_orders` view OR compute pre-image with the exact contract math.

### Operating note: empty-epoch bootstrap

After any orderbook redeploy, the brand-new orderbook is at epoch 0 with
`closes_at_block = deploy_block + EPOCH_LENGTH`. If no order is submitted
within that window, epoch 0 expires and submit_order is permanently rejected
with `block < epoch.closes_at_block`. Aggregator does NOT auto-advance empty
epochs.

Fix: `pnpm tsx scripts/force-close-epoch.ts` (admin-only public call).

For mainnet, consider adding a 1-block-after-deploy bootstrap submit_order
or weakening the aggregator's "queue.size() > 0" gate so it advances stale
empty epochs.
