// DepositTab — L1 → L2 bridge deposit form.

import { useState } from "react";
import type { CSSProperties } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useQuetzalClient, useClientContext } from "../../sdk/client-context.js";
import { useL1WalletClient, useL1Account } from "../../l1/hooks.js";
import {
  Eyebrow, Dot, PillButton, Field, AddressMono, Tooltip, Segmented,
} from "../../components/atoms.js";
import { useIsMobile } from "../../hooks/use-media-query.js";
import {
  addPendingClaim,
  type PendingClaim,
} from "./pending-claims.js";
import {
  parseAmount,
  tokenById,
  BRIDGE_TOKENS,
  type PushToast,
} from "./helpers.js";
import { BalanceLine } from "./scheduled-exits.js";
import { useL2Balance, formatTokenBalance, tokenDecimals } from "../../sdk/use-l2-balance.js";

export function DepositTab({ pushToast }: { pushToast: PushToast }) {
  const client = useQuetzalClient();
  const { session } = useClientContext();
  const qc = useQueryClient();
  const l1Wallet = useL1WalletClient();
  const { isConnected: l1Connected } = useL1Account();

  const [token, setToken] = useState("USDC");
  const [amount, setAmount] = useState("");
  const [visibility, setVisibility] = useState<"private" | "public">("private");
  const [step, setStep] = useState(0); // 0=form, 1=l1 sent, 2=ready

  const tokenData = tokenById(token);
  // Real on-chain L2 balances of the connected account (was hardcoded mock data).
  const l2bal = useL2Balance(token);

  // Sub-7c A3 shipped SDK bridge.deposit (viem-backed). DepositTab calls it
  // directly with l1Wallet from useL1WalletClient(). Pending claims persist to
  // localStorage via ./bridge/pending-claims.ts (Sub-7c C1).
  const depositMut = useMutation({
    mutationFn: async (input: { token: string; amount: bigint; isPrivate: boolean }) => {
      if (!client) throw new Error("Not connected");
      if (!l1Wallet) throw new Error("L1 wallet not connected — click 'Connect L1' in the top bar");
      return await client.bridge.deposit(
        {
          token: input.token,
          amount: input.amount,
          isPrivate: input.isPrivate,
        },
        l1Wallet,
      );
    },
    onSuccess: (result) => {
      const claim: PendingClaim = {
        token,
        amount: parseAmount(amount, tokenDecimals(token)).toString(), // M10: WETH=18, not a fixed 6
        secret: result.secret ?? "",
        secretHash: result.secretHash ?? "",
        // Sub-7c Task 12: SDK now parses messageHash from the L1Inbox.MessageSent
        // event emitted in the deposit tx (BridgeApi.deposit Option B). If the
        // event was missing (defensive fallback), messageHash is undefined and
        // the polling query falls back to a no-op (button stays Waiting; user
        // can still claim manually after the ~4-15min L1→L2 sync window).
        messageHash: result.messageHash ?? "",
        messageIndex: result.messageIndex.toString(),
        isPrivate: visibility === "private",
        createdAt: Date.now(),
      };
      addPendingClaim(claim);
      setStep(2);
      pushToast({ kind: "ok", text: `Deposit submitted: L1 tx ${String(result.l1TxHash).slice(0, 10)}…` });
      void qc.invalidateQueries({ queryKey: ["pendingClaims", session?.sessionId] });
      void qc.invalidateQueries({ queryKey: ["l2-balance"] });
    },
    onError: (e) => {
      const msg = e instanceof Error ? e.message : String(e);
      pushToast({ kind: "warn", text: msg.slice(0, 200) });
      setStep(0);
    },
  });

  function handleSubmit() {
    setStep(1);
    pushToast({ kind: "info", text: "L1 transaction broadcast — waiting for L1→L2 message" });
    depositMut.mutate({
      token,
      amount: parseAmount(amount, tokenDecimals(token)), // M10: per-token decimals (WETH=18)
      isPrivate: visibility === "private",
    });
  }

  const isMobile = useIsMobile();

  return (
    <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "1fr 320px", gap: isMobile ? 16 : 20 }}>

      <div className="q-card" style={{ display: "flex", flexDirection: "column", gap: 16 }}>

        {/* L1 connection warning */}
        {!l1Connected && (
          <div style={{
            background: "rgba(212,162,74,0.08)",
            border: "1px solid rgba(212,162,74,0.4)",
            borderRadius: 6, padding: "12px 14px",
            display: "flex", alignItems: "flex-start", gap: 10,
            fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--fg)",
          }}>
            <i data-lucide="alert-triangle" style={{ width: 14, height: 14, color: "var(--proving)", strokeWidth: 1.5, marginTop: 2, flexShrink: 0 } as CSSProperties}></i>
            <span>Connect MetaMask on Sepolia before submitting a deposit. Use the "Connect L1" button {isMobile ? "above" : "in the top bar"}.</span>
          </div>
        )}

        {/* token + amount */}
        <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "140px 1fr", gap: isMobile ? 12 : 8 }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <Eyebrow>Token</Eyebrow>
            <select value={token} onChange={(e) => setToken(e.target.value)} style={{
              height: 48, padding: "0 12px", borderRadius: 6,
              border: "1px solid var(--hairline-strong)", background: "var(--surface)",
              fontFamily: "var(--font-mono)", fontSize: 14, color: "var(--fg)",
              appearance: "none", cursor: "pointer",
            }}>
              {BRIDGE_TOKENS.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}
            </select>
          </div>
          <Field
            label="Amount"
            mono
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="0.00"
            suffix={`L1 bal · ${tokenData.l1Bal}`}
            hint="Click 'Max' to use full L1 balance"
          />
        </div>

        {/* Max button as separate row (Field hint is a string in our atoms typing) */}
        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <button onClick={() => setAmount(tokenData.l1Bal.replace(/,/g, ""))} style={{
            background: "transparent", border: "none", padding: 0,
            fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--fg)",
            cursor: "pointer", textDecoration: "underline",
          }}>Max</button>
        </div>

        {/* Recipient — M12: the deposit always credits the connected wallet. The SDK
            has no l2Recipient param, so the old "Send to…" input was silently ignored
            and the default row showed a hardcoded mock address. Show the real address. */}
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <Eyebrow>Recipient</Eyebrow>
          <div style={{
            height: 48, padding: "0 14px", borderRadius: 6,
            border: "1px solid var(--hairline)", background: "var(--bg-alt)",
            display: "flex", alignItems: "center", gap: 10,
          }}>
            <Dot kind="private" size={8} />
            <span style={{ fontFamily: "var(--font-mono)", fontSize: 13, color: "var(--fg-muted)" }}>your wallet ·</span>
            <AddressMono value={client?.address ? client.address.toString() : "—"} />
          </div>
        </div>

        {/* Privacy mode */}
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <Eyebrow>Privacy mode</Eyebrow>
            <Tooltip body="Private deposits use a secret hash; only you can claim them on L2. Public deposits go directly to recipient and are linkable to your L1 address.">
              <i data-lucide="help-circle" style={{ width: 12, height: 12, color: "var(--fg-muted)", strokeWidth: 1.5 } as CSSProperties}></i>
            </Tooltip>
          </div>
          <Segmented
            value={visibility}
            onChange={(v) => setVisibility(v as "private" | "public")}
            fullWidth
            size="lg"
            options={[
              { id: "private", label: "Private", dot: "private", activeBg: "var(--aztec-ink)", activeFg: "var(--aztec-parchment)" },
              { id: "public",  label: "Public",  dot: "public",  activeBg: "var(--surface)",  activeFg: "var(--fg)" },
            ]}
          />
        </div>

        {/* Submit / progress */}
        {step === 0 && (
          <PillButton size="lg" fullWidth variant="primary" onClick={handleSubmit}
            disabled={!amount || depositMut.isPending} rightIcon="arrow-right">
            {depositMut.isPending ? "Submitting…" : `Bridge ${amount || "0"} ${token} to Aztec`}
          </PillButton>
        )}
        {step === 1 && (
          <div style={{
            background: "rgba(212,162,74,0.08)",
            border: "1px solid rgba(212,162,74,0.4)",
            borderRadius: 6, padding: "14px 16px",
            display: "flex", alignItems: "center", gap: 12,
          }}>
            <Dot kind="proving" size={14} />
            <div style={{ flex: 1 }}>
              <div style={{ fontFamily: "var(--font-mono)", fontSize: 13, color: "var(--fg)" }}>Waiting for L1→L2 message</div>
              <div style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--fg-muted)", marginTop: 2 }}>~4-15 min · auto-polling every 30s</div>
            </div>
            <div style={{ height: 4, width: 120, background: "var(--hairline)", borderRadius: 2, overflow: "hidden" }}>
              <div style={{ height: "100%", width: "65%", background: "var(--proving)", transition: "width 1s linear" }} />
            </div>
          </div>
        )}
        {step === 2 && (
          <div style={{
            background: "rgba(13,152,118,0.06)",
            border: "1px solid rgba(13,152,118,0.4)",
            borderRadius: 6, padding: "14px 16px",
            display: "flex", alignItems: "center", gap: 12,
          }}>
            <i data-lucide="check-circle" style={{ width: 18, height: 18, color: "#0d9876", strokeWidth: 1.5 } as CSSProperties}></i>
            <div style={{ flex: 1 }}>
              <div style={{ fontFamily: "var(--font-mono)", fontSize: 13, color: "var(--fg)" }}>Ready to claim on L2</div>
              <div style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--fg-muted)", marginTop: 2 }}>Switch to the Claim tab to finalize.</div>
            </div>
            <PillButton size="sm" variant="ink" onClick={() => { setStep(0); setAmount(""); }}>Reset</PillButton>
          </div>
        )}
      </div>

      {/* sidebar */}
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <div className="q-card q-card-tight">
          <Eyebrow style={{ marginBottom: 12 }}>Balances · {token}</Eyebrow>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <BalanceLine kind="public" label="L1 · Sepolia" amount={tokenData.l1Bal} token={token} />
            <BalanceLine kind="private" label="L2 · private" amount={formatTokenBalance(l2bal.data?.private, token)} token={`a${token}`} />
            <BalanceLine kind="public" label="L2 · public" amount={formatTokenBalance(l2bal.data?.public, token)} token={`a${token}`} />
          </div>
        </div>
        <div className="q-card q-card-tight">
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
            <i data-lucide="info" style={{ width: 12, height: 12, color: "var(--fg-muted)", strokeWidth: 1.5 } as CSSProperties}></i>
            <Eyebrow>Bridge latency</Eyebrow>
          </div>
          <div style={{ fontFamily: "var(--font-body)", fontSize: 12, color: "var(--fg-muted)", lineHeight: 1.5 }}>
            L1→L2: ~4–15 min<br />
            L2→L1: ~30 min after epoch finalizes
          </div>
        </div>
      </div>
    </div>
  );
}
