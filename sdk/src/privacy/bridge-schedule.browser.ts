// sdk/src/privacy/bridge-schedule.browser.ts
// Browser-compatible shim for bridge-schedule.ts.
// Swapped in by Vite alias during frontend production build.
// Uses localStorage instead of node:fs.

import type { ScheduledExit } from "../types.js";

export type ExitStatus = ScheduledExit["status"];

export interface BridgeState {
  scheduledExits: ScheduledExit[];
}

const STORAGE_KEY = "quetzal:bridge-state";

export function loadBridgeState(): BridgeState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as BridgeState) : { scheduledExits: [] };
  } catch {
    return { scheduledExits: [] };
  }
}

export function saveBridgeState(state: BridgeState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Silently ignore quota errors.
  }
}

/**
 * Build an N-entry schedule of partial exits totaling `total` amount,
 * staggered by `intervalDays`. Per-exit amount = total/N +/- 20% deterministic
 * noise; the last entry is adjusted to make the sum equal `total` exactly.
 *
 * @throws if splitInto not in [2, 20] or intervalDays not in [1, 90]
 */
export function buildSplitSchedule(
  token: string,
  total: bigint,
  l1Recipient: string,
  splitInto: number,
  intervalDays: number,
  isPrivate: boolean,
): ScheduledExit[] {
  if (splitInto < 2 || splitInto > 20) {
    throw new Error(`--split-into must be in [2, 20], got ${splitInto}`);
  }
  if (intervalDays < 1 || intervalDays > 90) {
    throw new Error(`--interval-days must be in [1, 90], got ${intervalDays}`);
  }
  const now = Math.floor(Date.now() / 1000);
  const baseAmount = total / BigInt(splitInto);
  const amounts: bigint[] = [];
  let runningSum = 0n;
  for (let i = 0; i < splitInto - 1; i++) {
    const noisePct = ((i * 37) % 41) - 20;
    const noisy = baseAmount + (baseAmount * BigInt(noisePct)) / 100n;
    amounts.push(noisy);
    runningSum += noisy;
  }
  amounts.push(total - runningSum);

  return amounts.map((amt, idx) => ({
    id: `ex_${now}_${idx.toString().padStart(2, "0")}_${Math.random().toString(36).slice(2, 6)}`,
    token,
    amount: amt.toString(),
    l1Recipient,
    isPrivate,
    submitAfterUnix: now + idx * intervalDays * 86400,
    status: "pending" as ExitStatus,
    l2TxHash: null,
    l2EpochAtSubmit: null,
    createdAtUnix: now,
  }));
}
