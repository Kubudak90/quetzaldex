#!/usr/bin/env bash
# Auto-topup fee-juice when below a floor — via the OWN L1 BRIDGE (correct portal 0xd336…).
#
# 2026-06-23 REWRITE: the old primary (topup-admin-faucet.ts → Nethermind faucet) bridged
# FJ to a STALE portal 0x7c4176bf…/inbox 0x599e8d0a… that the CURRENT rollup (inbox
# 0xf1bb424a…, portal 0xd3361019…) never reads → deposits stranded FOREVER. Removed it.
# We now use scripts/bridge-fj-to-admin.ts directly (faucet/src/lib/l1-bridge.js =
# L1FeeJuicePortalManager → reads the CORRECT portal from the node). Balance read uses
# scripts/check-fj.ts (node storage read; the old check-admin-fj.ts is broken on
# @aztec/protocol-contracts).
#
# Env (set on the cron line):
#   AZTEC_NODE_URL=<PAID drpc>        (must contain 'testnet'; aztec-labs is down — DO NOT use it)
#   STATIC_MAX_FEE_PER_L2_GAS / STATIC_MAX_FEE_PER_DA_GAS
#   AUTO_TOPUP_FLOOR_FJ=150          (top up when below this)
#   BRIDGE_FALLBACK_FJ=200           (amount bridged per run)
#   TOPUP_M1_STATE=<m1-key file of the wallet to keep funded>
#   TOPUP_STATE=<resumable state prefix>      TOPUP_PXE_DIR=<pxe dir>
# Needs FAUCET_L1_PK / FAUCET_L1_RPC_URL (passed via the faucet --env-file) for the L1 deposit.
set -eo pipefail
cd "$(dirname "$0")/.."

FLOOR_FJ=${AUTO_TOPUP_FLOOR_FJ:-150}
BRIDGE_FJ=${BRIDGE_FALLBACK_FJ:-200}
M1_STATE=${TOPUP_M1_STATE:-testnet-m1-state.json}
STATE=${TOPUP_STATE:-topup-admin-state.json}
PXE_DIR=${TOPUP_PXE_DIR:-./testnet-m4-pxe}
ADDR=$(node -e "process.stdout.write(JSON.parse(require('fs').readFileSync('$M1_STATE','utf8')).address)")
TS=$(date -u +%FT%TZ)
echo "[auto-topup $TS] checking FJ of ${ADDR} (m1=${M1_STATE}, floor ${FLOOR_FJ} FJ) ..."

bal=$(node_modules/.bin/tsx scripts/check-fj.ts "$ADDR" 2>/dev/null | grep -oE 'balance: [0-9]+' | grep -oE '[0-9]+' | head -1)
if [ -z "$bal" ]; then
  # Fail-safe: don't bridge blindly (avoids over-funding if the read is transiently down).
  # The 6h cadence + the health-watch ntfy alert cover a missed run.
  echo "[auto-topup] ERROR: could not read FJ balance of ${ADDR} — skipping this run"
  exit 1
fi
fj=$(node -e "process.stdout.write(String(BigInt('$bal')/(10n**18n)))")
echo "[auto-topup] ${ADDR} FJ = ${fj}"

if [ "$fj" -ge "$FLOOR_FJ" ]; then
  echo "[auto-topup] healthy (>= ${FLOOR_FJ}); no topup needed"
  exit 0
fi

echo "[auto-topup] LOW (< ${FLOOR_FJ}) → bridging +${BRIDGE_FJ} FJ via own L1 (correct portal 0xd336) ..."
rm -f "${STATE}.bridge"
BRIDGE_M1_STATE="$M1_STATE" BRIDGE_STATE="${STATE}.bridge" BRIDGE_PXE_DIR="$PXE_DIR" \
  node_modules/.bin/tsx scripts/bridge-fj-to-admin.ts "$BRIDGE_FJ"
echo "[auto-topup] topup complete (own L1 bridge, correct portal 0xd336)"
