// Quetzal — Landing + First-launch setup

import { useState, useEffect, Fragment, useCallback } from "react";
import type { CSSProperties, ReactNode } from "react";
import {
  Eyebrow, Hairline, PillButton, Segmented,
  FeatherGlyph, FeatherWatermark,
} from "../components/atoms.js";
import { useClientContext } from "../sdk/client-context.js";
import { useIsMobile } from "../hooks/use-media-query.js";
import type { NetworkName } from "@quetzal/sdk";
import { WizardStep3 } from "../onboarding/wizard-step3.js";
import { hasSession, loadSession, clearSession } from "../onboarding/persistence.js";
import { isValidMasterSecret } from "../onboarding/master-secret.js";

import { GITHUB_URL, LITEPAPER_URL, DOCS_URL, FAUCET_URL, AZTEC_VERSION } from "../constants.js";
// Same-origin Vercel proxy base: /api/health + /api/reveal → the VPS aggregator
// server-side (see api/health.mjs + api/reveal.mjs). Hardcoded (NOT the
// VITE_AGGREGATOR_URL env) because that env is set in prod to the raw
// http://<vps>:3001 origin, which an HTTPS page can't reach (mixed-content) and
// the aggregator has no public HTTPS endpoint. The proxy is the canonical path.
const AGGREGATOR_URL = "/api";

/** Probes faucet + aggregator /health concurrently; returns 'live' | 'degraded' | 'down' | 'checking' */
function useLiveStatus(): "live" | "degraded" | "down" | "checking" {
  const [status, setStatus] = useState<"live" | "degraded" | "down" | "checking">("checking");
  useEffect(() => {
    let cancelled = false;
    async function probe() {
      const probes = await Promise.allSettled([
        // Both probed via same-origin proxies (faucet /api/health has no CORS;
        // the aggregator has no public HTTPS). See api/faucet-health + api/aggregator.
        fetch(`/api/faucet-health`, { method: "GET" }).then((r) => r.ok),
        fetch(`${AGGREGATOR_URL}/health`, { method: "GET" }).then((r) => r.ok),
      ]);
      if (cancelled) return;
      const ok = probes.filter((p) => p.status === "fulfilled" && p.value === true).length;
      setStatus(ok === 2 ? "live" : ok === 1 ? "degraded" : "down");
    }
    void probe();
    const t = setInterval(probe, 60_000);
    return () => { cancelled = true; clearInterval(t); };
  }, []);
  return status;
}

/* ============ LANDING ============ */
export function LandingScreen({ onStart }: { onStart: () => void }) {
  const status = useLiveStatus();
  const statusColor =
    status === "live" ? "var(--aztec-chartreuse)" :
    status === "degraded" ? "var(--q-warn-soft, #d4a24a)" :
    status === "down" ? "var(--aztec-vermillion)" :
    "var(--fg-muted)";
  const statusLabel =
    status === "live" ? "All systems live" :
    status === "degraded" ? "Degraded (some services down)" :
    status === "down" ? "Offline" :
    "Checking…";
  const isMobile = useIsMobile();

  return (
    <div style={{
      height: "100%", overflowY: "auto",
      // The decorative feather is deliberately off-canvas; without this the
      // page swipes sideways into empty space on a touch screen.
      overflowX: "hidden",
      display: "flex",
      // Centring a tall hero on a short viewport clips its top; anchor to the
      // start once the content is taller than the screen.
      alignItems: isMobile ? "flex-start" : "center",
      justifyContent: "center",
      padding: isMobile ? "32px 0 40px" : undefined,
      position: "relative",
    }} className="q-scroll">
      {/* Watermark background — large feather */}
      <div style={{
        position: "absolute", right: isMobile ? -220 : -120, top: "50%", transform: "translateY(-50%)",
        pointerEvents: "none",
      }}>
        {/* The 680px feather is wider than a phone; push it further off-canvas
            so it stays a texture instead of becoming the subject. */}
        <FeatherWatermark size={isMobile ? 420 : 680} opacity={0.05} />
      </div>

      <div style={{
        maxWidth: 1080, padding: isMobile ? "0 20px" : "0 48px",
        position: "relative", zIndex: 1, display: "grid",
        gridTemplateColumns: isMobile ? "minmax(0, 1fr)" : "1.4fr 1fr",
        gap: isMobile ? 36 : 64, alignItems: "center",
      }}>

        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 24, flexWrap: "wrap" }}>
            <FeatherGlyph size={28} />
            <div style={{
              fontFamily: "var(--font-mono)", fontSize: 11, letterSpacing: "0.1em",
              textTransform: "uppercase", color: "var(--fg-muted)",
            }}>Quetzal · alpha-testnet · Aztec {AZTEC_VERSION}</div>
            <div
              title={statusLabel}
              style={{
                display: "inline-flex", alignItems: "center", gap: 6,
                padding: "3px 8px", borderRadius: 999,
                border: "1px solid var(--hairline-strong)",
                fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--fg-muted)",
                letterSpacing: "0.06em",
              }}
            >
              <span style={{
                width: 6, height: 6, borderRadius: "50%", background: statusColor,
                boxShadow: status === "live" ? `0 0 6px ${statusColor}` : "none",
              }} className={status === "live" ? "pulse-dot" : undefined} />
              {statusLabel}
            </div>
          </div>

          <h1 style={{
            // Fluid so the display face keeps its presence on a phone without
            // overflowing: 44px floor, 96px ceiling at desktop widths.
            fontFamily: "var(--font-display)", fontSize: "clamp(44px, 11vw, 96px)", fontWeight: 300,
            letterSpacing: "-0.05em", lineHeight: 0.95, color: "var(--fg)",
            margin: 0,
          }}>
            Trade <em style={{ fontFamily: "var(--font-serif)", fontStyle: "italic", fontWeight: 400 }}>privately.</em>
            <br/>Clear together.
          </h1>

          <p style={{
            fontFamily: "var(--font-body)", fontSize: 18, color: "var(--fg-muted)",
            marginTop: 24, maxWidth: 540, lineHeight: 1.5,
          }}>
            A dark-pool DEX on Aztec. Order side, amount and limit price are sealed on-chain;
            only the per-epoch clearing result is public. No MEV, no order book to front-run.
          </p>

          <div style={{ display: "flex", gap: 12, marginTop: 36, flexWrap: "wrap" }}>
            <PillButton size="lg" variant="primary" onClick={onStart} rightIcon="arrow-right">Set up wallet</PillButton>
            <PillButton
              size="lg" variant="ghost" leftIcon="book-open"
              onClick={() => window.open(DOCS_URL, "_blank", "noopener,noreferrer")}
            >
              Read the docs
            </PillButton>
            <PillButton
              size="lg" variant="ghost" leftIcon="github"
              onClick={() => window.open(GITHUB_URL, "_blank", "noopener,noreferrer")}
            >
              Read the code
            </PillButton>
          </div>
          <div style={{ marginTop: 12, fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--fg-muted)" }}>
            Need fee-juice + test tokens?{" "}
            <a
              href={FAUCET_URL}
              target="_blank" rel="noopener noreferrer"
              style={{ color: "var(--fg-muted)", textDecoration: "underline" }}
            >Faucet ↗</a>
            &nbsp;·&nbsp;
            <a
              href={DOCS_URL}
              target="_blank" rel="noopener noreferrer"
              style={{ color: "var(--fg-muted)", textDecoration: "underline" }}
            >Docs ↗</a>
            &nbsp;·&nbsp;
            <a
              href={GITHUB_URL}
              target="_blank" rel="noopener noreferrer"
              style={{ color: "var(--fg-muted)", textDecoration: "underline" }}
            >GitHub ↗</a>
            &nbsp;·&nbsp;
            <a
              href={LITEPAPER_URL}
              target="_blank" rel="noopener noreferrer"
              style={{ color: "var(--fg-muted)", textDecoration: "underline" }}
            >Litepaper ↗</a>
          </div>

          <div style={{ marginTop: 48, display: "flex", gap: 32 }}>
            <LandingStat n="12 blocks" label="Epoch length on testnet" />
            <LandingStat n="K = 5" label="Max anonymity set per order" />
            <LandingStat n="0" label="MEV bots in the chain" />
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>

          <div className="q-card-deep q-card" style={{ padding: 24 }}>
            <Eyebrow style={{ color: "var(--fg-on-deep-mu)" }}>How clearing works</Eyebrow>
            <ol style={{ margin: "16px 0 0", padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 14 }}>
              {[
                { n: "01", t: "You submit a sealed order. Side, amount and price are encrypted.", icon: "shield" },
                { n: "02", t: "The protocol batches all orders in the current 10-minute epoch.", icon: "layers" },
                { n: "03", t: "At epoch close, a single uniform clearing price is computed.", icon: "git-merge" },
                { n: "04", t: "Fills land in your private balance. Nobody sees who traded what.", icon: "check-circle" },
              ].map(s => (
                <li key={s.n} style={{ display: "grid", gridTemplateColumns: "32px 18px 1fr", gap: 12, alignItems: "flex-start" }}>
                  <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--aztec-chartreuse)", letterSpacing: "0.06em" }}>{s.n}</span>
                  <i data-lucide={s.icon} style={{ width: 14, height: 14, color: "var(--fg-on-deep-mu)", strokeWidth: 1.5, marginTop: 2 } as CSSProperties}></i>
                  <span style={{ fontFamily: "var(--font-body)", fontSize: 13, color: "var(--fg-on-deep)", lineHeight: 1.5 }}>{s.t}</span>
                </li>
              ))}
            </ol>
          </div>

          <div className="q-card" style={{ padding: 20, borderLeft: "3px solid var(--q-warn-soft, #d4a24a)" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <i data-lucide="alert-triangle" style={{ width: 14, height: 14, color: "var(--q-warn-soft)", strokeWidth: 1.5 } as CSSProperties}></i>
              <Eyebrow>Aztec testnet · not real funds</Eyebrow>
            </div>
            <div style={{ marginTop: 8, fontFamily: "var(--font-body)", fontSize: 13, color: "var(--fg-muted)", lineHeight: 1.5 }}>
              Quetzal is in <strong style={{ color: "var(--fg)" }}>alpha</strong> on Aztec testnet (Sepolia L1).
              Tokens are testnet-only and have no value. Audit is in progress;
              AUDIT items T-13/T-15 are surfaced inline throughout the UI.
            </div>
          </div>
        </div>

      </div>
    </div>
  );
}

function LandingStat({ n, label }: { n: string; label: string }) {
  return (
    <div>
      <div style={{ fontFamily: "var(--font-display)", fontSize: 28, fontWeight: 300, letterSpacing: "-0.02em", color: "var(--fg)" }}>{n}</div>
      <div style={{ fontFamily: "var(--font-mono)", fontSize: 10, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--fg-muted)", marginTop: 4 }}>{label}</div>
    </div>
  );
}

/** Generate a fresh 32-byte hex master secret */
function generateMasterSecret(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return "0x" + Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Labeled wrapper for the passphrase inputs (Audit #8). The shared `Field`
 * atom renders its own internal input and takes no children, so we use this
 * small label+hint shell around a custom <input> to keep the password fields
 * matching the wizard's visual style.
 */
function PassphraseField({ label, hint, children }: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <label className="q-eyebrow" style={{ fontSize: 10 }}>{label}</label>
      {children}
      {hint && (
        <div style={{ fontFamily: "var(--font-body)", fontSize: 12, color: "var(--fg-muted)", lineHeight: 1.4 }}>
          {hint}
        </div>
      )}
    </div>
  );
}

/* ============ FIRST-LAUNCH SETUP ============ */
export function SetupScreen({ onComplete }: { onComplete: () => void }) {
  const isMobile = useIsMobile();
  // step: 0=mode, 1=secret, 2=size+net, 3=passphrase, 4=faucet
  const [step, setStep] = useState(0);
  const [mode, setMode] = useState<string | null>(null);
  const [n, setN] = useState(3);
  const [network, setNetwork] = useState<NetworkName>("alpha-testnet");
  // Master secret: generated fresh on mount; user can regenerate or import
  const [generatedSecret, setGeneratedSecret] = useState(() => generateMasterSecret());
  const [importedSecret, setImportedSecret] = useState("");
  // The effective secret: imported takes precedence if non-empty
  const masterSecret = importedSecret.trim() || generatedSecret;
  // M13: block advancing with a malformed imported secret (a typo silently derives
  // a different, empty pool). Empty import is fine — the generated secret is used.
  const importedSecretValid = importedSecret.trim() === "" || isValidMasterSecret(importedSecret);

  // Passphrase that encrypts the persisted session at rest (Audit #8).
  const [passphrase, setPassphrase] = useState("");
  const [passphraseConfirm, setPassphraseConfirm] = useState("");

  // Audit #8 unlock flow: if an encrypted session already exists, we must ask
  // for the passphrase before we can re-derive the pool. `existing` gates the
  // whole screen between "unlock" and "fresh onboarding".
  const [existing] = useState<boolean>(() => {
    try { return hasSession(); } catch { return false; }
  });
  const [unlocking, setUnlocking] = useState(false);
  const [unlockPassphrase, setUnlockPassphrase] = useState("");
  const [unlockError, setUnlockError] = useState<string | null>(null);

  // Local error display for connect failures
  const [localError, setLocalError] = useState<string | null>(null);

  const { connectAztecWallet, connectWalletPool, connecting, lastError } = useClientContext();

  /**
   * Audit #8: returning users unlock their encrypted session with the
   * passphrase, then we connect exactly as the old auto-load path did.
   */
  const handleUnlock = useCallback(async () => {
    setUnlockError(null);
    setUnlocking(true);
    try {
      const session = await loadSession(unlockPassphrase);
      if (!session) {
        setUnlockError("Could not unlock — check your passphrase and try again.");
        return;
      }
      if (session.deployedAddresses.length < session.poolSize) {
        setUnlockError("Saved session is incomplete. Use “Start over” to re-onboard.");
        return;
      }
      await connectWalletPool({
        masterSecret: session.masterSecret,
        n: session.poolSize,
        network: session.network,
      });
      onComplete();
    } catch (e) {
      setUnlockError(e instanceof Error ? e.message : String(e));
    } finally {
      setUnlocking(false);
    }
  }, [unlockPassphrase, connectWalletPool, onComplete]);

  /** Wipe the encrypted session and fall through to fresh onboarding. */
  const handleStartOver = useCallback(() => {
    clearSession();
    setUnlockError(null);
    setUnlockPassphrase("");
    // existing is frozen at mount; reload so the screen re-evaluates hasSession().
    window.location.reload();
  }, []);

  const regenerateSecret = useCallback(() => {
    setGeneratedSecret(generateMasterSecret());
    setImportedSecret("");
  }, []);

  const copySecret = useCallback(() => {
    void navigator.clipboard.writeText(generatedSecret);
  }, [generatedSecret]);

  /** Called from the Aztec Wallet mode button on step 0 */
  const handleConnectAztecWallet = useCallback(async () => {
    setLocalError(null);
    try {
      // Extension discovery (@aztec/wallet-sdk) + the encrypted channel happen
      // inside the adapter. If no wallet announces itself within the discovery
      // window, connect() throws and `lastError` is populated by the context
      // ("No Aztec wallet detected ...").
      await connectAztecWallet({ network });
      onComplete();
    } catch {
      // lastError is already populated by the context
    }
  }, [connectAztecWallet, network, onComplete]);

  /** Called from the final "Enter Quetzal" button on step 3 */
  const handleConnectPool = useCallback(async () => {
    setLocalError(null);
    try {
      await connectWalletPool({ masterSecret, n, network });
      onComplete();
    } catch {
      // lastError is already populated by the context
    }
  }, [connectWalletPool, masterSecret, n, network, onComplete]);

  /** The inline error to show: prefer local override, fall back to context error */
  const displayError = localError ?? (lastError ? `${lastError.code}: ${lastError.message}` : null);

  // Audit #8 — UNLOCK flow for returning users with an encrypted session.
  if (existing) {
    return (
      <div style={{
        height: "100%", overflow: "auto",
        display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
        padding: "48px 24px",
      }} className="q-scroll">
        <div style={{ width: "100%", maxWidth: 480 }}>
          <Eyebrow>Welcome back</Eyebrow>
          <h2 style={{ fontFamily: "var(--font-display)", fontSize: "clamp(28px, 7vw, 40px)", fontWeight: 300, letterSpacing: "-0.04em", marginTop: 4 }}>
            Unlock your <em style={{ fontFamily: "var(--font-serif)", fontStyle: "italic", fontWeight: 400 }}>pool</em>
          </h2>
          <p style={{ fontFamily: "var(--font-body)", fontSize: 14, color: "var(--fg-muted)", marginTop: 12, lineHeight: 1.5 }}>
            Your wallet master secret is encrypted in this browser. Enter the passphrase you
            set during onboarding to re-derive your pool.
          </p>

          <div className="q-card" style={{ padding: 24, marginTop: 24, display: "flex", flexDirection: "column", gap: 16 }}>
            <PassphraseField label="Passphrase">
              <input
                type="password"
                autoFocus
                value={unlockPassphrase}
                onChange={(e) => { setUnlockPassphrase(e.target.value); setUnlockError(null); }}
                onKeyDown={(e) => { if (e.key === "Enter" && unlockPassphrase && !unlocking) void handleUnlock(); }}
                placeholder="Your passphrase"
                style={{
                  width: "100%", padding: 12,
                  background: "var(--surface)", border: "1px solid var(--hairline-strong)", borderRadius: 6,
                  fontFamily: "var(--font-mono)", fontSize: 13, color: "var(--fg)",
                  boxSizing: "border-box",
                }}
              />
            </PassphraseField>
            {unlockError && (
              <div style={{ color: "var(--aztec-vermillion, #e55)", fontFamily: "var(--font-mono)", fontSize: 12 }}>
                {unlockError}
              </div>
            )}
            <PillButton
              size="lg" variant="primary" rightIcon={unlocking ? undefined : "arrow-right"}
              disabled={!unlockPassphrase || unlocking}
              onClick={() => void handleUnlock()}
            >
              {unlocking ? "Unlocking…" : "Unlock"}
            </PillButton>
          </div>

          <div style={{ marginTop: 16, fontFamily: "var(--font-body)", fontSize: 12, color: "var(--fg-muted)", lineHeight: 1.5 }}>
            Lost your passphrase? There is no recovery — you'll need to{" "}
            <button
              onClick={handleStartOver}
              style={{
                background: "none", border: "none", padding: 0, cursor: "pointer",
                color: "var(--fg)", textDecoration: "underline",
                fontFamily: "var(--font-body)", fontSize: 12,
              }}
            >start over</button>{" "}
            with a fresh master secret (you can re-import an old one if you saved it).
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={{
      height: "100%", overflow: "auto",
      display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "flex-start",
      padding: isMobile ? "24px 16px 40px" : "48px 24px",
    }} className="q-scroll">
      <div style={{ width: "100%", maxWidth: 760 }}>

        {/* progress dots */}
        <div style={{ display: "flex", alignItems: "center", gap: 8, justifyContent: "center", marginBottom: isMobile ? 24 : 32 }}>
          {["Mode", "Secret", "Pool", "Lock", "Faucet"].map((label, i) => (
            <Fragment key={label}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{
                  width: 24, height: 24, borderRadius: "50%",
                  background: i <= step ? "var(--aztec-ink)" : "transparent",
                  color: i <= step ? "var(--aztec-parchment)" : "var(--fg-muted)",
                  border: `1px solid ${i <= step ? "var(--aztec-ink)" : "var(--hairline-strong)"}`,
                  display: "inline-flex", alignItems: "center", justifyContent: "center",
                  fontFamily: "var(--font-mono)", fontSize: 11, fontWeight: 500, flexShrink: 0,
                }}>{i < step ? "✓" : i + 1}</span>
                {/* Five labelled steps don't fit a phone; the numbered dots
                    still carry position, and the step's own heading names it. */}
                {!isMobile && (
                  <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: i <= step ? "var(--fg)" : "var(--fg-muted)", letterSpacing: "0.04em" }}>{label}</span>
                )}
              </div>
              {i < 4 && <div style={{ width: isMobile ? 14 : 32, height: 1, background: i < step ? "var(--aztec-ink)" : "var(--hairline)" }} />}
            </Fragment>
          ))}
        </div>

        {/* STEP 0 — Mode picker */}
        {step === 0 && (
          <div>
            <Eyebrow>Wallet mode</Eyebrow>
            <h2 style={{ fontFamily: "var(--font-display)", fontSize: "clamp(28px, 7vw, 40px)", fontWeight: 300, letterSpacing: "-0.04em", marginTop: 4 }}>
              How do you want to <em style={{ fontFamily: "var(--font-serif)", fontStyle: "italic", fontWeight: 400 }}>sign</em>?
            </h2>
            <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "1fr 1fr", gap: 16, marginTop: isMobile ? 24 : 32 }}>
              <ModeCard
                id="aztec-wallet"
                title="Aztec Wallet"
                badge=""
                desc="Use the Aztec browser extension. One account, one signer. Best for casual use."
                features={["1 account", "browser-managed", "instant connect"]}
                active={mode === "aztec-wallet"}
                onClick={() => setMode("aztec-wallet")}
                icon="chrome"
              />
              <ModeCard
                id="wallet-pool"
                title="Wallet Pool"
                badge="Recommended"
                desc="N HD-derived child wallets, round-robin. ~18N pending tx capacity. Best for active traders."
                features={[`${n} wallets`, `${n * 18} parallel tx`, "self-custodied"]}
                active={mode === "wallet-pool"}
                onClick={() => setMode("wallet-pool")}
                icon="layers"
              />
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 32 }}>
              <PillButton
                size="lg"
                variant="primary"
                disabled={!mode || connecting}
                onClick={() => {
                  if (mode === "wallet-pool") {
                    setStep(1);
                  } else if (mode === "aztec-wallet") {
                    void handleConnectAztecWallet();
                  }
                }}
                rightIcon={connecting && mode === "aztec-wallet" ? undefined : "arrow-right"}
              >
                {connecting && mode === "aztec-wallet"
                  ? "Connecting..."
                  : mode === "aztec-wallet"
                  ? "Connect Aztec Wallet"
                  : "Continue"}
              </PillButton>
            </div>
            {displayError && mode === "aztec-wallet" && (
              <div style={{ marginTop: 12, color: "var(--aztec-vermillion, #e55)", fontFamily: "var(--font-mono)", fontSize: 12, textAlign: "right" }}>
                {displayError}
              </div>
            )}
          </div>
        )}

        {/* STEP 1 — Master secret */}
        {step === 1 && (
          <div>
            <Eyebrow>Master secret</Eyebrow>
            <h2 style={{ fontFamily: "var(--font-display)", fontSize: "clamp(28px, 7vw, 40px)", fontWeight: 300, letterSpacing: "-0.04em", marginTop: 4 }}>
              Generate or <em style={{ fontFamily: "var(--font-serif)", fontStyle: "italic", fontWeight: 400 }}>import</em>?
            </h2>
            <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "1fr 1fr", gap: 16, marginTop: isMobile ? 24 : 32 }}>
              <div className="q-card" style={{ padding: 24 }}>
                <Eyebrow>Recommended</Eyebrow>
                <h3 style={{ fontFamily: "var(--font-serif)", fontSize: 22, fontWeight: 400, marginTop: 8 }}>Generate fresh</h3>
                <p style={{ fontFamily: "var(--font-body)", fontSize: 13, color: "var(--fg-muted)", marginTop: 8, lineHeight: 1.5 }}>
                  A 64-character hex string seeds all N child wallets. Save it to your password manager — losing it means losing every wallet in the pool.
                </p>
                <div style={{
                  marginTop: 16, padding: 14, background: "var(--bg-alt)",
                  border: "1px dashed var(--hairline-strong)", borderRadius: 6,
                  fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--fg)",
                  wordBreak: "break-all", lineHeight: 1.5,
                }}>
                  {generatedSecret.slice(0, 34)}<br/>
                  {generatedSecret.slice(34)}
                </div>
                <div style={{ marginTop: 12, display: "flex", gap: 8 }}>
                  <PillButton size="sm" variant="ink" leftIcon="copy" onClick={copySecret}>Copy</PillButton>
                  <PillButton size="sm" variant="ghost" leftIcon="refresh-cw" onClick={regenerateSecret}>Regenerate</PillButton>
                </div>
              </div>
              <div className="q-card" style={{ padding: 24 }}>
                <Eyebrow>Existing user</Eyebrow>
                <h3 style={{ fontFamily: "var(--font-serif)", fontSize: 22, fontWeight: 400, marginTop: 8 }}>Import existing</h3>
                <p style={{ fontFamily: "var(--font-body)", fontSize: 13, color: "var(--fg-muted)", marginTop: 8, lineHeight: 1.5 }}>
                  Paste an existing 64-character hex secret to restore your pool. Children derive deterministically — same secret, same addresses.
                </p>
                <textarea
                  placeholder="0x…"
                  value={importedSecret}
                  onChange={(e) => setImportedSecret(e.target.value)}
                  style={{
                    width: "100%", height: 80, marginTop: 16, padding: 12,
                    background: "var(--surface)", border: "1px solid var(--hairline-strong)", borderRadius: 6,
                    fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--fg)", resize: "none",
                    boxSizing: "border-box",
                  }}
                />
                {importedSecret.trim() !== "" && !importedSecretValid && (
                  <div style={{ fontFamily: "var(--font-body)", fontSize: 11, color: "var(--danger, #c0392b)", marginTop: 8 }}>
                    Enter a valid 0x + 64-hex secret. A wrong secret silently restores a different (empty) wallet.
                  </div>
                )}
              </div>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", marginTop: 32 }}>
              <PillButton size="lg" variant="ghost" onClick={() => setStep(0)} leftIcon="arrow-left">Back</PillButton>
              <PillButton size="lg" variant="primary" disabled={!importedSecretValid} onClick={() => setStep(2)} rightIcon="arrow-right">I've saved my secret</PillButton>
            </div>
          </div>
        )}

        {/* STEP 2 — Pool size + network */}
        {step === 2 && (
          <div>
            <Eyebrow>Pool config</Eyebrow>
            <h2 style={{ fontFamily: "var(--font-display)", fontSize: "clamp(28px, 7vw, 40px)", fontWeight: 300, letterSpacing: "-0.04em", marginTop: 4 }}>
              Size your <em style={{ fontFamily: "var(--font-serif)", fontStyle: "italic", fontWeight: 400 }}>pool</em>
            </h2>
            <div className="q-card" style={{ padding: 28, marginTop: 32, display: "flex", flexDirection: "column", gap: 24 }}>
              <div>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                  <Eyebrow>Number of child wallets</Eyebrow>
                  <span data-mono style={{ fontFamily: "var(--font-mono)", fontSize: 13, color: "var(--fg)" }}>{n} wallets · ≈ {n * 18 - 6} capacity</span>
                </div>
                <input type="range" min="1" max="20" value={n} onChange={(e) => setN(parseInt(e.target.value, 10))}
                       style={{ width: "100%", marginTop: 12, accentColor: "var(--aztec-ink)" }} />
                <div style={{ display: "flex", justifyContent: "space-between", fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--fg-muted)", marginTop: 4 }}>
                  <span>1</span><span>5</span><span>10</span><span>15</span><span>20</span>
                </div>
                <div style={{ marginTop: 8, fontFamily: "var(--font-body)", fontSize: 12, color: "var(--fg-muted)", lineHeight: 1.5 }}>
                  Each wallet can hold up to 18 pending tx before stalling. {n === 1 ? "1 wallet ≈ 12 simultaneous orders." : `${n} wallets ≈ ${n * 18 - 6} simultaneous orders before any wallet stalls.`}
                </div>
              </div>

              <Hairline />

              <div>
                <Eyebrow>Network</Eyebrow>
                <div style={{ marginTop: 8 }}>
                  <Segmented value={network} onChange={(id) => setNetwork(id as NetworkName)} fullWidth options={[
                    { id: "alpha-testnet", label: "alpha-testnet" },
                    { id: "sandbox",       label: "sandbox" },
                    { id: "mainnet",       label: "mainnet" },
                  ]} />
                </div>
              </div>
            </div>

            <div style={{ display: "flex", justifyContent: "space-between", marginTop: 32 }}>
              <PillButton size="lg" variant="ghost" onClick={() => setStep(1)} leftIcon="arrow-left">Back</PillButton>
              <PillButton size="lg" variant="primary" onClick={() => setStep(3)} rightIcon="arrow-right">Continue</PillButton>
            </div>
          </div>
        )}

        {/* STEP 3 — Passphrase (encrypts the persisted session at rest — Audit #8) */}
        {step === 3 && (
          <div>
            <Eyebrow>Lock your wallet</Eyebrow>
            <h2 style={{ fontFamily: "var(--font-display)", fontSize: "clamp(28px, 7vw, 40px)", fontWeight: 300, letterSpacing: "-0.04em", marginTop: 4 }}>
              Set a <em style={{ fontFamily: "var(--font-serif)", fontStyle: "italic", fontWeight: 400 }}>passphrase</em>
            </h2>
            <p style={{ fontFamily: "var(--font-body)", fontSize: 14, color: "var(--fg-muted)", marginTop: 12, lineHeight: 1.5 }}>
              This passphrase encrypts your wallet master secret in this browser (AES-256-GCM).
              It is never sent anywhere. <strong style={{ color: "var(--fg)" }}>If you lose it you must
              re-onboard — there is no recovery.</strong>
            </p>

            <div className="q-card" style={{ padding: 28, marginTop: 32, display: "flex", flexDirection: "column", gap: 20 }}>
              <PassphraseField label="Passphrase" hint="At least 8 characters. Use something you'll remember or store in a password manager.">
                <input
                  type="password"
                  value={passphrase}
                  onChange={(e) => setPassphrase(e.target.value)}
                  placeholder="Choose a passphrase"
                  style={{
                    width: "100%", padding: 12,
                    background: "var(--surface)", border: "1px solid var(--hairline-strong)", borderRadius: 6,
                    fontFamily: "var(--font-mono)", fontSize: 13, color: "var(--fg)",
                    boxSizing: "border-box",
                  }}
                />
              </PassphraseField>
              <PassphraseField label="Confirm passphrase">
                <input
                  type="password"
                  value={passphraseConfirm}
                  onChange={(e) => setPassphraseConfirm(e.target.value)}
                  placeholder="Re-enter your passphrase"
                  style={{
                    width: "100%", padding: 12,
                    background: "var(--surface)", border: "1px solid var(--hairline-strong)", borderRadius: 6,
                    fontFamily: "var(--font-mono)", fontSize: 13, color: "var(--fg)",
                    boxSizing: "border-box",
                  }}
                />
              </PassphraseField>
              {passphrase.length > 0 && passphrase.length < 8 && (
                <div style={{ color: "var(--aztec-vermillion, #e55)", fontFamily: "var(--font-mono)", fontSize: 12 }}>
                  Passphrase must be at least 8 characters.
                </div>
              )}
              {passphraseConfirm.length > 0 && passphrase !== passphraseConfirm && (
                <div style={{ color: "var(--aztec-vermillion, #e55)", fontFamily: "var(--font-mono)", fontSize: 12 }}>
                  Passphrases do not match.
                </div>
              )}
            </div>

            <div style={{ display: "flex", justifyContent: "space-between", marginTop: 32 }}>
              <PillButton size="lg" variant="ghost" onClick={() => setStep(2)} leftIcon="arrow-left">Back</PillButton>
              <PillButton
                size="lg" variant="primary" rightIcon="arrow-right"
                disabled={passphrase.length < 8 || passphrase !== passphraseConfirm}
                onClick={() => setStep(4)}
              >Initialize pool</PillButton>
            </div>
          </div>
        )}

        {/* STEP 4 — Faucet + deploy pipeline */}
        {step === 4 && (
          <WizardStep3
            masterSecret={masterSecret}
            n={n}
            passphrase={passphrase}
            faucetUrl={import.meta.env.VITE_FAUCET_URL as string}
            nodeUrl={import.meta.env.VITE_AZTEC_NODE_URL as string}
            onAllDone={() => void handleConnectPool()}
            onBack={() => setStep(3)}
          />
        )}
      </div>
    </div>
  );
}

interface ModeCardProps {
  id: string;
  title: string;
  badge?: string;
  desc: string;
  features: string[];
  active: boolean;
  onClick: () => void;
  icon: string;
}
function ModeCard({ title, badge, desc, features, active, onClick, icon }: ModeCardProps) {
  return (
    <button onClick={onClick} style={{
      textAlign: "left", padding: 24, cursor: "pointer",
      background: active ? "var(--aztec-ink)" : "var(--surface-card)",
      color: active ? "var(--aztec-parchment)" : "var(--fg)",
      border: `1px solid ${active ? "var(--aztec-ink)" : "var(--hairline-strong)"}`,
      borderRadius: 12,
      transition: "all 200ms var(--ease-out)",
      display: "flex", flexDirection: "column", gap: 12,
    }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <i data-lucide={icon} style={{ width: 22, height: 22, color: active ? "var(--aztec-chartreuse)" : "var(--fg)", strokeWidth: 1.5 } as CSSProperties}></i>
        {badge && (
          <span style={{
            padding: "3px 8px", borderRadius: 999,
            background: "var(--aztec-chartreuse)",
            color: "var(--aztec-ink)",
            fontFamily: "var(--font-mono)", fontSize: 10, fontWeight: 500, letterSpacing: "0.04em",
            textTransform: "uppercase",
          }}>{badge}</span>
        )}
      </div>
      <div style={{ fontFamily: "var(--font-serif)", fontSize: 24, fontWeight: 400, lineHeight: 1.1 }}>{title}</div>
      <div style={{ fontFamily: "var(--font-body)", fontSize: 13, color: active ? "var(--fg-on-deep-mu)" : "var(--fg-muted)", lineHeight: 1.5 }}>{desc}</div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 4 }}>
        {features.map(f => (
          <span key={f} style={{
            fontFamily: "var(--font-mono)", fontSize: 10, padding: "3px 8px",
            borderRadius: 999, border: `1px solid ${active ? "rgba(242,238,225,0.2)" : "var(--hairline-strong)"}`,
            color: active ? "var(--fg-on-deep-mu)" : "var(--fg-muted)",
            letterSpacing: "0.04em",
          }}>{f}</span>
        ))}
      </div>
    </button>
  );
}
