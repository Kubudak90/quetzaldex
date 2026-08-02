import { describe, test, expect, beforeEach } from "vitest";
import { metrics, resetMetricsForTest } from "@/lib/metrics";

beforeEach(() => { resetMetricsForTest(); });

describe("metrics", () => {
  test("dripTotal counter increments + serializes", async () => {
    metrics.dripTotal.inc();
    metrics.dripTotal.inc();
    metrics.dripFailedTotal.inc();
    const text = await metrics.registry.metrics();
    expect(text).toMatch(/faucet_drip_total 2/);
    expect(text).toMatch(/faucet_drip_failed_total 1/);
  });

  test("gauges set + serialize", async () => {
    metrics.l1BalanceEth.set(0.5);
    metrics.l1BalanceFeeJuice.set(8400000000000000000000);
    const text = await metrics.registry.metrics();
    expect(text).toMatch(/faucet_l1_balance_eth 0.5/);
  });
});
