// PendingL1WithdrawsPanel — polls buildOutboxProof per row; once proof is ready
// exposes a "Withdraw on L1" button that calls prepareL1Withdraw + MetaMask sign.
// Sub-7c D2 (Task 13).

import { useMutation, useQuery, useQueries, useQueryClient } from "@tanstack/react-query";
import { sepolia } from "wagmi/chains";
import { useQuetzalClient, useClientContext } from "../../sdk/client-context.js";
import { useL1WalletClient, useL1Account } from "../../l1/hooks.js";
import { Eyebrow, Hairline, Badge, PillButton, AddressMono } from "../../components/atoms.js";
import { TokenGlyph } from "../../components/screens-shared.js";
import { useIsMobile } from "../../hooks/use-media-query.js";
import {
  loadPendingWithdraws,
  markWithdrawComplete,
  type PendingWithdraw,
} from "./pending-withdraws.js";
import {
  buildOutboxProof,
  OutboxProofNotReadyError,
  computeWithdrawContent,
  resolveOutboxScope,
  type OutboxProof,
} from "@quetzal/sdk";
import { type PushToast } from "./helpers.js";

export function PendingL1WithdrawsPanel({ pushToast }: { pushToast: PushToast }) {
  const isMobile = useIsMobile();
  const client = useQuetzalClient();
  const { session } = useClientContext();
  const qc = useQueryClient();
  const l1Wallet = useL1WalletClient();
  const { address: l1Address } = useL1Account();
  const nodeUrl = import.meta.env.VITE_AZTEC_NODE_URL as string | undefined;
  // v5: buildOutboxProof reads the epoch's progressive roots from the L1
  // Outbox via eth_call — needs an L1 RPC. Prefer the configured one, fall
  // back to the sepolia chain's default public RPC (read-only, no wallet).
  const l1RpcUrl =
    (import.meta.env.VITE_L1_RPC_URL as string | undefined) ??
    sepolia.rpcUrls.default.http[0];

  // Wrap loadPendingWithdraws in useQuery so addPendingWithdraw → invalidateQueries
  // re-renders the panel without a manual storage event listener.
  const withdrawsQ = useQuery({
    queryKey: ["pendingWithdraws", session?.sessionId],
    queryFn: () => loadPendingWithdraws(),
    refetchInterval: false,
  });
  const withdraws = withdrawsQ.data ?? [];

  // One proof query per pending row. Polls every 60s; OutboxProofNotReadyError
  // is treated as "still pending" (returns null) so the row stays in pending state.
  const proofQueries = useQueries({
    queries: withdraws.map((w) => ({
      queryKey: ["bridge", "outbox-proof", w.l2TxHash],
      queryFn: async (): Promise<OutboxProof | null> => {
        if (!nodeUrl) return null;
        if (w.status !== "pending") return null;
        try {
          const content = computeWithdrawContent(
            w.l1Recipient,
            BigInt(w.amount),
            w.isPrivate,
          );
          // The Outbox leaf binds the emitting L2 token and the target bridge,
          // so the proof needs both — resolved from the same config the exit used.
          if (!client) return null;
          const scope = resolveOutboxScope(client.config, w.token);
          return await buildOutboxProof(nodeUrl, w.l2TxHash, content, { rpcUrl: l1RpcUrl }, scope);
        } catch (err) {
          if (err instanceof OutboxProofNotReadyError) return null;
          // Don't propagate shape/network errors as red state — leave the row
          // pending; the next 60s tick will retry.
          return null;
        }
      },
      enabled: !!nodeUrl && w.status === "pending",
      refetchInterval: 60_000,
      staleTime: 55_000,
    })),
  });

  // Per-row withdraw mutation. Keyed by l2TxHash via mutate variables so a
  // withdraw in flight for row A doesn't disable other ready rows.
  const withdrawMut = useMutation({
    mutationFn: async (args: { row: PendingWithdraw; proof: OutboxProof }) => {
      if (!client) throw new Error("Not connected");
      if (!l1Wallet) throw new Error("Connect MetaMask first");
      if (!l1Address) throw new Error("Connect MetaMask first");
      const result = await client.bridge.prepareL1Withdraw({
        token: args.row.token,
        amount: BigInt(args.row.amount),
        l1Recipient: args.row.l1Recipient,
        isPrivate: args.row.isPrivate,
        siblingPath: args.proof.siblingPath,
        l2Epoch: BigInt(args.proof.l2Epoch),
        numCheckpointsInEpoch: BigInt(args.proof.numCheckpointsInEpoch),
        leafIndex: BigInt(args.proof.leafIndex),
      });
      const l1WithdrawTxHash = await l1Wallet.sendTransaction({
        to: result.to,
        data: result.data,
        account: l1Address,
        chain: sepolia,
        value: 0n,
      });
      return { l2TxHash: args.row.l2TxHash, l1WithdrawTxHash };
    },
    onSuccess: ({ l2TxHash, l1WithdrawTxHash }) => {
      markWithdrawComplete(l2TxHash, l1WithdrawTxHash);
      void qc.invalidateQueries({ queryKey: ["pendingWithdraws", session?.sessionId] });
      pushToast({ kind: "ok", text: `L1 withdraw sent: ${l1WithdrawTxHash.slice(0, 10)}…` });
    },
    onError: (e) => pushToast({ kind: "warn", text: e instanceof Error ? e.message : "L1 withdraw failed" }),
  });

  return (
    <div className="q-card" style={{ padding: 0, overflow: "hidden" }}>
      <div style={{ padding: "16px 20px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h4 style={{ fontFamily: "var(--font-serif)", fontSize: 18, fontWeight: 400 }}>Pending L1 withdraws</h4>
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--fg-muted)" }}>{withdraws.length} total</span>
      </div>
      <Hairline />
      {withdraws.length === 0 ? (
        <div style={{ padding: 60, textAlign: "center" }}>
          <div style={{ fontFamily: "var(--font-serif)", fontSize: 15, color: "var(--fg-muted)" }}>No pending L1 withdraws.</div>
        </div>
      ) : (
        withdraws.map((w, i) => {
          const proofQ = proofQueries[i];
          const proof = proofQ?.data ?? null;
          const isReady = w.status === "pending" && proof !== null;
          const isComplete = w.status === "complete";
          const isThisRowPending =
            withdrawMut.isPending && withdrawMut.variables?.row.l2TxHash === w.l2TxHash;
          return (
            <div key={w.l2TxHash} style={{
              display: "grid", gridTemplateColumns: isMobile ? "auto 1fr auto" : "auto 1fr 1fr 120px 140px", gap: isMobile ? 10 : 16,
              alignItems: "center", padding: "16px 20px",
              borderBottom: "1px solid var(--hairline)",
            }}>
              <TokenGlyph token={w.token} size={28} />
              <div>
                <div data-mono style={{ fontFamily: "var(--font-mono)", fontSize: 16, fontWeight: 500 }}>
                  {w.amount} <span style={{ color: "var(--fg-muted)" }}>{w.token}</span>
                </div>
                <div style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--fg-muted)", marginTop: 2 }}>
                  {Math.round((Date.now() - w.createdAt) / 60000)} min ago
                </div>
              </div>
              <div>
                <Eyebrow style={{ marginBottom: 2 }}>L1 recipient</Eyebrow>
                <AddressMono value={w.l1Recipient} />
              </div>
              <div>
                {isComplete ? (
                  <Badge tone="filled">Complete</Badge>
                ) : isReady ? (
                  <Badge tone="filled">Ready</Badge>
                ) : (
                  <Badge tone="warn">Pending finalisation · ~30-90 min</Badge>
                )}
                {isComplete && w.l1WithdrawTxHash && (
                  <div style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--fg-muted)", marginTop: 4 }}>
                    L1 tx {w.l1WithdrawTxHash.slice(0, 10)}…
                  </div>
                )}
              </div>
              <div style={{ textAlign: "right" }}>
                {isComplete ? (
                  <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--fg-muted)" }}>—</span>
                ) : (
                  <PillButton
                    size="sm"
                    variant="primary"
                    disabled={isThisRowPending || !isReady}
                    onClick={() => {
                      if (!l1Wallet) {
                        pushToast({ kind: "warn", text: "Connect MetaMask first" });
                        return;
                      }
                      if (!proof) return;
                      withdrawMut.mutate({ row: w, proof });
                    }}
                    rightIcon={isReady ? "check" : "clock"}
                  >
                    {isThisRowPending ? "Signing…" : isReady ? "Withdraw" : "Waiting"}
                  </PillButton>
                )}
              </div>
            </div>
          );
        })
      )}
    </div>
  );
}
