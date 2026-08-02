// sdk/src/internal/contracts.ts
// Loader for the Quetzal codegen'd contract bindings.
//
// The bindings currently live in `tests/integration/generated/*` (workspace-
// relative). The SDK tsconfig has `rootDir: src` so we can't statically import
// them; instead we resolve at runtime via a path concatenation that TS won't
// follow. Override the base path via QUETZAL_CONTRACTS_DIR env if the bindings
// are relocated post-Sub-6b.

// Built once per Node.js process; resolves the absolute prefix lazily so the
// SDK doesn't pay the path-cost when callers never touch on-chain methods.
let cachedBase: string | null = null;

function basePath(): string {
  if (cachedBase !== null) return cachedBase;
  if (process.env.QUETZAL_CONTRACTS_DIR) {
    cachedBase = process.env.QUETZAL_CONTRACTS_DIR;
    return cachedBase;
  }
  // Default: workspace-relative — resolve from process.cwd() at boot.
  cachedBase = `${process.cwd()}/tests/integration/generated`;
  return cachedBase;
}

// Cast to `any` at the dynamic-import boundary so TS doesn't try to follow the
// non-static path string.  The callers locally narrow the return shape.
async function loadModule(name: string): Promise<unknown> {
  const path = `${basePath()}/${name}.js`;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return await (import(/* @vite-ignore */ path) as Promise<any>);
}

export interface OrderbookContractFacade {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  at: (...args: any[]) => Promise<any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  artifact: any;
}
export interface TokenContractFacade {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  at: (...args: any[]) => Promise<any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  artifact: any;
}
export interface LiquidityPoolContractFacade {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  at: (...args: any[]) => Promise<any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  artifact: any;
}
export interface AggregatorRegistryContractFacade {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  at: (...args: any[]) => Promise<any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  artifact: any;
}
export interface TreasuryContractFacade {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  at: (...args: any[]) => Promise<any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  artifact: any;
}

export async function loadOrderbookContract(): Promise<OrderbookContractFacade> {
  const m = (await loadModule("Orderbook")) as { OrderbookContract: OrderbookContractFacade };
  return m.OrderbookContract;
}
export async function loadTokenContract(): Promise<TokenContractFacade> {
  const m = (await loadModule("Token")) as { TokenContract: TokenContractFacade };
  return m.TokenContract;
}
export async function loadLiquidityPoolContract(): Promise<LiquidityPoolContractFacade> {
  const m = (await loadModule("LiquidityPool")) as {
    LiquidityPoolContract: LiquidityPoolContractFacade;
  };
  return m.LiquidityPoolContract;
}
export async function loadAggregatorRegistryContract(): Promise<AggregatorRegistryContractFacade> {
  const m = (await loadModule("AggregatorRegistry")) as {
    AggregatorRegistryContract: AggregatorRegistryContractFacade;
  };
  return m.AggregatorRegistryContract;
}
export async function loadTreasuryContract(): Promise<TreasuryContractFacade> {
  const m = (await loadModule("Treasury")) as { TreasuryContract: TreasuryContractFacade };
  return m.TreasuryContract;
}
