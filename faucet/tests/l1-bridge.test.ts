import { describe, test, expect, vi } from "vitest";
import { generateClaimSecret, computeClaimSecretHash, L1Bridge } from "@/lib/l1-bridge";

describe("generateClaimSecret", () => {
  test("returns a 0x-prefixed 32-byte hex string under bn254 modulus", () => {
    const secret = generateClaimSecret();
    expect(secret).toMatch(/^0x[0-9a-f]{64}$/);
    const P_BN254 = BigInt(
      "0x30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001",
    );
    expect(BigInt(secret) < P_BN254).toBe(true);
  });

  test("produces distinct secrets on repeated calls", () => {
    const a = generateClaimSecret();
    const b = generateClaimSecret();
    expect(a).not.toBe(b);
  });
});

describe("computeClaimSecretHash", () => {
  // NOTE: deviation from plan — the hash is poseidon2 (computeSecretHash from
  // @aztec/stdlib/hash), which is async. The plan's starting-point used
  // sha256ToField but that's incompatible with the L2 FeeJuice contract's
  // claim consumption logic. See l1-bridge.ts for the full rationale.
  test("deterministic for the same input", async () => {
    const s = ("0x" + "11".repeat(32)) as `0x${string}`;
    const h1 = await computeClaimSecretHash(s);
    const h2 = await computeClaimSecretHash(s);
    expect(h1).toBe(h2);
  });

  test("distinct for distinct inputs", async () => {
    const h1 = await computeClaimSecretHash(("0x" + "11".repeat(32)) as `0x${string}`);
    const h2 = await computeClaimSecretHash(("0x" + "22".repeat(32)) as `0x${string}`);
    expect(h1).not.toBe(h2);
  });
});

// ── Task #376 (Sub-7b Phase A carryforward): L1 nonce drift fix ────────────
//
// Parallel /api/drip requests shared one viem WalletClient and fetched the
// same fresh nonce, then submitted with that stale nonce — 503 "Nonce
// provided lower than current". The fix serialises bridgeFeeJuice via a
// class-level promise chain. These two cases lock in:
//   1) parallel callers actually run one-at-a-time (mutex invariant)
//   2) a failed bridge doesn't poison the chain for the next caller
describe("L1Bridge serial mutex (Task #376)", () => {
  function mkBridge(): L1Bridge {
    return new L1Bridge({
      rpcUrl: "http://localhost:8545",
      privateKey: ("0x" + "11".repeat(32)) as `0x${string}`,
      chainId: 31337,
      aztecNodeUrl: "http://localhost:8080",
    });
  }

  function stubL1Plumbing(bridge: L1Bridge, stubManager: unknown): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (bridge as any)._portalManager = Promise.resolve(stubManager);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (bridge as any).aztecNode = {
      getNodeInfo: async () => ({
        l1ContractAddresses: {
          feeJuicePortalAddress: { toString: () => "0x" + "dd".repeat(20) },
          feeJuiceAddress: { toString: () => "0x" + "ee".repeat(20) },
        },
      }),
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (bridge as any)._l1Client = {
      getBlockNumber: async () => 100n,
      getLogs: async () => [],
    };
  }

  test("two parallel bridgeFeeJuice calls execute sequentially", async () => {
    const bridge = mkBridge();

    let activeCount = 0;
    let maxObservedConcurrency = 0;

    const stubManager = {
      bridgeTokensPublic: vi.fn(async () => {
        activeCount += 1;
        maxObservedConcurrency = Math.max(maxObservedConcurrency, activeCount);
        await new Promise((r) => setTimeout(r, 50));
        activeCount -= 1;
        return {
          messageHash: "0x" + "aa".repeat(32),
          messageLeafIndex: 0n,
          claimSecret: { toString: () => "0x" + "bb".repeat(32) },
          claimSecretHash: { toString: () => "0x" + "cc".repeat(32) },
          claimAmount: 1n,
        };
      }),
    };
    stubL1Plumbing(bridge, stubManager);

    // Note: each 32-byte address payload must be below the bn254 field
    // modulus, so we stick with the 0x11.../0x12.../0x13... family.
    const results = await Promise.all([
      bridge.bridgeFeeJuice(("0x" + "11".repeat(32)) as `0x${string}`, 1000n),
      bridge.bridgeFeeJuice(("0x" + "12".repeat(32)) as `0x${string}`, 2000n),
      bridge.bridgeFeeJuice(("0x" + "13".repeat(32)) as `0x${string}`, 3000n),
    ]);

    expect(results.length).toBe(3);
    // Mutex invariant: at most one bridgeTokensPublic in-flight at any time.
    expect(maxObservedConcurrency).toBe(1);
    expect(stubManager.bridgeTokensPublic).toHaveBeenCalledTimes(3);
  });

  test("a failed bridge does not poison subsequent calls", async () => {
    const bridge = mkBridge();

    let callIdx = 0;
    const stubManager = {
      bridgeTokensPublic: vi.fn(async () => {
        callIdx += 1;
        if (callIdx === 1) throw new Error("nonce too low");
        return {
          messageHash: "0x" + "aa".repeat(32),
          messageLeafIndex: 0n,
          claimSecret: { toString: () => "0x" + "bb".repeat(32) },
          claimSecretHash: { toString: () => "0x" + "cc".repeat(32) },
          claimAmount: 1n,
        };
      }),
    };
    stubL1Plumbing(bridge, stubManager);

    const [first, second] = await Promise.allSettled([
      bridge.bridgeFeeJuice(("0x" + "11".repeat(32)) as `0x${string}`, 1n),
      bridge.bridgeFeeJuice(("0x" + "12".repeat(32)) as `0x${string}`, 2n),
    ]);

    expect(first.status).toBe("rejected");
    expect(second.status).toBe("fulfilled");
  });
});
