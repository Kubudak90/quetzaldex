// Quetzal — atoms (TypeScript)
// Primitive components. All inherit Aztec tokens via CSS vars.

import { useState } from "react";
import type { CSSProperties, ReactNode, ChangeEvent } from "react";

/* ============================================================
   FeatherGlyph — Quetzal's signature mark.
   ============================================================ */
interface FeatherGlyphProps {
  size?: number;
  stroke?: string;
  strokeWidth?: number;
  fill?: string;
}
export function FeatherGlyph({ size = 24, stroke = "currentColor", strokeWidth = 1.5, fill = "none" }: FeatherGlyphProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill={fill}
         xmlns="http://www.w3.org/2000/svg"
         style={{ display: "inline-block", flexShrink: 0 }}>
      {/* head — small filled dot */}
      <circle cx="22.5" cy="5.5" r="1.8" fill={stroke} />
      {/* main rachis — long curved tail sweeping bottom-left */}
      <path d="M21 7 C 18 12, 14 17, 10 22 C 7 25.5, 4.5 27, 3 28"
            stroke={stroke} strokeWidth={strokeWidth} strokeLinecap="square" fill="none" />
      {/* barbs along the rachis (one side) */}
      <path d="M18.5 10 L 22.5 9"     stroke={stroke} strokeWidth={strokeWidth} strokeLinecap="square" />
      <path d="M16 13 L 21 12.5"      stroke={stroke} strokeWidth={strokeWidth} strokeLinecap="square" />
      <path d="M13.5 16 L 19 16"      stroke={stroke} strokeWidth={strokeWidth} strokeLinecap="square" />
      <path d="M11 19 L 16.5 19.5"    stroke={stroke} strokeWidth={strokeWidth} strokeLinecap="square" />
      <path d="M8.5 22 L 13.5 23"     stroke={stroke} strokeWidth={strokeWidth} strokeLinecap="square" />
      <path d="M6 25 L 10.5 26.5"     stroke={stroke} strokeWidth={strokeWidth} strokeLinecap="square" />
    </svg>
  );
}

/* ============================================================
   FeatherWatermark — large, low-opacity feather for empty
   states and landing hero.
   ============================================================ */
interface FeatherWatermarkProps {
  size?: number;
  opacity?: number;
  style?: CSSProperties;
}
export function FeatherWatermark({ size = 280, opacity = 0.05, style }: FeatherWatermarkProps) {
  return (
    <div data-feather-watermark aria-hidden="true" style={{ pointerEvents: "none", color: "var(--fg)", opacity, ...style }}>
      <FeatherGlyph size={size} strokeWidth={0.8} />
    </div>
  );
}

/* ============================================================
   Eyebrow / Hairline / StepDivider
   ============================================================ */
interface EyebrowProps {
  children?: ReactNode;
  style?: CSSProperties;
}
export function Eyebrow({ children, style }: EyebrowProps) {
  return <div className="q-eyebrow" style={style}>{children}</div>;
}

interface HairlineProps {
  style?: CSSProperties;
}
export function Hairline({ style }: HairlineProps) {
  return <div style={{ height: 1, background: "var(--hairline)", ...style }} />;
}

interface StepDividerProps {
  style?: CSSProperties;
}
export function StepDivider({ style }: StepDividerProps) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, ...style }}>
      <div style={{ flex: 1, height: 1, background: "var(--hairline)" }} />
      <svg width="56" height="8" viewBox="0 0 56 8" style={{ flexShrink: 0 }}>
        {/* Step pattern: rising-falling ziggurat */}
        <path d="M0 6 L8 6 L8 4 L16 4 L16 2 L24 2 L24 0 L32 0 L32 2 L40 2 L40 4 L48 4 L48 6 L56 6"
              fill="none" stroke="currentColor" strokeWidth="1" opacity="0.4" />
      </svg>
      <div style={{ flex: 1, height: 1, background: "var(--hairline)" }} />
    </div>
  );
}

/* ============================================================
   Dot — visibility / state indicator (Aztec celari pattern)
   ============================================================ */
type DotKind = "private" | "public" | "decoy" | "proving" | "filled" | "pending" | "cancel";

interface DotProps {
  kind?: DotKind;
  size?: number;
  shimmer?: boolean;
}
export function Dot({ kind = "private", size = 10, shimmer = false }: DotProps) {
  const base: CSSProperties = {
    display: "inline-block",
    width: size,
    height: size,
    borderRadius: "50%",
    flex: "none",
    boxSizing: "border-box",
  };
  if (kind === "private") {
    return <span style={{ ...base, background: "var(--priv)" }} className={shimmer ? "pulse-dot" : ""} />;
  }
  if (kind === "public") {
    return <span style={{ ...base, border: "2px solid var(--pub)" }} />;
  }
  if (kind === "decoy") {
    return <span style={{ ...base, background: "var(--q-decoy)" }} />;
  }
  if (kind === "proving") {
    return <span style={{ ...base, background: `conic-gradient(var(--proving) 0 70%, transparent 70% 100%)` }} />;
  }
  if (kind === "filled") {
    return <span style={{ ...base, background: "var(--aztec-chartreuse)", border: "1px solid var(--aztec-ink)" }} />;
  }
  if (kind === "pending") {
    return <span style={{ ...base, border: "1px solid var(--fg-subtle)" }} />;
  }
  if (kind === "cancel") {
    return <span style={{ ...base, background: "var(--fg-subtle)", opacity: 0.5 }} />;
  }
  return null;
}

/* ============================================================
   Badge — small inline label
   ============================================================ */
type BadgeTone = "default" | "ink" | "muted" | "ok" | "warn" | "danger" | "decoy"
  | "private" | "filled" | "cancel";

interface BadgeProps {
  children?: ReactNode;
  tone?: BadgeTone;
  style?: CSSProperties;
  shimmer?: boolean;
}
export function Badge({ children, tone = "default", style, shimmer = false }: BadgeProps) {
  const cls = `q-badge ${tone !== "default" ? `q-badge-${tone}` : ""} ${shimmer ? (tone === "decoy" ? "shimmer-orchid" : "shimmer") : ""}`.trim();
  return <span className={cls} style={style}>{children}</span>;
}

/* ============================================================
   PillButton — Aztec's button primitive
   ============================================================ */
type PillVariant = "primary" | "ink" | "ghost" | "quiet" | "danger" | "onDeep";
type PillSize = "sm" | "md" | "lg";

interface PillButtonProps {
  children?: ReactNode;
  variant?: PillVariant;
  onClick?: () => void;
  size?: PillSize;
  disabled?: boolean;
  style?: CSSProperties;
  fullWidth?: boolean;
  leftIcon?: string;
  rightIcon?: string;
  type?: "button" | "submit" | "reset";
}
export function PillButton({
  children, variant = "primary", onClick, size = "md", disabled, style, fullWidth, leftIcon, rightIcon, type = "button",
}: PillButtonProps) {
  const sizes: Record<PillSize, { height: number; padding: string; fs: number }> = {
    sm: { height: 30, padding: "0 12px", fs: 11 },
    md: { height: 40, padding: "0 18px", fs: 13 },
    lg: { height: 48, padding: "0 24px", fs: 14 },
  };
  const s = sizes[size];
  const variants: Record<PillVariant, CSSProperties> = {
    primary: { background: "var(--aztec-chartreuse)", color: "var(--aztec-ink)", border: "1px solid var(--aztec-chartreuse)" },
    ink:     { background: "var(--aztec-ink)", color: "var(--aztec-parchment)", border: "1px solid var(--aztec-ink)" },
    ghost:   { background: "transparent", color: "var(--fg)", border: "1px solid var(--hairline-strong)" },
    quiet:   { background: "rgba(26,20,0,0.04)", color: "var(--fg)", border: "1px solid transparent" },
    danger:  { background: "var(--aztec-vermillion)", color: "var(--aztec-parchment)", border: "1px solid var(--aztec-vermillion)" },
    onDeep:  { background: "transparent", color: "var(--aztec-parchment)", border: "1px solid rgba(242,238,225,0.25)" },
  };
  return (
    <button type={type} onClick={onClick} disabled={disabled} style={{
      display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 8,
      height: s.height, padding: s.padding, width: fullWidth ? "100%" : undefined,
      borderRadius: 999,
      fontFamily: "var(--font-mono)", fontSize: s.fs, fontWeight: 500,
      cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.45 : 1,
      transition: "background var(--dur-fast) var(--ease-out), border-color var(--dur-fast) var(--ease-out), transform var(--dur-fast) var(--ease-out)",
      ...variants[variant], ...style,
    }}>
      {/* Icons are wrapped in a stable <span> that React owns. The global
          lucide.createIcons() (App.tsx) replaces the inner <i> with an <svg>
          via replaceChild; if React removed that mutated <i> directly (e.g.
          when an icon toggles off during a connecting/unlocking state) it would
          throw "removeChild: node is not a child" and unmount the whole app
          (blank screen). Removing the wrapper <span> instead is always a valid
          op, since lucide only touches the span's interior. */}
      {leftIcon && <span style={{ display: "inline-flex" }}><i data-lucide={leftIcon} style={{ width: 14, height: 14, strokeWidth: 1.5 }}></i></span>}
      {children}
      {rightIcon && <span style={{ display: "inline-flex" }}><i data-lucide={rightIcon} style={{ width: 14, height: 14, strokeWidth: 1.5 }}></i></span>}
    </button>
  );
}

/* ============================================================
   Field — labeled input
   ============================================================ */
type FieldHintTone = "neutral" | "private" | "public" | "warn" | "decoy";

interface FieldProps {
  label?: string;
  value?: string | number;
  onChange?: (e: ChangeEvent<HTMLInputElement>) => void;
  hint?: string;
  hintTone?: FieldHintTone;
  placeholder?: string;
  mono?: boolean;
  suffix?: ReactNode;
  prefix?: ReactNode;
  type?: string;
  inputStyle?: CSSProperties;
}
export function Field({
  label, value, onChange, hint, hintTone = "neutral", placeholder, mono, suffix, prefix, type = "text", inputStyle,
}: FieldProps) {
  const tones: Record<FieldHintTone, string> = {
    neutral: "var(--fg-muted)",
    private: "var(--priv)",
    public:  "var(--pub)",
    warn:    "var(--q-warn-soft)",
    decoy:   "var(--q-decoy)",
  };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {label && (
        <label className="q-eyebrow" style={{ fontSize: 10 }}>{label}</label>
      )}
      <div style={{
        display: "flex", alignItems: "center", gap: 10,
        background: "var(--surface)",
        border: "1px solid var(--hairline-strong)",
        borderRadius: 6, height: 48, padding: "0 14px",
        transition: "border-color var(--dur-fast) var(--ease-out)",
      }}>
        {prefix && <div style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--fg-muted)" }}>{prefix}</div>}
        <input
          type={type}
          value={value ?? ""}
          onChange={onChange}
          placeholder={placeholder}
          style={{
            flex: 1, minWidth: 0, border: "none", outline: "none", background: "transparent",
            fontFamily: mono ? "var(--font-mono)" : "var(--font-body)",
            fontSize: 15, color: "var(--fg)",
            ...inputStyle,
          }}
        />
        {suffix && <div style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--fg-muted)" }}>{suffix}</div>}
      </div>
      {hint && (
        <div style={{ fontFamily: "var(--font-body)", fontSize: 12, color: tones[hintTone] ?? tones.neutral, lineHeight: 1.4 }}>
          {hintTone !== "neutral" && <span style={{ marginRight: 4 }}>→</span>}{hint}
        </div>
      )}
    </div>
  );
}

/* ============================================================
   AddressMono — short truncated mono address w/ copy
   ============================================================ */
interface AddressMonoProps {
  value: string;
  copy?: boolean;
  style?: CSSProperties;
  length?: number;
}
export function AddressMono({ value, copy = true, style, length = 6 }: AddressMonoProps) {
  const [copied, setCopied] = useState(false);
  const display = value.length > length * 2 + 2 ? `${value.slice(0, length)}…${value.slice(-4)}` : value;
  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--fg)", ...style }}>
      <span>{display}</span>
      {copy && (
        <button onClick={handleCopy} style={{ background: "transparent", border: "none", padding: 2, cursor: "pointer", color: "var(--fg-muted)", display: "inline-flex" }}>
          <i data-lucide={copied ? "check" : "copy"} style={{ width: 11, height: 11, strokeWidth: 1.5 }}></i>
        </button>
      )}
    </span>
  );
}

/* ============================================================
   Tooltip — wraps a child with a hovering ink popover
   ============================================================ */
interface TooltipProps {
  children?: ReactNode;
  body?: ReactNode;
  label?: ReactNode;
  placement?: "top" | "bottom" | "left" | "right";
}
export function Tooltip({ children, body, label }: TooltipProps) {
  return (
    <span className="q-tip">
      {children}
      <span data-tip-body>{body ?? label}</span>
    </span>
  );
}

/* ============================================================
   Segmented — radio control as a pill row
   ============================================================ */
type SegmentedSize = "sm" | "md" | "lg";

interface SegmentedOption {
  id: string;
  label: ReactNode;
  dot?: DotKind;
  activeBg?: string;
  activeFg?: string;
}

interface SegmentedProps {
  value: string;
  onChange: (id: string) => void;
  options: SegmentedOption[];
  size?: SegmentedSize;
  fullWidth?: boolean;
}
export function Segmented({ value, onChange, options, size = "md", fullWidth }: SegmentedProps) {
  const heights: Record<SegmentedSize, number> = { sm: 28, md: 36, lg: 44 };
  const h = heights[size];
  return (
    <div style={{
      display: "grid",
      gridTemplateColumns: `repeat(${options.length}, 1fr)`,
      gap: 2, padding: 3,
      background: "rgba(26,20,0,0.05)",
      borderRadius: 999,
      width: fullWidth ? "100%" : "fit-content",
    }}>
      {options.map(opt => {
        const active = value === opt.id;
        return (
          <button key={opt.id} onClick={() => onChange(opt.id)} style={{
            display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 6,
            height: h, padding: "0 14px", borderRadius: 999, border: "none", cursor: "pointer",
            fontFamily: "var(--font-mono)", fontSize: size === "sm" ? 11 : 12, fontWeight: 500,
            background: active ? (opt.activeBg ?? "var(--aztec-ink)") : "transparent",
            color:      active ? (opt.activeFg ?? "var(--aztec-parchment)") : "var(--fg-muted)",
            transition: "background 120ms var(--ease-out), color 120ms var(--ease-out)",
            whiteSpace: "nowrap",
          }}>
            {opt.dot && <Dot kind={opt.dot} size={8} />}
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

/* ============================================================
   QuetzalLogo — full lockup
   ============================================================ */
interface QuetzalLogoProps {
  size?: number;
  showWord?: boolean;
  color?: string;
}
export function QuetzalLogo({ size = 22, showWord = true, color = "var(--fg)" }: QuetzalLogoProps) {
  return (
    <div style={{ display: "inline-flex", alignItems: "center", gap: 8, color }}>
      <FeatherGlyph size={size} stroke="currentColor" />
      {showWord && (
        <span style={{
          fontFamily: "var(--font-display)", fontSize: Math.round(size * 0.95),
          fontWeight: 300, letterSpacing: "-0.02em",
        }}>
          Quet<em style={{ fontFamily: "var(--font-serif)", fontStyle: "italic", fontWeight: 400 }}>zal</em>
        </span>
      )}
    </div>
  );
}

/* ============================================================
   Toast — transient notification
   ============================================================ */
type ToastTone = "success" | "error" | "info";

interface ToastData {
  tone?: ToastTone;
  title?: string;
  detail?: string;
  tx?: string;
  /** legacy field from design source */
  kind?: string;
  text?: string;
  action?: unknown;
}

interface ToastProps {
  toast: ToastData | null;
}
export function Toast({ toast }: ToastProps) {
  if (!toast) return null;
  const toneStyles: Record<ToastTone, { iconColor: string; icon: string }> = {
    success: { iconColor: "var(--aztec-chartreuse)", icon: "check-circle" },
    error:   { iconColor: "var(--aztec-vermillion)", icon: "x-circle" },
    info:    { iconColor: "var(--pub)",              icon: "info" },
  };
  const t = toneStyles[toast.tone ?? "info"] ?? toneStyles.info;
  return (
    <div style={{
      position: "fixed", bottom: 24, left: "50%", transform: "translateX(-50%)",
      zIndex: 100,
      background: "var(--aztec-ink)", color: "var(--aztec-parchment)",
      padding: "12px 16px", borderRadius: 8,
      display: "flex", alignItems: "center", gap: 12,
      boxShadow: "var(--shadow-pop)",
      minWidth: 320, maxWidth: 480,
      fontFamily: "var(--font-body)",
    }}>
      <i data-lucide={t.icon} style={{ width: 16, height: 16, color: t.iconColor, strokeWidth: 1.5, flexShrink: 0 }}></i>
      <div style={{ flex: 1, fontSize: 13 }}>
        <div>{toast.title}</div>
        {toast.detail && <div style={{ fontSize: 11, color: "var(--fg-on-deep-mu)", marginTop: 2, fontFamily: "var(--font-mono)" }}>{toast.detail}</div>}
      </div>
      {toast.tx && (
        <a href="#" onClick={(e) => e.preventDefault()} style={{
          fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--aztec-chartreuse)",
          textDecoration: "underline", textDecorationColor: "rgba(212,255,40,0.4)",
          whiteSpace: "nowrap",
        }}>View ↗</a>
      )}
    </div>
  );
}

/* ============================================================
   EpochCountdown — live mm:ss to next epoch close.
   ============================================================ */
interface EpochCountdownProps {
  epoch?: number | string;
  secondsLeft: number;
  epochLength?: number;
  compact?: boolean;
}
export function EpochCountdown({ epoch, secondsLeft, epochLength = 600, compact = false }: EpochCountdownProps) {
  const pct = Math.max(0, Math.min(1, (epochLength - secondsLeft) / epochLength));
  const mm = String(Math.floor(secondsLeft / 60)).padStart(2, "0");
  const ss = String(secondsLeft % 60).padStart(2, "0");
  if (compact) {
    return (
      <div style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
        <span className="pulse-dot" style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--aztec-chartreuse)", display: "inline-block" }} />
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--fg-muted)" }}>EPOCH {epoch}</span>
        <span data-mono style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--fg)", fontWeight: 500 }}>{mm}:{ss}</span>
      </div>
    );
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12 }}>
        <div>
          <Eyebrow>Clearing in</Eyebrow>
          <div data-mono style={{ fontFamily: "var(--font-mono)", fontSize: 28, letterSpacing: "-0.02em", color: "var(--fg)", fontWeight: 500, marginTop: 2 }}>
            {mm}:{ss}
          </div>
        </div>
        <div style={{ textAlign: "right" }}>
          <Eyebrow>Epoch</Eyebrow>
          <div data-mono style={{ fontFamily: "var(--font-mono)", fontSize: 16, color: "var(--fg)", marginTop: 2 }}>{epoch}</div>
        </div>
      </div>
      <div style={{ height: 2, background: "var(--hairline)", borderRadius: 1, overflow: "hidden" }}>
        <div style={{ height: "100%", width: `${pct * 100}%`, background: "var(--aztec-chartreuse)", transition: "width 1s linear" }} />
      </div>
    </div>
  );
}
