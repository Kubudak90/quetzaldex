// ScheduledExits table (always shown below the bridge tabs) + BalanceLine helper.

import { Fragment } from "react";
import type { CSSProperties } from "react";
import { useQuery } from "@tanstack/react-query";
import { useClientContext } from "../../sdk/client-context.js";
import { Eyebrow, Hairline, Dot, Badge, PillButton, AddressMono } from "../../components/atoms.js";
import { TokenGlyph } from "../../components/screens-shared.js";
import { loadBrowserBridgeState } from "./helpers.js";
import { useIsMobile } from "../../hooks/use-media-query.js";

export function ScheduledExits() {
  const { session } = useClientContext();
  const isMobile = useIsMobile();

  // SDK's loadBridgeState() uses Node fs (CLI-only) — see loadBrowserBridgeState() in helpers.ts.
  // TODO(sdk-browser-state): replace with a browser-portable SDK bridge-state backend.
  const scheduledExitsQ = useQuery({
    queryKey: ["scheduledExits", session?.sessionId],
    queryFn: () => loadBrowserBridgeState().scheduledExits,
    refetchInterval: false,
  });

  const exits = scheduledExitsQ.data ?? [];

  return (
    <div className="q-card" style={{ padding: 0, overflow: "hidden" }}>
      <div style={{ padding: "16px 20px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h4 style={{ fontFamily: "var(--font-serif)", fontSize: 18, fontWeight: 400 }}>Scheduled exits</h4>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--fg-muted)", cursor: "pointer" }}>
            <input type="checkbox" defaultChecked style={{ accentColor: "var(--aztec-ink)" }} /> Auto-tick
          </label>
          <PillButton size="sm" variant="ghost" leftIcon="play">Tick now</PillButton>
        </div>
      </div>
      <Hairline />
      {exits.length === 0 ? (
        <div style={{ padding: 60, textAlign: "center" }}>
          <div style={{ fontFamily: "var(--font-serif)", fontSize: 15, color: "var(--fg-muted)" }}>No scheduled exits.</div>
        </div>
      ) : (
        <div className={isMobile ? "q-table-scroll" : undefined} style={{ ["--q-table-min" as string]: "660px" } as CSSProperties}>
          <div style={{
            display: "grid", gridTemplateColumns: "10px 70px 100px 1fr 1fr 100px 100px",
            gap: 12, padding: "8px 20px", background: "var(--bg-alt)",
          }}>
            <span></span>
            <span className="q-eyebrow">Part</span>
            <span className="q-eyebrow">Token</span>
            <span className="q-eyebrow">Amount</span>
            <span className="q-eyebrow">Recipient</span>
            <span className="q-eyebrow">Due</span>
            <span className="q-eyebrow" style={{ textAlign: "right" }}>Status</span>
          </div>
          {exits.map(e => (
            <div key={e.id} style={{
              display: "grid", gridTemplateColumns: "10px 70px 100px 1fr 1fr 100px 100px",
              gap: 12, padding: "12px 20px", alignItems: "center",
              borderBottom: "1px solid var(--hairline)",
            }}>
              <Dot kind={e.status === "submitted" ? "filled" : "pending"} size={8} />
              <span style={{ fontFamily: "var(--font-mono)", fontSize: 12 }}>{e.part}</span>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <TokenGlyph token={e.token} size={16} />
                <span style={{ fontFamily: "var(--font-mono)", fontSize: 12 }}>{e.token}</span>
              </div>
              <span data-mono style={{ fontFamily: "var(--font-mono)", fontSize: 13 }}>{e.amount}</span>
              <AddressMono value={e.recipient} />
              <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--fg-muted)" }}>{e.scheduled}</span>
              <div style={{ textAlign: "right" }}>
                <Badge tone={e.status === "submitted" ? "filled" : "default"}>{e.status}</Badge>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── BalanceLine ───────────────────────────────────────────────────────────────
// Shared by DepositTab and ExitTab sidebars.
interface BalanceLineProps {
  kind: "private" | "public";
  label: string;
  amount: string;
  token: string;
}
export function BalanceLine({ kind, label, amount, token }: BalanceLineProps) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
      <Dot kind={kind} size={8} />
      <div style={{ flex: 1, fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--fg-muted)" }}>{label}</div>
      <div data-mono style={{ fontFamily: "var(--font-mono)", fontSize: 13, color: "var(--fg)" }}>{amount} <span style={{ color: "var(--fg-muted)" }}>{token}</span></div>
    </div>
  );
}
