// sdk/src/wallet/adapter.ts
import type { Wallet } from "@aztec/aztec.js/wallet";
import type { AztecAddress } from "@aztec/aztec.js/addresses";

/**
 * Shared interface for all Quetzal SDK wallet adapters.
 * connect() yields the live wallet + address; stop() tears down any
 * embedded PXE / node connection. External adapters no-op on stop().
 */
export interface WalletAdapter {
  connect(): Promise<{ wallet: Wallet; address: AztecAddress }>;
  stop(): Promise<void>;
}
