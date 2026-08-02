import { describe, test, expect, vi } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import {
  useOnboardingStep3,
  type OnboardingStep3Deps,
} from "./use-onboarding-step3";
import type { DripResult } from "./faucet-client";
import type { ClaimDeployResult } from "./claim-deploy";

const MASTER = "0x" + "11".repeat(32);
const PASSPHRASE = "test passphrase";

function mkDeps(overrides: Partial<OnboardingStep3Deps> = {}): OnboardingStep3Deps {
  const dripResult = (addr: string): DripResult => ({
    l2Address: addr as `0x${string}`,
    claimData: {
      claimAmount: "100000000000000000000",
      claimSecretHex: "0x" + "a1".repeat(32),
      claimSecretHashHex: "0x" + "a2".repeat(32),
      messageHashHex: "0x" + "a3".repeat(32),
      messageLeafIndex: "1",
      l1TxHash: "0x" + "a4".repeat(32),
    },
    tUSDCMint: { txHash: "0x" + "b1".repeat(32), amount: "1000000000" },
    tETHMint: { txHash: "0x" + "b2".repeat(32), amount: "500000000000000000" },
  });
  const claimResult: ClaimDeployResult = {
    deployTxHash: "0x" + "c1".repeat(32),
    deployedAddress: "0x" + "d1".repeat(32) as `0x${string}`,
  };
  return {
    deriveAddress: vi.fn().mockImplementation(async (secret: string) =>
      // Mock address derivation: use secret as the L2 address for test simplicity.
      // Production wires this to the SDK in deps.deriveAddress (see runtime config in Step 3).
      secret as `0x${string}`,
    ),
    dripFaucet: vi.fn().mockImplementation(({ address }) => Promise.resolve(dripResult(address))),
    claimAndDeploy: vi.fn().mockResolvedValue(claimResult),
    saveSession: vi.fn().mockResolvedValue(undefined),
    config: {
      faucetUrl: "https://faucet.example",
      nodeUrl: "https://node.example",
    },
    ...overrides,
  };
}

describe("useOnboardingStep3", () => {
  test("idle → running through all N children → done", async () => {
    const deps = mkDeps();
    const { result } = renderHook(() =>
      useOnboardingStep3({ masterSecret: MASTER, n: 2, passphrase: PASSPHRASE, deps })
    );

    expect(result.current.phase).toBe("idle");

    act(() => { result.current.start(); });

    await waitFor(() => {
      expect(result.current.phase).toBe("done");
    }, { timeout: 3000 });

    expect(deps.dripFaucet).toHaveBeenCalledTimes(2);
    expect(deps.claimAndDeploy).toHaveBeenCalledTimes(2);
    expect(deps.saveSession).toHaveBeenCalledTimes(1);
    expect(result.current.children).toHaveLength(2);
    expect(result.current.children.every((c) => c.state === "done")).toBe(true);
  });

  test("error in one child does not block other children", async () => {
    const failDrip = vi.fn().mockImplementationOnce(() => Promise.reject(new Error("boom")))
      .mockImplementation(({ address }) => Promise.resolve({
        l2Address: address as `0x${string}`,
        claimData: { claimAmount: "1", claimSecretHex: "0x1", claimSecretHashHex: "0x2", messageHashHex: "0x3", messageLeafIndex: "1", l1TxHash: "0x4" },
        tUSDCMint: { txHash: "0x5", amount: "1" },
        tETHMint: { txHash: "0x6", amount: "1" },
      }));
    const deps = mkDeps({ dripFaucet: failDrip });
    const { result } = renderHook(() =>
      useOnboardingStep3({ masterSecret: MASTER, n: 2, passphrase: PASSPHRASE, deps })
    );

    act(() => { result.current.start(); });

    await waitFor(() => {
      expect(result.current.phase).toBe("partial-error");
    }, { timeout: 3000 });

    expect(result.current.children[0]?.state).toBe("error");
    expect(result.current.children[1]?.state).toBe("done");
  });

  test("retry(i) re-runs only the failed child", async () => {
    const dripCalls: string[] = [];
    const failOnce = vi.fn().mockImplementation(({ address }) => {
      dripCalls.push(address);
      if (dripCalls.length === 1) return Promise.reject(new Error("boom"));
      return Promise.resolve({
        l2Address: address as `0x${string}`,
        claimData: { claimAmount: "1", claimSecretHex: "0x1", claimSecretHashHex: "0x2", messageHashHex: "0x3", messageLeafIndex: "1", l1TxHash: "0x4" },
        tUSDCMint: { txHash: "0x5", amount: "1" },
        tETHMint: { txHash: "0x6", amount: "1" },
      });
    });
    const deps = mkDeps({ dripFaucet: failOnce });
    const { result } = renderHook(() =>
      useOnboardingStep3({ masterSecret: MASTER, n: 1, passphrase: PASSPHRASE, deps })
    );

    act(() => { result.current.start(); });
    await waitFor(() => expect(result.current.phase).toBe("partial-error"));
    expect(result.current.children[0]?.state).toBe("error");

    act(() => { result.current.retry(0); });
    await waitFor(() => expect(result.current.phase).toBe("done"));
    expect(result.current.children[0]?.state).toBe("done");
  });
});
