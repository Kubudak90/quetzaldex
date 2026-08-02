#!/usr/bin/env bash
#
# Start the local dev stack: anvil (L1) + Aztec local-network (L2).
#
# Aztec 4.x removed the self-contained sandbox; local development requires an
# external L1 RPC. We use anvil from Foundry (https://book.getfoundry.sh).
#
# Usage:
#   scripts/dev.sh             # start both, foreground; Ctrl+C stops both
#   scripts/dev.sh --down      # stop everything started by a previous run
#
# Endpoints when ready:
#   anvil:  http://localhost:8545
#   aztec:  http://localhost:8080 (PXE / Aztec node JSON-RPC)
#

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

VERSION="$(tr -d '[:space:]' < "$ROOT/.aztec-version")"
ANVIL_PORT=8545
AZTEC_PORT=8080
L1_CHAIN_ID=31337
ANVIL_PID_FILE="$ROOT/.aztec-store/anvil.pid"
mkdir -p "$ROOT/.aztec-store"

cleanup() {
  echo
  echo "→ Stopping Aztec containers..."
  docker ps --filter "ancestor=aztecprotocol/aztec:$VERSION" --format '{{.ID}}' \
    | xargs -r docker stop > /dev/null || true
  if [ -f "$ANVIL_PID_FILE" ]; then
    local pid
    pid="$(cat "$ANVIL_PID_FILE")"
    if kill -0 "$pid" 2>/dev/null; then
      echo "→ Stopping anvil (pid $pid)..."
      kill "$pid" 2>/dev/null || true
    fi
    rm -f "$ANVIL_PID_FILE"
  fi
  echo "→ Done."
}

# --down command
if [ "${1:-}" = "--down" ]; then
  cleanup
  exit 0
fi

# Sanity checks
command -v docker >/dev/null || { echo "docker not found in PATH"; exit 1; }
command -v anvil >/dev/null || {
  cat <<EOF
anvil not found. Install Foundry first:
  curl -L https://foundry.paradigm.xyz | bash
  foundryup
EOF
  exit 1
}
docker info >/dev/null 2>&1 || { echo "Docker daemon not running"; exit 1; }

# Refuse to run if anvil is already on the port (might be the user's other work)
if lsof -i ":$ANVIL_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Port $ANVIL_PORT already in use. Stop the other anvil first or run: scripts/dev.sh --down"
  exit 1
fi

# Start anvil
echo "→ Starting anvil on :$ANVIL_PORT (chain $L1_CHAIN_ID)..."
anvil --port "$ANVIL_PORT" --chain-id "$L1_CHAIN_ID" --silent > "$ROOT/.aztec-store/anvil.log" 2>&1 &
ANVIL_PID=$!
echo "$ANVIL_PID" > "$ANVIL_PID_FILE"

# Trap so Ctrl+C cleans up both
trap cleanup INT TERM EXIT

# Wait for anvil to accept JSON-RPC
for i in $(seq 1 30); do
  if curl -sf -X POST -H "Content-Type: application/json" \
      -d '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}' \
      "http://localhost:$ANVIL_PORT" > /dev/null 2>&1; then
    echo "→ anvil ready."
    break
  fi
  sleep 1
  if [ "$i" = "30" ]; then echo "anvil failed to come up"; exit 1; fi
done

# Start Aztec local-network in the foreground (this blocks)
echo "→ Starting Aztec local-network ($VERSION) on :$AZTEC_PORT..."
VERSION="$VERSION" aztec start --local-network \
  --l1-rpc-urls "http://host.docker.internal:$ANVIL_PORT" \
  --l1-chain-id "$L1_CHAIN_ID"
