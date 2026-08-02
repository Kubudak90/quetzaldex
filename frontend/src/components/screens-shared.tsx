// Quetzal — shared screen-level components (TypeScript)
// All depend on atoms. Aztec tokens loaded via CSS vars.

import { useState } from "react";
import type { CSSProperties } from "react";
import { Eyebrow, Dot, Badge, PillButton } from "./atoms.js";

/* ============================================================
   DecoyVisualizer — anonymity-set rendering.
   LOCKED to SLOTS viz only (Ring + Feathers variants dropped
   per user selection; no viz prop, no persona prop).
   ============================================================ */
interface DecoyVisualizerProps {
  count: number;
  max: number;
  onChange?: (n: number) => void;
}
export function DecoyVisualizer({ count, max, onChange }: DecoyVisualizerProps) {
  const slots = max + 1; // 1 real + max decoys

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
        <Eyebrow>Anonymity set</Eyebrow>
        <div style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--fg)" }}>
          <span style={{ color: "var(--fg)" }}>1 real</span>
          <span style={{ color: "var(--fg-muted)" }}> + </span>
          <span style={{ color: "var(--q-decoy)" }}>{count} decoy{count === 1 ? "" : "s"}</span>
        </div>
      </div>

      {/* SLOTS viz — grid of K+1 squares */}
      <div style={{ display: "grid", gridTemplateColumns: `repeat(${slots}, 1fr)`, gap: 6 }}>
        {Array.from({ length: slots }).map((_, i) => {
          const isReal = i === 0;
          const isActive = i <= count;
          return (
            <div key={i} style={{
              position: "relative",
              height: 56, borderRadius: 6,
              border: `1px solid ${isReal ? "var(--aztec-ink)" : (isActive ? "var(--q-decoy)" : "var(--hairline)")}`,
              background: isReal ? "var(--aztec-ink)" : (isActive ? "rgba(255,45,244,0.06)" : "transparent"),
              transition: "all 200ms var(--ease-out)",
              overflow: "hidden",
              opacity: isActive ? 1 : 0.4,
            }}>
              {!isReal && isActive && (
                <div className="shimmer-orchid" style={{ position: "absolute", inset: 0, pointerEvents: "none" }} />
              )}
              <div style={{
                position: "absolute", inset: 0,
                display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
                gap: 2,
              }}>
                {isReal ? (
                  <>
                    <Dot kind="filled" size={8} />
                    <div style={{ fontFamily: "var(--font-mono)", fontSize: 9, color: "var(--aztec-parchment)", letterSpacing: "0.06em", textTransform: "uppercase" }}>real</div>
                  </>
                ) : (
                  <>
                    <Dot kind={isActive ? "decoy" : "pending"} size={8} />
                    <div style={{ fontFamily: "var(--font-mono)", fontSize: 9, color: isActive ? "var(--q-decoy)" : "var(--fg-subtle)", letterSpacing: "0.06em", textTransform: "uppercase" }}>
                      decoy
                    </div>
                  </>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Slider */}
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <Eyebrow style={{ width: 64 }}>Decoys</Eyebrow>
        <input
          type="range" min="0" max={max} step="1"
          value={count}
          onChange={(e) => onChange?.(parseInt(e.target.value, 10))}
          style={{ flex: 1, accentColor: "var(--q-decoy)" }}
        />
        <div data-mono style={{ fontFamily: "var(--font-mono)", fontSize: 13, color: "var(--fg)", width: 18, textAlign: "right" }}>{count}</div>
      </div>

      <div style={{ fontFamily: "var(--font-body)", fontSize: 12, color: "var(--fg-muted)", lineHeight: 1.45 }}>
        Decoys submit unfillable orders alongside yours so observers can't tell which is real.{" "}
        {count === 0 && <span style={{ color: "var(--q-warn-soft)" }}>0 decoys → your order is visible on-chain by elimination.</span>}
      </div>
    </div>
  );
}

/* ============================================================
   RoundAmountAdvisory — inline advisory for round amounts.
   ============================================================ */
interface RoundAmountAdvisoryProps {
  classification: string;
  suggested?: string | number;
  onApply?: () => void;
  acknowledged?: boolean;
  onAck?: (checked: boolean) => void;
}
export function RoundAmountAdvisory({ classification, suggested, onApply, acknowledged, onAck }: RoundAmountAdvisoryProps) {
  if (classification === "natural") return null;
  return (
    <div style={{
      background: "rgba(194,112,31,0.06)",
      border: "1px solid rgba(194,112,31,0.35)",
      borderRadius: 6,
      padding: "10px 12px",
      display: "flex",
      flexDirection: "column",
      gap: 8,
    }}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
        <i data-lucide="alert-triangle" style={{ width: 14, height: 14, color: "var(--q-warn-soft)", strokeWidth: 1.5, marginTop: 2, flexShrink: 0 } as CSSProperties}></i>
        <div style={{ flex: 1 }}>
          <div style={{ fontFamily: "var(--font-mono)", fontSize: 10, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--q-warn-soft)", fontWeight: 600 }}>
            Round amount · {classification}
          </div>
          <div style={{ fontFamily: "var(--font-body)", fontSize: 12, color: "var(--fg)", marginTop: 4, lineHeight: 1.45 }}>
            Round amounts are easier to fingerprint across observations. Try a slightly perturbed amount instead.
          </div>
        </div>
      </div>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <PillButton size="sm" variant="ink" onClick={onApply} leftIcon="check">
          Apply <span style={{ fontFamily: "var(--font-mono)", marginLeft: 4 }}>{suggested}</span>
        </PillButton>
        <label style={{ display: "inline-flex", alignItems: "center", gap: 6, cursor: "pointer", fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--fg-muted)" }}>
          <input type="checkbox" checked={acknowledged} onChange={(e) => onAck?.(e.target.checked)}
                 style={{ accentColor: "var(--q-warn-soft)" }} />
          Acknowledge &amp; proceed anyway
        </label>
      </div>
    </div>
  );
}

/* ============================================================
   OrderRow — a row in the open-orders table
   ============================================================ */
type OrderStatus = "open" | "filled" | "cancelled" | "decoy" | "pending";

interface Order {
  nonce?: string | number;
  side: "buy" | "sell";
  amount: string | number;
  amountToken: string;
  limit: string | number;
  limitToken: string;
  status: OrderStatus;
}

interface OrderRowProps {
  order: Order;
  onClaim?: (order: Order) => void;
  onCancel?: (order: Order) => void;
}
export function OrderRow({ order, onClaim, onCancel }: OrderRowProps) {
  type StatusInfo = { dot: "private" | "filled" | "cancel" | "decoy" | "pending"; label: string; tone: string };
  const statusMap: Record<OrderStatus, StatusInfo> = {
    open:      { dot: "private", label: "Open", tone: "private" },
    filled:    { dot: "filled",  label: "Filled · claimable", tone: "filled" },
    cancelled: { dot: "cancel",  label: "Cancelled", tone: "cancel" },
    decoy:     { dot: "decoy",   label: "Decoy", tone: "decoy" },
    pending:   { dot: "pending", label: "Pending", tone: "default" },
  };
  const st = statusMap[order.status] ?? statusMap.open;
  // The raw nonce is a full ~64-char hex; rendered untruncated it overflowed its
  // 80px grid track and collided with the side/amount columns. Show a short form
  // (full value on hover); order.nonce stays intact for the cancel/claim handlers.
  const nonceStr = order.nonce == null ? "" : String(order.nonce);
  const nonceShort = nonceStr.length > 14 ? `${nonceStr.slice(0, 8)}…${nonceStr.slice(-4)}` : nonceStr;
  return (
    <div style={{
      display: "grid",
      gridTemplateColumns: "16px 80px 60px 1fr 1fr 100px 120px",
      gap: 12, alignItems: "center",
      padding: "12px 16px",
      borderBottom: "1px solid var(--hairline)",
      transition: "background 120ms",
    }}>
      <Dot kind={st.dot} size={10} shimmer={order.status === "open"} />
      <div title={nonceStr} style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--fg-muted)", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {nonceShort}
      </div>
      <div style={{
        fontFamily: "var(--font-mono)", fontSize: 11, fontWeight: 500,
        color: "var(--aztec-ink)",
        letterSpacing: "0.06em", textTransform: "uppercase",
      }}>
        <span style={{
          padding: "3px 7px", borderRadius: 3,
          background: order.side === "buy" ? "rgba(13, 152, 118, 0.12)" : "rgba(255, 26, 26, 0.10)",
          color: order.side === "buy" ? "#0d9876" : "var(--aztec-vermillion)",
        }}>{order.side}</span>
      </div>
      <div data-mono style={{ fontFamily: "var(--font-mono)", fontSize: 13, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {order.amount} <span style={{ color: "var(--fg-muted)" }}>{order.amountToken}</span>
      </div>
      <div data-mono style={{ fontFamily: "var(--font-mono)", fontSize: 13, color: "var(--fg-muted)", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        @ {order.limit} <span style={{ color: "var(--fg-subtle)" }}>{order.limitToken}</span>
      </div>
      <div>
        {/* Badge tone typed loosely via cast — tone union includes all status values */}
        <Badge tone={st.tone as Parameters<typeof Badge>[0]["tone"]} shimmer={order.status === "open" || order.status === "decoy"}>{st.label}</Badge>
      </div>
      <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
        {order.status === "filled" && (
          <PillButton size="sm" variant="primary" onClick={() => onClaim?.(order)} leftIcon="download">Claim</PillButton>
        )}
        {order.status === "open" && (
          <PillButton size="sm" variant="ghost" onClick={() => onCancel?.(order)}>Cancel</PillButton>
        )}
        {order.status === "decoy" && (
          <PillButton size="sm" variant="quiet" onClick={() => onCancel?.(order)}>Cancel</PillButton>
        )}
      </div>
    </div>
  );
}

/* ============================================================
   FillRow — minimal row of recent epoch fills
   ============================================================ */
interface Fill {
  epoch: string | number;
  side: "buy" | "sell";
  amount: string | number;
  amountToken: string;
  price: string | number;
  priceToken: string;
  tx: string;
}

interface FillRowProps {
  fill: Fill;
}
export function FillRow({ fill }: FillRowProps) {
  return (
    <div style={{
      display: "grid",
      gridTemplateColumns: "12px 70px 80px 1fr 1fr 100px",
      gap: 12, alignItems: "center",
      padding: "10px 16px",
      borderBottom: "1px solid var(--hairline)",
    }}>
      <Dot kind="filled" size={8} />
      <div style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--fg-muted)" }}>e{fill.epoch}</div>
      <div style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--fg)", letterSpacing: "0.06em", textTransform: "uppercase" }}>
        <span style={{
          padding: "2px 6px", borderRadius: 3,
          background: fill.side === "buy" ? "rgba(13, 152, 118, 0.12)" : "rgba(255, 26, 26, 0.10)",
          color: fill.side === "buy" ? "#0d9876" : "var(--aztec-vermillion)",
        }}>{fill.side}</span>
      </div>
      <div data-mono style={{ fontFamily: "var(--font-mono)", fontSize: 12 }}>{fill.amount} {fill.amountToken}</div>
      <div data-mono style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--fg-muted)" }}>@ {fill.price} {fill.priceToken}</div>
      <div style={{ textAlign: "right" }}>
        <a href="#" onClick={(e) => e.preventDefault()} style={{
          fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--fg-muted)",
          textDecoration: "underline", textDecorationColor: "var(--hairline-strong)",
        }}>
          {fill.tx} <i data-lucide="external-link" style={{ width: 9, height: 9, strokeWidth: 1.5, marginLeft: 2 } as CSSProperties}></i>
        </a>
      </div>
    </div>
  );
}

/* ============================================================
   PairChip — compact token pair label
   ============================================================ */
interface PairChipProps {
  pair: string;
  style?: CSSProperties;
}
export function PairChip({ pair, style }: PairChipProps) {
  const tokens = pair.split("/");
  return (
    <div style={{ display: "inline-flex", alignItems: "center", gap: 4, ...style }}>
      {tokens.map((t, i) => (
        <TokenGlyph key={i} token={t} style={{ marginLeft: i > 0 ? -6 : 0, zIndex: tokens.length - i }} />
      ))}
      <span style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--fg)", marginLeft: 4 }}>{pair}</span>
    </div>
  );
}

/* ============================================================
   NetworkPill — Aztec network status indicator
   ============================================================ */
type NetworkStatus = "live" | "syncing" | "offline";

interface NetworkPillProps {
  status?: NetworkStatus;
  label?: string;
}
export function NetworkPill({ status = "live", label }: NetworkPillProps) {
  const dotKind: Record<NetworkStatus, "private" | "pending" | "cancel"> = {
    live:    "private",
    syncing: "pending",
    offline: "cancel",
  };
  const defaultLabel: Record<NetworkStatus, string> = {
    live:    "Aztec · Live",
    syncing: "Aztec · Syncing",
    offline: "Aztec · Offline",
  };
  return (
    <div style={{
      display: "inline-flex", alignItems: "center", gap: 6,
      background: "rgba(26,20,0,0.05)", borderRadius: 999,
      padding: "4px 10px",
      fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--fg-muted)",
    }}>
      <Dot kind={dotKind[status]} size={6} shimmer={status === "live"} />
      {label ?? defaultLabel[status]}
    </div>
  );
}

/* ============================================================
   PoolCapacityBar — the X/18 indicator for wallet pool children.
   ============================================================ */
interface PoolCapacityBarProps {
  current: number;
  max?: number;
}
export function PoolCapacityBar({ current, max = 18 }: PoolCapacityBarProps) {
  const pct = Math.min(1, current / max);
  let tone = "var(--aztec-chartreuse)";
  if (current >= 16) tone = "var(--aztec-vermillion)";
  else if (current >= 10) tone = "var(--proving)";
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <span className="q-eyebrow">Pending tx</span>
        <span data-mono style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--fg)" }}>
          {current}<span style={{ color: "var(--fg-muted)" }}>/{max}</span>
        </span>
      </div>
      <div style={{ height: 4, background: "var(--hairline)", borderRadius: 2, overflow: "hidden" }}>
        <div style={{ height: "100%", width: `${pct * 100}%`, background: tone, transition: "width 200ms var(--ease-out)" }} />
      </div>
    </div>
  );
}

/* ============================================================
   PairSelector — token pair picker (compact)
   ============================================================ */
interface PairOption {
  id: string;
  label: string;
  priceLabel?: string;
}
interface PairSelectorProps {
  value: string;
  options: PairOption[];
  onChange: (id: string) => void;
}
export function PairSelector({ value, options, onChange }: PairSelectorProps) {
  const [open, setOpen] = useState(false);
  const cur = options.find(o => o.id === value) ?? options[0];
  if (!cur) return null;
  return (
    <div style={{ position: "relative" }}>
      <button onClick={() => setOpen(!open)} style={{
        display: "flex", alignItems: "center", gap: 10,
        background: "transparent", border: "1px solid var(--hairline-strong)",
        borderRadius: 6, height: 48, padding: "0 14px", cursor: "pointer", width: "100%",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flex: 1 }}>
          <TokenPair pair={cur.id} />
          <div style={{ fontFamily: "var(--font-mono)", fontSize: 14, color: "var(--fg)" }}>{cur.label}</div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 2 }}>
          <div data-mono style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--fg-muted)" }}>{cur.priceLabel}</div>
        </div>
        <i data-lucide={open ? "chevron-up" : "chevron-down"} style={{ width: 14, height: 14, color: "var(--fg-muted)", strokeWidth: 1.5 } as CSSProperties}></i>
      </button>
      {open && (
        <div style={{
          position: "absolute", top: "calc(100% + 4px)", left: 0, right: 0,
          background: "var(--surface)", border: "1px solid var(--hairline-strong)",
          borderRadius: 6, boxShadow: "var(--shadow-pop)", zIndex: 20,
          overflow: "hidden",
        }}>
          {options.map(opt => (
            <button key={opt.id} onClick={() => { onChange(opt.id); setOpen(false); }} style={{
              display: "flex", alignItems: "center", gap: 10, width: "100%",
              background: "transparent", border: "none", padding: "10px 14px", cursor: "pointer",
              borderBottom: "1px solid var(--hairline)", textAlign: "left",
            }}>
              <TokenPair pair={opt.id} />
              <div style={{ fontFamily: "var(--font-mono)", fontSize: 13, color: "var(--fg)", flex: 1 }}>{opt.label}</div>
              <div data-mono style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--fg-muted)" }}>{opt.priceLabel}</div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/* ============================================================
   TokenPair — two overlapping token glyphs
   ============================================================ */
interface TokenPairProps {
  pair: string;
}
export function TokenPair({ pair }: TokenPairProps) {
  const tokens = pair.split("/");
  return (
    <div style={{ display: "flex", alignItems: "center" }}>
      {tokens.map((t, i) => (
        <TokenGlyph key={i} token={t} style={{ marginLeft: i > 0 ? -6 : 0, zIndex: tokens.length - i }} />
      ))}
    </div>
  );
}

/* ============================================================
   TokenGlyph — circular token icon (used by PairChip internally)
   ============================================================ */
interface TokenGlyphProps {
  token: string;
  size?: number;
  style?: CSSProperties;
}
export function TokenGlyph({ token, size = 22, style }: TokenGlyphProps) {
  type TokenColors = { bg: string; fg: string; char: string };
  const colors: Record<string, TokenColors> = {
    USDC: { bg: "#2775CA", fg: "#fff", char: "$" },
    ETH:  { bg: "#627EEA", fg: "#fff", char: "Ξ" },
    WETH: { bg: "#627EEA", fg: "#fff", char: "Ξ" },
    BTC:  { bg: "#F7931A", fg: "#fff", char: "₿" },
    wBTC: { bg: "#F7931A", fg: "#fff", char: "₿" },
  };
  const c: TokenColors = colors[token] ?? { bg: "var(--fg-subtle)", fg: "var(--bg)", char: token[0] ?? "?" };
  return (
    <div style={{
      width: size, height: size, borderRadius: "50%",
      background: c.bg, color: c.fg,
      display: "inline-flex", alignItems: "center", justifyContent: "center",
      fontFamily: "var(--font-mono)", fontSize: Math.round(size * 0.48), fontWeight: 600,
      border: "1.5px solid var(--bg)",
      boxSizing: "border-box",
      ...style,
    }}>
      {c.char}
    </div>
  );
}
