// sdk/src/internal/contracts.browser.ts
//
// Browser variant of internal/contracts.ts. The Node variant resolves the
// codegen'd bindings at runtime via `${process.cwd()}/tests/integration/generated`,
// which in the browser becomes an invalid protocol-relative `//tests/...` URL
// (process.cwd() polyfills to "/"). A runtime path can never be bundled, so the
// browser MUST import the bindings statically — Vite then bundles them (and the
// Noir artifact JSON each pulls in). Wired in via the `sdkBrowserShims` plugin in
// frontend/vite.config.ts. The SDK's own tsconfig EXCLUDES this file because the
// static imports cross the `rootDir: src` boundary (the bindings live under
// tests/); it is only ever consumed through the Vite shim, never tsc-built.
//
// Each function mirrors the Node loader's exported signature (same names, same
// shape: the returned class exposes static `.at()` + `.artifact`). No facade
// type import — esbuild strips types and this file is never typechecked.

import { OrderbookContract } from "../../../tests/integration/generated/Orderbook.js";
import { TokenContract } from "../../../tests/integration/generated/Token.js";
import { LiquidityPoolContract } from "../../../tests/integration/generated/LiquidityPool.js";
import { AggregatorRegistryContract } from "../../../tests/integration/generated/AggregatorRegistry.js";
import { TreasuryContract } from "../../../tests/integration/generated/Treasury.js";

export async function loadOrderbookContract() {
  return OrderbookContract;
}
export async function loadTokenContract() {
  return TokenContract;
}
export async function loadLiquidityPoolContract() {
  return LiquidityPoolContract;
}
export async function loadAggregatorRegistryContract() {
  return AggregatorRegistryContract;
}
export async function loadTreasuryContract() {
  return TreasuryContract;
}
