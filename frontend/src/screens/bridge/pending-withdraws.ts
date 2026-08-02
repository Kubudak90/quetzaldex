// Pending L2→L1 withdraw persistence. Tracks state from exit() → finalisation
// → user-clicked L1 withdraw tx. Browser localStorage only.

const STORAGE_KEY = "quetzal-pending-withdraws";

export interface PendingWithdraw {
  token: string;
  amount: string;
  l1Recipient: `0x${string}`;
  isPrivate: boolean;
  l2TxHash: `0x${string}`;
  status: "pending" | "complete";
  createdAt: number;
  l2BlockNumber?: string;
  leafIndex?: string;
  l1WithdrawTxHash?: `0x${string}`;
}

export function loadPendingWithdraws(): PendingWithdraw[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed as PendingWithdraw[];
  } catch {
    return [];
  }
}

export function addPendingWithdraw(w: PendingWithdraw): void {
  const list = loadPendingWithdraws();
  list.push(w);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
}

export function markWithdrawComplete(l2TxHash: string, l1WithdrawTxHash: `0x${string}`): void {
  const list = loadPendingWithdraws().map((w) =>
    w.l2TxHash === l2TxHash ? { ...w, status: "complete" as const, l1WithdrawTxHash } : w,
  );
  localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
}
