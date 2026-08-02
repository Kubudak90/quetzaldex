// H10: "Reset local state" used to remove EVERY "quetzal-" localStorage key,
// which silently deleted the encrypted master secret (persistence.ts) and the
// one-time L1<->L2 claim/withdraw secrets (pending-claims.ts / pending-withdraws.ts)
// — unrecoverable money — while the UI copy claimed the master secret was kept and
// on-chain state unaffected. This module decides what the reset may safely remove.
//
// Literals mirror the module-private STORAGE_KEY in each source file (stable
// storage identifiers; changing them is itself a migration).
export const MASTER_SECRET_KEY = "quetzal-onboarded-v1";
export const PENDING_CLAIMS_KEY = "quetzal-pending-claims";
export const PENDING_WITHDRAWS_KEY = "quetzal-pending-withdraws";

const PENDING_SECRET_KEYS = new Set<string>([PENDING_CLAIMS_KEY, PENDING_WITHDRAWS_KEY]);

/**
 * Which localStorage keys "Reset local state" may remove.
 * - ALWAYS preserves the encrypted master secret (the UI promises it is kept).
 * - Preserves the pending-claim / pending-withdraw keys (their secrets make
 *   in-flight funds recoverable) UNLESS the caller opts in via wipePendingSecrets
 *   after a loss-spelling-out confirm.
 * - Only ever touches "quetzal-" prefixed keys (leaves foreign keys and the
 *   colon-namespaced order journal untouched).
 */
export function resettableKeys(
  allKeys: string[],
  opts: { wipePendingSecrets: boolean },
): string[] {
  return allKeys.filter(
    (k) =>
      k.startsWith("quetzal-") &&
      k !== MASTER_SECRET_KEY &&
      (opts.wipePendingSecrets || !PENDING_SECRET_KEYS.has(k)),
  );
}
