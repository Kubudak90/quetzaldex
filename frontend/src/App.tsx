// Quetzal — App shell: TopBar + SideNav + route state machine + Toast manager.
// Default theme is parchment (no class needed; .theme-dark would flip to malachite).

import { useState, useEffect, useRef } from "react";
import type { CSSProperties } from "react";
import {
  Dot, AddressMono, QuetzalLogo, Toast, StepDivider,
  Eyebrow, PillButton, FeatherWatermark,
} from "./components/atoms.js";
import { LandingScreen, SetupScreen } from "./screens/landing.js";
import { TradeScreen } from "./screens/trade.js";
import { BridgeScreen } from "./screens/bridge.js";
import {
  WalletScreen, HistoryScreen, SettingsScreen,
} from "./screens/wallet-history-settings.js";
import { useClientContext } from "./sdk/client-context.js";
import { L1ConnectButton } from "./l1/connect-button.js";
import { useIsMobile } from "./hooks/use-media-query.js";
import { DOCS_URL, GITHUB_URL, TWITTER_URL, AZTEC_VERSION, SDK_VERSION } from "./constants.js";

const VALID_ROUTES = ["landing", "setup", "trade", "bridge", "wallet", "history", "settings"] as const;
type Route = (typeof VALID_ROUTES)[number];

function routeFromHash(): Route {
  const h = (window.location.hash || "").replace(/^#\/?/, "");
  return (VALID_ROUTES as readonly string[]).includes(h) ? (h as Route) : "landing";
}

interface ToastIn { kind: string; text: string }
interface ToastState {
  kind: string;
  text: string;
  // The atoms `Toast` component supports both shapes; we expose `title` so it shows.
  title: string;
  tone: "success" | "info" | "error";
}

function toToastState(t: ToastIn): ToastState {
  const tone: "success" | "info" | "error" =
    t.kind === "success" ? "success" :
    t.kind === "error"   ? "error"   :
    "info";
  return { kind: t.kind, text: t.text, title: t.text, tone };
}

const PROTECTED_ROUTES = ["trade", "bridge", "wallet", "history", "settings"] as const;

export default function App() {
  const [route, _setRoute] = useState<Route>(routeFromHash());
  const setRoute = (r: Route) => {
    _setRoute(r);
    if (r === "landing") history.replaceState(null, "", " ");
    else history.replaceState(null, "", "#" + r);
  };
  useEffect(() => {
    const h = () => _setRoute(routeFromHash());
    window.addEventListener("hashchange", h);
    return () => window.removeEventListener("hashchange", h);
  }, []);

  // Protected-route guard: redirect to setup if not connected
  const { session } = useClientContext();
  useEffect(() => {
    if (!session && (PROTECTED_ROUTES as readonly string[]).includes(route)) {
      setRoute("setup");
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [route, session]);

  const [toast, setToast] = useState<ToastState | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(247);

  // pretty toast manager
  function pushToast(t: ToastIn) {
    setToast(toToastState(t));
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 4000);
  }

  // tick clock when on trade
  useEffect(() => {
    if (route !== "trade") return;
    const id = setInterval(() => {
      setSecondsLeft(s => s <= 1 ? 600 : s - 1);
    }, 1000);
    return () => clearInterval(id);
  }, [route]);

  // re-render lucide icons whenever route or DOM changes
  useEffect(() => {
    if (window.lucide) window.lucide.createIcons();
  });

  // Sub-6c frontend: theme switcher (parchment <-> dark/malachite)
  const [theme, setTheme] = useState<"parchment" | "dark">(() => {
    if (typeof window === "undefined") return "parchment";
    const saved = window.localStorage.getItem("quetzal-theme");
    return saved === "dark" ? "dark" : "parchment";
  });
  const toggleTheme = () => {
    setTheme((t) => {
      const next = t === "dark" ? "parchment" : "dark";
      window.localStorage.setItem("quetzal-theme", next);
      return next;
    });
  };

  // Default theme = parchment (no class). Persona + motifs are CSS hooks.
  const rootClasses = `${theme === "dark" ? "theme-dark" : ""} persona-renaissance motifs-subtle`.trim();
  useEffect(() => {
    document.body.className = rootClasses;
  }, [rootClasses]);

  // Onboarding tour state
  const [tourStep, setTourStep] = useState<number>(-1); // -1 = not active
  // First-visit-to-trade trigger
  useEffect(() => {
    if (route === "trade" && session && tourStep === -1) {
      const seen = localStorage.getItem("quetzal-tour-seen");
      if (seen !== "1") setTourStep(0);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [route, session]);

  const tourSteps: TourStep[] = [
    { title: "Wallet pool", body: "Quetzal uses N HD-derived child wallets in round-robin. Manage them at /wallet.", target: "nav-wallet" },
    { title: "Decoys", body: "Decoys submit unfillable orders alongside yours so observers can't pick out which is real. Pick 0–4.", target: "decoy-area" },
    { title: "Round-amount advisory", body: "Round numbers (1 USDC, 100 ETH) are easy to fingerprint. The form warns inline and suggests a perturbed amount.", target: "advisory-area" },
    { title: "Round-trip warning", body: "On Bridge → Exit, if your withdrawal matches a recent deposit, you'll be warned that the two could be linked.", target: "nav-bridge" },
    { title: "Epoch clearing", body: "Orders are matched in 10-minute batches. Your order lands at the next epoch close at a single uniform price.", target: "epoch-card" },
  ];

  const handleTourSkip = () => {
    setTourStep(-1);
    localStorage.setItem("quetzal-tour-seen", "1");
  };

  const isMobile = useIsMobile();
  const chromeVisible = route !== "landing" && route !== "setup";
  const showTabBar = chromeVisible && isMobile;

  return (
    <div className={`${rootClasses} q-app-shell`.trim()} style={{
      display: "flex", flexDirection: "column",
      background: "var(--bg)", color: "var(--fg)",
    }}>
      <TopBar route={route} setRoute={setRoute} secondsLeft={secondsLeft} theme={theme} onToggleTheme={toggleTheme} isMobile={isMobile} />

      <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
        {chromeVisible && !isMobile && (
          <SideNav route={route} setRoute={setRoute} />
        )}
        <main style={{
          flex: 1, minWidth: 0, position: "relative",
          // The tab bar is fixed, so reserve its height (plus the home-bar
          // inset) or the last row of every screen sits underneath it.
          paddingBottom: showTabBar ? "calc(56px + env(safe-area-inset-bottom, 0px))" : undefined,
        }}>
          {route === "landing" && <LandingScreen onStart={() => setRoute("setup")} />}
          {route === "setup"   && <SetupScreen onComplete={() => setRoute("trade")} />}
          {route === "trade"   && <TradeScreen pushToast={pushToast} secondsLeft={secondsLeft} />}
          {route === "bridge"  && <BridgeScreen pushToast={pushToast} />}
          {route === "wallet"  && <WalletScreen pushToast={pushToast} />}
          {route === "history" && <HistoryScreen />}
          {route === "settings"&& <SettingsScreen />}
        </main>
      </div>

      {showTabBar && <TabBar route={route} setRoute={setRoute} />}

      <Toast toast={toast} />

      {/* Onboarding tour: 5 steps fired on first /trade visit */}
      {tourStep >= 0 && tourStep < tourSteps.length && (
        <TourOverlay
          step={tourSteps[tourStep]}
          index={tourStep}
          total={tourSteps.length}
          onNext={() => setTourStep((s) => s + 1)}
          onSkip={handleTourSkip}
        />
      )}
    </div>
  );
}

/* ============ ONBOARDING TOUR ============ */
interface TourStep {
  title: string;
  body: string;
  target: string;
}

function TourOverlay({
  step, index, total, onNext, onSkip,
}: {
  step: TourStep;
  index: number;
  total: number;
  onNext: () => void;
  onSkip: () => void;
}) {
  return (
    <div style={{
      position: "fixed", inset: 0, zIndex: 200,
      background: "rgba(26, 20, 0, 0.55)",
      backdropFilter: "blur(2px)",
      display: "flex", alignItems: "center", justifyContent: "center",
      // Keep the card off the screen edges on a phone.
      padding: 16,
    }}>
      <div className="q-card" style={{
        maxWidth: 480, width: "100%", padding: "clamp(20px, 5vw, 32px)", position: "relative",
        background: "var(--surface-card)",
        // The watermark is pinned past the corner; clip it to the card.
        overflow: "hidden",
      }}>
        <FeatherWatermark size={180} opacity={0.06} style={{ position: "absolute", top: -20, right: -20 }} />
        <div style={{ position: "relative" }}>
          <Eyebrow>Tour · {index + 1} / {total}</Eyebrow>
          <h3 style={{ fontFamily: "var(--font-display)", fontSize: 32, fontWeight: 300, letterSpacing: "-0.03em", marginTop: 8 }}>
            {step.title}
          </h3>
          <p style={{ fontFamily: "var(--font-body)", fontSize: 14, color: "var(--fg-muted)", marginTop: 12, lineHeight: 1.55 }}>
            {step.body}
          </p>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 24, gap: 8 }}>
            <button onClick={onSkip} style={{ background: "transparent", border: "none", fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--fg-muted)", cursor: "pointer", textDecoration: "underline" }}>Skip tour</button>
            <PillButton variant="primary" onClick={index === total - 1 ? onSkip : onNext} rightIcon={index === total - 1 ? "check" : "arrow-right"}>
              {index === total - 1 ? "Done" : "Next"}
            </PillButton>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ============ TOP BAR ============ */
interface TopBarProps {
  route: Route;
  setRoute: (r: Route) => void;
  secondsLeft: number;
  theme: "parchment" | "dark";
  onToggleTheme: () => void;
  isMobile: boolean;
}
function TopBar({ route, setRoute, secondsLeft, theme, onToggleTheme, isMobile }: TopBarProps) {
  const showEpoch = route !== "landing" && route !== "setup";
  return (
    <header style={{
      display: "flex", alignItems: "center", justifyContent: "space-between",
      gap: isMobile ? 10 : 24, padding: isMobile ? "10px 14px" : "14px 24px",
      background: "var(--bg)",
      borderBottom: "1px solid var(--hairline)",
      flexShrink: 0,
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: isMobile ? 10 : 24, minWidth: 0 }}>
        <button onClick={() => setRoute("landing")} style={{ background: "transparent", border: "none", padding: 0, cursor: "pointer", flexShrink: 0 }}>
          <QuetzalLogo size={22} />
        </button>
        {/* The network chip is context, not control — it loses to the epoch
            timer and the wallet chip for the little width a phone has. */}
        {showEpoch && !isMobile && (
          <div style={{
            display: "inline-flex", alignItems: "center", gap: 8,
            padding: "5px 10px", border: "1px solid var(--hairline)",
            borderRadius: 999,
          }}>
            <span className="pulse-dot" style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--aztec-chartreuse)" }}></span>
            <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--fg-muted)" }}>alpha-testnet · seq 4</span>
          </div>
        )}
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: isMobile ? 8 : 12, minWidth: 0 }}>
        {showEpoch && (
          <div style={{
            display: "inline-flex", alignItems: "center", gap: isMobile ? 6 : 10,
            padding: isMobile ? "5px 9px" : "6px 12px", background: "var(--bg-alt)", borderRadius: 999,
            flexShrink: 0,
          }}>
            {/* Phone keeps the countdown (it's the actionable half) and drops
                the epoch number, which is already on the trade screen. */}
            {!isMobile && (
              <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--fg-muted)" }}>Epoch 41828</span>
            )}
            <span data-mono style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--fg)", fontWeight: 500 }}>
              {String(Math.floor(secondsLeft / 60)).padStart(2, "0")}:{String(secondsLeft % 60).padStart(2, "0")}
            </span>
          </div>
        )}
        {route !== "landing" && route !== "setup" && (
          <button
            onClick={onToggleTheme}
            title={theme === "dark" ? "Switch to Parchment" : "Switch to Malachite"}
            aria-label="Toggle theme"
            style={{
              display: "inline-flex", alignItems: "center", justifyContent: "center",
              width: 32, height: 32, border: "1px solid var(--hairline-strong)",
              borderRadius: 999, background: "transparent",
              color: "var(--fg)", cursor: "pointer",
              transition: "all 120ms var(--ease-out)",
            }}
          >
            <i data-lucide={theme === "dark" ? "sun" : "moon"} style={{ width: 14, height: 14, strokeWidth: 1.5 } as CSSProperties}></i>
          </button>
        )}
        {showEpoch && !isMobile && <L1ConnectButton />}
        {route !== "landing" && route !== "setup" && (
          <div style={{
            display: "inline-flex", alignItems: "center", gap: isMobile ? 6 : 8,
            padding: isMobile ? "5px 8px" : "5px 10px 5px 14px",
            border: "1px solid var(--hairline-strong)",
            borderRadius: 999, minWidth: 0, flexShrink: 1,
          }}>
            <Dot kind="private" size={6} />
            <AddressMono value="0x7c5fA12e8B3D4f9aC1e29bd071E4a7e123a456b8" copy={false} style={{ fontSize: 11 }} />
            {/* The child-index label is redundant next to the address on a
                phone; L1 connect moves to Settings/Bridge where it's used. */}
            {!isMobile && (
              <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--fg-muted)" }}>· child-0</span>
            )}
            <i data-lucide="chevron-down" style={{ width: 12, height: 12, color: "var(--fg-muted)", strokeWidth: 1.5, marginLeft: 2 } as CSSProperties}></i>
          </div>
        )}
      </div>
    </header>
  );
}

/* ============ NAV ============ */
const NAV_ITEMS: { id: Route; label: string; icon: string }[] = [
  { id: "trade",    label: "Trade",     icon: "candlestick-chart" },
  { id: "bridge",   label: "Bridge",    icon: "git-branch" },
  { id: "wallet",   label: "Wallet",    icon: "layers" },
  { id: "history",  label: "History",   icon: "history" },
  { id: "settings", label: "Settings",  icon: "sliders-horizontal" },
];

/* Phone: the side nav becomes a bottom tab bar (thumb-reachable, and it
   gives the 200px back to the content, which the trade form needs). */
function TabBar({ route, setRoute }: { route: Route; setRoute: (r: Route) => void }) {
  return (
    <nav className="q-tabbar" aria-label="Primary">
      {NAV_ITEMS.map(it => {
        const active = route === it.id;
        return (
          <button
            key={it.id}
            onClick={() => setRoute(it.id)}
            data-active={active}
            aria-current={active ? "page" : undefined}
          >
            <i data-lucide={it.icon} style={{ width: 18, height: 18, strokeWidth: 1.5 } as CSSProperties}></i>
            {it.label}
          </button>
        );
      })}
    </nav>
  );
}

interface SideNavProps {
  route: Route;
  setRoute: (r: Route) => void;
}
function SideNav({ route, setRoute }: SideNavProps) {
  const items = NAV_ITEMS;
  return (
    <nav style={{
      width: 200, flexShrink: 0,
      background: "var(--bg)",
      borderRight: "1px solid var(--hairline)",
      padding: "20px 12px",
      display: "flex", flexDirection: "column", gap: 4,
    }}>
      {items.map(it => {
        const active = route === it.id;
        return (
          <button key={it.id} onClick={() => setRoute(it.id)} style={{
            display: "flex", alignItems: "center", gap: 10,
            padding: "10px 14px", borderRadius: 8,
            background: active ? "var(--aztec-ink)" : "transparent",
            color: active ? "var(--aztec-parchment)" : "var(--fg)",
            border: "none", cursor: "pointer", textAlign: "left",
            fontFamily: "var(--font-mono)", fontSize: 13, fontWeight: 500,
            transition: "all 120ms var(--ease-out)",
          }}>
            <i data-lucide={it.icon} style={{ width: 16, height: 16, strokeWidth: 1.5 } as CSSProperties}></i>
            {it.label}
          </button>
        );
      })}

      <div style={{ flex: 1 }} />

      {/* Sidebar footer — small Quetzal motif */}
      <div style={{ padding: "14px 12px 4px", display: "flex", flexDirection: "column", gap: 8 }}>
        <StepDivider />
        <div style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--fg-subtle)", letterSpacing: "0.04em", lineHeight: 1.5 }}>
          Quetzal · alpha-testnet<br/>
          Aztec {AZTEC_VERSION} · SDK {SDK_VERSION}<br/>
          <a href={DOCS_URL} target="_blank" rel="noopener noreferrer" style={{ color: "var(--fg-muted)" }}>Docs ↗</a>
          &nbsp;·&nbsp;
          <a href={GITHUB_URL} target="_blank" rel="noopener noreferrer" style={{ color: "var(--fg-muted)" }}>GitHub ↗</a>
          &nbsp;·&nbsp;
          <a href={TWITTER_URL} target="_blank" rel="noopener noreferrer" style={{ color: "var(--fg-muted)" }}>X ↗</a>
        </div>
      </div>
    </nav>
  );
}
