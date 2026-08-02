// BridgeScreen — tab state machine + header + ScheduledExits footer.

import { useState } from "react";
import type { CSSProperties } from "react";
import { Eyebrow, Badge } from "../../components/atoms.js";
import { useIsMobile } from "../../hooks/use-media-query.js";
import { L1ConnectButton } from "../../l1/connect-button.js";
import { type PushToast } from "./helpers.js";
import { DepositTab } from "./deposit-tab.js";
import { ClaimTab } from "./claim-tab.js";
import { ExitTab } from "./exit-tab.js";
import { ScheduledExits } from "./scheduled-exits.js";

interface BridgeScreenProps {
  pushToast: PushToast;
}

export function BridgeScreen({ pushToast }: BridgeScreenProps) {
  const [tab, setTab] = useState<"deposit" | "claim" | "exit">("deposit");
  const isMobile = useIsMobile();
  return (
    <div style={{ padding: isMobile ? 14 : 24, height: "100%", overflow: "auto" }} className="q-scroll">
      <div style={{ maxWidth: 920, margin: "0 auto", display: "flex", flexDirection: "column", gap: isMobile ? 16 : 20 }}>

        {/* Header */}
        <div style={{
          display: "flex",
          alignItems: isMobile ? "flex-start" : "baseline",
          flexDirection: isMobile ? "column" : "row",
          justifyContent: "space-between", gap: isMobile ? 10 : 16,
        }}>
          <div>
            <Eyebrow>Bridge</Eyebrow>
            <h2 style={{ fontFamily: "var(--font-display)", fontSize: isMobile ? 30 : 44, fontWeight: 300, letterSpacing: "-0.04em", marginTop: 4 }}>
              Move funds <em style={{ fontFamily: "var(--font-serif)", fontStyle: "italic", fontWeight: 400 }}>across</em> layers
            </h2>
            <p style={{ fontFamily: "var(--font-body)", fontSize: isMobile ? 13 : 14, color: "var(--fg-muted)", marginTop: 8 }}>
              Sepolia L1 ↔ Aztec L2 · USDC / WETH · public or private modes
            </p>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            {/* The top bar has no room for this on a phone, and Bridge is the
                only place an L1 wallet is actually needed. */}
            {isMobile && <L1ConnectButton />}
            <Badge tone="warn"><i data-lucide="alert-triangle" style={{ width: 11, height: 11, strokeWidth: 1.5 } as CSSProperties}></i> Testnet</Badge>
          </div>
        </div>

        {/* Tabs */}
        <div
          className={isMobile ? "q-scroll" : undefined}
          style={{
            display: "flex", alignItems: "center", gap: 4,
            borderBottom: "1px solid var(--hairline)",
            overflowX: isMobile ? "auto" : undefined,
          }}
        >
          {([
            { id: "deposit", label: "Deposit", subtitle: "L1 → L2", icon: "arrow-down-to-line" },
            { id: "claim",   label: "Claim",   subtitle: "Pending messages", icon: "inbox" },
            { id: "exit",    label: "Exit",    subtitle: "L2 → L1", icon: "arrow-up-from-line" },
          ] as const).map(t => (
            <button key={t.id} onClick={() => setTab(t.id)} style={{
              display: "flex", flexDirection: "column", gap: 2,
              padding: isMobile ? "10px 12px" : "12px 16px",
              border: "none", background: "transparent",
              cursor: "pointer", textAlign: "left", flexShrink: 0,
              borderBottom: `2px solid ${tab === t.id ? "var(--aztec-ink)" : "transparent"}`,
              marginBottom: -1,
            }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <i data-lucide={t.icon} style={{ width: 14, height: 14, color: tab === t.id ? "var(--fg)" : "var(--fg-muted)", strokeWidth: 1.5 } as CSSProperties}></i>
                <span style={{ fontFamily: "var(--font-mono)", fontSize: 13, fontWeight: 500, color: tab === t.id ? "var(--fg)" : "var(--fg-muted)" }}>{t.label}</span>
              </div>
              <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--fg-subtle)", letterSpacing: "0.04em" }}>{t.subtitle}</span>
            </button>
          ))}
        </div>

        {tab === "deposit" && <DepositTab pushToast={pushToast} />}
        {tab === "claim"   && <ClaimTab pushToast={pushToast} />}
        {tab === "exit"    && <ExitTab pushToast={pushToast} />}

        {/* Scheduled exits table (always shown below) */}
        <ScheduledExits />
      </div>
    </div>
  );
}
