# Sub-7a faucet — multi-stage Docker build.
#
# Build context: monorepo root (one level above this file). Run from /faucet:
#   docker build -t quetzal-faucet:latest -f Dockerfile ..
#
# Prerequisite: BEFORE `docker build`, the operator MUST run from the repo root:
#   pnpm install
#   pnpm compile        # produces contracts/*/target/*.json (gitignored)
#   pnpm codegen        # produces tests/integration/generated/*.ts (tracked)
#
# The build stage asserts contracts/token/target/token-Token.json exists and
# fails fast with an operator-actionable message if it is missing — the faucet's
# l2-mint.ts statically imports tests/integration/generated/Token.ts, which in
# turn statically imports that JSON artifact.

# ---------------------------------------------------------------------------
# Stage 1: deps — install workspace deps from lockfile.
# Cached aggressively when only source files change.
# ---------------------------------------------------------------------------
FROM node:22-trixie-slim AS deps

# pnpm via corepack (matches packageManager in repo root package.json: pnpm@9.12.0).
RUN corepack enable pnpm

# Native build deps for better-sqlite3 (and any other native modules).
# The `deps` stage itself never ships — only its node_modules tree is copied
# into the runtime stage via `--from=build` — so leaving these packages
# installed here costs nothing in the final image.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /repo

# Workspace manifest + lockfile + every package.json that pnpm-workspace.yaml
# enumerates. We need ALL of them for `pnpm install` to resolve the workspace
# graph deterministically, even though we only build @quetzal/faucet later.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY sdk/package.json ./sdk/package.json
COPY cli/package.json ./cli/package.json
COPY aggregator/package.json ./aggregator/package.json
COPY frontend/package.json ./frontend/package.json
COPY examples/package.json ./examples/package.json
COPY faucet/package.json ./faucet/package.json
COPY tools/outbox-proof/package.json ./tools/outbox-proof/package.json
COPY tools/exporters/package.json ./tools/exporters/package.json
# tests/* is a workspace glob (`tests/**` in pnpm-workspace.yaml). Copy the
# whole tree so pnpm sees tests/package.json (and any nested workspace pkgs).
COPY tests ./tests

# --frozen-lockfile=false: the lockfile may drift between contributor branches
# but the workspace topology is stable; we accept a non-frozen install rather
# than block container builds on a transient lockfile mismatch.
RUN pnpm install --frozen-lockfile=false

# ---------------------------------------------------------------------------
# Stage 2: build — copy source, assert the Noir artifact is present, then
# run `next build` (via `pnpm build` in the @quetzal/faucet workspace).
# ---------------------------------------------------------------------------
FROM deps AS build

# Source trees needed at build time:
# - contracts/   — holds the Noir compile artifacts that Token.ts imports
# - faucet/      — the Next app being built
# (tests/ is already copied in the deps stage above; the codegen'd
# tests/integration/generated/Token.ts ships in-tree, no rebuild needed.)
COPY contracts ./contracts
COPY faucet ./faucet

# Fail-fast guard: tests/integration/generated/Token.ts imports
# ../../../contracts/token/target/token-Token.json via a static `import ... with
# { type: 'json' }` directive. If the artifact is missing, `next build` errors
# out with an opaque Webpack "module not found" deep in the trace. We surface
# the real cause + the exact remediation command here, BEFORE pnpm build runs.
RUN [ -f /repo/contracts/token/target/token-Token.json ] || ( \
    echo ""; \
    echo "============================================================"; \
    echo "ERROR: Noir compile artifact is missing:"; \
    echo "  /repo/contracts/token/target/token-Token.json"; \
    echo ""; \
    echo "The faucet imports tests/integration/generated/Token.ts, which"; \
    echo "statically imports that JSON via 'import ... with { type: json }'."; \
    echo "next build will fail with a module-not-found error without it."; \
    echo ""; \
    echo "Fix: from the monorepo root, BEFORE running docker build, run:"; \
    echo ""; \
    echo "    pnpm compile        # workspace-level script (scripts/compile-all.sh)"; \
    echo ""; \
    echo "or compile only the token contract directly:"; \
    echo ""; \
    echo "    cd contracts/token && nargo compile"; \
    echo ""; \
    echo "Then re-run:  docker build -t quetzal-faucet:latest -f faucet/Dockerfile ."; \
    echo "============================================================"; \
    echo ""; \
    exit 1 )

WORKDIR /repo/faucet
RUN pnpm build

# ---------------------------------------------------------------------------
# Stage 3: runtime — minimal slim image with just what `next start` needs.
# Carries node_modules across from the build stage; rebuilds the better-sqlite3
# native binding to be safe against any toolchain skew between stages.
# ---------------------------------------------------------------------------
FROM node:22-trixie-slim AS runtime

RUN corepack enable pnpm

# wget is used by HEALTHCHECK + docker-compose healthcheck. ca-certificates so
# outbound HTTPS to the L2 PXE / L1 RPC works. python3/make/g++ are present
# in case the `pnpm rebuild better-sqlite3` below has to fall back to
# compiling the binding from source.
#
# Base is node:22-trixie-slim (Debian 13). Trixie ships libstdc++6 14.2 which
# provides GLIBCXX 3.4.33+, required by @aztec/bb.js's prebuilt native module.
# (Bookworm-slim only goes up to 3.4.30 and breaks at dlopen.)
RUN apt-get update \
    && apt-get install -y --no-install-recommends wget ca-certificates python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /repo

# Workspace metadata so pnpm can locate the @quetzal/faucet package at
# `pnpm start` time (pnpm resolves the workspace via these files even when
# only running a script, since faucet's package.json is reached through the
# workspace graph, not as a standalone package).
COPY --from=build /repo/package.json ./package.json
COPY --from=build /repo/pnpm-lock.yaml ./pnpm-lock.yaml
COPY --from=build /repo/pnpm-workspace.yaml ./pnpm-workspace.yaml

# Installed dependencies (the pnpm symlink topology + the .pnpm store) and the
# three source trees the running faucet actually touches at runtime:
# - sdk/         — workspace dep (exports point at src/*.ts directly)
# - contracts/   — token-Token.json is loaded at runtime via the Token.ts binding
# - tests/       — tests/integration/generated/Token.ts (the codegen'd binding)
# - faucet/      — the built Next app (includes .next/)
COPY --from=build /repo/node_modules ./node_modules
COPY --from=build /repo/sdk ./sdk
COPY --from=build /repo/contracts ./contracts
COPY --from=build /repo/tests ./tests
COPY --from=build /repo/faucet ./faucet

# Defense-in-depth: rebuild better-sqlite3 against this stage's libc/node. The
# deps + runtime stages both use node:22-bookworm-slim so a rebuild SHOULD be a
# no-op, but if the prebuilt binding ships with mismatched glibc symbols
# `require('better-sqlite3')` will throw on first request. We rebuild from the
# workspace root with --filter so pnpm resolves the package correctly via the
# .pnpm symlink store; running this from /repo/faucet works too but is less
# robust if the symlink topology changes between pnpm versions.
RUN pnpm --filter @quetzal/faucet rebuild better-sqlite3

WORKDIR /repo/faucet

EXPOSE 3030
ENV NODE_ENV=production

# Container-level healthcheck. docker-compose.yml has its own healthcheck for
# the compose-managed lifecycle; this one makes `docker ps` / `docker stats`
# show health even when running the image standalone.
HEALTHCHECK --interval=60s --timeout=10s --retries=3 \
    CMD wget -qO- http://localhost:3030/api/health || exit 1

CMD ["pnpm", "start"]
