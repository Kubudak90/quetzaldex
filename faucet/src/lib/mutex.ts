// Minimal in-process async mutex.
//
// The faucet has exactly ONE operator wallet / PXE / L1 signer. The frontend
// onboarding wizard derives N child wallets and fires N drips CONCURRENTLY
// (Promise.all in use-onboarding-step3.ts). Without serialization those N
// drips would race on the operator's tx nonce (L1 fee-juice deposit) and the
// shared PXE world-state during proof-gen, producing dropped/duplicate-nonce
// failures. We run each drip's on-chain section (bridge + mint) under this
// mutex so they execute one-at-a-time, in arrival order.
//
// Single-process only — the faucet runs as one Node process, so a module-level
// instance is a true process-global lock. (If the faucet is ever horizontally
// scaled, this must become a distributed lock keyed on the operator address.)

/** FIFO async mutex: serializes async critical sections within one process. */
export class Mutex {
  // The promise that resolves when the currently-queued tail of work finishes.
  // Each caller chains onto it, so callers run strictly in arrival order.
  private tail: Promise<void> = Promise.resolve();

  /**
   * Run `fn` exclusively: waits until all previously-enqueued sections have
   * finished, runs `fn`, then releases the lock for the next waiter. The lock
   * is always released even if `fn` throws, and the caller still sees the
   * rejection.
   */
  async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.tail;
    let release!: () => void;
    // Install our own tail BEFORE awaiting prev so the next caller queues
    // behind us, preserving FIFO order even under synchronous bursts.
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}
