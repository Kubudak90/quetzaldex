// M13: an imported master secret must be 0x + 64 hex chars (32 bytes), matching
// generateMasterSecret's output. Without this gate a typo'd import silently derives
// a DIFFERENT (usually empty) wallet pool — the user thinks they restored their
// wallet but sees none of their funds.
export function isValidMasterSecret(s: string): boolean {
  return /^0x[0-9a-fA-F]{64}$/.test(s.trim());
}
