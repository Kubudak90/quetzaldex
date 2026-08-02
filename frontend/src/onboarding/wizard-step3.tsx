import { useEffect } from "react";
import type { CSSProperties } from "react";
import { useOnboardingStep3, type ChildState } from "./use-onboarding-step3";
import { Eyebrow, PillButton, Badge, AddressMono } from "../components/atoms.js";

export interface WizardStep3Props {
  masterSecret: string;
  n: number;
  /** Encrypts the persisted session at rest (Audit #8). Set in an earlier step. */
  passphrase: string;
  faucetUrl: string;
  nodeUrl: string;
  onAllDone: () => void;
  onBack: () => void;
}

export function WizardStep3(props: WizardStep3Props) {
  const onboarding = useOnboardingStep3({
    masterSecret: props.masterSecret,
    n: props.n,
    passphrase: props.passphrase,
    deps: { config: { faucetUrl: props.faucetUrl, nodeUrl: props.nodeUrl } },
  });

  // Auto-start on mount
  useEffect(() => {
    if (onboarding.phase === "idle") onboarding.start();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // When fully done, notify parent so it can transition to /trade.
  useEffect(() => {
    if (onboarding.phase === "done") props.onAllDone();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onboarding.phase]);

  const childStateLabel = (c: ChildState): string => {
    switch (c.state) {
      case "pending": return "Queued";
      case "dripping": return "Dripping fee-juice (2-4 min)";
      case "claiming":
        switch (c.phase) {
          case "claiming": return "Reading L1→L2 message…";
          case "proving": return "Generating ClientIVC proof (~50s)";
          case "sending": return "Sending deploy tx";
          case "waiting": return "Waiting for confirmation";
          case "done": return "✓ Deployed";
        }
      case "done": return "✓ Deployed";
      case "error": return `⚠ ${c.error.slice(0, 80)}`;
    }
  };

  const rowStyle: CSSProperties = {
    display: "grid",
    gridTemplateColumns: "32px 1fr 220px 90px",
    gap: 16,
    padding: "14px 20px",
    alignItems: "center",
  };

  return (
    <div>
      <Eyebrow>Activate your pool</Eyebrow>
      <h2 style={{ fontFamily: "var(--font-display)", fontSize: 40, fontWeight: 300, letterSpacing: "-0.04em", marginTop: 4 }}>
        Funding & deploying <em style={{ fontFamily: "var(--font-serif)", fontStyle: "italic", fontWeight: 400 }}>{props.n} wallets</em>
      </h2>
      <p style={{ fontFamily: "var(--font-body)", fontSize: 14, color: "var(--fg-muted)", marginTop: 12 }}>
        We're dripping fee-juice + tUSDC + tETH to each child and deploying their account on L2. Total time:
        usually 5-10 minutes; the Aztec sequencer can occasionally take longer. You can leave this tab open.
      </p>

      <div className="q-card" style={{ padding: 0, marginTop: 24, overflow: "hidden" }}>
        {onboarding.children.map((c, i) => (
          <div
            key={i}
            style={{ ...rowStyle, borderBottom: i === onboarding.children.length - 1 ? "none" : "1px solid var(--hairline)" }}
          >
            <div style={{
              width: 28, height: 28, borderRadius: 4,
              background: c.state === "done" ? "var(--aztec-chartreuse)" : "var(--aztec-ink)",
              color: c.state === "done" ? "var(--aztec-ink)" : "var(--aztec-parchment)",
              display: "flex", alignItems: "center", justifyContent: "center",
              fontFamily: "var(--font-mono)", fontSize: 12, fontWeight: 500,
            }}>{c.state === "done" ? "✓" : i}</div>
            <div>
              <div style={{ fontFamily: "var(--font-mono)", fontSize: 12 }}>child-{i}</div>
              <AddressMono value={c.secret} style={{ fontSize: 11, color: "var(--fg-muted)" }} />
            </div>
            <div style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--fg-muted)" }}>
              {childStateLabel(c)}
            </div>
            <div style={{ textAlign: "right" }}>
              {c.state === "done" ? (
                <Badge tone="filled">Ready</Badge>
              ) : c.state === "error" ? (
                <PillButton size="sm" variant="primary" onClick={() => onboarding.retry(i)}>Retry</PillButton>
              ) : (
                <Badge tone="filled">…</Badge>
              )}
            </div>
          </div>
        ))}
      </div>

      <div style={{ display: "flex", justifyContent: "space-between", marginTop: 32 }}>
        <PillButton size="lg" variant="ghost" onClick={props.onBack} leftIcon="arrow-left"
          disabled={onboarding.phase === "running"}>Back</PillButton>
        <div style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--fg-muted)", alignSelf: "center" }}>
          {onboarding.phase === "done" ? "Pool ready — connecting…"
            : onboarding.phase === "partial-error" ? "Some children failed — retry above"
            : onboarding.phase === "running" ? "Working…"
            : "Click Start"}
        </div>
      </div>
    </div>
  );
}
