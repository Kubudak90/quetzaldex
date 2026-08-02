// Quetzal — React SDK client context
// Provides lazy QuetzalClient connection via context. Call connectAztecWallet or
// connectWalletPool from SetupScreen; all downstream screens read useQuetzalClient().

import React, { createContext, useContext, useState, useCallback } from "react";
import {
  QuetzalClient,
  WalletPool,
  ConfigError,
  QuetzalError,
  type NetworkName,
  type QuetzalContracts,
} from "@quetzal/sdk";
import { loadContractsFromEnv, loadL1FromEnv } from "./contracts-env";

/**
 * Quetzal frontend SDK context.
 *
 * Lazy lifecycle: `client` is null until SetupScreen calls `connectAztecWallet`
 * or `connectWalletPool`. The connected client (and optional pool) flow through
 * context to all screens.
 *
 * Disconnect via `disconnect()` -- clears the client + stops the pool.
 */

export type ConnectionMode = "aztec-wallet" | "wallet-pool" | "external-pxe" | "test-account";

export interface QuetzalSession {
  mode: ConnectionMode;
  network: NetworkName;
  client: QuetzalClient;
  pool: WalletPool | null;
  /** Stable per-session id used to invalidate React Query caches on disconnect. */
  sessionId: number;
}

interface ClientContextValue {
  session: QuetzalSession | null;
  connecting: boolean;
  lastError: QuetzalError | null;
  connectAztecWallet: (opts: { network: NetworkName; nodeUrl?: string; contracts?: QuetzalContracts }) => Promise<void>;
  connectWalletPool: (opts: { masterSecret: string; n: number; network: NetworkName; nodeUrl?: string; contracts?: QuetzalContracts }) => Promise<void>;
  disconnect: () => Promise<void>;
}

const ClientContext = createContext<ClientContextValue | null>(null);

export function ClientProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<QuetzalSession | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [lastError, setLastError] = useState<QuetzalError | null>(null);
  const [sessionCounter, setSessionCounter] = useState(0);

  const connectAztecWallet = useCallback(async (opts: { network: NetworkName; nodeUrl?: string; contracts?: QuetzalContracts }) => {
    setConnecting(true);
    setLastError(null);
    try {
      const contracts = opts.contracts ?? loadContractsFromEnv();
      const client = await QuetzalClient.connect({
        network: opts.network,
        nodeUrl: opts.nodeUrl,
        // Discovery + encrypted channel are handled inside the adapter
        // (@aztec/wallet-sdk). No provider object is passed from the page.
        account: { type: "aztec-wallet" },
        contracts,
        l1: loadL1FromEnv(),
      });
      setSessionCounter((c) => {
        const nextId = c + 1;
        setSession({
          mode: "aztec-wallet",
          network: opts.network,
          client,
          pool: null,
          sessionId: nextId,
        });
        return nextId;
      });
    } catch (e) {
      if (e instanceof QuetzalError) setLastError(e);
      else if (e instanceof Error) setLastError(new ConfigError("UNKNOWN", e.message));
      throw e;
    } finally {
      setConnecting(false);
    }
  }, []);

  const connectWalletPool = useCallback(async (opts: { masterSecret: string; n: number; network: NetworkName; nodeUrl?: string; contracts?: QuetzalContracts }) => {
    setConnecting(true);
    setLastError(null);
    try {
      const contracts = opts.contracts ?? loadContractsFromEnv();
      const pool = await WalletPool.fromMaster({
        masterSecret: opts.masterSecret,
        n: opts.n,
        network: opts.network,
        nodeUrl: opts.nodeUrl,
        contracts,
        l1: loadL1FromEnv(),
      });
      const client = pool.next();
      setSessionCounter((c) => {
        const nextId = c + 1;
        setSession({
          mode: "wallet-pool",
          network: opts.network,
          client,
          pool,
          sessionId: nextId,
        });
        return nextId;
      });
    } catch (e) {
      if (e instanceof QuetzalError) setLastError(e);
      else if (e instanceof Error) setLastError(new ConfigError("UNKNOWN", e.message));
      throw e;
    } finally {
      setConnecting(false);
    }
  }, []);

  const disconnect = useCallback(async () => {
    if (!session) return;
    try {
      if (session.pool) await session.pool.stop();
      else await session.client.stop();
    } catch {
      // Best-effort: ignore stop errors
    }
    setSession(null);
  }, [session]);

  return (
    <ClientContext.Provider value={{ session, connecting, lastError, connectAztecWallet, connectWalletPool, disconnect }}>
      {children}
    </ClientContext.Provider>
  );
}

export function useClientContext(): ClientContextValue {
  const ctx = useContext(ClientContext);
  if (!ctx) throw new Error("useClientContext must be used inside <ClientProvider>");
  return ctx;
}

/**
 * Returns the connected client OR null if not yet connected.
 * Callers should render a "connect first" CTA when null.
 */
export function useQuetzalClient(): QuetzalClient | null {
  return useClientContext().session?.client ?? null;
}

/**
 * Returns the WalletPool if the user picked the pool mode; null otherwise.
 * Used by /wallet to show per-child cards.
 */
export function useWalletPool(): WalletPool | null {
  return useClientContext().session?.pool ?? null;
}
