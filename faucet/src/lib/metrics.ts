import { Counter, Gauge, Registry } from "prom-client";

const registry = new Registry();

const dripTotal = new Counter({
  name: "faucet_drip_total",
  help: "Total successful drips",
  registers: [registry],
});
const dripFailedTotal = new Counter({
  name: "faucet_drip_failed_total",
  help: "Total failed drips (any cause)",
  registers: [registry],
});
const throttledTotal = new Counter({
  name: "faucet_throttled_total",
  help: "Total rate-limited drip attempts",
  registers: [registry],
});

const l1BalanceEth = new Gauge({
  name: "faucet_l1_balance_eth",
  help: "Operator Sepolia ETH balance",
  registers: [registry],
});
const l1BalanceFeeJuice = new Gauge({
  name: "faucet_l1_balance_fee_juice",
  help: "Operator L1 fee-juice balance",
  registers: [registry],
});
const l2BalanceTUSDC = new Gauge({
  name: "faucet_l2_balance_tusdc",
  help: "Operator tUSDC balance on L2",
  registers: [registry],
});
const l2BalanceTETH = new Gauge({
  name: "faucet_l2_balance_teth",
  help: "Operator tETH balance on L2",
  registers: [registry],
});

export const metrics = {
  registry,
  dripTotal,
  dripFailedTotal,
  throttledTotal,
  l1BalanceEth,
  l1BalanceFeeJuice,
  l2BalanceTUSDC,
  l2BalanceTETH,
};

export function resetMetricsForTest(): void {
  registry.resetMetrics();
}
