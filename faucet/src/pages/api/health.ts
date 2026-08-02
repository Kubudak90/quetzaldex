import type { NextApiRequest, NextApiResponse } from "next";
import { getRuntime } from "@/lib/runtime";
import type { HealthResponse } from "@/lib/types";
import { formatEther, createPublicClient, http } from "viem";
import { sepolia } from "viem/chains";
import { getOperatorL2Balance } from "@/lib/l2-mint";
import { createAztecNodeClient } from "@aztec/aztec.js/node";
import { metrics } from "@/lib/metrics";
import { safeReason } from "@/lib/safe-error";

export default async function handler(req: NextApiRequest, res: NextApiResponse): Promise<void> {
  if (req.method !== "GET") { res.status(405).end(); return; }
  const rt = getRuntime();
  try {
    const ethBal = await rt.l1Bridge.getEthBalance();
    const pc = createPublicClient({ chain: sepolia, transport: http(rt.config.l1RpcUrl) });
    const blockNumber = await pc.getBlockNumber();
    const feeJuiceBal = await rt.l1Bridge.getFeeJuiceBalance();

    const node = createAztecNodeClient(rt.config.l2NodeUrl);
    const nodeInfo = await node.getNodeInfo();

    const tUSDCBal = await getOperatorL2Balance({
      nodeUrl: rt.config.l2NodeUrl,
      operatorSecret: rt.config.l2Secret,
      operatorSalt: rt.config.l2Salt,
      operatorSigningKey: rt.config.l2SigningKey,
      tokenAddress: rt.config.l2TUSDC,
    });
    const tETHBal = await getOperatorL2Balance({
      nodeUrl: rt.config.l2NodeUrl,
      operatorSecret: rt.config.l2Secret,
      operatorSalt: rt.config.l2Salt,
      operatorSigningKey: rt.config.l2SigningKey,
      tokenAddress: rt.config.l2TETH,
    });

    metrics.l1BalanceEth.set(Number(formatEther(ethBal)));
    if (feeJuiceBal !== null) metrics.l1BalanceFeeJuice.set(Number(feeJuiceBal));
    metrics.l2BalanceTUSDC.set(Number(tUSDCBal));
    metrics.l2BalanceTETH.set(Number(tETHBal));

    const drainThreshold = BigInt(rt.config.drainThresholdMultiplier);
    const degraded =
      tUSDCBal < rt.config.tUSDCAmount * drainThreshold ||
      tETHBal < rt.config.tETHAmount * drainThreshold;

    const stats = rt.rateLimiter.stats({ now: () => Math.floor(Date.now() / 1000) });

    const body: HealthResponse = {
      status: degraded ? "degraded" : "ok",
      l1: {
        blockNumber: Number(blockNumber),
        operatorBalanceEth: formatEther(ethBal),
        operatorBalanceFeeJuice: feeJuiceBal !== null ? feeJuiceBal.toString() : "unknown",
      },
      l2: {
        rollupVersion: nodeInfo.rollupVersion,
        operatorBalanceTUSDC: tUSDCBal.toString(),
        operatorBalanceTETH: tETHBal.toString(),
      },
      rateLimit: stats,
    };
    res.status(200).json(body);
  } catch (e) {
    // Audit #7: never leak the raw error to the client — upstream errors have
    // exposed full RPC URLs + API keys. Full detail goes to server logs only;
    // the client receives a coarse, non-sensitive category.
    console.error("[health] probe failed", e);
    res.status(503).json({ status: "degraded", error: safeReason(e) });
  }
}
