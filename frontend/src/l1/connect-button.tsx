import { useL1Account, useL1Connect, useL1Disconnect } from "./hooks.js";
import { PillButton, AddressMono } from "../components/atoms.js";

export function L1ConnectButton() {
  const { address, isConnected } = useL1Account();
  const { connect, isPending } = useL1Connect();
  const disconnect = useL1Disconnect();

  if (!isConnected) {
    return (
      <PillButton size="sm" variant="ghost" onClick={connect} disabled={isPending}>
        {isPending ? "Connecting…" : "Connect L1"}
      </PillButton>
    );
  }

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <AddressMono value={address ?? ""} style={{ fontSize: 11 }} />
      <PillButton size="sm" variant="ink" onClick={disconnect}>
        Disconnect
      </PillButton>
    </div>
  );
}
