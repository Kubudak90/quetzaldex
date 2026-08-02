// Pending L1→L2 claim persistence. Browser localStorage; never sent to a server.
// Keyed by messageIndex (unique per L1 bridge tx).

const STORAGE_KEY = "quetzal-pending-claims";

export interface PendingClaim {
  token: string;
  /** Atomic units, stringified bigint. */
  amount: string;
  /** L1→L2 claim secret (Fr hex). NEVER leaves the browser. */
  secret: string;
  secretHash: string;
  /** L1 inbox message hash (used for getMessageReady polling). */
  messageHash: string;
  /** L1 inbox leaf index (used by L2 claim_* call). */
  messageIndex: string;
  isPrivate: boolean;
  createdAt: number;
}

export function loadPendingClaims(): PendingClaim[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed as PendingClaim[];
  } catch {
    return [];
  }
}

export function addPendingClaim(c: PendingClaim): void {
  const list = loadPendingClaims();
  list.push(c);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
}

export function removePendingClaim(messageIndex: string): void {
  const list = loadPendingClaims().filter((c) => c.messageIndex !== messageIndex);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
}
