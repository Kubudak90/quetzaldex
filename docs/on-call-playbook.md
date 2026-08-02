# Quetzal On-Call Playbook

This playbook codifies the operator response to production alerts + incidents
for the Quetzal L1↔L2 bridge + L2 dark-pool exchange. Audience: on-call
engineers + 2-of-3 emergency multisig signers + 3-of-5 governance multisig
signers.

## Severity classification

| Sev | Definition | Response time | Channels |
|-----|------------|---------------|----------|
| **SEV1** | Bridge funds at risk, paused unexpectedly, drain attempt detected, L2 orderbook clearing stalled with funds in flight | <15 min | PagerDuty page + emergency multisig huddle (Signal/Telegram) |
| **SEV2** | Orderbook stalled >1h (no clearing), aggregator daemon outage, treasury balance dry blocking aggregator fee payouts, exporter scrape failure >30min | <1 hour | Slack #quetzal-ops + governance multisig async |
| **SEV3** | Monitoring alert (TVL near cap, outbox backlog, single-portal pause that is operator-initiated), CLI UX regression reported | <4 hours | Slack #quetzal-ops |
| **SEV4** | Documentation gap, dashboard cosmetic issue, governance proposal that isn't time-critical | next business day | GitHub issue with `sub5d` label |

## Escalation tree

```
On-call (PagerDuty rotation)
        ↓ unable to mitigate within 15min for SEV1
Tech lead (Slack DM)
        ↓ tech lead unreachable or escalation required
Emergency Multisig Signer #1 (Signal/Telegram)
        ↓
Emergency Multisig Signer #2
        ↓
Emergency Multisig Signer #3
        ↓
Governance Multisig (full-team huddle for governance ops)
```

Multisig signer contacts: see `docs/contacts.md` (private, not committed; lives
in 1Password / shared vault).

## Per-alert runbooks

Each Prometheus/Alertmanager alert has a corresponding section in
the incident-response runbook (git history: docs/superpowers/specs/sub5c-runbook.md). Link directly from PagerDuty
incident messages:

| Alert | Severity | Runbook section |
|---|---|---|
| `BridgePaused` | SEV1 (page) | `sub5c-runbook.md#emergencypauser-incident-response` |
| `BridgeTvlNearCap` | SEV3 (warn) | `sub5c-runbook.md#tvl-cap-ramp` |
| `OrderbookStalled` | SEV1 (page) | `sub5c-runbook.md#aggregator-recovery` |
| `OutboxBacklog` | SEV3 (warn) | `sub5c-runbook.md#withdraw-flow-debugging` |
| **(new alert)** | — | add a runbook section + link the alert here as the first onboarding step for any new alert |

## SEV1 — Bridge funds at risk: immediate response

1. **Verify the alert.** Check Grafana `Quetzal Bridge Health` dashboard for context (TVL trend, paused state, outbox backlog). False positives happen; spending 30s confirming saves a multisig huddle.

2. **Page emergency multisig signers** via PagerDuty + Signal/Telegram. Goal: 2-of-3 quorum reachable within 5 minutes.

3. **Pause the affected portal(s).** Via the 0-delay emergency timelock:

   ```bash
   # Multisig signer 1 proposes via Safe UI; signer 2 confirms.
   # OR (if Safe UI down) sign via cast multisend equivalent + propagate.
   cast send $EMERGENCY_TIMELOCK \
     "schedule(address,uint256,bytes,bytes32,bytes32,uint256)" \
     $BRIDGE_ADDR 0 $(cast calldata "pause()") 0x0 0x0 0
   # Immediately execute (delay=0):
   cast send $EMERGENCY_TIMELOCK \
     "execute(address,uint256,bytes,bytes32,bytes32)" \
     $BRIDGE_ADDR 0 $(cast calldata "pause()") 0x0 0x0
   ```

4. **Post a status update** to the public status page within 15 minutes:
   - What happened (1-2 sentences, no speculation)
   - What's affected (which portal, which users)
   - What we're doing (investigating; bridge paused as precaution)
   - Next update ETA

5. **Begin investigation** in a dedicated incident channel. Snapshot:
   - Last 24h of bridge events (`quetzal_bridge_*` metrics)
   - Last 24h of governance / emergency timelock txs
   - L1 portal address etherscan history
   - L2 orderbook last clearings
   - Aggregator daemon logs

## SEV1 — Orderbook clearing stalled with funds in flight

This is a different SEV1 from bridge-funds-at-risk. The clearing pipeline
(Sub-3 aggregator) is down + makers have submitted orders that can't be
filled until clearing resumes.

1. **Verify the alert.** Grafana `MEV-Protection Health` panel: "Seconds since
   last clearing". If >3600 + climbing, the alert is real.

2. **Page the aggregator team** (separate rotation from bridge on-call).

3. **Check aggregator daemon status:**
   ```bash
   ssh root@161.97.110.1
   docker ps | grep quetzal-aggregator
   docker logs --tail 200 quetzal-aggregator-1
   ```

4. **If daemon crashed:** restart. If repeated crashes: switch to backup
   aggregator (separate VPS) by updating the registered aggregator address
   in the registry via governance multisig.

5. **Update status page** within 30 minutes. Mention: order submissions are
   still accepted; clearing is paused until aggregator recovers; cancel
   path remains available.

## SEV2 — Orderbook stalled >1h

Similar to SEV1 but lower urgency (no funds at immediate risk; makers can
cancel orders during OPEN epochs).

1. Verify; page aggregator team via Slack (not PagerDuty).
2. Check daemon + logs as above.
3. Operator restarts daemon OR pauses orderbook via governance until aggregator
   is healthy. (Pause path needs Sub-5d if not yet built; for now restart is
   the only mitigation.)

## SEV3 — Monitoring alerts

Each SEV3 has a corresponding runbook entry. The general flow:

1. Acknowledge the alert in PagerDuty/Slack (silences for 4 hours; respond
   within that window).
2. Open the linked runbook section.
3. Execute the runbook's mitigation steps.
4. Close the alert OR escalate to SEV2/SEV1 if the situation worsens.

## Rotation

**Schedule:** PagerDuty service "quetzal-oncall". 3 engineers in rotation;
weekly handoff (Monday 09:00 UTC). On-call covers SEV1 + SEV2; SEV3 + SEV4
handled async during business hours.

**Hand-off ritual** (every Monday at handoff):
1. Outgoing on-call: review the past week's alerts in Grafana + PagerDuty.
   Identify any patterns (recurring false positives, missing runbooks, etc.).
2. Incoming on-call: confirm access to PagerDuty + Signal/Telegram + VPS SSH
   keys + Safe UI.
3. File post-mortems for any SEV1 incidents from the past week (see template
   below). Ensure each SEV1 has at least one action item filed as a GitHub
   issue.

## Post-mortem template

Location: `docs/post-mortems/YYYY-MM-DD-<incident-slug>.md`

```markdown
# Incident YYYY-MM-DD: <one-line description>

**Severity:** SEV1 | SEV2 | SEV3
**Duration:** <impact start> → <recovery>
**On-call:** <engineer name>
**Reporters:** <who first noticed; alert ID; user reports>

## Timeline

- HH:MM UTC — Alert fires
- HH:MM UTC — On-call acknowledges
- HH:MM UTC — Mitigation begins (link to commands run)
- HH:MM UTC — Service restored
- HH:MM UTC — Status page updated to all-clear

## Root cause

<What actually went wrong. Be specific — file:line + commit SHA if applicable.>

## What worked

<What helped detection + recovery. Praise specific tooling/people. Future
us will read this and feel less afraid.>

## What didn't

<Gaps in tooling, runbook, or process. Be honest. This section drives the
action items.>

## Action items

- [ ] AI-1: <ticket title>  (Owner: @name, ETA: <date>, label: sub5d)
- [ ] AI-2: ...

## Lessons / pattern

<Optional: was this a recurrence of a prior pattern? Link to past PMs.>
```

## Bug-bounty interaction

When a bug bounty report arrives via Immunefi:

1. **Triage within 24 hours** (severity assignment + ack to reporter).
2. **Coordinate fix** with security-rotation engineer + governance multisig.
3. **Disclose** per Immunefi's policy (typically 90-day private + public post-fix).
4. **Update threat model** in `contracts-l1/AUDIT.md` post-disclosure.

## Mainnet pause-button accessibility test

**Quarterly drill:** every 3 months, the on-call team simulates a SEV1
pause-the-bridge incident on testnet. Goal: 2-of-3 emergency multisig
reach + pause complete within 15 minutes from "page" to "paused".

Drill output: timestamp log + identified friction points + GitHub issues
to address.
