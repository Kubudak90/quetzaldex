// Placed-order journal. Browser localStorage; never sent to a server.
//
// Why this exists: a FILLED order is consumed out of the orderbook's resting set,
// so client.reads.getOrders() can no longer see it — the maker has no on-chain way
// to rediscover their own filled orders to claim. We persist each placed real
// order's nonce + display metadata here, then ask the aggregator's GET /proof which
// of them filled. Keyed by owner address so multiple wallets on one browser don't
// cross-contaminate. (Decoy nonces are tracked separately in the privacy registry.)

const STORAGE_PREFIX = "quetzal:orders:";

export interface JournalOrder {
  nonce: string; // 0x hex (real order nonce returned by placeOrder/placeOrderBulk)
  epoch: number; // placement epoch (display only — claim auto-discovers the fill epoch)
  side: "buy" | "sell";
  pair: string; // e.g. "USDC/ETH"
  amount: string; // display amount string (as entered)
  amountToken: string;
  limit: string; // display limit-price string
  limitToken: string;
  createdAt: number;
}

function storageKey(owner: string): string {
  return STORAGE_PREFIX + owner.toLowerCase();
}

export function loadOrders(owner: string): JournalOrder[] {
  try {
    const raw = localStorage.getItem(storageKey(owner));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed as JournalOrder[];
  } catch {
    return [];
  }
}

/** Append a placed order, or update it in place if the nonce already exists. */
export function recordOrder(owner: string, o: JournalOrder): void {
  const list = loadOrders(owner);
  const idx = list.findIndex((e) => e.nonce.toLowerCase() === o.nonce.toLowerCase());
  if (idx >= 0) list[idx] = o;
  else list.push(o);
  try {
    localStorage.setItem(storageKey(owner), JSON.stringify(list));
  } catch {
    // Ignore quota errors — the journal is a convenience cache, not source of truth.
  }
}

/** Drop an order once it's been claimed (or is otherwise no longer actionable). */
export function removeOrder(owner: string, nonce: string): void {
  const list = loadOrders(owner).filter((e) => e.nonce.toLowerCase() !== nonce.toLowerCase());
  try {
    localStorage.setItem(storageKey(owner), JSON.stringify(list));
  } catch {
    // Ignore quota errors.
  }
}
