#!/usr/bin/env bash
# Honest-clear watcher for Task 11 validation.
# Phase 1: poll daemon /health until block >= CLOSES (epoch 1 expiry).
# Phase 2: capture the clear cycle (drain/validate/prove/submit) outcome.
set -u
SSH="ssh -o BatchMode=yes -o ConnectTimeout=12 root@194.163.136.1"
CLOSES=104419
LOG=/tmp/q_clear_watch.log
: > "$LOG"
echo "WATCH_START $(date -u +%H:%M:%S) closes_at=$CLOSES" >> "$LOG"

# Phase 1: wait for epoch expiry (cap ~3h)
for i in $(seq 1 200); do
  H=$($SSH 'curl -s --max-time 10 localhost:3001/health' 2>/dev/null)
  block=$(printf '%s' "$H" | grep -oE 'lastBlockSeen":[0-9]+' | grep -oE '[0-9]+')
  queue=$(printf '%s' "$H" | grep -oE 'queueSize":[0-9]+' | grep -oE '[0-9]+$')
  echo "$(date -u +%H:%M:%S) i=$i block=${block:-?} queue=${queue:-?}" >> "$LOG"
  if [ -n "${block:-}" ] && [ "$block" -ge "$CLOSES" ]; then
    echo "EPOCH_EXPIRED at block=$block" >> "$LOG"; break
  fi
  sleep 55
done

# Phase 2: capture clear cycle for up to ~20 min
echo "PHASE2_CAPTURE $(date -u +%H:%M:%S)" >> "$LOG"
for j in $(seq 1 40); do
  L=$($SSH 'docker logs --since 80s quetzal-aggregator 2>&1 | grep -iE "drain|validated|replay|wouldClear|clearing|prove|nargo|submit|close_epoch_and_clear|revert|settle|fills|mismatch|error|verify"' 2>/dev/null)
  [ -n "$L" ] && printf '%s\n' "$L" >> "$LOG"
  if printf '%s' "$L" | grep -qiE "close_epoch_and_clear|cleared|settl|replay mismatch|revert|verify failed|commitment mismatch"; then
    echo "OUTCOME_DETECTED $(date -u +%H:%M:%S)" >> "$LOG"; break
  fi
  sleep 30
done
echo "WATCH_END $(date -u +%H:%M:%S)" >> "$LOG"
# Final daemon state
$SSH 'echo "=== final health ==="; curl -s localhost:3001/health; echo; echo "=== last 40 daemon lines ==="; docker logs --tail 40 quetzal-aggregator 2>&1' >> "$LOG" 2>&1
