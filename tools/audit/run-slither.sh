#!/usr/bin/env bash
#
# Sub-5c E2: one-shot Slither static-analysis runner for the audit-prep snapshot.
#
# Requirements:
#   pip install slither-analyzer  (Python 3.8+)
#   Foundry already installed (forge available on PATH)
#
# Output: contracts-l1/audit/slither-<YYYY-MM-DD>.txt
#
# Run from the repo root:
#   bash tools/audit/run-slither.sh
#
set -euo pipefail

if ! command -v slither >/dev/null 2>&1; then
  echo "ERROR: slither not installed. Install with: pip install slither-analyzer"
  echo "       See: https://github.com/crytic/slither#how-to-install"
  exit 127
fi

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO_ROOT"

DATE=$(date +%Y-%m-%d)
OUT_DIR="contracts-l1/audit"
OUT_FILE="$OUT_DIR/slither-${DATE}.txt"
mkdir -p "$OUT_DIR"

echo "Running Slither static analysis..."
echo "  Target:    contracts-l1/src/"
echo "  Output:    $OUT_FILE"
echo ""

# Use --solc-remaps for the OZ + forge-std remappings matching foundry.toml
# Filter out lib/ + test/ to focus on production code only.
cd contracts-l1
slither . \
  --solc-remaps "@openzeppelin/contracts=lib/openzeppelin-contracts/contracts @openzeppelin/contracts-upgradeable=lib/openzeppelin-contracts-upgradeable/contracts forge-std=lib/forge-std/src" \
  --exclude-dependencies \
  --filter-paths "lib/|test/" \
  > "../${OUT_FILE}" 2>&1 || true
cd ..

echo ""
echo "Slither complete. Output written to ${OUT_FILE}"
echo "Tail of output:"
tail -n 20 "$OUT_FILE"
