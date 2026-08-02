// Thin wrappers around wagmi hooks. The rest of the app uses these so the
// wagmi import surface is centralised.

import { useAccount, useConnect, useDisconnect, useWalletClient, useReadContract } from "wagmi";
import { injected } from "wagmi/connectors";
import { sepolia } from "wagmi/chains";
import { ERC20_ABI } from "./abis.js";

export function useL1Account(): { address?: `0x${string}`; isConnected: boolean } {
  const { address, isConnected } = useAccount();
  return { address, isConnected };
}

export function useL1Connect(): { connect: () => void; isPending: boolean; error?: Error } {
  const { connect, isPending, error } = useConnect();
  return {
    connect: () => connect({ connector: injected(), chainId: sepolia.id }),
    isPending,
    error: error ?? undefined,
  };
}

export function useL1Disconnect(): () => void {
  const { disconnect } = useDisconnect();
  return disconnect;
}

export function useL1WalletClient() {
  return useWalletClient({ chainId: sepolia.id }).data ?? null;
}

export function useL1TokenBalance(
  token: `0x${string}` | undefined,
  owner: `0x${string}` | undefined,
): { value: bigint | null; isLoading: boolean } {
  const { data, isLoading } = useReadContract({
    address: token,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: owner ? [owner] : undefined,
    query: { enabled: !!token && !!owner },
  });
  return { value: (data as bigint | undefined) ?? null, isLoading };
}
