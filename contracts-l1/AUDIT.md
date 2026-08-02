# Quetzal L1 Bridge — Audit Brief

**Audit target commit:** `2747700e48fc0eb8d84a489afdd4c4468d5918a9` (git tag `sub5c-audit-snapshot`)
**Audit window opens:** 2026-05-23 (Sub-5c code-complete)
**Scope owner:** Quetzal core team
**Audit scope:** L1 portal contracts (`contracts-l1/`)

## Scope (in-scope contracts)

- `contracts-l1/src/TokenBridge.sol` — UUPS-upgradeable + AccessControl + Pausable L1 portal contract. **PRIMARY AUDIT TARGET.**
- `contracts-l1/src/interfaces/IInbox.sol` — interface mirror of Aztec's L1↔L2 message inbox. No logic; ABI shape only.
- `contracts-l1/src/interfaces/IOutbox.sol` — interface mirror of Aztec's L1↔L2 message outbox. No logic.
- `contracts-l1/src/lib/DataStructures.sol` — L1↔L2 message struct definitions + 4 domain-separator tag constants for the bridge's content hash.
- `contracts-l1/src/lib/TimeMath.sol` — minimal mirror of Aztec's `Epoch` user-defined value type (`type Epoch is uint256`).
- `contracts-l1/script/DeployAllBridges.s.sol` — Foundry deploy script that produces the production topology.

## Out-of-scope

- `@aztec/l1-artifacts@5.0.0` Inbox.sol + Outbox.sol implementations — the live Aztec rollup contracts on L1. Quetzal depends on these existing + behaving correctly; auditing them is Aztec's responsibility.
- Aztec L2 Noir contracts (`contracts/token/src/main.nr`, `contracts/orderbook/`, `contracts/pool/`, etc.) — separate Noir audit recommended (Aztec's `aztec-nr` is itself under continuous review).
- L2 ↔ L1 client integration (`cli/`, `aggregator/`, `tools/outbox-proof/`) — JS/TS code; safety surface limited to what L1 contracts enforce.
- OpenZeppelin v5.0.2 itself — pinned + vendored as `contracts-l1/lib/openzeppelin-contracts/` and `contracts-l1/lib/openzeppelin-contracts-upgradeable/`. Auditor reviews Quetzal's usage of OZ, not OZ's own code.

## Trust model

- **Owner:** Two TimelockController instances (OpenZeppelin v5.0.2 `TimelockController`):
  - **Governance timelock** — 7-day delay on mainnet (0 on testnet). Admin: 3-of-5 Gnosis Safe multisig. Has `GOVERNANCE_ROLE` on every TokenBridge: setMaxTvl, setL2TokenAddress, withdrawTreasuryDust, _authorizeUpgrade (UUPS), approveRecovery.
  - **Emergency timelock** — 0-day delay always. Admin: 2-of-3 separate Gnosis Safe multisig (distinct signer set from governance). Has `EMERGENCY_PAUSER_ROLE` on every TokenBridge: pause, unpause.

- **Role admin invariant:** `EMERGENCY_PAUSER_ROLE` is its own admin (set at `initialize` via `_setRoleAdmin`). The governance timelock holds `DEFAULT_ADMIN_ROLE` for everything else, but **cannot revoke or rotate the emergency role** — this prevents a compromised governance multisig from silently disabling the emergency pause path during a 7-day attack window.

- **TVL cap:** Per-portal soft limit (`uint256 maxTvl`). 0 = unlimited. Caps are token-native-units, NOT USD-normalized. Initial mainnet values: USDC 10,000_000_000 (~$10k), WETH 4_000_000_000_000_000_000 (~$10k @ $2.5k/ETH), wBTC 10_000_000 (~$10k @ $100k/BTC). Adjustable via `setMaxTvl` (7-day timelocked).

- **Per-asset deposit tracking:** Each `depositToL2Public/Private` writes a `Deposit` record keyed by `keccak256(msg.sender, secretHash)` for the 3-phase `recoverDeposit` flow. The original depositor is the only L1 entity that can recover. Knowledge of the secret alone is INSUFFICIENT for L1 recovery (the L2 claim path remains under secret-only control as before).

## Known issues (operator-acknowledged carryforwards)

1. **Fee-on-transfer / deflationary token incompatibility.** `_enforceTvlCap` projects post-deposit total as `balanceOf + amount`. This assumes a standard ERC20 where `amount` is exactly what arrives. Fee-on-transfer tokens would underflow the projection. **Mitigation:** Quetzal launches with USDC + WETH + wBTC — all standard ERC20s. Adding any non-standard token requires reviewing this assumption. Flagged in `setMaxTvl` NatSpec.

2. **`recoverDeposit`'s off-chain L2-consumption check.** Phase 2 (`approveRecovery`) requires the governance multisig to manually verify on L2 that the corresponding L1→L2 message has NOT been consumed. There is no on-chain L1 way to read L2 nullifier state directly. If governance approves a recovery for a deposit that WAS already consumed on L2, the maker double-spends. **Mitigation:** 90-day waiting period (`block.timestamp >= d.timestamp + 90 days`) gives operators ample time + observability. The audit should confirm the on-chain logic correctly prevents same-key replay (state clearing on execute) and that there is no race window across phases.

3. **`Number(BigInt)` precision in Prometheus exporter.** For 18-decimal tokens (WETH) at scales ≥ 9 ETH, gauge values lose precision (Number's 2^53 limit). Observability-level acceptable; not a fund-safety issue. Tools/exporters/src/l1-exporter.ts:NOTE.

4. **`exit_to_l1_private` ↔ `withdrawPrivate` pairing.** Sub-5b shipped `exit_to_l1_private` on L2 with a banner that "no L1 consumer exists yet." Sub-5c B3 ships `withdrawPrivate`. Both directions use `WITHDRAW_PRIVATE_TAG` content; cross-mode confusion impossible (different content hash from PUBLIC_TAG flow). Audit should confirm the byte-for-byte alignment between L1 + L2 reconstructions.

5. **PXE tagging window caps anonymity-set growth.** Aztec PXE has a hard limit of ~20 unfinalized private submits per wallet. A maker who pushes `submit_order_bulk` with K=9 decoys consumes 9 slots of the tagging window per bulk tx. After ~2 bulk submissions the wallet stalls until earlier txs finalize. The anonymity set per epoch is therefore bounded by the wallet's tagging capacity, not by Sub-6a's design parameters.
   - **Impact:** Low. Performance bound, not a correctness bug.
   - **Likelihood:** N/A (architectural constraint).
   - **Mitigation:** Wait for tx finalization, OR use a second wallet, OR reduce decoys to K=4 to fit 4 bulks per tagging window.
   - **Status:** Known. Documented as architectural limitation, not a Sub-6a bug.
   - **Notes:** Aztec-version specific; last re-evaluated against 5.0.0. Re-check on each Aztec upgrade.

## Threat model

The following threats were considered during design. Each lists the mitigation in place; auditor verifies sufficiency.

| ID | Threat | Mitigation |
|---|---|---|
| **T-1** | Portal fund drain via direct external call | All withdraw paths go through `outbox.consume()` which is one-shot per (epoch, leafIndex) per Aztec rollup contract; `whenNotPaused` guard; `SafeERC20` |
| **T-2** | Ownership takeover via initialize re-entry | `Initializable._disableInitializers()` in constructor; `initializer` modifier on `initialize`; verified in A3 + A2 tests |
| **T-3** | Replay via Outbox double-consume | Aztec Outbox's `hasMessageBeenConsumedAtEpoch` flag; `outbox.consume` reverts on already-consumed; `test_withdraw_doubleConsume_reverts` covers |
| **T-4** | Governance collusion → drain | 7-day timelock window for all governance ops; community observation possible during window |
| **T-5** | Upgrade-during-pause exploit | Emergency role can only pause/unpause; cannot upgrade (`_authorizeUpgrade` requires GOVERNANCE_ROLE). An emergency pause cannot bundle a malicious upgrade |
| **T-6** | Treasury dust sweep abuse | `withdrawTreasuryDust` reverts if token == l1Token; can only sweep accidentally-sent OTHER ERC20s |
| **T-7** | TVL cap bypass | Pre-transfer balance projection check; assumes standard ERC20 (see Known Issue #1) |
| **T-8** | Recovery race / double-spend across L1+L2 | Sender-identity gate (only original depositor); 90-day window; multisig approval; full state clearing on `executeRecovery`; secret leak insufficient |
| **T-9** | Content-hash collision across flows | 4 domain-separator tags (DEPOSIT_PUBLIC/PRIVATE, WITHDRAW_PUBLIC/PRIVATE); 248-bit field-fitting values; ASCII-readable in logs; same byte values on L1 + L2 |
| **T-10** | Initialize race (impl init before proxy points at it) | `_disableInitializers()` in implementation constructor blocks any direct initialize on the implementation; only the proxy's delegated initialize works |
| **T-11** | Emergency-role takeover via governance | `EMERGENCY_PAUSER_ROLE` self-admin invariant set at initialize; governance cannot reach the role |
| **T-12** | Stale codegen → CLI misinvocation | Operator concern; runbook documents `pnpm codegen` step pre-deploy. Defense-in-depth: every contract function uses custom errors + revert messages so a wrong-ABI call returns a structured error, not silent corruption |
| **T-13** | Bulk-submit gate-budget exhaustion | `MAX_ORDERS_PER_BULK = 5` hard cap (downsized from 9 after A5 2026-05-23 measurement showed K=9 = 581K gates, K=5 = 312K gates). Per-tx gas pricing on Aztec L2 provides natural rate limiting |
| **T-14** | Decoy-registry corruption attack | Accepted limitation — registry is intentionally local + unprivileged; attacker needs maker-machine filesystem access (at which point private keys are also exposed). Cancel path still requires the legitimate signing key; fund loss is not possible |
| **T-15** | Bridge round-trip advisory bypass via amount fuzzing | Maker uses `--split-into N` (multi-hop split) + amount perturbation (`--ack-round` prompt) + non-default `--recipient` address. Advisory is warn-only; `--ack-delay` disables the heuristic if the maker's use case requires the deposit pattern |
| **T-16** | Trade-direction path-order leak | Noir circuit asserts `path[0] < path[path_len-1]` (Sub-6c A1); SDK auto-canonicalizes (A2). Direction is encoded only in private `side` bool; path no longer leaks. Status: closed |
| **T-17** | WalletPool exhaustion | Maker's N child wallets all at PXE_TAGGING_CAP=18 saturate the pool; `next()` throws `WalletPoolExhausted`. Frontend must catch + show "wait for finalization OR grow pool" message. Status: accepted limitation; architectural, not a vulnerability |

### T-13 detail — Bulk-submit gate-budget exhaustion

A maker submitting `submit_order_bulk` with all 5 slots filled performs K=5 internal calls, each enqueueing 3 public enqueues (escrow + epoch-state mutation + `_assert_path_pools_registered` callback), for 15 public enqueues per private tx. Measured circuit_size = 312,538 gates at K=5 (within the 350K UX-acceptable threshold). The previous K=9 design measured at 581,228 gates -- above threshold -- and was downsized in A5.

- **Impact:** Medium. A malicious maker can attempt to spam bulk submissions to DoS the public queue. Per-tx gas pricing on the Aztec L2 side is the natural rate limit.
- **Likelihood:** Low under normal load; high under coordinated spam.
- **Mitigation:** `MAX_ORDERS_PER_BULK = 5` hard cap in `contracts/orderbook/src/main.nr`. See `docs/superpowers/specs/sub6a-gate-measurement.md` for the full per-K table.
- **Status:** Resolved as of 2026-05-23 A5 measurement run.
- **Notes:** Decoy registry is a maker-side privacy tool; the contract treats all 5 slots identically. Any maker can spam at the gas cost of 5 escrows.

### T-14 detail — Decoy-registry corruption attack

`~/.quetzal/decoy-registry-<wallet>.json` is unsigned local state. If a maker's filesystem is compromised, an attacker can flip `isDecoy: true` → `false` for a real order, causing the maker's claim command to not skip-filter that nonce, leaking the claim back into the on-chain settlement set. The reverse attack (flip `false` → `true`) causes the maker to lose access to a real fill by treating it as a decoy and canceling it.

- **Impact:** Low. The attacker needs maker-machine filesystem access, at which point they have private keys anyway.
- **Likelihood:** Low (defense in depth).
- **Mitigation:** None at contract layer (registry is intentionally local + unprivileged). Documented as a known limitation in Sub-6a README. Operator follow-up: signed JSON or HMAC-on-disk if real-world attestation needs emerge.
- **Status:** Open (accepted limitation; mitigation deferred).
- **Notes:** This is a privacy degradation, not a fund loss — the `cancel_order` path still requires the legitimate signing key.

### T-15 detail — Bridge round-trip advisory bypass via amount fuzzing

C2's `isRoundTripRisk` flags 5%-tolerance amount matches between an L1 deposit and a subsequent L1 exit-claim. An attacker observing the deposit can predict the maker's likely exit amount and deliberately match it with a different L1 EOA to dilute the privacy signal. The advisory is a maker-side hint, not a contract enforcement; an adversary cannot trigger a false-positive ack on the maker's machine but can amplify the natural matching probability by colluding with multiple deposits around the same amount.

- **Impact:** Low. Maker can perturb amount + use `--split-into` to defeat.
- **Likelihood:** Low (adversary must observe + predict before the maker exits).
- **Mitigation:** Maker uses `--split-into N` (multi-hop split, C3) + amount perturbation (`--ack-round` prompt, D2) + non-default `--recipient` address. The advisory itself is warn-only; the maker can also disable the heuristic with `--ack-delay` if their use case requires the deposit pattern.
- **Status:** Open (defense-in-depth; not a single-point fix).
- **Notes:** Bridge surfaces leak more information than orderbook surfaces because L1 is fully public. The advisory is meant to inform, not block.

## Dependencies + supply chain

- **OpenZeppelin v5.0.2** (`contracts-l1/lib/openzeppelin-contracts/` + `openzeppelin-contracts-upgradeable/`) — pinned tag, vendored, not modified.
- **forge-std v1.7.x** — pinned in `lib/forge-std/`.
- **Foundry** — solc 0.8.27, via_ir = true, optimizer_runs = 200. Defined in `contracts-l1/foundry.toml`.
- **Aztec L1 artifacts** — `@aztec/l1-artifacts@5.0.0` (Inbox + Outbox interfaces mirrored into our `IInbox.sol` + `IOutbox.sol`).
- No on-chain proxy library used beyond `ERC1967Proxy` from OZ.

## Test coverage at audit-window-open

Post-Sub-5c numbers (run from `contracts-l1/`):

- **Foundry tests: 31 pass** (`forge test`):
  - 25 TokenBridgeTest unit tests in `contracts-l1/test/TokenBridge.t.sol` (covering deposit + withdraw + withdrawPrivate + pause + TVL cap + recoverDeposit 3-phase + role-separation + EMERGENCY_PAUSER_ROLE self-admin invariant)
  - 6 BridgeFlowTest integration tests in `contracts-l1/test/BridgeFlow.t.sol` (covering multisig→timelock→bridge governance flow + governanceTimelockCannotPause)
- **Noir TXE tests: 5 bridge-mode tests** in `contracts/token/src/test.nr` (Docker-blocked local execution; CI runs).
- **Forge coverage:** run `forge coverage --report lcov` for line/branch coverage; commit the LCOV.

## Out-of-band verification artifacts

- **Etherscan source verification** — `forge script ... --verify --etherscan-api-key $ETHERSCAN_API_KEY` is the canonical deploy invocation per sub5c-runbook.md. All 6 contracts (2 TimelockControllers + 3 TokenBridge proxies + 3 TokenBridge implementations) verified post-deploy.
- **Slither static analysis** — `tools/audit/run-slither.sh` runs Slither against `contracts-l1/`. Output committed as `contracts-l1/audit/slither-<date>.txt`.
- **Foundry gas report** — `forge test --gas-report > contracts-l1/audit/gas-report-<date>.txt` at audit window open.

## Audit deliverables expected

The audit firm should produce:

1. **Findings report** — Critical / High / Medium / Low / Informational categorization. Each finding with: location (file:line), description, impact, recommended fix.
2. **Threat model coverage** — confirmation each T-1..T-15 mitigation is sufficient, OR new threats identified.
3. **Code recommendations** — non-blocking improvements (style, gas, naming, NatSpec) at any severity.
4. **Sign-off statement** — text usable in a public bug-bounty announcement.

## Post-audit process

- All Critical + High findings: fixed BEFORE mainnet open, separate PR per finding referencing audit ID.
- Medium findings: triaged; may be accepted with explicit rationale in this doc.
- Low + Informational: tracked in GitHub issues; addressed during normal sprint.
- Findings remediation is its own project (Sub-5d candidate); Sub-5c does NOT block on the audit report.

### T-16 detail -- Trade-direction path-order leak

submit_order's `path: [Field; 3]` field-array was previously interpreted in submission direction: a sell from USDC to ETH stored `[USDC, ETH]`; a buy of USDC from ETH stored `[ETH, USDC]`. On-chain observers reading the public submit tx would see this redundantly encode the direction that the private `side` bool was supposed to hide.

Sub-6c A1 circuit enforces `path[0] < path[path_len-1]` (lex-sorted endpoints) via the codebase convention `(field as u128) < (field as u128)`. Sub-6c A2 SDK transparently canonicalizes: if user-input path is reversed, SDK flips the `side` bool + reverses the array. Post-canonical: `side=buy` means maker pays canonical-low + receives canonical-high; `side=sell` is the inverse.

Side itself remains private (encrypted in the OrderNote). The on-chain escrow call to `Token.transfer_private_to_public(...)` still reveals which token the maker spent (the input asset) -- this is the residual #2-leak, deferred to Sub-6d as "full direction obscure" via per-token shielded escrow pool.

- **Impact:** Medium. Pre-fix: observer could correlate path direction with side, learn maker's direction even for private orders.
- **Likelihood:** High under adversarial monitoring.
- **Mitigation:** A1 + A2 + A3 doc.
- **Status:** Closed (path-order leak fully fixed; residual escrow-side leak deferred).
- **Notes:** Backward-compat: existing SDK callers see no behavior change; canonicalization is transparent.

### T-17 detail -- WalletPool exhaustion

Aztec PXE caps ~20 unfinalised private submits per wallet. Sub-6c B1-B3 `WalletPool` distributes across N wallets to give frontend ~N*18 capacity (PXE_TAGGING_CAP=18 with safety buffer), but a maker that opens many orders in rapid succession can saturate all N. `WalletPool.next()` throws `WalletPoolExhausted` with a helpful message.

- **Impact:** Low. UX degradation, not security. Maker either waits ~6-10s for testnet finalization OR grows pool by adding more child wallets (requires fresh fee-juice drip per child).
- **Likelihood:** Medium for heavy power-user / market-maker patterns.
- **Mitigation:** Document in `docs/wallet-pool.md`; default pool size N=3 conservative; max N=20 configurable.
- **Status:** Accepted architectural limitation.
- **Notes:** Aztec-version specific; last re-evaluated against 5.0.0. Re-check the per-wallet tagging cap on each upgrade.
