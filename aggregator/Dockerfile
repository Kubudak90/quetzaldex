# Sub-8.1 aggregator — multi-stage Docker build.
# Sub-9.3 update: runtime stage now FROMs aztecprotocol/aztec:4.3.0 so the
# clearing loop's `nargo execute` + `bb prove` shellouts work in-container
# without an extra build. The image grows from ~600MB to ~2.4GB but the alternative
# (bespoke toolchain install) is fragile across Aztec releases.
#
# Build context: monorepo root (one level above this file). From /repo root:
#   docker build -t quetzal-aggregator:latest -f aggregator/Dockerfile .
#
# Prerequisite: BEFORE `docker build`, run from repo root:
#   pnpm install
#   pnpm compile        # optional — only required if the on-chain epoch-poll
#                       # path is enabled (AZTEC_NODE_URL + ORDERBOOK_ADDRESS).
#                       # The reveal-server path (/reveal + /health) does NOT
#                       # need compiled Noir artifacts.
#
# Sub-9.3 ENV switches:
#   CLEARING_ENABLED=1   wire the full multi-pair close_epoch_and_clear_verified path
#   NARGO_BIN=...        override nargo binary path (default: /usr/src/noir/noir-repo/target/release/nargo)
#   BB_BIN=...           override bb binary path (default: /usr/src/barretenberg/ts/build/amd64-linux/bb)

# ---------------------------------------------------------------------------
# Stage 1: deps — install workspace deps from lockfile on a slim node image.
# Cached aggressively when only source files change.
# ---------------------------------------------------------------------------
FROM node:22-trixie-slim AS deps

RUN corepack enable pnpm

# Native build deps (some @aztec/* and viem chains pull native binaries).
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /repo

# Workspace manifest + every package.json that pnpm-workspace.yaml enumerates.
# pnpm needs the full workspace graph to resolve workspace:* deps deterministically.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY sdk/package.json ./sdk/package.json
COPY cli/package.json ./cli/package.json
COPY aggregator/package.json ./aggregator/package.json
COPY frontend/package.json ./frontend/package.json
COPY examples/package.json ./examples/package.json
COPY faucet/package.json ./faucet/package.json
COPY tools/outbox-proof/package.json ./tools/outbox-proof/package.json
COPY tools/exporters/package.json ./tools/exporters/package.json
COPY tests ./tests

# --frozen-lockfile=false: tolerate lockfile drift across contributor branches.
RUN pnpm install --frozen-lockfile=false

# ---------------------------------------------------------------------------
# Stage 2: runtime — aztecprotocol/aztec:4.3.0 with our source + node_modules.
# This image bakes in nargo + bb (Sub-9.3 clearing-cycle uses them).
# Image WORKDIR resets; we set our own.
# ---------------------------------------------------------------------------
FROM aztecprotocol/aztec:5.0.0 AS runtime

# Bring corepack into PATH if missing.  The aztec image has node 24; corepack
# ships with it.
RUN corepack enable pnpm || true

# curl + ca-certificates: needed for HEALTHCHECK and L2 PXE HTTPS.
# The aztec image is bookworm-based; apt is available.
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    || (echo "apt-get failed; assuming curl + ca-certificates already present" && which curl)

WORKDIR /repo

# Workspace metadata + installed dependencies (from deps stage).
COPY --from=deps /repo/package.json ./package.json
COPY --from=deps /repo/pnpm-lock.yaml ./pnpm-lock.yaml
COPY --from=deps /repo/pnpm-workspace.yaml ./pnpm-workspace.yaml
COPY --from=deps /repo/node_modules ./node_modules

# Source trees the aggregator touches at runtime.
COPY aggregator ./aggregator
COPY sdk ./sdk
COPY cli ./cli
COPY tests ./tests
COPY contracts ./contracts
# Sub-9.3: circuit dir for nargo + bb prove. nargo execute regenerates
# clearing.gz + public_inputs per cycle. The on-chain orderbook is bound to the
# vk_hash of this exact circuit — if you replace circuits/, you must redeploy
# the orderbook to match the new vk_hash.
COPY circuits ./circuits

# circuits/*/target/ is GITIGNORED, so whatever copies happen to sit in the build
# context are arbitrary leftovers — on the v5 migration the image shipped a 4.3-era
# clearing.json AND a stale vk (hash 0x059e8255) while the deployed orderbook was
# bound to 0x014d86f6, so every crossing clear proved fine and then died in the
# on-chain recursive verify ("Failed to verify the generated proof!"). Rebuild both
# here from SOURCE with the in-image nargo + the SAME bb that generates the proofs,
# so circuit, vk and proof can never drift apart.
RUN cd circuits/clearing \
    && rm -rf target \
    && PATH=/usr/src/noir/noir-repo/target/release:$PATH nargo compile --silence-warnings \
    && /usr/src/barretenberg/ts/build/amd64-linux/bb write_vk \
         -b target/clearing.json -o target/vk.bin -t noir-recursive \
    && od -An -tx1 target/vk.bin/vk_hash | tr -d ' \n' \
    && echo "  <- clearing vk_hash baked into the image (must equal the deployed orderbook's)"

# Re-link the per-workspace node_modules symlink farm. Same reasoning as
# Sub-8.1: per-pkg symlinks get clobbered by the host COPYs.
RUN pnpm install --frozen-lockfile=false --prefer-offline

# Pre-create the snapshots dir so the bind-mount volume picks up clean perms.
RUN mkdir -p /repo/aggregator/data/snapshots && chmod -R 0755 /repo/aggregator/data

ENV NODE_ENV=production \
    PORT=3000 \
    LOG_LEVEL=info \
    NARGO_BIN=/usr/src/noir/noir-repo/target/release/nargo \
    BB_BIN=/usr/src/barretenberg/ts/build/amd64-linux/bb

EXPOSE 3000

# Container-level healthcheck.
HEALTHCHECK --interval=30s --timeout=5s --retries=3 --start-period=60s \
    CMD curl -sf http://localhost:${PORT}/health || exit 1

WORKDIR /repo/aggregator

# Use the aztec image's bash + our app via npx pnpm. We override the aztec
# entrypoint (which runs `aztec`) by setting ours explicitly.
ENTRYPOINT []
CMD ["sh", "-c", "pnpm start"]
