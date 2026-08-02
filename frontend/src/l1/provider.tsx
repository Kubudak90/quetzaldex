// wagmi-based L1 wallet provider. MetaMask only for MVP; WalletConnect /
// Coinbase Wallet deferred to Sub-7d.

import { ReactNode, useMemo } from "react";
import { createConfig, http, WagmiProvider } from "wagmi";
import { sepolia } from "wagmi/chains";
import { injected } from "wagmi/connectors";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

export interface L1ProviderProps {
  children: ReactNode;
  /** Optional RPC override; defaults to VITE_L1_RPC_URL */
  rpcUrl?: string;
}

export function L1Provider({ children, rpcUrl }: L1ProviderProps) {
  const config = useMemo(() => createConfig({
    chains: [sepolia],
    connectors: [injected({ shimDisconnect: true })],
    transports: {
      [sepolia.id]: http(rpcUrl ?? import.meta.env.VITE_L1_RPC_URL ?? "https://sepolia.drpc.org"),
    },
  }), [rpcUrl]);

  // Dedicated query client for L1 reads (separate from the existing app-level
  // react-query client used for L2 ops).
  const queryClient = useMemo(() => new QueryClient({
    defaultOptions: { queries: { staleTime: 30_000 } },
  }), []);

  return (
    <WagmiProvider config={config}>
      <QueryClientProvider client={queryClient}>
        {children}
      </QueryClientProvider>
    </WagmiProvider>
  );
}
