// Public faucet page — status strip (/api/health + /api/config) · drip form
// (reCAPTCHA v3, invisible) · result card with the fee-juice claim package.

import { useCallback, useEffect, useRef, useState } from "react";
import Head from "next/head";
import styles from "@/styles/faucet.module.css";
import {
  isValidAztecAddress,
  dripErrorMessage,
  claimFileName,
  formatTokenAmount,
  stockLevel,
  type DripErrorCode,
} from "@/lib/ui-helpers";

interface UiConfig {
  requireCaptcha: boolean;
  recaptchaSiteKey: string;
  amounts: { tUSDC: string; tETH: string; feeJuice: string };
  globalDailyCap: number;
}
interface Health {
  status: "ok" | "degraded";
  l1?: { operatorBalanceEth: string; operatorBalanceFeeJuice: string };
  rateLimit?: { totalRequests24h: number };
}
interface DripSuccess {
  success: true;
  claimData: Record<string, string>;
  tUSDCMint: { txHash: string; amount: string };
  tETHMint: { txHash: string; amount: string };
}
interface DripFailure {
  success: false;
  error: string;
  code?: Exclude<DripErrorCode, undefined>;
  retryAfterSeconds?: number;
}
/** Success payload + the address it was funded for (captured at success time,
 *  so later edits to the input don't change the claim filename). */
type DripResult = DripSuccess & { address: string };

declare global {
  interface Window {
    grecaptcha?: {
      ready: (cb: () => void) => void;
      execute: (siteKey: string, opts: { action: string }) => Promise<string>;
    };
  }
}

export default function FaucetPage() {
  const [config, setConfig] = useState<UiConfig | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [address, setAddress] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<DripResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lockSeconds, setLockSeconds] = useState(0);
  const [copied, setCopied] = useState(false);
  const captchaLoaded = useRef(false);

  // Load config once + health on load and every 60 s.
  useEffect(() => {
    fetch("/api/config").then(async (r) => setConfig(await r.json())).catch(() => setConfig(null));
    // On a failed poll keep the last-known-good value (initial state is already null).
    const poll = () =>
      fetch("/api/health").then(async (r) => setHealth(await r.json())).catch(() => {});
    poll();
    const t = setInterval(poll, 60_000);
    return () => clearInterval(t);
  }, []);

  // Prefill from ?address= so the app can deep-link here for a wallet it cannot
  // refuel in-app (it only holds the connected wallet's signer). Validated
  // before use — a bad param is ignored rather than dropped into the field.
  useEffect(() => {
    const q = new URLSearchParams(window.location.search).get("address")?.trim();
    if (q && isValidAztecAddress(q)) setAddress(q);
  }, []);

  // reCAPTCHA v3 script — only when the server requires captcha.
  useEffect(() => {
    if (!config?.requireCaptcha || !config.recaptchaSiteKey || captchaLoaded.current) return;
    const s = document.createElement("script");
    s.src = `https://www.google.com/recaptcha/api.js?render=${config.recaptchaSiteKey}`;
    s.async = true;
    document.head.appendChild(s);
    captchaLoaded.current = true;
  }, [config]);

  // Rate-limit lock countdown.
  useEffect(() => {
    if (lockSeconds <= 0) return;
    const t = setTimeout(() => setLockSeconds((s) => s - 1), 1000);
    return () => clearTimeout(t);
  }, [lockSeconds]);

  // While the first health check is in flight (5-30 s) the faucet is "checking",
  // not degraded — don't lock the page out on first paint.
  const checking = health === null;
  const degraded = health !== null && health.status !== "ok";
  const remaining =
    config && health?.rateLimit
      ? Math.max(0, config.globalDailyCap - health.rateLimit.totalRequests24h)
      : null;

  const submit = useCallback(async () => {
    if (!isValidAztecAddress(address)) {
      setError(dripErrorMessage("bad-request", undefined));
      return;
    }
    setBusy(true);
    setError(null);
    setResult(null);
    // Captcha acquisition gets its OWN try/catch — a grecaptcha failure must not
    // surface the "drip may still have landed" message (no request was sent yet).
    let captchaToken = "";
    if (config?.requireCaptcha) {
      if (!window.grecaptcha) {
        setError("Bot check could not load (adblock?). Disable blockers for this page and retry.");
        setBusy(false);
        return;
      }
      try {
        // A half-loaded script can leave ready()/execute() hanging forever — cap at 15 s.
        captchaToken = await Promise.race([
          (async () => {
            await new Promise<void>((res) => window.grecaptcha!.ready(res));
            return window.grecaptcha!.execute(config.recaptchaSiteKey, { action: "drip" });
          })(),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("captcha timed out")), 15_000),
          ),
        ]);
      } catch {
        setError("Bot verification failed — refresh the page and try again.");
        setBusy(false);
        return;
      }
    }
    try {
      const ctrl = new AbortController();
      const timeout = setTimeout(() => ctrl.abort(), 5 * 60_000); // server pipeline takes 2-4 min
      const r = await fetch("/api/drip", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address, captchaToken }),
        signal: ctrl.signal,
      });
      clearTimeout(timeout);
      const body = (await r.json()) as DripSuccess | DripFailure;
      if (body.success) {
        setResult({ ...body, address });
      } else {
        setError(dripErrorMessage(body.code, body.retryAfterSeconds));
        if (body.code === "rate-limited" && body.retryAfterSeconds) setLockSeconds(body.retryAfterSeconds);
      }
    } catch (e) {
      setError(
        e instanceof DOMException && e.name === "AbortError"
          ? "Request timed out — the drip may STILL have landed. Check your balance before retrying."
          : "Network error — the drip may still have landed server-side. Check your balance before retrying.",
      );
    } finally {
      setBusy(false);
    }
  }, [address, config]);

  const downloadClaim = useCallback(() => {
    if (!result) return;
    const blob = new Blob([JSON.stringify(result.claimData, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = claimFileName(result.address);
    a.click();
    URL.revokeObjectURL(a.href);
  }, [result]);

  const copyClaim = useCallback(() => {
    if (!result) return;
    // navigator.clipboard is undefined on non-secure contexts — no-op instead of crashing.
    navigator.clipboard
      ?.writeText(JSON.stringify(result.claimData))
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2_000);
      })
      .catch(() => {});
  }, [result]);

  const dripCopy = config
    ? `${formatTokenAmount(config.amounts.tUSDC, 6)} tUSDC + ${formatTokenAmount(config.amounts.tETH, 18)} tETH + ${formatTokenAmount(config.amounts.feeJuice, 18)} fee juice`
    : "…";

  return (
    <div className={styles.page}>
      <Head><title>Quetzal Faucet — Aztec Testnet</title></Head>

      <div className={styles.statusStrip}>
        <span>
          Faucet:{" "}
          <span className={degraded ? styles.statusBad : styles.statusOk}>
            {health ? health.status : "checking…"}
          </span>
        </span>
        <span>{remaining !== null ? `${remaining} drips left today` : ""}</span>
        <span>Stock: {stockLevel(health?.l1) ?? "—"}</span>
      </div>

      <div className={styles.card}>
        <h1 className={styles.title}>Quetzal Faucet</h1>
        <p className={styles.subtitle}>
          Get {dripCopy} on Aztec testnet. One request funds a wallet for hours of trading.
        </p>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <input
            className={styles.input}
            placeholder="0x… your Aztec address (64 hex chars)"
            value={address}
            onChange={(e) => setAddress(e.target.value.trim())}
            disabled={busy || degraded}
          />
          <button
            type="submit"
            className={styles.button}
            disabled={busy || checking || degraded || lockSeconds > 0 || !address}
          >
            {busy
              ? "Dripping… (L1 deposit + two L2 mints — takes a few minutes)"
              : lockSeconds > 0
                ? `Rate-limited — retry in ${lockSeconds}s`
                : checking
                  ? "Checking status…"
                  : degraded
                    ? "Faucet temporarily unavailable"
                    : "Request tokens"}
          </button>
        </form>
        {error && <p className={styles.error}>{error}</p>}
        {config?.requireCaptcha && (
          <p className={styles.note}>
            Protected by reCAPTCHA — the Google{" "}
            <a href="https://policies.google.com/privacy">Privacy Policy</a> and{" "}
            <a href="https://policies.google.com/terms">Terms of Service</a> apply.
          </p>
        )}
      </div>

      {result && (
        <div className={styles.card}>
          <h2 className={styles.title} style={{ fontSize: 20 }}>Tokens sent ✓</h2>
          <p className={styles.note}>
            Mint transaction (tUSDC + tETH in one batch):{" "}
            <span className={styles.txHash}>{result.tUSDCMint.txHash}</span>
          </p>
          <p className={styles.subtitle} style={{ marginTop: 16 }}>
            Fee-juice claim package — needed ONLY for CLI/SDK use. If you onboard in the
            Quetzal app, fee juice is claimed automatically and you can ignore this.
          </p>
          <pre className={styles.claimBox}>{JSON.stringify(result.claimData, null, 2)}</pre>
          <div className={styles.row}>
            <button className={styles.smallBtn} onClick={copyClaim}>
              {copied ? "Copied ✓" : "Copy JSON"}
            </button>
            <button className={styles.smallBtn} onClick={downloadClaim}>
              Download {claimFileName(result.address)}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
