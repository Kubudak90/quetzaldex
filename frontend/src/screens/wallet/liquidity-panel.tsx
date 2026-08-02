// Sub-8.2b: LiquidityPanel — "Liquidity" subtab inside the Wallet screen.
//
// Shows:
//   1. Pool state (current_sqrt_price + total reserves) as context header.
//   2. User's existing LP positions (from client.pools.getPositions()).
//   3. Deposit form: bucket slider + tUSDC/tETH amounts + estimated L_used preview.
//      Handles the fresh-pool "below-range" regime by auto-zeroing tETH with
//      a clear inline message.
//   4. Withdraw button per position (calls client.pools.withdraw()).
//
// Patterns match ExitTab (useMutation + onSuccess toast + useQuery for reads).

import { useState, useMemo } from "react";
import type { CSSProperties } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useQuetzalClient, useClientContext } from "../../sdk/client-context.js";
import {
  Eyebrow, Hairline, PillButton, Field, Segmented,
} from "../../components/atoms.js";
import {
  computeDeposit,
  computeBucketBounds,
  depositRegime,
  type PositionView,
  type PoolState,
} from "@quetzal/sdk";

// ─── Types ────────────────────────────────────────────────────────────────────

interface ToastIn { kind: string; text: string }
type PushToast = (t: ToastIn) => void;

interface LiquidityPanelProps {
  pushToast: PushToast;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const SCALE = 1_000_000_000_000_000_000n;
// Default pool p_min_sqrt / growth_num.  These come from quetzal.config.json
// at deploy time; hardcoded here as display-layer constants (not used in the
// actual contract call; the contract re-reads them on-chain).
// Values were taken from scripts/seed-lp.ts comment: "bucket_growth_num".
// TODO: expose from QuetzalContracts config when Sub-5 config schema lands.
const DEFAULT_P_MIN_SQRT = SCALE; // 1e18 placeholder; real pools set this at deploy
const DEFAULT_GROWTH_NUM = (12n * SCALE) / 10n; // 1.2x per bucket (20% wide)

const USDC_DECIMALS = 6;
const ETH_DECIMALS = 18;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function parseAmount(s: string, decimals: number): bigint {
  const clean = s.replace(/,/g, "").trim();
  if (!clean || clean === ".") return 0n;
  const [whole = "0", frac = ""] = clean.split(".");
  const fracPadded = frac.padEnd(decimals, "0").slice(0, decimals);
  try {
    return BigInt(whole + fracPadded);
  } catch {
    return 0n;
  }
}

function formatSmall(n: bigint, decimals: number, maxFrac = 6): string {
  if (n === 0n) return "0";
  const scale = 10n ** BigInt(decimals);
  const whole = n / scale;
  const fracBig = n % scale;
  const fracStr = fracBig.toString().padStart(decimals, "0").slice(0, maxFrac).replace(/0+$/, "");
  return fracStr ? `${whole}.${fracStr}` : `${whole}`;
}

function formatSqrtPrice(v: bigint): string {
  // Display as a scaled ratio. Actual UI shows it as a raw bigint for now.
  return `${v.toString().slice(0, 8)}…`;
}

// ─── PoolStateHeader ─────────────────────────────────────────────────────────

function PoolStateHeader({ state }: { state: PoolState | undefined; loading: boolean }) {
  if (!state) {
    return (
      <div className="q-card" style={{ padding: 16, fontFamily: "var(--font-body)", fontSize: 13, color: "var(--fg-muted)" }}>
        Pool state unavailable
      </div>
    );
  }
  return (
    <div className="q-card" style={{ padding: 16, display: "flex", gap: 24, flexWrap: "wrap" }}>
      <div>
        <Eyebrow>Pool 0 · tUSDC / tETH</Eyebrow>
        <div style={{ fontFamily: "var(--font-mono)", fontSize: 13, marginTop: 4 }}>
          sqrt_P: <span style={{ color: "var(--aztec-chartreuse)" }}>{formatSqrtPrice(state.currentSqrtPrice)}</span>
        </div>
      </div>
      <div>
        <Eyebrow>Total tUSDC</Eyebrow>
        <div style={{ fontFamily: "var(--font-mono)", fontSize: 13, marginTop: 4 }}>
          {formatSmall(state.reserveA, USDC_DECIMALS)}
        </div>
      </div>
      <div>
        <Eyebrow>Total tETH</Eyebrow>
        <div style={{ fontFamily: "var(--font-mono)", fontSize: 13, marginTop: 4 }}>
          {formatSmall(state.reserveB, ETH_DECIMALS)}
        </div>
      </div>
    </div>
  );
}

// ─── PositionRow ─────────────────────────────────────────────────────────────

interface PositionRowProps {
  pos: PositionView;
  onWithdraw: (nonce: bigint) => void;
  withdrawing: boolean;
}

function PositionRow({ pos, onWithdraw, withdrawing }: PositionRowProps) {
  return (
    <div style={{
      display: "grid",
      gridTemplateColumns: "80px 1fr 1fr auto",
      gap: 12,
      padding: "12px 16px",
      alignItems: "center",
      borderBottom: "1px solid var(--hairline)",
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <div style={{
          width: 28, height: 28, borderRadius: 4,
          background: "var(--bg-alt)",
          display: "flex", alignItems: "center", justifyContent: "center",
          fontFamily: "var(--font-mono)", fontSize: 12, fontWeight: 600,
          color: "var(--fg)",
        }}>{pos.bucketId}</div>
        <Eyebrow style={{ fontSize: 9 }}>bucket</Eyebrow>
      </div>
      <div>
        <Eyebrow>LP share</Eyebrow>
        <div style={{ fontFamily: "var(--font-mono)", fontSize: 12, marginTop: 2 }}>
          {formatSmall(pos.lpShare, 18)}
        </div>
      </div>
      <div>
        <Eyebrow>Nonce (short)</Eyebrow>
        <div style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--fg-muted)", marginTop: 2 }}>
          0x{pos.positionNonce.toString(16).slice(0, 8)}…
        </div>
      </div>
      <PillButton
        size="sm"
        variant="ghost"
        leftIcon="log-out"
        disabled={withdrawing}
        onClick={() => onWithdraw(pos.positionNonce)}
      >
        {withdrawing ? "Withdrawing…" : "Withdraw"}
      </PillButton>
    </div>
  );
}

// ─── DepositForm ──────────────────────────────────────────────────────────────

interface DepositFormProps {
  poolState: PoolState | undefined;
  onDeposit: (params: { bucketId: number; amountA: bigint; amountB: bigint }) => void;
  depositing: boolean;
}

function DepositForm({ poolState, onDeposit, depositing }: DepositFormProps) {
  const [bucketId, setBucketId] = useState(8);
  const [amountA, setAmountA] = useState("");
  const [amountB, setAmountB] = useState("");

  // Compute bucket bounds + regime from the current pool state.
  const { bounds, regime, estimate } = useMemo(() => {
    const rawA = parseAmount(amountA, USDC_DECIMALS);
    const rawB = parseAmount(amountB, ETH_DECIMALS);
    const sqrtP = poolState?.currentSqrtPrice ?? DEFAULT_P_MIN_SQRT;
    const b = computeBucketBounds(DEFAULT_P_MIN_SQRT, DEFAULT_GROWTH_NUM, bucketId);
    const r = depositRegime(sqrtP, b);

    let est = { l_used: 0n, used_a: 0n, used_b: 0n };
    if (rawA > 0n || rawB > 0n) {
      try {
        est = computeDeposit(rawA, rawB, sqrtP, b);
      } catch {
        // ignore math errors (e.g. zero divisor on fresh bucket)
      }
    }
    return { bounds: b, regime: r, estimate: est };
  }, [bucketId, amountA, amountB, poolState]);

  const regimeColor =
    regime === "below-range" ? "var(--fg-muted)" :
    regime === "above-range" ? "var(--aztec-vermillion)" :
    "var(--aztec-chartreuse)";

  const canSubmit =
    !depositing &&
    (parseAmount(amountA, USDC_DECIMALS) > 0n || parseAmount(amountB, ETH_DECIMALS) > 0n) &&
    estimate.l_used > 0n;

  return (
    <div className="q-card" style={{ display: "flex", flexDirection: "column", gap: 16, padding: 20 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div>
          <Eyebrow>Deposit liquidity</Eyebrow>
          <div style={{ fontFamily: "var(--font-body)", fontSize: 12, color: "var(--fg-muted)", marginTop: 4 }}>
            tUSDC / tETH · Pool 0
          </div>
        </div>
        <div style={{
          fontFamily: "var(--font-mono)", fontSize: 10, letterSpacing: "0.06em",
          textTransform: "uppercase", color: regimeColor,
          padding: "4px 10px", borderRadius: 999,
          border: `1px solid ${regimeColor}`,
        }}>
          {regime}
        </div>
      </div>

      {/* Bucket slider */}
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <Eyebrow>Bucket</Eyebrow>
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 13, fontWeight: 600 }}>{bucketId}</span>
        </div>
        <input
          type="range"
          min="0"
          max="15"
          step="1"
          value={bucketId}
          onChange={(e) => setBucketId(parseInt(e.target.value, 10))}
          style={{ accentColor: "var(--aztec-ink)", width: "100%" }}
        />
        <div style={{ display: "flex", justifyContent: "space-between", fontFamily: "var(--font-mono)", fontSize: 9, color: "var(--fg-muted)" }}>
          <span>0 (low price)</span>
          <span style={{ color: "var(--fg-subtle)" }}>
            √lower: {formatSqrtPrice(bounds.sqrt_lower)} · √upper: {formatSqrtPrice(bounds.sqrt_upper)}
          </span>
          <span>15 (high price)</span>
        </div>
      </div>

      {/* Amount inputs */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <Field
            label="tUSDC amount"
            mono
            value={amountA}
            onChange={(e) => setAmountA(e.target.value)}
            placeholder="0.00"
            suffix="tUSDC"
          />
          {regime !== "above-range" && (
            <div style={{ fontFamily: "var(--font-body)", fontSize: 11, color: "var(--fg-muted)" }}>
              Used: {formatSmall(estimate.used_a, USDC_DECIMALS)} tUSDC
            </div>
          )}
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <Field
            label="tETH amount"
            mono
            value={amountB}
            onChange={(e) => setAmountB(e.target.value)}
            placeholder="0.000000"
            suffix="tETH"
          />
          {regime !== "below-range" && (
            <div style={{ fontFamily: "var(--font-body)", fontSize: 11, color: "var(--fg-muted)" }}>
              Used: {formatSmall(estimate.used_b, ETH_DECIMALS)} tETH
            </div>
          )}
        </div>
      </div>

      {/* Fresh-pool / out-of-range advisory */}
      {regime === "below-range" && (
        <div style={{
          background: "var(--bg-alt)",
          border: "1px solid var(--hairline-strong)",
          borderRadius: 6,
          padding: "10px 14px",
          fontFamily: "var(--font-body)", fontSize: 12, color: "var(--fg-muted)",
          lineHeight: 1.5,
        }}>
          <strong style={{ color: "var(--fg)", fontFamily: "var(--font-mono)" }}>Below-range bucket</strong> — the pool's current price is below this bucket's range.
          Only <em>tUSDC</em> will be deposited; tETH would be fully refunded. You can leave tETH at 0 to skip the escrow round-trip.
        </div>
      )}
      {regime === "above-range" && (
        <div style={{
          background: "rgba(255,26,26,0.04)",
          border: "1px solid rgba(255,26,26,0.3)",
          borderRadius: 6,
          padding: "10px 14px",
          fontFamily: "var(--font-body)", fontSize: 12, color: "var(--fg-muted)",
          lineHeight: 1.5,
        }}>
          <strong style={{ color: "var(--aztec-vermillion)", fontFamily: "var(--font-mono)" }}>Above-range bucket</strong> — the pool price is above this bucket's range.
          Only <em>tETH</em> will be deposited; tUSDC would be fully refunded.
        </div>
      )}

      {/* Estimated L_used preview */}
      <div style={{
        padding: "12px 14px",
        background: "var(--surface)",
        border: "1px solid var(--hairline)",
        borderRadius: 6,
        display: "flex", flexDirection: "column", gap: 6,
      }}>
        <Eyebrow>Estimated L_used</Eyebrow>
        <div style={{ fontFamily: "var(--font-mono)", fontSize: 16, fontWeight: 600, color: estimate.l_used > 0n ? "var(--fg)" : "var(--fg-subtle)" }}>
          {estimate.l_used > 0n ? formatSmall(estimate.l_used, 18) : "—"}
        </div>
        {estimate.l_used === 0n && (amountA || amountB) && (
          <div style={{ fontFamily: "var(--font-body)", fontSize: 11, color: "var(--aztec-vermillion)" }}>
            L_used is 0 — deposit too small or zero amounts for this regime.
          </div>
        )}
      </div>

      <PillButton
        size="lg"
        fullWidth
        variant="primary"
        disabled={!canSubmit}
        rightIcon="droplet"
        onClick={() => {
          if (!canSubmit) return;
          onDeposit({
            bucketId,
            amountA: parseAmount(amountA, USDC_DECIMALS),
            amountB: parseAmount(amountB, ETH_DECIMALS),
          });
        }}
      >
        {depositing ? "Depositing…" : `Deposit to bucket ${bucketId}`}
      </PillButton>
    </div>
  );
}

// ─── LiquidityPanel ──────────────────────────────────────────────────────────

export function LiquidityPanel({ pushToast }: LiquidityPanelProps) {
  const client = useQuetzalClient();
  const { session } = useClientContext();
  const qc = useQueryClient();
  const [withdrawingNonce, setWithdrawingNonce] = useState<bigint | null>(null);

  // ── Queries ──────────────────────────────────────────────────────────────

  const poolStateQ = useQuery({
    queryKey: ["poolState", 0, session?.sessionId],
    queryFn: async (): Promise<PoolState | null> => {
      if (!client) return null;
      try {
        return await client.pools.getPoolState(0);
      } catch {
        return null;
      }
    },
    enabled: !!client,
    staleTime: 30_000,
  });

  const positionsQ = useQuery({
    queryKey: ["lpPositions", 0, session?.sessionId],
    queryFn: async (): Promise<PositionView[]> => {
      if (!client) return [];
      try {
        return await client.pools.getPositions(0);
      } catch {
        return [];
      }
    },
    enabled: !!client,
    staleTime: 30_000,
  });

  // ── Mutations ─────────────────────────────────────────────────────────────

  const depositMut = useMutation({
    mutationFn: async (params: { bucketId: number; amountA: bigint; amountB: bigint }) => {
      if (!client) throw new Error("Not connected");
      return await client.pools.deposit({
        poolId: 0,
        bucketId: params.bucketId,
        amountA: params.amountA,
        amountB: params.amountB,
      });
    },
    onSuccess: (result) => {
      void qc.invalidateQueries({ queryKey: ["lpPositions", 0, session?.sessionId] });
      void qc.invalidateQueries({ queryKey: ["poolState", 0, session?.sessionId] });
      pushToast({
        kind: "ok",
        text: `Liquidity deposited! Position nonce: 0x${result.positionNonce.toString(16).slice(0, 8)}… tx: ${result.l2TxHash.slice(0, 10)}…`,
      });
    },
    onError: (e) => {
      pushToast({ kind: "warn", text: e instanceof Error ? e.message : "Deposit failed" });
    },
  });

  const withdrawMut = useMutation({
    mutationFn: async (positionNonce: bigint) => {
      if (!client) throw new Error("Not connected");
      setWithdrawingNonce(positionNonce);
      return await client.pools.withdraw({ poolId: 0, positionNonce });
    },
    onSuccess: (result, positionNonce) => {
      setWithdrawingNonce(null);
      void qc.invalidateQueries({ queryKey: ["lpPositions", 0, session?.sessionId] });
      void qc.invalidateQueries({ queryKey: ["poolState", 0, session?.sessionId] });
      pushToast({
        kind: "ok",
        text: `Withdrawn position 0x${positionNonce.toString(16).slice(0, 8)}… tx: ${result.l2TxHash.slice(0, 10)}…`,
      });
    },
    onError: (e) => {
      setWithdrawingNonce(null);
      pushToast({ kind: "warn", text: e instanceof Error ? e.message : "Withdraw failed" });
    },
  });

  // ── Render ────────────────────────────────────────────────────────────────

  const positions = positionsQ.data ?? [];
  const poolState = poolStateQ.data ?? undefined;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>

      {/* Pool context header */}
      <PoolStateHeader
        state={poolState}
        loading={poolStateQ.isFetching}
      />

      {/* Positions list */}
      <div className="q-card" style={{ padding: 0, overflow: "hidden" }}>
        {/* Header row */}
        <div style={{
          display: "grid", gridTemplateColumns: "80px 1fr 1fr auto",
          gap: 12, padding: "10px 16px",
          background: "var(--bg-alt)",
        }}>
          <Eyebrow>Bucket</Eyebrow>
          <Eyebrow>LP share</Eyebrow>
          <Eyebrow>Nonce</Eyebrow>
          <span></span>
        </div>

        {positionsQ.isLoading && (
          <div style={{ padding: "20px 16px", fontFamily: "var(--font-body)", fontSize: 13, color: "var(--fg-muted)" }}>
            Loading positions…
          </div>
        )}

        {!positionsQ.isLoading && positions.length === 0 && (
          <div style={{
            padding: "24px 20px",
            display: "flex", flexDirection: "column", alignItems: "center", gap: 10,
            fontFamily: "var(--font-body)", fontSize: 14, color: "var(--fg-muted)",
            textAlign: "center",
          }}>
            <i data-lucide="droplets" style={{ width: 28, height: 28, strokeWidth: 1, color: "var(--fg-subtle)" } as CSSProperties}></i>
            No active positions.
            <span style={{ fontSize: 12, color: "var(--fg-subtle)" }}>Deposit below to start providing liquidity.</span>
          </div>
        )}

        {positions.map((pos) => (
          <PositionRow
            key={pos.positionNonce.toString()}
            pos={pos}
            onWithdraw={(nonce) => withdrawMut.mutate(nonce)}
            withdrawing={withdrawMut.isPending && withdrawingNonce === pos.positionNonce}
          />
        ))}
      </div>

      <Hairline />

      {/* Deposit form */}
      <DepositForm
        poolState={poolState}
        onDeposit={(params) => depositMut.mutate(params)}
        depositing={depositMut.isPending}
      />
    </div>
  );
}
