/** @type {import('next').NextConfig} */
const nextConfig = {
  // NOTE: do NOT set `output: "standalone"`. The Docker runtime stage copies the
  // full node_modules + .next + workspace and runs `next start`. With
  // output:standalone, `next start` is unsupported and silently delivers an EMPTY
  // req.body, so every POST /api/drip returns "invalid body: Required". Running
  // the normal (non-standalone) build under `next start` parses bodies correctly.
  // Enables src/instrumentation.ts (prom-client server-startup init);
  // stable in Next 15, safe to drop on upgrade.
  experimental: {
    instrumentationHook: true,
    // Allow Next.js SWC loader to transpile .ts files that live outside the
    // faucet/ project root (e.g. tests/integration/generated/Token.ts imported
    // by src/lib/l2-mint.ts). Without this flag, webpack's codeCondition has
    // `include: [dir]` which rejects any file above the project root.
    externalDir: true,
  },
  // reactStrictMode off: the page is a simple form; no double-render need.
  reactStrictMode: false,
  // ESM convention: .ts files import siblings as ".js" (paired with type:module
  // in package.json). Vitest + tsc resolve this natively; Next 14's webpack needs
  // an explicit extensionAlias to map .js requests to .ts/.tsx files.
  webpack: (config, { isServer }) => {
    config.resolve.extensionAlias = {
      ".js": [".ts", ".tsx", ".js"],
      ".mjs": [".mts", ".mjs"],
    };
    // Externalize Aztec runtime packages on the server side: they ship native
    // modules (@aztec/bb.js — barretenberg .wasm.gz, @aztec/native — .node) and
    // dynamic transports (pino) that webpack's bundling breaks. Loading them
    // at runtime via require() from node_modules sidesteps all of it. The
    // Dockerfile already COPYs node_modules into the runtime image, so
    // require resolution at request-time just works.
    if (isServer) {
      const aztecExternals = [
        "@aztec/aztec.js",
        "@aztec/wallets",
        "@aztec/wallet-sdk",
        "@aztec/stdlib",
        "@aztec/foundation",
        "@aztec/bb.js",
        "@aztec/native",
        "@aztec/pxe",
        "@aztec/ethereum",
        "@aztec/l1-artifacts",
        "better-sqlite3",
      ];
      const existing = Array.isArray(config.externals) ? config.externals : [];
      config.externals = [
        ...existing,
        ({ request }, callback) => {
          if (request && aztecExternals.some((p) => request === p || request.startsWith(p + "/"))) {
            return callback(null, "commonjs " + request);
          }
          callback();
        },
      ];
    }
    return config;
  },
};

export default nextConfig;
