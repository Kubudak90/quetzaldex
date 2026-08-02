#!/usr/bin/env bash
#
# Generate TypeScript bindings from compiled Noir contracts.
#
# Mirrors the "Generate TypeScript bindings (codegen)" step in CI
# (.github/workflows/ci.yml) so that `pnpm codegen` (or the automatic
# `pretest` hook) works on a fresh clone without needing CI.
#
# Prerequisites:
#   - Docker running
#   - Contracts compiled (`pnpm compile`) so that contracts/*/target/ exists
#
# Usage:
#   bash scripts/codegen.sh          # generate bindings for all contracts
#   pnpm codegen                     # same, via npm script alias
#
# Output:
#   tests/integration/generated/Token.ts
#   (and its companion .js / .d.ts artefacts produced by the Aztec codegen)
#

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

VERSION="$(tr -d '[:space:]' < "$ROOT/.aztec-version")"

echo "→ Generating TypeScript bindings (aztecprotocol/aztec:$VERSION)..."
mkdir -p tests/integration/generated

for dir in contracts/*/; do
  if [ -f "$dir/Nargo.toml" ]; then
    echo "  codegen: $dir"
    docker run --rm \
      --entrypoint bash \
      -v "$ROOT:/work" -w /work \
      "aztecprotocol/aztec:$VERSION" \
      -c "node --no-warnings /usr/src/yarn-project/aztec/dest/bin/index.js codegen --force ${dir}target -o tests/integration/generated"
  fi
done

echo "→ Codegen done. Generated files:"
ls tests/integration/generated/ | sed 's/^/   /'
