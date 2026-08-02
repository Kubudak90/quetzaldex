// Quetzal — Wallet pool screen + History screen + Settings screen.
// `poolExhausted` hardcoded to false; theme switcher hardcoded to "parchment".

import { useState, useMemo } from "react";
import type { CSSProperties, ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useQuetzalClient, useClientContext, useWalletPool } from "../sdk/client-context.js";
import { useRefuel, formatFeeJuice } from "../sdk/use-fee-juice.js";
import { formatTokenBalance } from "../sdk/use-l2-balance.js";
import {
  Eyebrow, Hairline, Dot, Badge, PillButton, AddressMono, Segmented,
} from "../components/atoms.js";
import { PoolCapacityBar, TokenGlyph } from "../components/screens-shared.js";
import { useIsMobile } from "../hooks/use-media-query.js";
import { LiquidityPanel } from "./wallet/liquidity-panel.js";
import { resettableKeys } from "./reset-local-state.js";
import { loadPendingClaims } from "./bridge/pending-claims.js";
import { loadPendingWithdraws } from "./bridge/pending-withdraws.js";

interface ToastIn { kind: string; text: string }
type PushToast = (t: ToastIn) => void;

interface WalletScreenProps {
  pushToast: PushToast;
}

interface PoolChild {
  id: number;
  addr: string;
  fee: string;
  usdc: string;
  weth: string;
  wbtc: string;
  pending: number;
}

const POOL_EXHAUSTED = false; // hardcoded (was tweaks.poolExhausted)

export function WalletScreen({ pushToast }: WalletScreenProps) {
  const pool = useWalletPool();
  const { session } = useClientContext();
  const [walletTab, setWalletTab] = useState<"pool" | "liquidity">("pool");

  // Build per-child card data from pool.addresses (live, lazy-connected).
  // Fee-juice and PUBLIC token balances are public reads by address, so the
  // session client can read any child's. PRIVATE token balances are PXE-local to
  // each child's wallet and cannot be read from here, so the columns show the
  // child's PUBLIC token balance only.
  const childrenQ = useQuery({
    queryKey: ["walletChildren", session?.sessionId],
    queryFn: async (): Promise<PoolChild[]> => {
      if (!pool) return [];
      return await Promise.all(pool.addresses.map(async (addr, i) => {
        let fee = "—";
        try {
          if (session?.client) fee = formatFeeJuice(await session.client.fees.getJuiceBalance(addr));
        } catch { /* leave as "—" on read failure */ }
        const readPub = async (tok: string): Promise<string> => {
          try {
            if (!session?.client) return "—";
            return formatTokenBalance(await session.client.reads.getPublicBalanceOf(tok, addr), tok);
          } catch { return "—"; }
        };
        const [usdc, weth, wbtc] = await Promise.all([
          readPub("USDC"), readPub("WETH"), readPub("wBTC"),
        ]);
        return {
          id: i,
          addr,
          fee,
          usdc,
          weth,
          wbtc,
          // pendingTx counter is internal to the pool; not exposed publicly.
          pending: 0,
        };
      }));
    },
    enabled: !!pool,
    staleTime: 30_000,
  });

  const children: PoolChild[] = childrenQ.data ?? [];
  const totalCapacity = children.length * 18 - children.reduce((s, c) => s + c.pending, 0);
  const [showMaster, setShowMaster] = useState(false);

  // In-app refuel for the connected wallet (drip + redeem fee-juice).
  const qc = useQueryClient();
  const refuelMut = useRefuel();
  const refueling = refuelMut.isPending;
  function doRefuel() {
    pushToast({ kind: "ok", text: "Refueling — requesting fuel + bridging (~1–2 min)…" });
    refuelMut.mutate(undefined, {
      onSuccess: () => {
        void qc.invalidateQueries({ queryKey: ["walletChildren"] });
        void qc.invalidateQueries({ queryKey: ["fee-juice"] });
        pushToast({ kind: "ok", text: "Refueled — fee-juice topped up." });
      },
      onError: (e) => pushToast({ kind: "warn", text: e instanceof Error ? e.message : "Refuel failed" }),
    });
  }
  return (
    <div style={{ padding: 24, height: "100%", overflow: "auto" }} className="q-scroll">
      <div style={{ maxWidth: 1200, margin: "0 auto", display: "flex", flexDirection: "column", gap: 20 }}>

        <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 16 }}>
          <div>
            <Eyebrow>Wallet pool</Eyebrow>
            <h2 style={{ fontFamily: "var(--font-display)", fontSize: 44, fontWeight: 300, letterSpacing: "-0.04em", marginTop: 4 }}>
              {children.length} wallets · <em style={{ fontFamily: "var(--font-serif)", fontStyle: "italic", fontWeight: 400 }}>{totalCapacity}</em> open slots
            </h2>
            <p style={{ fontFamily: "var(--font-body)", fontSize: 14, color: "var(--fg-muted)", marginTop: 8 }}>
              HD-derived children of a single master secret · round-robin via <code style={{ fontFamily: "var(--font-mono)", fontSize: 12 }}>pool.next()</code>
            </p>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <PillButton variant="ghost" leftIcon="plus">Grow pool</PillButton>
            <PillButton variant="ink" leftIcon="droplet">Faucet all</PillButton>
          </div>
        </div>

        {/* Subtab selector: Pool | Liquidity */}
        <div style={{ display: "flex", gap: 0, borderBottom: "1px solid var(--hairline)" }}>
          {(["pool", "liquidity"] as const).map((tab) => (
            <button
              key={tab}
              onClick={() => setWalletTab(tab)}
              style={{
                padding: "10px 20px",
                background: "transparent",
                border: "none",
                borderBottom: walletTab === tab ? "2px solid var(--aztec-ink)" : "2px solid transparent",
                fontFamily: "var(--font-mono)", fontSize: 13, fontWeight: 500,
                color: walletTab === tab ? "var(--fg)" : "var(--fg-muted)",
                cursor: "pointer",
                textTransform: "capitalize",
                transition: "color 120ms, border-color 120ms",
              }}
            >
              {tab === "pool" ? "Wallet Pool" : "Liquidity"}
            </button>
          ))}
        </div>

        {/* Liquidity subtab */}
        {walletTab === "liquidity" && (
          <LiquidityPanel pushToast={pushToast} />
        )}

        {/* Pool subtab — only rendered when that tab is active */}
        {walletTab === "pool" && (<>

        {/* Pool exhaustion banner (conditional — hardcoded false; the next task wires it from real state) */}
        {POOL_EXHAUSTED && (
          <div style={{
            background: "rgba(255,26,26,0.06)",
            border: "1px solid rgba(255,26,26,0.4)",
            borderRadius: 8,
            padding: "14px 16px",
            display: "flex", alignItems: "center", gap: 12,
          }}>
            <i data-lucide="alert-octagon" style={{ width: 18, height: 18, color: "var(--aztec-vermillion)", strokeWidth: 1.5 } as CSSProperties}></i>
            <div style={{ flex: 1 }}>
              <div style={{ fontFamily: "var(--font-mono)", fontSize: 13, color: "var(--fg)", fontWeight: 500 }}>All wallets at capacity</div>
              <div style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--fg-muted)", marginTop: 2 }}>Submissions paused. Either wait for next epoch to clear pending tx, or grow the pool.</div>
            </div>
            <PillButton size="sm" variant="ink">Grow to 6 wallets</PillButton>
          </div>
        )}

        {/* Children grid */}
        {pool === null ? (
          <div className="q-card" style={{ padding: 20, fontFamily: "var(--font-body)", fontSize: 14, color: "var(--fg-muted)" }}>
            Single-wallet mode — no pool children to display.
            {session?.client && (
              <div style={{ marginTop: 8, fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--fg)" }}>
                Connected: {session.client.address.toString()}
              </div>
            )}
          </div>
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 280px), 1fr))", gap: 16 }}>
            {children.map(c => {
              const isConnected = session?.client?.address.toString().toLowerCase() === c.addr.toLowerCase();
              return (
                <ChildCard
                  key={c.id}
                  child={c}
                  refueling={isConnected && refueling}
                  onFaucet={() => {
                    if (isConnected) {
                      // In-app refuel: drip + redeem into THIS (connected) wallet's balance.
                      doRefuel();
                    } else {
                      // Non-connected children can't be refueled in-app (we only hold the
                      // connected wallet's signer); deep-link to the external faucet.
                      const url = `https://aztec-faucet.dev-nethermind.xyz/?address=${encodeURIComponent(c.addr)}`;
                      window.open(url, "_blank", "noopener,noreferrer");
                      pushToast({ kind: "ok", text: "Opened Aztec faucet in new tab. Drip + refresh page." });
                    }
                  }}
                />
              );
            })}
          </div>
        )}

        {/* Master secret */}
        <div className="q-card-deep q-card" style={{ padding: 24 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
            <div>
              <Eyebrow style={{ color: "var(--fg-on-deep-mu)" }}>Master secret</Eyebrow>
              <div style={{ fontFamily: "var(--font-display)", fontSize: 24, fontWeight: 300, color: "var(--fg-on-deep)", marginTop: 6 }}>
                Single source of <em style={{ fontFamily: "var(--font-serif)", fontStyle: "italic", fontWeight: 400 }}>truth</em>
              </div>
            </div>
            <PillButton variant="onDeep" size="sm" onClick={() => setShowMaster(!showMaster)} leftIcon={showMaster ? "eye-off" : "eye"}>
              {showMaster ? "Hide" : "Reveal"}
            </PillButton>
          </div>
          <div style={{ marginTop: 16, display: "flex", alignItems: "center", gap: 12, padding: "14px 16px", background: "rgba(0,0,0,0.3)", borderRadius: 6 }}>
            <i data-lucide="key" style={{ width: 16, height: 16, color: "var(--aztec-chartreuse)", strokeWidth: 1.5 } as CSSProperties}></i>
            <code style={{
              flex: 1, fontFamily: "var(--font-mono)", fontSize: 13, color: "var(--fg-on-deep)",
              filter: showMaster ? "none" : "blur(6px)", userSelect: showMaster ? "auto" : "none",
            }}>
              0x9d2c1f8a4b3e7d6c5f1e2a9b8c7d6e5f4a3b2c1d0e9f8a7b6c5d4e3f2a1b0c9d8
            </code>
            <PillButton variant="onDeep" size="sm" leftIcon="copy" disabled={!showMaster}>Copy</PillButton>
          </div>
          <div style={{ marginTop: 10, fontFamily: "var(--font-body)", fontSize: 12, color: "var(--fg-on-deep-mu)", lineHeight: 1.5 }}>
            Whoever holds this secret controls every child wallet in the pool. Store it in a password manager. Never paste it into a website.
          </div>
        </div>
        </>)}
      </div>
    </div>
  );
}

function ChildCard({ child, onFaucet, refueling }: { child: PoolChild; onFaucet: () => void; refueling?: boolean }) {
  return (
    <div className="q-card" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{
            width: 32, height: 32, borderRadius: 6,
            background: "var(--aztec-ink)", color: "var(--aztec-parchment)",
            display: "flex", alignItems: "center", justifyContent: "center",
            fontFamily: "var(--font-mono)", fontSize: 13, fontWeight: 500,
          }}>{child.id}</div>
          <div>
            <div style={{ fontFamily: "var(--font-mono)", fontSize: 13, color: "var(--fg)" }}>child-{child.id}</div>
            <AddressMono value={child.addr} style={{ fontSize: 11, color: "var(--fg-muted)" }} />
          </div>
        </div>
        <PillButton size="sm" variant="quiet" onClick={onFaucet} disabled={refueling} leftIcon="droplet">
          {refueling ? "Refueling…" : "Refuel"}
        </PillButton>
      </div>

      <Hairline />

      <PoolCapacityBar current={child.pending} max={18} />

      <Hairline />

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <Eyebrow>Balances</Eyebrow>
        <BalanceRow2 token="ETH"  kind="public"  amount={child.fee}  label="fee-juice" />
        {/* These are PUBLIC balances (getPublicBalanceOf); private notes are
            PXE-local and unreadable for other children, so label them public. */}
        <BalanceRow2 token="USDC" kind="public" amount={child.usdc} label="USDC · public" />
        <BalanceRow2 token="WETH" kind="public" amount={child.weth} label="WETH · public" />
        <BalanceRow2 token="wBTC" kind="public" amount={child.wbtc} label="wBTC · public" />
      </div>
    </div>
  );
}

interface BalanceRow2Props {
  token: string;
  kind: "private" | "public";
  amount: string;
  label: string;
}
function BalanceRow2({ token, kind, amount, label }: BalanceRow2Props) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "22px 1fr auto", gap: 10, alignItems: "center" }}>
      <TokenGlyph token={token} size={22} />
      <div>
        <div style={{ fontFamily: "var(--font-serif)", fontSize: 13 }}>{label}</div>
        <div style={{ fontFamily: "var(--font-mono)", fontSize: 9, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--fg-muted)", marginTop: 1 }}>
          <Dot kind={kind} size={5} /> {kind}
        </div>
      </div>
      <div data-mono style={{ fontFamily: "var(--font-mono)", fontSize: 13, textAlign: "right", color: "var(--fg)" }}>{amount}</div>
    </div>
  );
}

/* ============ HISTORY ============ */
interface HistoryRow {
  time: string;
  epoch: number;
  side: "buy" | "sell";
  amount: string;
  amountToken: string;
  limit: string;
  fillPrice: string;
  status: "filled" | "decoy" | "cancelled";
  tx: string;
  decoy: boolean;
}

/**
 * Map an OrderViewModel (from client.reads.getOrders()) to the display HistoryRow shape.
 * SDK currently returns only resting/active orders — a proper filled+cancelled history
 * archive is a Sub-7 carry-forward. We surface the active-orders snapshot here.
 */
function orderToHistoryRow(o: {
  nonce: bigint;
  side: boolean;
  amount_in: bigint;
  limit_price: bigint;
  submitted_at_block: bigint;
}): HistoryRow {
  // side: true = sell, false = buy (Noir convention from OrderNote)
  const side = o.side ? "sell" : "buy";
  // amount_in is in token's base units (6 decimals for USDC, 18 for ETH).
  // Display as raw bigint string — no decimal formatting without knowing the token.
  const amount = o.amount_in.toString();
  const limit = o.limit_price.toString();
  const nonce = o.nonce.toString(16).slice(0, 8);
  return {
    time: "—",
    epoch: Number(o.submitted_at_block),
    side,
    amount,
    amountToken: side === "sell" ? "ETH" : "USDC",
    limit,
    fillPrice: "—",
    status: "filled",  // SDK has no status field; treat active orders as open/filled
    tx: `0x${nonce}…`,
    decoy: false,
  };
}

export function HistoryScreen() {
  const isMobile = useIsMobile();
  const client = useQuetzalClient();
  const { session } = useClientContext();
  const [side, setSide] = useState<"all" | "buy" | "sell">("all");
  const [hideDecoys, setHideDecoys] = useState(false);
  const [epochFrom, setEpochFrom] = useState<number>(0);
  const [epochTo, setEpochTo] = useState<number>(999_999_999);

  // SDK currently exposes only client.reads.getOrders() returning resting/active orders.
  // A proper history (filled + cancelled archive) is a Sub-7 carry-forward.
  const historyQ = useQuery({
    queryKey: ["history", session?.sessionId],
    queryFn: async (): Promise<HistoryRow[]> => {
      if (!client) return [];
      try {
        const orders = await client.reads.getOrders();
        return orders.map(orderToHistoryRow);
      } catch {
        return [];
      }
    },
    enabled: !!client,
    staleTime: 30_000,
  });

  const filtered = useMemo(() => {
    const rows = historyQ.data ?? [];
    return rows.filter(h =>
      (side === "all" || h.side === side) &&
      (!hideDecoys || !h.decoy) &&
      h.epoch >= epochFrom &&
      h.epoch <= epochTo,
    );
  }, [historyQ.data, side, hideDecoys, epochFrom, epochTo]);

  const exportCsv = () => {
    const header = "epoch,side,amount,amountToken,limitPrice,fillPrice,status,tx";
    const lines = filtered.map(h =>
      `${h.epoch},${h.side},${h.amount},${h.amountToken},${h.limit},${h.fillPrice},${h.status},${h.tx}`,
    );
    const csv = [header, ...lines].join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `quetzal-orders-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };
  return (
    <div style={{ padding: 24, height: "100%", overflow: "auto" }} className="q-scroll">
      <div style={{ maxWidth: 1200, margin: "0 auto", display: "flex", flexDirection: "column", gap: 20 }}>

        <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between" }}>
          <div>
            <Eyebrow>History</Eyebrow>
            <h2 style={{ fontFamily: "var(--font-display)", fontSize: 44, fontWeight: 300, letterSpacing: "-0.04em", marginTop: 4 }}>
              Every <em style={{ fontFamily: "var(--font-serif)", fontStyle: "italic", fontWeight: 400 }}>order</em>, every epoch
            </h2>
          </div>
          {/* CSV export: client-side serializer + blob download. No SDK API for this. */}
          <PillButton variant="ghost" leftIcon="download" onClick={exportCsv}>Export CSV</PillButton>
        </div>

        {/* Filter row */}
        <div className="q-card" style={{ padding: 16, display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <Eyebrow>Side</Eyebrow>
            <Segmented value={side} onChange={(v) => setSide(v as "all" | "buy" | "sell")} size="sm" options={[
              { id: "all",  label: "All"  },
              { id: "buy",  label: "Buy"  },
              { id: "sell", label: "Sell" },
            ]} />
          </div>
          <div style={{ width: 1, height: 24, background: "var(--hairline)" }} />
          <label style={{ display: "inline-flex", alignItems: "center", gap: 8, cursor: "pointer", fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--fg)" }}>
            <input type="checkbox" checked={hideDecoys} onChange={(e) => setHideDecoys(e.target.checked)} style={{ accentColor: "var(--q-decoy)" }} />
            Hide decoys
          </label>
          <div style={{ width: 1, height: 24, background: "var(--hairline)" }} />
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <Eyebrow>Epoch range</Eyebrow>
            <div style={{ display: "flex", alignItems: "center", gap: 6, fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--fg)" }}>
              <input type="number" value={epochFrom === 0 ? "" : epochFrom} placeholder="0" onChange={(e) => setEpochFrom(e.target.value === "" ? 0 : Number(e.target.value))} style={{ width: 70, height: 28, padding: "0 8px", borderRadius: 4, border: "1px solid var(--hairline-strong)", background: "var(--surface)", fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--fg)" }} />
              <span style={{ color: "var(--fg-muted)" }}>→</span>
              <input type="number" value={epochTo === 999_999_999 ? "" : epochTo} placeholder="∞" onChange={(e) => setEpochTo(e.target.value === "" ? 999_999_999 : Number(e.target.value))} style={{ width: 70, height: 28, padding: "0 8px", borderRadius: 4, border: "1px solid var(--hairline-strong)", background: "var(--surface)", fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--fg)" }} />
            </div>
          </div>
          <div style={{ flex: 1 }} />
          <div style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--fg-muted)" }}>{filtered.length} rows</div>
        </div>

        {/* Table */}
        <div className="q-card" style={{ padding: 0, overflow: "hidden" }}>
          {/* Nine fixed tracks can't collapse without losing row/header
              alignment, so the table scrolls sideways on a phone. */}
          <div className={isMobile ? "q-table-scroll" : undefined} style={{ ["--q-table-min" as string]: "760px" } as CSSProperties}>
          <div>
          <div style={{
            display: "grid", gridTemplateColumns: "16px 80px 80px 70px 1fr 1fr 1fr 100px 100px",
            gap: 12, padding: "10px 20px", background: "var(--bg-alt)",
          }}>
            <span></span>
            <span className="q-eyebrow">Time</span>
            <span className="q-eyebrow">Epoch</span>
            <span className="q-eyebrow">Side</span>
            <span className="q-eyebrow">Amount</span>
            <span className="q-eyebrow">Limit</span>
            <span className="q-eyebrow">Fill</span>
            <span className="q-eyebrow">Status</span>
            <span className="q-eyebrow" style={{ textAlign: "right" }}>TX</span>
          </div>
          {/* Orders from client.reads.getOrders() filtered client-side.
              Sub-7 carry-forward: SDK needs a history API for filled+cancelled archive. */}
          {filtered.map((h, i) => (
            <div key={i} style={{
              display: "grid", gridTemplateColumns: "16px 80px 80px 70px 1fr 1fr 1fr 100px 100px",
              gap: 12, padding: "12px 20px", alignItems: "center",
              borderBottom: "1px solid var(--hairline)",
              opacity: h.decoy ? 0.7 : 1,
            }}>
              <Dot kind={h.status === "filled" ? "filled" : h.status === "decoy" ? "decoy" : "cancel"} size={8} />
              <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--fg-muted)" }}>{h.time}</span>
              <span style={{ fontFamily: "var(--font-mono)", fontSize: 11 }}>{h.epoch}</span>
              <span style={{
                fontFamily: "var(--font-mono)", fontSize: 10, fontWeight: 500, letterSpacing: "0.06em",
                textTransform: "uppercase",
                padding: "3px 7px", borderRadius: 3, width: "fit-content",
                background: h.side === "buy" ? "rgba(13, 152, 118, 0.12)" : "rgba(255, 26, 26, 0.10)",
                color: h.side === "buy" ? "#0d9876" : "var(--aztec-vermillion)",
              }}>{h.side}</span>
              <span data-mono style={{ fontFamily: "var(--font-mono)", fontSize: 12 }}>{h.amount} <span style={{ color: "var(--fg-muted)" }}>{h.amountToken}</span></span>
              <span data-mono style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--fg-muted)" }}>{h.limit}</span>
              <span data-mono style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: h.fillPrice === "—" ? "var(--fg-subtle)" : "var(--fg)" }}>{h.fillPrice}</span>
              <Badge tone={h.status === "filled" ? "filled" : h.status === "decoy" ? "decoy" : "cancel"}>{h.status}</Badge>
              <a href="#" onClick={(e) => e.preventDefault()} style={{
                fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--fg-muted)",
                textDecoration: "underline", textDecorationColor: "var(--hairline-strong)",
                textAlign: "right",
              }}>{h.tx.slice(0, 8)}…</a>
            </div>
          ))}
          </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ============ SETTINGS ============ */
export function SettingsScreen() {
  const [network, setNetwork] = useState("alpha-testnet");
  const { disconnect } = useClientContext();

  const handleReset = async () => {
    if (!confirm("Reset local Quetzal state? This disconnects your wallet and clears local settings. Your encrypted master secret is KEPT (you stay onboarded) and on-chain state is unaffected.")) return;

    // H10: pending claim/withdraw entries hold ONE-TIME secrets that live only in
    // this browser — deleting them makes those in-flight funds unrecoverable. Never
    // wipe them (or the master secret) as a side effect of a settings reset. Only
    // remove them if the user opts in after an explicit, loss-spelling-out confirm.
    const claims = loadPendingClaims();
    const withdraws = loadPendingWithdraws();
    let wipePendingSecrets = false;
    if (claims.length + withdraws.length > 0) {
      wipePendingSecrets = confirm(
        `You have ${claims.length} pending claim(s) and ${withdraws.length} pending withdrawal(s). ` +
          `Their one-time secrets live ONLY in this browser — deleting them makes those funds PERMANENTLY unrecoverable.\n\n` +
          `OK = delete them too (funds lost) · Cancel = keep them.`,
      );
    }

    const all: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k) all.push(k);
    }
    for (const k of resettableKeys(all, { wipePendingSecrets })) localStorage.removeItem(k);

    // Disconnect client/pool
    await disconnect();
    // Reload to land on /landing
    window.location.hash = "";
    window.location.reload();
  };
  return (
    <div style={{ padding: 24, height: "100%", overflow: "auto" }} className="q-scroll">
      <div style={{ maxWidth: 760, margin: "0 auto", display: "flex", flexDirection: "column", gap: 20 }}>
        <div>
          <Eyebrow>Settings</Eyebrow>
          <h2 style={{ fontFamily: "var(--font-display)", fontSize: 44, fontWeight: 300, letterSpacing: "-0.04em", marginTop: 4 }}>
            <em style={{ fontFamily: "var(--font-serif)", fontStyle: "italic", fontWeight: 400 }}>Knobs</em>, for power users
          </h2>
        </div>

        <SettingsSection title="Network">
          <Segmented value={network} onChange={setNetwork} fullWidth options={[
            { id: "alpha-testnet", label: "alpha-testnet" },
            { id: "sandbox",       label: "sandbox" },
            { id: "mainnet",       label: "mainnet" },
          ]} />
          <div style={{ fontFamily: "var(--font-body)", fontSize: 12, color: "var(--fg-muted)", marginTop: 8 }}>
            {network === "mainnet" && (
              <span style={{ color: "var(--aztec-vermillion)" }}>⚠ Mainnet is live. Operations cost real money.</span>
            )}
            {network === "alpha-testnet" && "Public testnet. Free faucet, no real value. 10-min epochs."}
            {network === "sandbox"       && "Local sandbox. Requires a running node at localhost:8080."}
          </div>
        </SettingsSection>

        <SettingsSection title="Theme">
          {/* Hardcoded to Parchment for now; the next task wires the actual switcher */}
          <Segmented value="parchment" onChange={() => undefined} fullWidth options={[
            { id: "parchment", label: "Parchment" },
            { id: "dark",      label: "Malachite" },
          ]} />
          <div style={{ fontFamily: "var(--font-body)", fontSize: 12, color: "var(--fg-muted)", marginTop: 8 }}>
            Parchment is the default. Malachite switcher lands in the next task.
          </div>
        </SettingsSection>

        <SettingsSection title="Privacy defaults">
          <SettingRow label="Default decoy count" hint="Applied to new orders. You can override per-order on the trade screen.">
            <input type="number" min="0" max="4" defaultValue={2} style={{ width: 60, height: 32, padding: "0 8px", border: "1px solid var(--hairline-strong)", borderRadius: 4, fontFamily: "var(--font-mono)", fontSize: 13, color: "var(--fg)", background: "var(--surface)" }} />
          </SettingRow>
          <SettingRow label="Show round-amount advisory" hint="Warn when amount looks fingerprintable.">
            <Toggle defaultOn />
          </SettingRow>
          <SettingRow label="Show round-trip warning" hint="Warn when exit amount resembles a recent L1 deposit.">
            <Toggle defaultOn />
          </SettingRow>
        </SettingsSection>

        <SettingsSection title="Advanced">
          <SettingRow label="RPC override" hint="Use a custom Aztec node. Leave blank for default.">
            <input placeholder="https://…" style={{ width: 240, height: 32, padding: "0 10px", border: "1px solid var(--hairline-strong)", borderRadius: 4, fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--fg)", background: "var(--surface)" }} />
          </SettingRow>
          <SettingRow label="Gas overestimate" hint="Multiplier applied to gas estimate.">
            <input type="number" defaultValue={1.2} step={0.1} style={{ width: 60, height: 32, padding: "0 8px", border: "1px solid var(--hairline-strong)", borderRadius: 4, fontFamily: "var(--font-mono)", fontSize: 13, color: "var(--fg)", background: "var(--surface)" }} />
          </SettingRow>
        </SettingsSection>

        <SettingsSection title="Help">
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16 }}>
            <div>
              <div style={{ fontFamily: "var(--font-mono)", fontSize: 12, fontWeight: 500, color: "var(--fg)" }}>Onboarding tour</div>
              <div style={{ fontFamily: "var(--font-body)", fontSize: 12, color: "var(--fg-muted)", marginTop: 4 }}>Walk through Quetzal's privacy features again.</div>
            </div>
            <button
              onClick={() => {
                localStorage.removeItem("quetzal-tour-seen");
                alert("Tour will fire next time you visit Trade.");
              }}
              style={{
                background: "transparent", border: "1px solid var(--hairline-strong)",
                borderRadius: 8, padding: "8px 14px",
                fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--fg)",
                cursor: "pointer",
              }}
            >
              Replay onboarding tour
            </button>
          </div>
        </SettingsSection>

        <SettingsSection title="Danger zone">
          <div style={{
            border: "1px solid rgba(255,26,26,0.35)", background: "rgba(255,26,26,0.04)",
            borderRadius: 6, padding: 16, display: "flex", justifyContent: "space-between", alignItems: "center", gap: 16,
          }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontFamily: "var(--font-mono)", fontSize: 12, fontWeight: 500, color: "var(--fg)" }}>Reset local state</div>
              <div style={{ fontFamily: "var(--font-body)", fontSize: 12, color: "var(--fg-muted)", marginTop: 4 }}>Clears decoy registry and cached pool/settings. Keeps your master secret; keeps pending claims/withdrawals unless you confirm deleting them.</div>
            </div>
            {/* Clears quetzal-* localStorage keys + disconnects. No SDK API. */}
            <PillButton variant="danger" size="sm" onClick={() => { void handleReset(); }}>Reset</PillButton>
          </div>
        </SettingsSection>
      </div>
    </div>
  );
}

function SettingsSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="q-card">
      <h4 style={{ fontFamily: "var(--font-serif)", fontSize: 18, fontWeight: 400, marginBottom: 16 }}>{title}</h4>
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>{children}</div>
    </div>
  );
}

function SettingRow({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 16, alignItems: "center", paddingBottom: 12, borderBottom: "1px solid var(--hairline)" }}>
      <div>
        <div style={{ fontFamily: "var(--font-body)", fontSize: 13, color: "var(--fg)" }}>{label}</div>
        {hint && <div style={{ fontFamily: "var(--font-body)", fontSize: 11, color: "var(--fg-muted)", marginTop: 2, lineHeight: 1.45 }}>{hint}</div>}
      </div>
      <div>{children}</div>
    </div>
  );
}

function Toggle({ defaultOn = false }: { defaultOn?: boolean }) {
  const [on, setOn] = useState(defaultOn);
  return (
    <button onClick={() => setOn(!on)} style={{
      width: 40, height: 22, borderRadius: 999,
      background: on ? "var(--aztec-ink)" : "var(--hairline-strong)",
      border: "none", cursor: "pointer", position: "relative",
      transition: "background var(--dur-fast) var(--ease-out)",
    }}>
      <span style={{
        position: "absolute", top: 2, left: on ? 20 : 2,
        width: 18, height: 18, borderRadius: "50%", background: "var(--aztec-parchment)",
        transition: "left var(--dur-fast) var(--ease-out)",
      }} />
    </button>
  );
}
