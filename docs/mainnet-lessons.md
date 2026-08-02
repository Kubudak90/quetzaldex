# Mainnet Lessons — what the public-testnet hardening cycle taught us

> Compiled 2026-06-10, at the end of the cycle that produced the first live
> 3-pool clearing settlement (tx `0x1218ed3b…`, epoch 57). Every item below was
> learned the hard way on Aztec alpha-testnet; each lists the failure we hit,
> the fix that landed, and what to do differently on mainnet.

---

## 1. Fee-juice economics is an OPS problem, not a footnote

**What happened.** The orderbook silently froze TWICE in 24h because the
daemon's fee wallet ran dry. Measured burn: ~4 FJ per `close_epoch` at calm
gas, **~27 FJ at spiked gas** — and testnet `feePerL2Gas` swung 2.5e13 → 4.7e13
within a single hour. Keeping an EMPTY orderbook alive (auto-rolling ~17-min
epochs) cost 280–2,300 FJ/day. A settle tx died mid-cycle because auto-rolls
had eaten the wallet between queue-drain and submission.

**Fixes landed.**
- Hourly auto-topup cron per wallet (floor 150 FJ), wallet-generic
  (`scripts/auto-topup-admin.sh` + `TOPUP_M1_STATE`).
- Pre-flight fee gate in the clearing cycle (`CLEAR_MIN_FEE_JUICE`, default
  100 FJ): a broke wallet leaves reveals QUEUED instead of consuming them.
- L1→L2 bridge as faucet-independent funding path
  (`scripts/bridge-fj-to-admin.ts`, `BRIDGE_M1_STATE` selects the target).
- `scripts/check-min-fees.ts` to set fee ceilings from the LIVE gas price —
  static `STATIC_MAX_FEE_PER_L2_GAS` values kept getting rejected.

**Mainnet rules.**
- Fee asset is REAL money: budget `epoch_length` so empty-epoch rolls are rare
  (longer epochs, or roll-on-demand when the first order arrives).
- Treat the fee wallet like an exchange hot wallet: balance alerts at
  multiple floors, automated refill from a treasury with human-approved caps,
  and a measured FJ/day dashboard (we now alert at <50; mainnet should also
  page at unusual burn RATE, not just low balance).
- Never submit with `gasLimit × maxFee > balance` headroom unplanned — the
  node rejects on the RESERVE (limit × max), not the expected cost. Size
  wallet floors off worst-case reserve, not average burn.

## 2. The node's view of private state is NOT reliable under reorgs

**What happened.** The PXE's note discovery stalled for hours
(`pxe:block_synchronizer Pruning data after block N due to reorg`). The SDK
read the just-placed OrderNote to get the order's true anchor block
(`submitted_at_block`, folded into the on-chain commitment c_i); when the note
wasn't discoverable it silently fell back to the MINED block — but the
contract folds the SIMULATION anchor (typically mined-1). One poisoned reveal
fails the all-or-nothing `order_acc` replay and strands EVERY order in the
epoch. This burned epochs 47, 50 and 53.

**Fixes landed.**
- SDK: retry the note read (6×3s) + loud warn on fallback (`orders.ts
  readAnchorBlock`).
- Daemon: `repairReveals` self-heal — searches per-reveal anchor corrections
  (0..-3 blocks) and accepts ONLY a combination whose fold matches the
  on-chain `order_acc`. No trust is added: the acc still gates settlement.
  Worked live twice (corrected -1 on all reveals).

**Mainnet rules.**
- Any value the contract derives from the anchor header must reach reveal
  producers from the TX ITSELF, not from post-hoc PXE reads. If the wallet
  SDK ever exposes the proven tx's `historicalHeader`, switch to it.
- Design accumulator checks to be repairable-or-partial: all-or-nothing
  validation turns one bad client into a DoS on every other order in the
  batch. Keep the drift-repair, and consider per-order inclusion proofs in a
  future contract revision.
- Expect reorgs. Anything that assumes "the note will be readable in N
  seconds" will break exactly when the chain is under load.

## 3. Concurrency: the watcher loop races itself

**What happened.** The clearing cycle drains the reveal queue at start; the
next poll tick saw an expired epoch with `queue==0`, judged it "empty" and
auto-rolled it. `close_epoch` mined before `close_epoch_and_clear_verified`,
which then reverted `"epoch has not expired yet"` against the fresh epoch —
losing a fully-computed, fully-proved 3-pool clear (epoch 45).

**Fix landed.** `clearingInFlight` flag guards both branches; auto-roll can
never fire while a cycle runs.

**Mainnet rules.**
- Every state machine that both (a) advances epochs and (b) settles them
  needs ONE serialized decision point. Audit any future "keep-alive" feature
  against in-flight settlement before shipping it.
- Destructive steps (queue drain) must come AFTER all pre-flight gates
  (fee balance, validation) — we now drain last; keep it that way.

## 4. External dependencies have quotas and lag — plan for both

- **Nethermind faucet:** ~3 drips/address/day. Hit it mid-incident. Mitigation
  that landed: our own L1→L2 fee-juice bridge from the operator's L1 stock.
  Mainnet: no faucets exist — all funding paths must be first-party.
- **Vercel DNS:** a new A record took ~2.5 HOURS to reach the authoritative
  servers while existing records kept serving (control-plane lag; rm/re-add
  doesn't help). Mainnet: make DNS changes days before launch, and keep
  service routing independent of fresh records (the frontend's same-origin
  `/api` proxy saved us — keep that pattern).
- **L1 RPC throttling:** the public node's `getCurrentMinFees` L1 read 429s;
  scripts wrap the node with a static-fee proxy. Mainnet: paid RPC with SLA
  for anything in the settlement path (we already front the public node with
  a keyed dRPC proxy at `node.quetzaldex.xyz`; the daemon should get the same
  treatment).

## 5. Deploy-config hygiene: one default address cost us a product feature

**What happened.** `deploy-bridge.ts` defaulted `L1_WBTC_ADDR` to the MAINNET
WBTC address. The deploy ran without the env override → the Sepolia WBTC
bridge wraps a token with NO code at that address → every deposit reverts.
Because the L2 token's `portal_addr` is `PublicImmutable`, the fix requires a
UUPS upgrade of the L1 bridge (possible: timelock minDelay=0 on testnet) — or
hiding the feature (what we shipped).

**Mainnet rules.**
- NO network-foreign defaults in deploy scripts. Required params must be
  required (`throw` if unset), and deploys must print + verify every external
  address against on-chain code (`eth_getCode != 0x`) before proceeding.
- Governance timing: mainnet timelocks will NOT be 0-delay. Any
  parameter that might need correction (token addresses, registries) needs
  either a tested upgrade path with realistic delays, or must be validated
  pre-deploy by an automated checklist.

## 6. Observability: silence looked exactly like health

**What happened.** The orderbook was stuck for ~17 hours before anyone
noticed — the daemon was "up" and "healthy" the whole time, failing one tx
type repeatedly.

**Fix landed.** `/root/quetzal-health-watch.sh` (5-min cron → ntfy.sh push):
daemon health + lastError + poll staleness, epoch-stuck (>45 min), the
"auto-roll close_epoch failed" fee-drain signature, faucet health + L1
ETH/FJ stock floors, hourly re-alerts + RESOLVED messages.

**Mainnet rules.**
- Alert on OUTCOMES (epoch advanced? settles landing? fills > 0 when queue
  > 0?), not just process liveness.
- The fee-drain signature ("auto-roll … failed") was only visible in
  container logs — ship daemon metrics (Prometheus exists in-repo, unused)
  and alert from metrics, not log greps, before mainnet.
- Keep runbooks next to alerts: every alert key in the health-watch script
  should map to a written response procedure.

## 7. Batch UX debt: stranded escrows

Failed epochs (6, 45, 47, 50, 53) left escrowed order funds in the orderbook
with no settlement. Amounts were small and admin-owned, but on mainnet these
are USER funds. Before mainnet:
- implement + test the refund/cancel path for orders in closed-without-clear
  epochs, and surface it in the UI;
- add an invariant check (escrow balance == open-order obligations) to the
  monitoring.

## 8. What the validation finally proved (keep as regression baseline)

- Commit→reveal→multi-pool price discovery→ZK proof→on-chain verified settle
  works end-to-end with REAL orders on 3 pools simultaneously
  (`cleared:fills=3`, tx `0x1218ed3b…`, block 110148).
- Flow-binding conservation held on-chain (aggregate reserves == bucket sums
  on all 3 pools post-clear).
- The adversarial suite (A1 fabricated state / A3 mis-pointed pool / A4
  mismatched flows) reverts with exact messages on the live contracts.
- Faucet drip and USDC/WETH L1↔L2 bridging verified live with on-chain
  balance deltas.

**Mainnet entry checklist seeded from this cycle:** longer/On-demand epochs ·
first-party fee funding with rate alerts · paid RPC in settlement path ·
deploy-script address verification · refund path for stranded escrows ·
metrics-based alerting · captcha ON for any faucet-like endpoint · DNS/infra
changes staged days ahead · all of §1–§7 re-tested on a mainnet-fork dress
rehearsal before announcement.
