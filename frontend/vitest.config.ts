import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "happy-dom",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    setupFiles: [],
    testTimeout: 10_000,
    css: false,
  },
  resolve: {
    alias: { "@": resolve(__dirname, "src") },
  },
});
