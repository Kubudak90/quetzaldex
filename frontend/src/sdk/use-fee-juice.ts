// Fee-juice balance + in-app refuel hooks.
//
// Each wallet self-pays L2 tx fees from its fee-juice balance. An order tx costs
// ~3.4 FJ and onboarding grants 100 FJ, so a heavy session can run dry and hit
// "Insufficient fee payer balance". These hooks surface the running balance and
// a one-tap refuel: drip a fresh claim from the Quetzal faucet (also tops up test
// tokens) and redeem it into the balance in-browser. (The external Nethermind
// faucet can't be called from the browser — no CORS — so we use our own faucet.)
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useQuetzalClient, useClientContext } from "./client-context";
import { dripFaucet } from "../onboarding/faucet-client";

const FAUCET_URL =
  (import.meta.env.VITE_FAUCET_URL as string | undefined) ?? "https://faucet.quetzaldex.xyz";

/** 1 fee-juice = 1e18 base units. */
export const FJ_UNIT = 10n ** 18n;
/** Approx fee-juice cost of one order tx (measured on testnet). */
export const ORDER_FJ_COST = 3.4;
/** Warn below ~2 orders of headroom. */
export const LOW_FUEL_THRESHOLD = 8n * FJ_UNIT;

/** Format fee-juice base units as "X.XX FJ" (or "—" when unknown). */
export function formatFeeJuice(v: bigint | null | undefined): string {
  if (v == null) return "—";
  const whole = v / FJ_UNIT;
  const frac = ((v % FJ_UNIT) * 100n) / FJ_UNIT;
  return `${whole.toString()}.${frac.toString().padStart(2, "0")} FJ`;
}

/** Rough "orders remaining" estimate from a fee-juice balance. */
export function ordersRemaining(v: bigint | null | undefined): number | null {
  if (v == null) return null;
  return Math.floor(Number(v / FJ_UNIT) / ORDER_FJ_COST);
}

/**
 * Live fee-juice balance for `address` (defaults to the connected account).
 * Polls every 30s; returns base units (bigint) or null when disconnected.
 */
export function useFeeJuiceBalance(address?: string) {
  const client = useQuetzalClient();
  const { session } = useClientContext();
  const addr = address ?? client?.address.toString();
  return useQuery<bigint | null>({
    queryKey: ["fee-juice", session?.sessionId, addr],
    queryFn: async () => {
      if (!client || !addr) return null;
      return await client.fees.getJuiceBalance(addr);
    },
    enabled: !!client && !!addr,
    staleTime: 15_000,
    refetchInterval: 30_000,
  });
}

export interface RefuelProgress {
  phase: "dripping" | "bridging" | "redeeming";
}

/**
 * One-tap refuel: drip a fee-juice claim from the Quetzal faucet, then redeem it
 * into the connected wallet's balance (retries while the L1->L2 message bridges).
 * Pass an optional onProgress to narrate the phases. Invalidates the balance on
 * success so the display refreshes.
 */
export function useRefuel(onProgress?: (p: RefuelProgress) => void) {
  const client = useQuetzalClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      if (!client) throw new Error("Connect a wallet first.");
      const addr = client.address.toString() as `0x${string}`;
      onProgress?.({ phase: "dripping" });
      const drip = await dripFaucet({ faucetUrl: FAUCET_URL, address: addr });
      return await client.fees.redeemClaim(
        {
          claimAmount: drip.claimData.claimAmount,
          claimSecretHex: drip.claimData.claimSecretHex,
          messageLeafIndex: drip.claimData.messageLeafIndex,
        },
        { onProgress: (phase) => onProgress?.({ phase }) },
      );
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["fee-juice"] });
    },
  });
}
