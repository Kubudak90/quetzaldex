// Quetzal — Trade screen
// Order placement + open orders + recent fills.
// decoy count starts at constant 2 (was tweaks.defaultDecoys).

import { useState, useMemo } from "react";
import type { ChangeEvent, CSSProperties } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useQuetzalClient, useClientContext } from "../sdk/client-context.js";
import {
  useFeeJuiceBalance, useRefuel, formatFeeJuice, ordersRemaining, LOW_FUEL_THRESHOLD,
  type RefuelProgress,
} from "../sdk/use-fee-juice.js";
import {
  Eyebrow, Hairline, Dot, Badge, PillButton, Field, Tooltip, Segmented, FeatherWatermark,
  EpochCountdown,
} from "../components/atoms.js";
import {
  DecoyVisualizer, RoundAmountAdvisory, OrderRow, FillRow, PairSelector,
} from "../components/screens-shared.js";
import { useIsMobile } from "../hooks/use-media-query.js";
import { recordOrder, loadOrders, removeOrder } from "./order-journal.js";
import { parseAmount, formatAmount, pairToPath, inputDecimals } from "./trade-amounts.js";

interface ToastIn { kind: string; text: string }
type PushToast = (t: ToastIn) => void;

interface TradeScreenProps {
  pushToast: PushToast;
  secondsLeft: number;
}

const DEFAULT_DECOYS = 2;

const TRADE_PAIRS = [
  { id: "USDC/ETH",  label: "USDC / ETH",  priceLabel: "1 ETH = 3,217.84 USDC" },
  { id: "USDC/BTC",  label: "USDC / BTC",  priceLabel: "1 BTC = 67,402.10 USDC" },
  { id: "ETH/BTC",   label: "ETH / BTC",   priceLabel: "1 BTC = 20.94 ETH" },
];

type TradeOrderStatus = "open" | "filled" | "cancelled" | "decoy" | "pending";
interface TradeOrder {
  nonce: string;
  side: "buy" | "sell";
  amount: string;
  amountToken: string;
  limit: string;
  limitToken: string;
  epoch: number;
  status: TradeOrderStatus;
}

// SEED_ORDERS removed — replaced by useQuery(["orders", sessionId]) via client.reads.getOrders()

interface TradeFill {
  epoch: number;
  side: "buy" | "sell";
  amount: string;
  amountToken: string;
  price: string;
  priceToken: string;
  tx: string;
}

// SEED_FILLS removed — recentFills is now derived client-side from orders with status==="filled"
// (SDK has no separate history.getRecentFills; deferred to a future Sub-7 history API)

// ─── SDK input helpers ────────────────────────────────────────────────────────
// H9: parseAmount/formatAmount/pairToPath live in ./trade-amounts and now REQUIRE
// explicit decimals so the order amount uses the input token's TRUE precision
// (ETH=18, not a fixed 6). LIMIT price keeps its 6-decimal scale (USDC quote).

/** Canonicalize an order nonce for comparison (drops leading zeros). */
function normNonce(hex: string): string {
  try { return "0x" + BigInt(hex).toString(16); } catch { return hex.toLowerCase(); }
}

// ─── Amount advisory ─────────────────────────────────────────────────────────

interface AmountAdvisory {
  classification: "natural" | "round_unit" | "round_cent";
  suggested?: string;
}
function classifyAmount(raw: string): AmountAdvisory {
  if (!raw) return { classification: "natural" };
  const n = parseFloat(raw.replace(/,/g, ""));
  if (isNaN(n) || n === 0) return { classification: "natural" };
  const s = String(n);
  if (/^\d+$/.test(s) && n >= 1) return { classification: "round_unit", suggested: (n + 0.073).toFixed(3) };
  if (/^\d+\.0+$/.test(s)) return { classification: "round_unit", suggested: (n + 0.073).toFixed(3) };
  if (/^\d+\.00$/.test(s) || /^\d+\.000$/.test(s)) return { classification: "round_cent", suggested: (n + 0.073).toFixed(3) };
  return { classification: "natural" };
}

export function TradeScreen({ pushToast, secondsLeft }: TradeScreenProps) {
  // ── SDK client + React Query ───────────────────────────────────────────────
  const client = useQuetzalClient();
  const { session } = useClientContext();
  const qc = useQueryClient();

  // Guard: App-level redirect handles the no-session case; this is belt-and-suspenders.
  if (!client) return null;

  // ── Fee-juice (fuel) ───────────────────────────────────────────────────────
  const feeJuiceQ = useFeeJuiceBalance();
  const [refuelPhase, setRefuelPhase] = useState<RefuelProgress["phase"] | null>(null);
  const refuelMut = useRefuel((p) => setRefuelPhase(p.phase));
  function doRefuel() {
    setRefuelPhase("dripping");
    refuelMut.mutate(undefined, {
      onSuccess: () => { setRefuelPhase(null); pushToast({ kind: "ok", text: "Refueled — fee-juice topped up." }); },
      onError: (e) => { setRefuelPhase(null); pushToast({ kind: "warn", text: e instanceof Error ? e.message : "Refuel failed" }); },
    });
  }
  const lowFuel = feeJuiceQ.data != null && feeJuiceQ.data < LOW_FUEL_THRESHOLD;
  const ordersLeft = ordersRemaining(feeJuiceQ.data ?? null);
  const refuelLabel = refuelPhase === "dripping"
    ? "Requesting fuel…"
    : refuelPhase === "bridging"
      ? "Bridging (≈1–2 min)…"
      : refuelPhase === "redeeming"
        ? "Crediting balance…"
        : "Refuel";

  // ── Form state ─────────────────────────────────────────────────────────────
  const [pair, setPair] = useState("USDC/ETH");
  const [side, setSide] = useState<"buy" | "sell">("sell");
  const [amount, setAmount] = useState("");
  const [amountToken, setAmountToken] = useState("ETH");
  const [limit, setLimit] = useState("3,218.50");
  const [decoys, setDecoys] = useState(DEFAULT_DECOYS);
  const [ack, setAck] = useState(false);

  const advisory = useMemo(() => classifyAmount(amount), [amount]);
  const canSubmit = !!amount && parseFloat(amount.replace(/,/g, "")) > 0 &&
    (advisory.classification === "natural" || ack);

  // ── Orders query ───────────────────────────────────────────────────────────
  // getOrders() returns resting orders (all "open" from the contract's perspective).
  // The SDK's OrderViewModel has: nonce: bigint, side: boolean, amount_in: bigint,
  // limit_price: bigint, submitted_at_block: bigint — no status field.
  const ordersQ = useQuery({
    queryKey: ["orders", session?.sessionId],
    queryFn: () => client.reads.getOrders(),
    enabled: !!client,
  });

  // ── Filled-order detection ─────────────────────────────────────────────────
  // A filled order leaves the resting set, so getOrders() can't see it. We
  // reconcile the maker-local order journal against the resting set + the
  // aggregator's GET /proof (via the same-origin /api proxy) to surface claimable
  // fills. See order-journal.ts for why the journal is needed.
  const ownerHex = client.address.toString();
  const orderStatusQ = useQuery({
    queryKey: ["order-status", session?.sessionId, ordersQ.dataUpdatedAt],
    enabled: !!client && ordersQ.data !== undefined,
    refetchInterval: 15_000,
    queryFn: async (): Promise<TradeOrder[]> => {
      const journal = loadOrders(ownerHex);
      const resting = new Set((ordersQ.data ?? []).map(o => normNonce("0x" + o.nonce.toString(16))));
      const filled: TradeOrder[] = [];
      for (const e of journal) {
        if (resting.has(normNonce(e.nonce))) continue; // still resting → already shown as "open"
        try {
          const proof = await client.aggregator.fetchHopProof("/api", { orderNonce: BigInt(e.nonce) });
          filled.push({
            nonce: e.nonce,
            side: e.side,
            amount: e.amount,
            amountToken: e.amountToken,
            limit: e.limit,
            limitToken: e.limitToken,
            epoch: proof.epoch_id,
            status: "filled",
          });
        } catch {
          // 404 = not filled yet / already claimed / cancelled. Don't auto-prune on a
          // transient error — the journal is cleared explicitly on a successful claim.
        }
      }
      return filled;
    },
  });

  // Map resting orders (all "open" from the contract's view) and overlay the
  // journal-detected filled orders (which take precedence on nonce collision).
  const restingOrders: TradeOrder[] = (ordersQ.data ?? []).map(o => ({
    nonce: "0x" + o.nonce.toString(16),
    side: o.side ? "sell" : "buy",
    amount: formatAmount(o.amount_in, inputDecimals(pair, o.side ? "sell" : "buy")),
    amountToken: pair.split("/")[o.side ? 1 : 0] ?? "—",
    limit: formatAmount(o.limit_price, 6),
    limitToken: "USDC",
    epoch: Number(o.submitted_at_block),
    status: "open" as const,
  }));
  const filledOrders = orderStatusQ.data ?? [];
  const filledNonces = new Set(filledOrders.map(f => normNonce(f.nonce)));
  const orders: TradeOrder[] = [
    ...filledOrders,
    ...restingOrders.filter(o => !filledNonces.has(normNonce(o.nonce))),
  ];

  // Recent fills: client-side filter on orders with status === "filled".
  // All resting orders from the contract are "open"; filled orders are
  // removed from the note tree after claiming. Until a dedicated Sub-7
  // history API ships, recentFills will be empty (orders are claim-and-gone).
  const recentFills: TradeFill[] = orders
    .filter(o => o.status === "filled")
    .slice(0, 20)
    .map(o => ({
      epoch: o.epoch,
      side: o.side,
      amount: o.amount,
      amountToken: o.amountToken,
      price: o.limit,
      priceToken: o.limitToken,
      tx: o.nonce,
    }));

  // ── Place order mutation ───────────────────────────────────────────────────
  const placeOrderMut = useMutation({
    mutationFn: async (input: {
      side: "buy" | "sell";
      amount: bigint;
      limitPrice: bigint;
      path: string[];
      decoys: number;
      // Display fields captured at submit time so the order journal renders the
      // filled order accurately later (state may have changed by then).
      pair: string;
      amountDisplay: string;
      amountToken: string;
      limitDisplay: string;
    }) => {
      if (input.decoys === 0) {
        return await client.orders.placeOrder({
          side: input.side,
          amount: input.amount,
          limitPrice: input.limitPrice,
          path: input.path,
        });
      }
      return await client.orders.placeOrderBulk({
        side: input.side,
        amount: input.amount,
        limitPrice: input.limitPrice,
        path: input.path,
        decoyCount: input.decoys,
      });
    },
    onSuccess: (result, vars) => {
      void qc.invalidateQueries({ queryKey: ["orders", session?.sessionId] });
      void qc.invalidateQueries({ queryKey: ["escrow-status"] });
      setAmount("");
      pushToast({ kind: "ok", text: "Order placed." });

      // Persist the placed real order so its fill can be discovered + claimed later
      // (filled orders leave the resting set — see order-journal.ts).
      const orderNonce =
        "orderNonce" in result
          ? `0x${result.orderNonce.toString(16)}`
          : `0x${result.realNonce.toString(16)}`;
      recordOrder(client.address.toString(), {
        nonce: orderNonce,
        epoch: result.epoch,
        side: vars.side,
        pair: vars.pair,
        amount: vars.amountDisplay,
        amountToken: vars.amountToken,
        limit: vars.limitDisplay,
        limitToken: "USDC",
        createdAt: Date.now(),
      });
      void qc.invalidateQueries({ queryKey: ["order-status", session?.sessionId] });

      // ── Sub-8.5: broadcast reveal to aggregator ──────────────────────────
      // Same-origin Vercel proxy: directReveal POSTs to `${url}/reveal` →
      // /api/reveal → the VPS aggregator server-side (see api/reveal.mjs).
      // Hardcoded (NOT VITE_AGGREGATOR_URL) — that env is set in prod to the raw
      // http://<vps>:3001 origin, which is mixed-content-blocked from HTTPS and
      // has no public HTTPS endpoint; the reveal was effectively never delivered.
      const aggregatorUrl = "/api";
      if (aggregatorUrl && result) {
        // Reveal EVERY submitted order to the aggregator. A bulk order folds the real
        // order AND each decoy into the epoch order_acc, so revealing only the real
        // one fails the replay and the WHOLE epoch is skipped (decoys carry unfillable
        // limits → they never fill, they only complete the chain). The aggregator
        // re-sorts by order_nonce, so reveal order here doesn't matter. See sdk
        // placeOrderBulk + aggregator validate.ts.
        const toReveal =
          "reveals" in result && Array.isArray(result.reveals)
            ? result.reveals.map((r) => ({
                order_nonce: `0x${r.orderNonce.toString(16)}`,
                side: r.side,
                amount_in: r.amountIn.toString(),
                limit_price: r.limitPrice.toString(),
                path_len: r.pathLen,
                path: r.path,
              }))
            : [{
                order_nonce: orderNonce,
                // M11: the reveal side must be the CANONICAL side the contract folded
                // into c_i (result.side), not the raw UI side — canonicalizePath may
                // flip it for a reverse-lex path, and a mismatch fails order_acc replay.
                side: result.side,
                amount_in: vars.amount.toString(),
                limit_price: vars.limitPrice.toString(),
                path_len: result.path_len,
                path: result.path,
              }];
        void Promise.all(
          toReveal.map((o) =>
            client.aggregator.directReveal(aggregatorUrl, {
              epoch_id: result.epoch,
              order_nonce: o.order_nonce,
              side: o.side,
              amount_in: o.amount_in,
              limit_price: o.limit_price,
              // Anchor block bound into every c_i (one tx → one block), NOT the mined
              // block — using the mined block mismatched the order_acc replay.
              submitted_at_block: result.submittedAtBlock,
              owner: client.address.toString(),
              submission_tx_hash: result.txHash || undefined,
              path_len: o.path_len,
              path: o.path,
            }),
          ),
        ).then((oks) => {
          if (oks.every(Boolean)) {
            pushToast({ kind: "ok", text: `Revealed ${oks.length} order${oks.length === 1 ? "" : "s"} to aggregator.` });
          } else {
            pushToast({ kind: "warn", text: "Aggregator unreachable for some orders — they won't clear until you retry." });
          }
        });
      }
    },
    onError: (e) => {
      const msg = e instanceof Error ? e.message : "Order failed";
      if (/insufficient fee payer balance|fee.?juice/i.test(msg)) {
        void feeJuiceQ.refetch();
        pushToast({ kind: "warn", text: "Out of fuel — this wallet's fee-juice ran low. Tap Refuel below, then resubmit." });
      } else {
        pushToast({ kind: "warn", text: msg });
      }
    },
  });

  // ── Claim fill mutation ────────────────────────────────────────────────────
  const claimFillMut = useMutation({
    mutationFn: async (input: { nonce: bigint; epoch?: number }) => {
      // Sub-4 browser claim: the SDK fetches the hop-fill proof from the aggregator
      // (/api/proof) and submits the 7-arg claim_fill. epoch is auto-discovered.
      return await client.orders.claimFill({
        nonce: input.nonce,
        epoch: input.epoch,
        aggregatorUrl: "/api",
        filterDecoys: true,
      });
    },
    onSuccess: (res, vars) => {
      // Drop the claimed order from the journal so it stops showing as claimable.
      if (!res.skipped) removeOrder(client.address.toString(), `0x${vars.nonce.toString(16)}`);
      void qc.invalidateQueries({ queryKey: ["orders", session?.sessionId] });
      void qc.invalidateQueries({ queryKey: ["order-status", session?.sessionId] });
      pushToast({
        kind: res.skipped ? "warn" : "ok",
        text: res.skipped
          ? `Skipped claim: ${res.reason ?? "decoy"}`
          : `Fill claimed (nonce 0x${vars.nonce.toString(16).slice(0, 8)}…)`,
      });
    },
    onError: (e) => pushToast({ kind: "warn", text: e instanceof Error ? e.message : "Claim failed" }),
  });

  // ── Cancel mutation ────────────────────────────────────────────────────────
  const cancelMut = useMutation({
    mutationFn: async (input: { nonce: bigint }) => {
      return await client.orders.cancelOrder({ nonce: input.nonce });
    },
    onSuccess: (_, vars) => {
      void qc.invalidateQueries({ queryKey: ["orders", session?.sessionId] });
      pushToast({ kind: "ok", text: `Order cancelled (nonce 0x${vars.nonce.toString(16).slice(0, 8)}…)` });
    },
    onError: (e) => pushToast({ kind: "warn", text: e instanceof Error ? e.message : "Cancel failed" }),
  });

  // ── Two-phase escrow funding (ERC20 wrap pattern) ───────────────────────────
  // Orders escrow from PRIVATE balance; the faucet funds PUBLIC. Shielding is a
  // slow proof, so we keep it OUT of the order tx (which must fit the orderbook
  // epoch window — a slow shield+order in one flow can exceed it and revert at
  // _assert_epoch_open). Instead: check private balance, shield up-front if short
  // (separate tx), then the order tx escrows from settled notes and stays fast.
  const orderInput = useMemo(() => {
    const amt = parseFloat(amount.replace(/,/g, ""));
    if (!amount || !(amt > 0)) return null;
    const amountBig = parseAmount(amount, inputDecimals(pair, side));
    const limitBig = parseAmount(limit, 6);
    if (amountBig <= 0n || limitBig <= 0n) return null;
    return { side, amount: amountBig, limitPrice: limitBig, path: pairToPath(pair), decoys };
  }, [amount, limit, pair, side, decoys]);

  const escrowStatusQ = useQuery({
    queryKey: ["escrow-status", session?.sessionId, side, pair, decoys, orderInput?.amount.toString()],
    queryFn: () =>
      client.orders.privateBalanceStatus(
        { side: orderInput!.side, amount: orderInput!.amount, limitPrice: orderInput!.limitPrice, path: orderInput!.path },
        orderInput!.decoys,
      ),
    enabled: !!client && !!orderInput,
    staleTime: 8_000,
  });
  const needsShield = !!escrowStatusQ.data && !escrowStatusQ.data.sufficient;

  const fundMut = useMutation({
    mutationFn: async () => {
      if (!orderInput) throw new Error("Enter an amount first");
      return await client.orders.fundPrivateForOrder(
        { side: orderInput.side, amount: orderInput.amount, limitPrice: orderInput.limitPrice, path: orderInput.path },
        orderInput.decoys,
      );
    },
    onSuccess: () => {
      void escrowStatusQ.refetch();
      pushToast({ kind: "ok", text: "Funds shielded to private — you can submit now." });
    },
    onError: (e) => pushToast({ kind: "warn", text: e instanceof Error ? e.message : "Shield failed" }),
  });

  // ── Form submit ────────────────────────────────────────────────────────────
  function handleSubmit() {
    const amountBigInt = parseAmount(amount, inputDecimals(pair, side));
    const limitBigInt = parseAmount(limit, 6);
    const path = pairToPath(pair);
    placeOrderMut.mutate({
      side,
      amount: amountBigInt,
      limitPrice: limitBigInt,
      path,
      decoys,
      pair,
      amountDisplay: amount,
      amountToken,
      limitDisplay: limit,
    });
  }

  // ── Row action handlers ────────────────────────────────────────────────────
  function handleClaim(o: { nonce?: string | number; amount: string | number; amountToken: string }) {
    const nonceStr = String(o.nonce ?? "0x0");
    // For a filled order, .epoch is the fill epoch (from /proof); pass it as a hint —
    // claimFill auto-discovers it from the aggregator snapshot if omitted.
    const orderData = orders.find(x => x.nonce === nonceStr);
    claimFillMut.mutate({ nonce: BigInt(nonceStr), epoch: orderData?.epoch });
  }
  function handleCancel(o: { nonce?: string | number }) {
    cancelMut.mutate({ nonce: BigInt(String(o.nonce ?? "0x0")) });
  }

  function applySuggested() {
    if (advisory.suggested) setAmount(advisory.suggested);
  }

  // ── Display counts ─────────────────────────────────────────────────────────
  const openCount = orders.filter(o => o.status === "open").length;
  const decoyCount = orders.filter(o => o.status === "decoy").length;
  const filledCount = orders.filter(o => o.status === "filled").length;
  const isMobile = useIsMobile();

  return (
    <div style={{
      display: "grid",
      // Phone: order form first, then the orders/fills column beneath it.
      gridTemplateColumns: isMobile ? "minmax(0, 1fr)" : "minmax(0, 460px) minmax(0, 1fr)",
      gap: isMobile ? 16 : 24, padding: isMobile ? 14 : 24,
      height: "100%", overflow: "auto",
    }} className="q-scroll">

      {/* ===== LEFT: ORDER FORM ===== */}
      <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>

        <div className="q-card">
          <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 16 }}>
            <h3 style={{ fontFamily: "var(--font-display)", fontSize: 28, fontWeight: 300, letterSpacing: "-0.03em", color: "var(--fg)" }}>
              Place <em style={{ fontFamily: "var(--font-serif)", fontStyle: "italic", fontWeight: 400 }}>private</em> order
            </h3>
            <Badge tone="private" shimmer>
              <Dot kind="private" size={6} /> sealed
            </Badge>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>

            {/* Pair */}
            <div>
              <Eyebrow style={{ marginBottom: 6 }}>Pair</Eyebrow>
              <PairSelector value={pair} options={TRADE_PAIRS} onChange={setPair} />
            </div>

            {/* Side toggle */}
            <div>
              <Eyebrow style={{ marginBottom: 6 }}>Side</Eyebrow>
              <Segmented
                value={side}
                onChange={(v) => setSide(v as "buy" | "sell")}
                fullWidth
                size="lg"
                options={[
                  { id: "buy",  label: "Buy",  activeBg: "#0d9876", activeFg: "#FFFFFF" },
                  { id: "sell", label: "Sell", activeBg: "var(--aztec-vermillion)", activeFg: "var(--aztec-parchment)" },
                ]}
              />
              <div style={{ fontFamily: "var(--font-body)", fontSize: 11, color: "var(--fg-muted)", marginTop: 6, lineHeight: 1.4 }}>
                <Tooltip body="Buy = pay the canonical-low token (USDC) and receive the canonical-high token (ETH). The SDK auto-flips the path internally — you only think in plain buy/sell.">
                  <i data-lucide="info" style={{ width: 11, height: 11, color: "var(--fg-muted)", strokeWidth: 1.5, marginRight: 4 } as CSSProperties}></i>
                </Tooltip>
                Path is auto-canonicalized.
              </div>
            </div>

            {/* Amount + token */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 100px", gap: 8 }}>
              <Field label="Amount" mono value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" />
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <Eyebrow>Token</Eyebrow>
                <select value={amountToken} onChange={(e: ChangeEvent<HTMLSelectElement>) => setAmountToken(e.target.value)} style={{
                  height: 48, padding: "0 12px", borderRadius: 6,
                  border: "1px solid var(--hairline-strong)", background: "var(--surface)",
                  fontFamily: "var(--font-mono)", fontSize: 14, color: "var(--fg)",
                  appearance: "none", cursor: "pointer",
                }}>
                  <option>ETH</option>
                  <option>USDC</option>
                </select>
              </div>
            </div>

            {/* Round-amount advisory */}
            <RoundAmountAdvisory
              classification={advisory.classification}
              suggested={advisory.suggested}
              acknowledged={ack}
              onAck={setAck}
              onApply={applySuggested}
            />

            {/* Limit price */}
            <Field
              label="Limit price"
              mono
              value={limit}
              onChange={(e) => setLimit(e.target.value)}
              suffix="USDC"
              hint="Pool √p ≈ 3,217.84 USDC · ±5%"
            />

            {/* Privacy panel */}
            <div style={{
              background: "var(--bg-alt)",
              border: "1px dashed var(--hairline-strong)",
              borderRadius: 8,
              padding: 16,
              display: "flex", flexDirection: "column", gap: 12,
            }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <i data-lucide="shield" style={{ width: 14, height: 14, color: "var(--priv)", strokeWidth: 1.5 } as CSSProperties}></i>
                <Eyebrow>Privacy</Eyebrow>
              </div>
              <DecoyVisualizer count={decoys} max={4} onChange={setDecoys} />
            </div>

            {/* Submit — two-phase: shield to private first (if short), then place the order */}
            <PillButton
              variant="primary"
              size="lg"
              fullWidth
              disabled={!canSubmit || placeOrderMut.isPending || fundMut.isPending || escrowStatusQ.isFetching}
              onClick={needsShield ? () => fundMut.mutate() : handleSubmit}
              rightIcon={(placeOrderMut.isPending || fundMut.isPending) ? undefined : "arrow-right"}
            >
              {fundMut.isPending
                ? "Shielding to private…"
                : placeOrderMut.isPending
                  ? "Sealing & submitting…"
                  : escrowStatusQ.isFetching
                    ? "Checking private balance…"
                    : needsShield
                      ? `Shield ${escrowStatusQ.data ? formatAmount(escrowStatusQ.data.shortfall, inputDecimals(pair, side)) : ""} ${amountToken} → private`
                      : `Submit ${side === "buy" ? "buy" : "sell"} · 1 real + ${decoys} decoy${decoys === 1 ? "" : "s"}`}
            </PillButton>
            {needsShield && !fundMut.isPending && (
              <div style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--fg-muted)", marginTop: 8, textAlign: "center" }}>
                One-time wrap to private (separate tx) so the order escrows from settled funds — keeps it inside the epoch window.
              </div>
            )}

            <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center" }}>
              <div style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--fg-muted)" }}>
                Fee-juice:{" "}
                <span style={{ color: lowFuel ? "var(--aztec-vermillion)" : "var(--fg)" }} title="On-chain L2 fee-juice balance of the connected wallet">
                  {feeJuiceQ.isLoading ? "…" : formatFeeJuice(feeJuiceQ.data)}
                </span>
                {ordersLeft != null && (
                  <span style={{ color: "var(--fg-muted)" }}> · ≈{ordersLeft} order{ordersLeft === 1 ? "" : "s"}</span>
                )}
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <button
                  type="button"
                  onClick={doRefuel}
                  disabled={refuelMut.isPending}
                  title="Top up this wallet's fee-juice via the faucet"
                  style={{
                    background: "none", border: "none", padding: 0, cursor: refuelMut.isPending ? "default" : "pointer",
                    fontFamily: "var(--font-mono)", fontSize: 10,
                    color: refuelMut.isPending ? "var(--fg-muted)" : "var(--priv)",
                    textDecoration: refuelMut.isPending ? "none" : "underline",
                  }}
                >
                  {refuelMut.isPending ? refuelLabel : "↻ refuel"}
                </button>
                <div style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--fg-muted)" }}>
                  Wallet: <span style={{ color: "var(--fg)" }}>{client.address.toString().slice(0, 8)}…</span>
                </div>
              </div>
            </div>

            {/* Low-fuel warning + one-tap refuel */}
            {lowFuel && (
              <div style={{
                background: "rgba(255,77,46,0.06)",
                border: "1px solid rgba(255,77,46,0.35)",
                borderRadius: 8,
                padding: "12px 14px",
                display: "flex", alignItems: "center", gap: 12,
              }}>
                <i data-lucide="fuel" style={{ width: 16, height: 16, color: "var(--aztec-vermillion)", strokeWidth: 1.5 } as CSSProperties}></i>
                <div style={{ flex: 1, fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--fg-muted)", lineHeight: 1.4 }}>
                  Low fuel — an order costs ~3.4 FJ. Top up to keep trading.
                </div>
                <PillButton variant="ink" size="sm" disabled={refuelMut.isPending} onClick={doRefuel}>
                  {refuelLabel}
                </PillButton>
              </div>
            )}
          </div>
        </div>

      </div>

      {/* ===== RIGHT: ORDERS + FILLS ===== */}
      <div style={{ display: "flex", flexDirection: "column", gap: 20, minWidth: 0 }}>

        {/* Epoch + summary strip */}
        <div className="q-card-deep q-card" style={{
          padding: isMobile ? 16 : 20, display: "grid",
          // Countdown spans the full width, then Open/Decoys/Filled sit in a
          // three-up row underneath — the vertical rule only reads in a row.
          gridTemplateColumns: isMobile ? "repeat(3, minmax(0, 1fr))" : "minmax(0, 320px) 1px 1fr 1fr 1fr",
          gap: isMobile ? 14 : 24, alignItems: "center",
        }}>
          <div style={{ gridColumn: isMobile ? "1 / -1" : undefined }}>
            <EpochCountdown epoch={41828} secondsLeft={secondsLeft} epochLength={600} />
          </div>
          {!isMobile && <div style={{ width: 1, height: 56, background: "rgba(242,238,225,0.12)" }} />}
          <div>
            <div style={{ fontFamily: "var(--font-mono)", fontSize: 10, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--fg-on-deep-mu)" }}>Open</div>
            <div data-mono style={{ fontFamily: "var(--font-mono)", fontSize: 22, color: "var(--fg-on-deep)", marginTop: 4, fontWeight: 500 }}>{openCount}</div>
          </div>
          <div>
            <div style={{ fontFamily: "var(--font-mono)", fontSize: 10, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--fg-on-deep-mu)" }}>Decoys</div>
            <div data-mono style={{ fontFamily: "var(--font-mono)", fontSize: 22, color: "var(--q-decoy)", marginTop: 4, fontWeight: 500 }}>{decoyCount}</div>
          </div>
          <div>
            <div style={{ fontFamily: "var(--font-mono)", fontSize: 10, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--fg-on-deep-mu)" }}>Claimable</div>
            <div data-mono style={{ fontFamily: "var(--font-mono)", fontSize: 22, color: "var(--aztec-chartreuse)", marginTop: 4, fontWeight: 500 }}>{filledCount}</div>
          </div>
        </div>

        {/* Open orders */}
        <div className="q-card" style={{ padding: 0, overflow: "hidden" }}>
          <div style={{
            display: "flex", alignItems: isMobile ? "stretch" : "center",
            flexDirection: isMobile ? "column" : "row",
            justifyContent: "space-between", gap: isMobile ? 10 : 0,
            padding: isMobile ? "14px 16px" : "18px 20px",
          }}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
              <h4 style={{ fontFamily: "var(--font-serif)", fontWeight: 400, fontSize: 18, color: "var(--fg)" }}>Open orders</h4>
              <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--fg-muted)" }}>
                auto-refresh every 10s
              </span>
            </div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <PillButton size="sm" variant="ghost" leftIcon="x-circle">Cancel decoys ({decoyCount})</PillButton>
              <PillButton size="sm" variant="quiet" leftIcon="refresh-cw">Refresh</PillButton>
            </div>
          </div>
          <Hairline />
          {/* The seven tracks below stay fixed and the table scrolls sideways
              on a phone — collapsing them would break row/header alignment. */}
          <div className={isMobile ? "q-table-scroll" : undefined} style={{ ["--q-table-min" as string]: "560px" } as CSSProperties}>
          <div>
          {/* Column header */}
          <div style={{
            display: "grid",
            gridTemplateColumns: "16px 80px 60px 1fr 1fr 100px 120px",
            gap: 12, alignItems: "center",
            padding: "8px 16px",
            background: "var(--bg-alt)",
          }}>
            <span></span>
            <span className="q-eyebrow">Nonce</span>
            <span className="q-eyebrow">Side</span>
            <span className="q-eyebrow">Amount</span>
            <span className="q-eyebrow">Limit</span>
            <span className="q-eyebrow">Status</span>
            <span className="q-eyebrow" style={{ textAlign: "right" }}>Actions</span>
          </div>
          {ordersQ.isLoading && (
            <div style={{ padding: 16, fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--fg-muted)", textAlign: "center" }}>
              Loading orders…
            </div>
          )}
          {ordersQ.error && (
            <div style={{ padding: 16, fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--aztec-vermillion)", textAlign: "center" }}>
              Failed to load orders: {ordersQ.error instanceof Error ? ordersQ.error.message : "unknown error"}
            </div>
          )}
          {!ordersQ.isLoading && !ordersQ.error && orders.length === 0 && (
            <div style={{ padding: 60, textAlign: "center", position: "relative", overflow: "hidden" }}>
              <FeatherWatermark size={180} opacity={0.08} style={{ position: "absolute", top: -20, right: -20 }} />
              <div style={{ fontFamily: "var(--font-serif)", fontSize: 16, color: "var(--fg-muted)" }}>No open orders.</div>
              <div style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--fg-subtle)", marginTop: 6 }}>Submit your first order to see it here.</div>
            </div>
          )}
          {orders.length > 0 && orders.slice(0, 8).map(o => (
            <OrderRow key={o.nonce} order={o} onClaim={handleClaim} onCancel={handleCancel} />
          ))}
          </div>
          </div>
        </div>

        {/* Recent fills */}
        <div className="q-card" style={{ padding: 0, overflow: "hidden" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "18px 20px" }}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 12 }}>
              <h4 style={{ fontFamily: "var(--font-serif)", fontWeight: 400, fontSize: 18, color: "var(--fg)" }}>Recent fills</h4>
              <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--fg-muted)" }}>last 5 epochs</span>
            </div>
            <a href="#" onClick={(e) => e.preventDefault()} style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--fg-muted)", textDecoration: "underline" }}>View full history →</a>
          </div>
          <Hairline />
          {/* recentFills: client-side filter of orders with status==="filled" (last 20).
              SDK has no separate history.getRecentFills; deferred to Sub-7 history API.
              Resting orders returned by getOrders() are all "open"; filled orders are
              removed from the note tree after claim, so this will show entries only if
              the local optimistic state is ever updated with "filled" status. */}
          {recentFills.length === 0 ? (
            <div style={{ padding: 32, textAlign: "center" }}>
              <div style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--fg-muted)" }}>No recent fills.</div>
            </div>
          ) : (
            recentFills.map((f, i) => <FillRow key={i} fill={f} />)
          )}
        </div>
      </div>
    </div>
  );
}
