import { build } from "esbuild";

await build({
  entryPoints: ["src/main.ts"],
  outfile: "dist/zswap-outbox-proof.mjs",
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  banner: {
    js: "#!/usr/bin/env node\nimport { createRequire } from 'module'; const require = createRequire(import.meta.url);",
  },
});
console.log("Built dist/zswap-outbox-proof.mjs");
