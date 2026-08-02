// sdk/src/util/sha256-content.ts
// Sub-5c D3: JS-side reconstruction of the L1 _withdrawContent hash.
//
// Matches contracts-l1/src/TokenBridge.sol's:
//   _sha256ToField(abi.encode(bytes32(uint256(uint160(recipient))), amount, tag))
// which is: sha256(packed) → first 31 bytes → prepend 0x00 → bytes32.

import { createHash } from "node:crypto";

/**
 * @param l1RecipientHex  0x-prefixed 20-byte address
 * @param amount          uint256 amount
 * @param isPrivate       false → WITHDRAW_PUBLIC_TAG; true → WITHDRAW_PRIVATE_TAG
 * @returns 0x-prefixed 32-byte field-fitting hash (matches L1 + L2 reconstruction)
 */
export function computeWithdrawContent(
  l1RecipientHex: string,
  amount: bigint,
  isPrivate: boolean,
): string {
  if (!l1RecipientHex.startsWith("0x") || l1RecipientHex.length !== 42) {
    throw new Error(`l1RecipientHex must be 0x-prefixed 20-byte address, got: ${l1RecipientHex}`);
  }

  // Domain tags MUST match both:
  //   contracts-l1/src/lib/DataStructures.sol: WITHDRAW_PUBLIC_TAG / WITHDRAW_PRIVATE_TAG
  //   contracts/token/src/main.nr             globals
  // (Sub-5b C1 set these to ZSWAP_WD_\x03 / ZSWAP_WD_\x04 ASCII packed.)
  const WITHDRAW_PUBLIC_TAG = "000000000000000000000000000000000000000000005a535741505f57445f03";
  const WITHDRAW_PRIVATE_TAG = "000000000000000000000000000000000000000000005a535741505f57445f04";
  const tag = isPrivate ? WITHDRAW_PRIVATE_TAG : WITHDRAW_PUBLIC_TAG;

  const recipientBytes32 = l1RecipientHex.slice(2).padStart(64, "0");
  const packed = recipientBytes32 + amount.toString(16).padStart(64, "0") + tag;
  const bytes = Buffer.from(packed, "hex");

  const digest = createHash("sha256").update(bytes).digest();
  const first31 = digest.subarray(0, 31);
  const result = Buffer.concat([Buffer.alloc(1, 0), first31]);
  return "0x" + result.toString("hex");
}

/**
 * The leaf the Aztec Outbox commits for an L2→L1 message — and therefore the
 * value a membership proof must search for.
 *
 * `TxEffect.l2ToL1Msgs` does NOT carry the raw `content` a portal emitted: it
 * carries this SCOPED hash, which binds the emitting L2 contract and the target
 * L1 portal into the leaf (so a message cannot be replayed against a different
 * bridge). Passing the raw content to `computeL2ToL1MembershipWitness` therefore
 * never matches and every withdraw proof fails with "the L2ToL1Message you are
 * trying to prove inclusion of does not exist" — caught live on v5 by the exit
 * e2e, after deposits had been green for hours.
 *
 * Mirrors aztec-packages l1-contracts Hash.sha256ToField(DataStructures.L2ToL1Msg):
 *   sha256(abi.encodePacked(
 *     sender.actor (bytes32), sender.version (uint256),
 *     recipient.actor (address), recipient.chainId (uint256),
 *     content (bytes32)
 *   )) truncated to its top 31 bytes (0x00-prefixed).
 */
export function computeL2ToL1MessageLeaf(input: {
  /** L2 contract that emitted the message (the bridged Token), 0x + 32 bytes. */
  l2Sender: string;
  /** Aztec rollup version the message was emitted under. */
  rollupVersion: bigint;
  /** L1 portal the message targets (the TokenBridge), 0x + 20 bytes. */
  l1Recipient: string;
  /** L1 chain id. */
  chainId: bigint;
  /** The portal content hash (computeWithdrawContent / computeDepositContent). */
  content: string;
}): string {
  const b32 = (hex: string, label: string): string => {
    const raw = hex.startsWith("0x") ? hex.slice(2) : hex;
    if (raw.length !== 64) throw new Error(`${label} must be 0x + 32 bytes, got: ${hex}`);
    return raw;
  };
  const addr = (hex: string, label: string): string => {
    const raw = hex.startsWith("0x") ? hex.slice(2) : hex;
    if (raw.length !== 40) throw new Error(`${label} must be 0x + 20 bytes, got: ${hex}`);
    return raw;
  };
  const u256 = (v: bigint): string => v.toString(16).padStart(64, "0");

  // encodePacked: bytes32 | uint256 | address (20 bytes, NOT padded) | uint256 | bytes32
  const packed =
    b32(input.l2Sender, "l2Sender") +
    u256(input.rollupVersion) +
    addr(input.l1Recipient, "l1Recipient") +
    u256(input.chainId) +
    b32(input.content, "content");

  const digest = createHash("sha256").update(Buffer.from(packed, "hex")).digest();
  const first31 = digest.subarray(0, 31);
  return "0x" + Buffer.concat([Buffer.alloc(1, 0), first31]).toString("hex");
}
