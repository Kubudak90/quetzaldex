import { Gauge } from "prom-client";
import { setupRegistry, startServer } from "./shared/promClient.js";
import { readFileSync } from "node:fs";

const PORT = Number(process.env.PORT ?? 9101);
const CONFIG_PATH = process.env.QUETZAL_CONFIG ?? "quetzal.config.json";

interface QuetzalPool {
  pool_id: number;
  address: string;
  token_a: string;
  token_b: string;
}

interface QuetzalConfig {
  nodeUrl: string;
  orderbook: string;
  treasury?: string;
  aggregatorRegistry?: string;
  pools: QuetzalPool[];
  tUSDC: string;
  tETH: string;
  tBTC?: string;
}

const cfg = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as QuetzalConfig;

const reg = setupRegistry();

// ---------------------------------------------------------------------------
// Metric definitions — names + labels are LOCKED (Grafana dashboards built
// against these in C3). Port 9101 is one above the L1 exporter (9100).
// Scrape interval 60s (L2 state changes slower than L1).
// ---------------------------------------------------------------------------

const lastClearingG = new Gauge({
  name: "quetzal_l2_orderbook_last_clearing_timestamp",
  help: "unix seconds of most recent close_epoch_and_clear_verified",
  registers: [reg],
});

const treasuryBalanceG = new Gauge({
  name: "quetzal_l2_treasury_balance",
  help: "Treasury tracked_balance (bond token native units)",
  labelNames: ["token"],
  registers: [reg],
});

const registrySizeG = new Gauge({
  name: "quetzal_l2_aggregator_registry_size",
  help: "Number of currently-bonded aggregators (highest-ever-allocated id; may include holes)",
  registers: [reg],
});

const poolReserveG = new Gauge({
  name: "quetzal_l2_pool_reserve",
  help: "Pool reserve (token native units)",
  labelNames: ["pool_id", "token"],
  registers: [reg],
});

// ---------------------------------------------------------------------------
// scrape() — each metric block has its own try/catch so one broken view call
// does not kill the exporter.
//
// All L2 reads require a PXE-backed wallet for `.simulate()`. The aztec.js
// wiring below is scaffolded with the exact call sites in comments so an
// operator can wire them incrementally during testnet ops.
//
// View-call API patterns (mirrored from cli/src/commands/positions.ts):
//   const pool = await LiquidityPoolContract.at(AztecAddress.fromString(addr), wallet);
//   const state = await pool.methods.get_pool_state().simulate({ from: account });
//   const reserves = (state as { result: { reserve_a: bigint; reserve_b: bigint } }).result;
//
// All relevant contract utility functions are #[external("utility")] unconstrained,
// which means they must be called via simulate() — there is no pure JSON-RPC
// read path without a PXE wallet.
// ---------------------------------------------------------------------------

async function scrape(): Promise<void> {
  // -------------------------------------------------------------------------
  // 1. Orderbook last_clearing_timestamp
  //
  //    The Orderbook stores `current_epoch: PublicMutable<EpochState>` but has
  //    no dedicated view function that exposes a timestamp field.
  //    This metric will be wired when a `get_last_clearing_timestamp()` view
  //    is added to the Orderbook contract (deferred to operator session).
  //    Until then the gauge holds 0 (Prometheus will show "no data" on the
  //    Grafana panel until the first real value is pushed).
  //
  //    Implementer wiring (once view fn exists):
  //      import { OrderbookContract } from "../../../tests/integration/generated/orderbook/OrderbookContract.js";
  //      const node   = createAztecNodeClient(cfg.nodeUrl);
  //      const wallet = await createEphemeralAccount(node); // or AdminWallet
  //      const ob     = await OrderbookContract.at(AztecAddress.fromString(cfg.orderbook), wallet);
  //      const ts     = await ob.methods.get_last_clearing_timestamp().simulate({ from: wallet.getAddress() });
  //      lastClearingG.set(Number((ts as { result: bigint }).result));
  // -------------------------------------------------------------------------
  try {
    // todo: wire when Orderbook exposes get_last_clearing_timestamp() view
    void lastClearingG; // reference to suppress "declared but never read" in strict mode
  } catch (e) {
    console.error(
      "l2-exporter orderbook.last_clearing_timestamp failed:",
      e instanceof Error ? e.message : String(e),
    );
  }

  // -------------------------------------------------------------------------
  // 2. Treasury tracked_balance (only when config.treasury is set)
  //
  //    Treasury contract exposes:
  //      #[external("utility")] unconstrained fn get_tracked_balance() -> u128
  //
  //    Implementer wiring:
  //      import { TreasuryContract } from "../../../tests/integration/generated/treasury/TreasuryContract.js";
  //      const treasury = await TreasuryContract.at(AztecAddress.fromString(cfg.treasury!), wallet);
  //      const bal = await treasury.methods.get_tracked_balance().simulate({ from: wallet.getAddress() });
  //      treasuryBalanceG.labels("USDC").set(Number((bal as { result: bigint }).result));
  //
  //    "USDC" label is the bond token; update to match actual bond token symbol
  //    from config once wired.
  // -------------------------------------------------------------------------
  if (cfg.treasury) {
    try {
      // todo: wire TreasuryContract.at(...).methods.get_tracked_balance().simulate()
      void treasuryBalanceG;
    } catch (e) {
      console.error(
        "l2-exporter treasury.get_tracked_balance failed:",
        e instanceof Error ? e.message : String(e),
      );
    }
  }

  // -------------------------------------------------------------------------
  // 3. Aggregator registry size (only when config.aggregatorRegistry is set)
  //
  //    AggregatorRegistry exposes:
  //      #[external("utility")] unconstrained fn get_aggregator_count() -> u32
  //
  //    NOTE: get_aggregator_count() returns (next_id - 1), which is the highest-
  //    ever-allocated id. Slots of unregistered aggregators are holes (zero addr).
  //    The gauge therefore over-counts by the number of historic departures.
  //    A strict "active bonded count" would require enumerating all slots; the
  //    approximation is acceptable for dashboard observability.
  //
  //    Implementer wiring:
  //      import { AggregatorRegistryContract } from "../../../tests/integration/generated/aggregator_registry/AggregatorRegistryContract.js";
  //      const registry = await AggregatorRegistryContract.at(AztecAddress.fromString(cfg.aggregatorRegistry!), wallet);
  //      const count = await registry.methods.get_aggregator_count().simulate({ from: wallet.getAddress() });
  //      registrySizeG.set(Number((count as { result: number }).result));
  // -------------------------------------------------------------------------
  if (cfg.aggregatorRegistry) {
    try {
      // todo: wire AggregatorRegistryContract.at(...).methods.get_aggregator_count().simulate()
      void registrySizeG;
    } catch (e) {
      console.error(
        "l2-exporter aggregator_registry.get_aggregator_count failed:",
        e instanceof Error ? e.message : String(e),
      );
    }
  }

  // -------------------------------------------------------------------------
  // 4. Pool reserves per pool
  //
  //    LiquidityPool exposes:
  //      #[external("utility")] unconstrained fn get_pool_state() -> PoolState
  //    where PoolState = { reserve_a: u128, reserve_b: u128, current_sqrt_price: u128 }
  //
  //    Implementer wiring (inside the loop):
  //      import { LiquidityPoolContract } from "../../../tests/integration/generated/pool/LiquidityPoolContract.js";
  //      const pool  = await LiquidityPoolContract.at(AztecAddress.fromString(p.address), wallet);
  //      const state = await pool.methods.get_pool_state().simulate({ from: wallet.getAddress() });
  //      const { reserve_a, reserve_b } = (state as { result: { reserve_a: bigint; reserve_b: bigint } }).result;
  //      poolReserveG.labels(String(p.pool_id), "a").set(Number(reserve_a));
  //      poolReserveG.labels(String(p.pool_id), "b").set(Number(reserve_b));
  // -------------------------------------------------------------------------
  for (const p of cfg.pools) {
    try {
      // todo: wire LiquidityPoolContract.at(...).methods.get_pool_state().simulate()
      void poolReserveG;
      void p;
    } catch (e) {
      console.error(
        `l2-exporter pool ${p.pool_id} reserve failed:`,
        e instanceof Error ? e.message : String(e),
      );
    }
  }
}

setInterval(
  () => {
    scrape().catch((e) => console.error("scrape error:", e));
  },
  60_000,
);

scrape().catch((e) => console.error("initial scrape error:", e));

startServer(reg, PORT);

console.log("l2-exporter: listening on :" + PORT);
console.log("l2-exporter: NOTE — metric collection is scaffolded; aztec.js view calls require");
console.log("             a PXE-backed wallet which is not yet wired here. Each metric block");
console.log("             has a 'todo' comment with the exact call site. Operator: prioritize");
console.log("             per the sub5c-runbook's monitoring-rollout phase.");
