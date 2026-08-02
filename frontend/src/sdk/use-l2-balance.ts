// L2 token-balance hooks for the bridge/wallet screens.
//
// The app previously rendered NO real L2 token balance anywhere (the bridge
// "Balances" panel showed hardcoded mock numbers, wallet columns showed "—"),
// so a successful bridge claim produced no visible balance change. These hooks
// read the connected account's real public + private L2 balances via the SDK
// (client.reads.getBalance / getPrivateBalance) and a per-address public balance
// for wallet-pool children (getPublicBalanceOf).
import { useQuery } from "@tanstack/react-query";
import { resolveTokenDecimals } from "@quetzal/sdk";
import { useQuetzalClient, useClientContext } from "./client-context";

// On-chain Token balances are stored at each token's TRUE decimals (USDC=6,
// WETH=18, wBTC=8) — the same scale the SDK's resolveTokenDecimals, orders.ts,
// and the Trade screen use. Format with the per-token decimals (not a single
// hardcoded value) so balances match the rest of the app.
const FALLBACK_DECIMALS = 6;

/** True decimals for a token alias; falls back to 6 for unknown aliases. */
export function tokenDecimals(token: string): number {
  try {
    return resolveTokenDecimals(token);
  } catch {
    return FALLBACK_DECIMALS;
  }
}

/** Format an atomic balance as a grouped decimal string ("1,234.5"); trailing zeros trimmed. */
export function formatTokenAmount(atomic: bigint | null | undefined, decimals = FALLBACK_DECIMALS): string {
  if (atomic == null) return "—";
  const neg = atomic < 0n;
  const v = neg ? -atomic : atomic;
  const base = 10n ** BigInt(decimals);
  const whole = v / base;
  const frac = (v % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  const wholeStr = whole.toLocaleString("en-US");
  return (neg ? "-" : "") + (frac ? `${wholeStr}.${frac}` : wholeStr);
}

/** Format an atomic balance using the token's TRUE decimals (USDC=6/WETH=18/wBTC=8). */
export function formatTokenBalance(atomic: bigint | null | undefined, token: string): string {
  return formatTokenAmount(atomic, tokenDecimals(token));
}

export interface L2Balance {
  /** Public L2 balance (atomic units). */
  public: bigint;
  /** Private L2 balance of the connected account (atomic units). */
  private: bigint;
}

/**
 * Live L2 balance (public + private) of the connected account for `token`.
 * Polls every 30s. Keyed so callers can invalidate after a claim/deposit via
 * qc.invalidateQueries({ queryKey: ["l2-balance"] }).
 */
export function useL2Balance(token: string) {
  const client = useQuetzalClient();
  const { session } = useClientContext();
  return useQuery<L2Balance>({
    queryKey: ["l2-balance", session?.sessionId, client?.address.toString(), token],
    queryFn: async (): Promise<L2Balance> => {
      if (!client) return { public: 0n, private: 0n };
      const [pub, priv] = await Promise.all([
        client.reads.getBalance(token).catch(() => 0n),
        client.reads.getPrivateBalance(token).catch(() => 0n),
      ]);
      return { public: pub, private: priv };
    },
    enabled: !!client,
    staleTime: 20_000,
    refetchInterval: 30_000,
  });
}
