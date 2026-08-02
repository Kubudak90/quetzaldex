// ExitTab — L2 → L1 bridge exit form with optional multi-hop split.

import { useState, useMemo, useEffect, Fragment } from "react";
import type { CSSProperties } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useQuetzalClient, useClientContext } from "../../sdk/client-context.js";
import { Eyebrow, PillButton, Field, Segmented, Tooltip } from "../../components/atoms.js";
import { RoundAmountAdvisory } from "../../components/screens-shared.js";
import { useIsMobile } from "../../hooks/use-media-query.js";
import {
  addPendingWithdraw,
} from "./pending-withdraws.js";
import {
  parseAmount,
  tokenById,
  isValidL1Address,
  BRIDGE_TOKENS,
  type PushToast,
} from "./helpers.js";
import { useL1Account } from "../../l1/hooks.js";
import { BalanceLine } from "./scheduled-exits.js";
import { PendingL1WithdrawsPanel } from "./pending-l1-withdraws-panel.js";
import { tokenDecimals } from "../../sdk/use-l2-balance.js";

interface ExitAdvisory {
  classification: "natural" | "round_unit" | "round_cent";
  suggested?: string;
}

interface ScheduleTimelineProps {
  parts: number;
  interval: number;
  amount: string;
  token: string;
}

function ScheduleTimeline({ parts, interval, amount, token }: ScheduleTimelineProps) {
  const per = (parseFloat(String(amount).replace(/,/g, "")) / parts).toFixed(2);
  return (
    <div>
      <div style={{ fontFamily: "var(--font-mono)", fontSize: 10, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--fg-muted)", marginBottom: 8 }}>
        Schedule preview
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
        {Array.from({ length: parts }).map((_, i) => (
          <Fragment key={i}>
            <div style={{ flex: 1, position: "relative" }}>
              <div style={{
                height: 28,
                background: i === 0 ? "var(--aztec-ink)" : "var(--surface-card)",
                border: `1px solid ${i === 0 ? "var(--aztec-ink)" : "var(--hairline-strong)"}`,
                borderRadius: 4,
                display: "flex", alignItems: "center", justifyContent: "center",
                fontFamily: "var(--font-mono)", fontSize: 10, fontWeight: 500,
                color: i === 0 ? "var(--aztec-parchment)" : "var(--fg)",
              }}>
                {per} {token}
              </div>
              <div style={{ fontFamily: "var(--font-mono)", fontSize: 9, color: "var(--fg-subtle)", marginTop: 4, textAlign: "center" }}>
                {i === 0 ? "now" : `+${i * interval}d`}
              </div>
            </div>
            {i < parts - 1 && <div style={{ width: 6, height: 1, background: "var(--hairline-strong)" }} />}
          </Fragment>
        ))}
      </div>
    </div>
  );
}

export function ExitTab({ pushToast }: { pushToast: PushToast }) {
  const client = useQuetzalClient();
  const { session } = useClientContext();
  const qc = useQueryClient();

  const [token, setToken] = useState("USDC");
  const [amount, setAmount] = useState("");
  const [visibility, setVisibility] = useState<"private" | "public">("private");
  // H8: start EMPTY, never a placeholder address. The exit binds l1Recipient into
  // the withdraw content; a leftover mock address burns the balance to an address
  // nobody controls. Prefill from the connected L1 wallet when available.
  const [recipient, setRecipient] = useState("");
  const { address: l1Address } = useL1Account();
  useEffect(() => {
    if (!recipient && l1Address) setRecipient(l1Address);
  }, [l1Address, recipient]);
  const recipientValid = isValidL1Address(recipient);
  const [splitInto, setSplitInto] = useState(1);
  const [interval, setIntervalDays] = useState(7);
  const [ackRound, setAckRound] = useState(false);
  const [ackDelay, setAckDelay] = useState(false);

  const advisory: ExitAdvisory = useMemo(() => {
    if (!amount) return { classification: "natural" };
    const n = parseFloat(amount.replace(/,/g, ""));
    if (isNaN(n)) return { classification: "natural" };
    if (/^\d+$/.test(String(n))) return { classification: "round_unit", suggested: (n + 0.073).toFixed(3) };
    if (/^\d+\.00$/.test(String(n.toFixed(2))) && n >= 100) return { classification: "round_cent", suggested: (n + 0.073).toFixed(3) };
    return { classification: "natural" };
  }, [amount]);

  const parsed = parseFloat(amount.replace(/,/g, ""));
  const showRoundTrip = !isNaN(parsed) && parsed >= 2400 && parsed <= 2600;

  const exitMut = useMutation({
    mutationFn: async (input: { token: string; amount: bigint; l1Recipient: string; isPrivate: boolean; splitInto: number; intervalDays: number; ackRound: boolean; ackDelay: boolean }) => {
      if (!client) throw new Error("Not connected");
      return await client.bridge.exit({
        token: input.token,
        amount: input.amount,
        l1Recipient: input.l1Recipient,
        isPrivate: input.isPrivate,
        splitInto: input.splitInto > 1 ? input.splitInto : undefined,
        intervalDays: input.splitInto > 1 ? input.intervalDays : undefined,
        ackRound: input.ackRound,
        ackDelay: input.ackDelay,
      });
    },
    onSuccess: (result, vars) => {
      void qc.invalidateQueries({ queryKey: ["scheduledExits", session?.sessionId] });
      if ("scheduledExits" in result) {
        pushToast({ kind: "ok", text: `${(result as { scheduledExits: unknown[] }).scheduledExits.length} exits scheduled.` });
      } else {
        const exitResult = result as { l2TxHash: string };
        pushToast({ kind: "ok", text: `Exit submitted: L2 tx ${String(exitResult.l2TxHash).slice(0, 10)}…` });
        // Sub-7c D2 (Task 13): persist for L1 withdraw polling. The polling
        // panel watches buildOutboxProof; once the L2 epoch finalises on L1,
        // the user can click "Withdraw" which calls prepareL1Withdraw +
        // MetaMask sign+send. isPrivate routes to withdrawPrivate vs withdraw.
        addPendingWithdraw({
          token: vars.token,
          amount: vars.amount.toString(),
          l1Recipient: vars.l1Recipient as `0x${string}`,
          isPrivate: vars.isPrivate,
          l2TxHash: exitResult.l2TxHash as `0x${string}`,
          status: "pending",
          createdAt: Date.now(),
        });
        void qc.invalidateQueries({ queryKey: ["pendingWithdraws", session?.sessionId] });
      }
      setAmount("");
    },
    onError: (e) => pushToast({ kind: "warn", text: e instanceof Error ? e.message : "Exit failed" }),
  });

  const canSubmit = !!amount &&
    recipientValid &&
    (advisory.classification === "natural" || ackRound) &&
    (!showRoundTrip || ackDelay) &&
    !exitMut.isPending;

  const isMobile = useIsMobile();

  return (
    <>
    <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "1fr 320px", gap: isMobile ? 16 : 20 }}>
      <div className="q-card" style={{ display: "flex", flexDirection: "column", gap: 16 }}>

        {/* Privacy mode */}
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <Eyebrow>Privacy mode</Eyebrow>
            <Tooltip body="Private exits burn from your private L2 balance; only you can claim the L1 withdrawal. Public exits spend from your public L2 balance and are linkable on-chain.">
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

        {/* Token + amount + recipient */}
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
          <Field label="Amount" mono value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" suffix={`a${token}`} />
        </div>

        <Field label="L1 recipient" mono value={recipient} onChange={(e) => setRecipient(e.target.value)} placeholder="0x…" />
        {recipient !== "" && !recipientValid && (
          <div style={{ fontSize: 11, color: "var(--danger, #c0392b)", marginTop: -8 }}>
            Enter a valid L1 address (0x + 40 hex). Funds withdraw ONLY to this address.
          </div>
        )}

        {/* Advisories */}
        <RoundAmountAdvisory
          classification={advisory.classification}
          suggested={advisory.suggested}
          acknowledged={ackRound}
          onAck={setAckRound}
          onApply={() => { if (advisory.suggested) setAmount(advisory.suggested); }}
        />

        {showRoundTrip && (
          <div style={{
            background: "rgba(255,26,26,0.04)",
            border: "1px solid rgba(255,26,26,0.35)",
            borderRadius: 6, padding: "12px 14px",
            display: "flex", flexDirection: "column", gap: 8,
          }}>
            <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
              <i data-lucide="link" style={{ width: 14, height: 14, color: "var(--aztec-vermillion)", strokeWidth: 1.5, marginTop: 2, flexShrink: 0 } as CSSProperties}></i>
              <div style={{ flex: 1 }}>
                <div style={{ fontFamily: "var(--font-mono)", fontSize: 10, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--aztec-vermillion)", fontWeight: 600 }}>
                  Round-trip risk
                </div>
                <div style={{ fontFamily: "var(--font-body)", fontSize: 12, color: "var(--fg)", marginTop: 4, lineHeight: 1.45 }}>
                  This exit is within 5% of a recent L1 deposit you made (2,500 USDC, 4 days ago). Pattern-matching observers may link the two and de-anonymize your L2 activity.
                  &nbsp;<a href="#" onClick={(e) => e.preventDefault()} style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--fg-muted)" }}>Why does this matter? →</a>
                </div>
              </div>
            </div>
            <label style={{ display: "inline-flex", alignItems: "center", gap: 6, cursor: "pointer", fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--fg-muted)" }}>
              <input type="checkbox" checked={ackDelay} onChange={(e) => setAckDelay(e.target.checked)} style={{ accentColor: "var(--aztec-vermillion)" }} />
              I understand the linkage risk. Proceed anyway.
            </label>
          </div>
        )}

        {/* Multi-hop split */}
        <div style={{
          background: "var(--bg-alt)", border: "1px dashed var(--hairline-strong)", borderRadius: 8, padding: 16,
          display: "flex", flexDirection: "column", gap: 12,
        }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <i data-lucide="split" style={{ width: 14, height: 14, color: "var(--priv)", strokeWidth: 1.5 } as CSSProperties}></i>
              <Eyebrow>Multi-hop split</Eyebrow>
            </div>
            <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--fg-muted)" }}>
              {splitInto === 1 ? "single withdrawal" : `${splitInto} parts · every ${interval}d`}
            </span>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "1fr 1fr", gap: 12 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <Eyebrow style={{ width: 56 }}>Split</Eyebrow>
              <input type="range" min="1" max="20" value={splitInto} onChange={(e) => setSplitInto(parseInt(e.target.value, 10))}
                     style={{ flex: 1, accentColor: "var(--aztec-ink)" }} />
              <span data-mono style={{ fontFamily: "var(--font-mono)", fontSize: 13, width: 20, textAlign: "right" }}>{splitInto}</span>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <Eyebrow style={{ width: 64 }}>Interval</Eyebrow>
              <input type="range" min="1" max="90" value={interval} onChange={(e) => setIntervalDays(parseInt(e.target.value, 10))}
                     style={{ flex: 1, accentColor: "var(--aztec-ink)" }} disabled={splitInto === 1} />
              <span data-mono style={{ fontFamily: "var(--font-mono)", fontSize: 13, width: 40, textAlign: "right" }}>{interval}d</span>
            </div>
          </div>
          {splitInto > 1 && (
            <ScheduleTimeline parts={splitInto} interval={interval} amount={amount || "0"} token={token} />
          )}
        </div>

        <PillButton size="lg" fullWidth variant="primary" onClick={() => {
          exitMut.mutate({
            token,
            amount: parseAmount(amount, tokenDecimals(token)), // M10: per-token decimals (WETH=18)
            l1Recipient: recipient,
            isPrivate: visibility === "private",
            splitInto,
            intervalDays: interval,
            ackRound,
            ackDelay,
          });
        }} disabled={!canSubmit} rightIcon="arrow-right">
          {exitMut.isPending
            ? "Submitting…"
            : splitInto === 1 ? `Exit ${amount || "0"} ${token} to L1` : `Schedule ${splitInto}-part exit`}
        </PillButton>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <div className="q-card q-card-tight">
          <Eyebrow style={{ marginBottom: 12 }}>Balances · {token}</Eyebrow>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <BalanceLine kind="private" label="L2 · private" amount={tokenById(token).priv} token={`a${token}`} />
            <BalanceLine kind="public" label="L2 · public" amount={tokenById(token).pub} token={`a${token}`} />
            <BalanceLine kind="public" label="L1 · Sepolia" amount={tokenById(token).l1Bal} token={token} />
          </div>
        </div>
        <div className="q-card q-card-tight" style={{ background: "var(--bg-deep)", borderColor: "rgba(242,238,225,0.10)" }}>
          <div style={{ color: "var(--fg-on-deep)" }}>
            <Eyebrow style={{ color: "var(--fg-on-deep-mu)", marginBottom: 8 }}>Why split?</Eyebrow>
            <p style={{ fontFamily: "var(--font-body)", fontSize: 12, color: "var(--fg-on-deep)", lineHeight: 1.5, margin: 0, maxWidth: "100%" }}>
              Withdrawing in N parts at irregular intervals breaks timing correlation with your L1 deposit history. The cost is held-up capital for the duration.
            </p>
          </div>
        </div>
      </div>
    </div>
    <PendingL1WithdrawsPanel pushToast={pushToast} />
    </>
  );
}
