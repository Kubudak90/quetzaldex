const P_BN254 = BigInt("0x30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001");

export function validateL2Address(hex: string): boolean {
  if (typeof hex !== "string") return false;
  if (!/^0x[0-9a-fA-F]{64}$/.test(hex)) return false;
  let asBigint: bigint;
  try { asBigint = BigInt(hex); } catch { return false; }
  if (asBigint === 0n) return false;
  if (asBigint >= P_BN254) return false;
  return true;
}
