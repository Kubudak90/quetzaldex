import { describe, test, expect } from "vitest";
import { L1Bridge } from "@/lib/l1-bridge";
import { mintBatchToPublic } from "@/lib/l2-mint";
import { loadConfig } from "@/lib/config";

const RUN = process.env.RUN_INTEGRATION_TESTS === "1";

describe.skipIf(!RUN)("faucet integration (live testnet)", () => {
  test("L1 bridgeFeeJuice + batched L2 mint (tUSDC + tETH in one tx) succeed end-to-end for a fresh address", async () => {
    const cfg = loadConfig();
    const recipient = ("0x" + "00".repeat(31) + "01") as `0x${string}`;

    const bridge = new L1Bridge({
      rpcUrl: cfg.l1RpcUrl,
      privateKey: cfg.l1Pk,
      chainId: cfg.l1ChainId,
      aztecNodeUrl: cfg.l2NodeUrl,
    });
    const bridgeRes = await bridge.bridgeFeeJuice(recipient, cfg.feeJuiceAmount);
    expect(bridgeRes.messageLeafIndex).toBeGreaterThan(0n);
    expect(bridgeRes.claimSecretHex).toMatch(/^0x[0-9a-f]{64}$/);

    // Single BatchCall tx mints both tokens — one ClientIVC proof.
    const mintRes = await mintBatchToPublic(
      { nodeUrl: cfg.l2NodeUrl, operatorSecret: cfg.l2Secret },
      recipient,
      [
        { tokenAddress: cfg.l2TUSDC, amount: cfg.tUSDCAmount },
        { tokenAddress: cfg.l2TETH, amount: cfg.tETHAmount },
      ],
    );
    expect(mintRes.txHash).toMatch(/^0x[0-9a-f]+$/);
  }, 600_000); // 10 min — testnet ClientIVC proving is slow
});
