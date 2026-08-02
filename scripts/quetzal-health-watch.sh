#!/usr/bin/env bash
# Quetzal health watch — runs from cron every 5 min on the ops VPS.
#
# Checks (all local — no L1/L2 RPC reads):
#   1. aggregator /health reachable + ok:true
#   2. watcher.lastError must be null
#   3. watcher.lastPollAt must be fresh (< 5 min)
#   4. epoch must advance (lastEpochSeen unchanged > 45 min → stuck;
#      epochs are ~17 min and auto-roll keeps them moving)
#   5. daemon logs: any "auto-roll close_epoch failed" in the last 6 min
#      (catches the fee-payer-out-of-fee-juice failure mode of 2026-06-09/10)
#   6. faucet /api/health reachable + status:ok
#   7. faucet stock floors: operator L1 ETH >= 0.05, L1 fee-juice >= 1000 FJ
#
# Alerts: ntfy.sh push (subscribe to the topic in the ntfy app / browser).
# Policy: alert on first detection; re-alert hourly while broken; RESOLVED
# message when a check recovers. State in /var/lib/quetzal-health/.
set -uo pipefail

NTFY_TOPIC=${NTFY_TOPIC:-quetzal-ops-c20726ba6807}
STATE_DIR=/var/lib/quetzal-health
REALERT_SECONDS=3600
mkdir -p "$STATE_DIR"
NOW=$(date +%s)

alert() { # alert <key> <message>
  local key=$1 msg=$2 last=0
  [ -f "$STATE_DIR/$key.alerted" ] && last=$(cat "$STATE_DIR/$key.alerted")
  if [ $((NOW - last)) -ge $REALERT_SECONDS ]; then
    curl -s -m 10 -H "Title: Quetzal ALERT: $key" -H "Priority: high" \
      -d "$msg" "https://ntfy.sh/$NTFY_TOPIC" >/dev/null || true
    echo "$NOW" > "$STATE_DIR/$key.alerted"
  fi
  echo "[health $(date -u +%FT%TZ)] ALERT $key: $msg"
}

resolve() { # resolve <key>
  local key=$1
  if [ -f "$STATE_DIR/$key.alerted" ]; then
    rm -f "$STATE_DIR/$key.alerted"
    curl -s -m 10 -H "Title: Quetzal resolved: $key" \
      -d "$key has recovered" "https://ntfy.sh/$NTFY_TOPIC" >/dev/null || true
    echo "[health $(date -u +%FT%TZ)] RESOLVED $key"
  fi
}

# ── 1-3: aggregator health ────────────────────────────────────────────────
HEALTH=$(curl -s -m 10 http://localhost:3001/health || true)
if [ -z "$HEALTH" ] || [ "$(echo "$HEALTH" | jq -r '.ok' 2>/dev/null)" != "true" ]; then
  alert daemon-down "aggregator /health unreachable or ok!=true: ${HEALTH:0:200}"
else
  resolve daemon-down
  LAST_ERR=$(echo "$HEALTH" | jq -r '.watcher.lastError')
  if [ "$LAST_ERR" != "null" ]; then
    alert daemon-error "watcher.lastError: ${LAST_ERR:0:200}"
  else
    resolve daemon-error
  fi
  POLL_AT=$(echo "$HEALTH" | jq -r '.watcher.lastPollAt')
  POLL_TS=$(date -d "$POLL_AT" +%s 2>/dev/null || echo 0)
  if [ $((NOW - POLL_TS)) -gt 300 ]; then
    alert watcher-stale "lastPollAt is $(( (NOW - POLL_TS) / 60 )) min old ($POLL_AT)"
  else
    resolve watcher-stale
  fi
  # ── 4: epoch advance ──
  EPOCH=$(echo "$HEALTH" | jq -r '.watcher.lastEpochSeen')
  PREV_EPOCH=0 PREV_TS=$NOW
  if [ -f "$STATE_DIR/epoch.state" ]; then read -r PREV_EPOCH PREV_TS < "$STATE_DIR/epoch.state"; fi
  if [ "$EPOCH" != "$PREV_EPOCH" ]; then
    echo "$EPOCH $NOW" > "$STATE_DIR/epoch.state"
    resolve epoch-stuck
  elif [ $((NOW - PREV_TS)) -gt 2700 ]; then
    alert epoch-stuck "epoch $EPOCH unchanged for $(( (NOW - PREV_TS) / 60 )) min"
  fi
fi

# ── 5: auto-roll fee failures in recent daemon logs ───────────────────────
ROLL_FAILS=$(docker logs --since 6m quetzal-aggregator 2>&1 | grep -c "auto-roll close_epoch failed" || true)
if [ "${ROLL_FAILS:-0}" -gt 0 ]; then
  alert auto-roll-failing "$ROLL_FAILS auto-roll failures in last 6 min (fee payer broke? check FJ balance / auto-topup log)"
else
  resolve auto-roll-failing
fi

# ── 6-7: faucet health + stock floors ─────────────────────────────────────
FHEALTH=$(curl -s -m 10 http://localhost:3030/api/health || true)
if [ -z "$FHEALTH" ] || [ "$(echo "$FHEALTH" | jq -r '.status' 2>/dev/null)" != "ok" ]; then
  alert faucet-down "faucet /api/health unreachable or status!=ok: ${FHEALTH:0:200}"
else
  resolve faucet-down
  ETH_WEI=$(echo "$FHEALTH" | jq -r '.l1.operatorBalanceEth')
  FJ_RAW=$(echo "$FHEALTH" | jq -r '.l1.operatorBalanceFeeJuice')
  # operatorBalanceEth is a decimal-ETH string; FJ is atomic (1e18)
  ETH_LOW=$(python3 -c "print(1 if float('$ETH_WEI') < 0.05 else 0)" 2>/dev/null || echo 0)
  FJ_LOW=$(python3 -c "print(1 if int('$FJ_RAW') < 1000*10**18 else 0)" 2>/dev/null || echo 0)
  if [ "$ETH_LOW" = "1" ]; then alert faucet-eth-low "operator L1 ETH = $ETH_WEI (< 0.05)"; else resolve faucet-eth-low; fi
  if [ "$FJ_LOW" = "1" ]; then alert faucet-fj-low "operator L1 fee-juice low: $FJ_RAW (< 1000 FJ → ~<10 drips)"; else resolve faucet-fj-low; fi
fi
