// Tests for contracts-env loader. Passes a synthetic env override for
// test isolation (Vite's import.meta.env can't be stubbed reliably across
// suites).
import { describe, test, expect } from "vitest";
import { loadContractsFromEnv } from "./contracts-env";

describe("loadContractsFromEnv", () => {
  test("returns undefined when no orderbook is configured", () => {
    expect(loadContractsFromEnv({})).toBeUndefined();
  });

  test("returns full contracts object when all addresses are set", () => {
    const c = loadContractsFromEnv({
      VITE_QUETZAL_ORDERBOOK: "0xob",
      VITE_QUETZAL_TUSDC: "0xu",
      VITE_QUETZAL_TETH:  "0xe",
      VITE_QUETZAL_TBTC:  "0xb",
      VITE_QUETZAL_ADMIN: "0xa",
      VITE_QUETZAL_AGGREGATOR_REGISTRY: "0xr",
      VITE_QUETZAL_TREASURY: "0xt",
      VITE_QUETZAL_POOL_USDC_ETH: "0xp0",
      VITE_QUETZAL_POOL_USDC_BTC: "0xp1",
      VITE_QUETZAL_POOL_ETH_BTC:  "0xp2",
    });
    expect(c).toBeDefined();
    expect(c!.orderbook).toBe("0xob");
    expect(c!.tUSDC).toBe("0xu");
    expect(c!.tETH).toBe("0xe");
    expect(c!.tBTC).toBe("0xb");
    expect(c!.admin).toBe("0xa");
    expect(c!.aggregatorRegistry).toBe("0xr");
    expect(c!.treasury).toBe("0xt");
    expect(c!.pools).toHaveLength(3);
    expect(c!.pools[0]).toEqual({ pool_id: 0, address: "0xp0", token_a: "0xu", token_b: "0xe" });
    expect(c!.pools[1]).toEqual({ pool_id: 1, address: "0xp1", token_a: "0xu", token_b: "0xb" });
    expect(c!.pools[2]).toEqual({ pool_id: 2, address: "0xp2", token_a: "0xe", token_b: "0xb" });
  });

  test("omits pools when their tokens are missing", () => {
    const c = loadContractsFromEnv({
      VITE_QUETZAL_ORDERBOOK: "0xob",
      VITE_QUETZAL_TUSDC: "0xu",
      VITE_QUETZAL_TETH:  "0xe",
      // No tBTC, no pool addresses
    });
    expect(c).toBeDefined();
    expect(c!.tBTC).toBeUndefined();
    expect(c!.pools).toHaveLength(0);
  });

  test("supports a USDC/ETH-only deployment (no BTC tokens or pool)", () => {
    const c = loadContractsFromEnv({
      VITE_QUETZAL_ORDERBOOK: "0xob",
      VITE_QUETZAL_TUSDC: "0xu",
      VITE_QUETZAL_TETH:  "0xe",
      VITE_QUETZAL_POOL_USDC_ETH: "0xp0",
    });
    expect(c!.pools).toHaveLength(1);
    expect(c!.pools[0]!.pool_id).toBe(0);
  });
});
