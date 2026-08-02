import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { nodePolyfills } from "vite-plugin-node-polyfills";
import { createRequire } from "module";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// Resolve the shim paths absolutely so pnpm workspace packages (e.g. sdk)
// that don't directly depend on vite-plugin-node-polyfills can still resolve
// the injected shim imports at build time.
const pluginRoot = require.resolve("vite-plugin-node-polyfills").replace(/\/dist\/index\..*$/, "");

// Absolute path to the sdk source root (sibling workspace package).
const sdkSrc = path.resolve(__dirname, "../sdk/src");

/**
 * Vite plugin that redirects Node-only sdk source files to their browser-
 * compatible shims (localStorage instead of node:fs).
 *
 * Operates on resolved absolute paths (after Vite/Rollup resolution) so it
 * works regardless of how the file was imported (relative or package-name).
 */
function sdkBrowserShims(): Plugin {
  const shims: Record<string, string> = {
    [path.resolve(sdkSrc, "privacy/decoy-registry.ts")]:
      path.resolve(sdkSrc, "privacy/decoy-registry.browser.ts"),
    [path.resolve(sdkSrc, "privacy/bridge-schedule.ts")]:
      path.resolve(sdkSrc, "privacy/bridge-schedule.browser.ts"),
    // Node loader resolves codegen'd bindings via process.cwd() (invalid in the
    // browser); the browser variant statically imports them so Vite bundles them.
    [path.resolve(sdkSrc, "internal/contracts.ts")]:
      path.resolve(sdkSrc, "internal/contracts.browser.ts"),
  };

  return {
    name: "quetzal:sdk-browser-shims",
    enforce: "pre",
    resolveId(source, importer) {
      // Only intercept relative imports from within the sdk src tree.
      if (!importer) return null;
      if (!source.startsWith(".")) return null;

      const resolved = path.resolve(path.dirname(importer), source);

      // Try both .ts and without extension.
      for (const candidate of [resolved, resolved + ".ts", resolved.replace(/\.js$/, ".ts")]) {
        if (shims[candidate]) {
          return shims[candidate];
        }
      }
      return null;
    },
    load(id) {
      // Also intercept if the id is the Node-only file directly (e.g., from
      // optimizeDeps or other resolvers that already resolved to .ts).
      const shimTarget = shims[id];
      if (shimTarget) {
        // Return null to let Vite load the shim file via its normal pipeline.
        // The resolveId hook already redirected to the shim, so this won't
        // be triggered for the shim path itself.
        return null;
      }
      return null;
    },
  };
}

export default defineConfig({
  plugins: [
    react(),
    sdkBrowserShims(),
    nodePolyfills({
      // Polyfill specific globals + modules the @aztec/* deps reach for.
      globals: {
        Buffer: true,
        global: true,
        process: true,
      },
      // Polyfill these Node modules with browser-compatible shims.
      // Include the set Aztec's foundation/stdlib/pxe/wallets touch:
      include: ["util", "buffer", "stream", "events", "crypto", "path", "os", "fs", "url"],
      // Allow the polyfills to apply to imports prefixed with "node:" too
      // (e.g., the explicit `import { ... } from "node:util"` in pino-logger)
      protocolImports: true,
    }),
  ],
  resolve: {
    alias: [
      // ── vite-plugin-node-polyfills shims ───────────────────────────────────
      // Explicitly map shim sub-paths so pnpm workspace packages that don't
      // have vite-plugin-node-polyfills as a direct dep can resolve them.
      {
        find: "vite-plugin-node-polyfills/shims/buffer",
        replacement: `${pluginRoot}/shims/buffer/dist/index.js`,
      },
      {
        find: "vite-plugin-node-polyfills/shims/global",
        replacement: `${pluginRoot}/shims/global/dist/index.js`,
      },
      {
        find: "vite-plugin-node-polyfills/shims/process",
        replacement: `${pluginRoot}/shims/process/dist/index.js`,
      },
    ],
  },
  server: { port: 5173, strictPort: false },
  build: {
    target: "es2022",
    // Increase chunk size warning threshold; aztec.js bundles are large.
    chunkSizeWarningLimit: 2000,
  },
  // Some Aztec packages have CJS-only files; preempt resolver issues.
  optimizeDeps: {
    // Pre-bundle the wallet-sdk discovery entry that the "aztec-wallet" adapter
    // pulls in via dynamic import. Without this, Vite discovers it lazily on the
    // first Connect click and force-reloads the page mid-connect ("optimized
    // dependencies changed. reloading"), dropping the flow. Pre-bundling at
    // startup keeps the connect flow intact.
    // `vite-plugin-node-polyfills/shims/global` is reached only via the
    // wallet-sdk code path; if not pre-bundled it gets optimized lazily and
    // triggers a reload. Pin it here so the startup optimize pass covers it.
    include: ["@aztec/wallet-sdk/manager", "vite-plugin-node-polyfills/shims/global"],
    esbuildOptions: {
      target: "es2022",
    },
  },
});
