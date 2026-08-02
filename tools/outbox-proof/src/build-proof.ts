/**
 * Sub-5c A3: L2→L1 Outbox proof builder.
 *
 * Discovered Aztec 4.2.1 outbox-tree mechanics (from Step 1 inspection of
 * @aztec/stdlib/dest/messaging/l2_to_l1_membership.js and portal_manager.js):
 *
 * The L2→L1 message tree is a 4-level hierarchical unbalanced Merkle tree:
 *   Epoch → Checkpoints → Blocks → Transactions → Messages
 *
 * Each level uses UnbalancedMerkleTreeCalculator (from @aztec/foundation/trees),
 * with SHA-256-truncation as the leaf hash and compressed (zero-skipping) semantics
 * at the Block and Checkpoint levels. Specifically:
 *
 *   Level 1 — Message Tree (TX out hash):
 *     Leaves: individual Fr L2→L1 messages per tx; unbalanced, NOT compressed
 *   Level 2 — Block Tree:
 *     Leaves: TX out hashes (sha256-truncated to Fr) per block; unbalanced, compressed
 *   Level 3 — Checkpoint Tree:
 *     Leaves: Block out hashes per checkpoint; unbalanced, compressed
 *   Level 4 — Epoch Tree:
 *     Leaves: Checkpoint out hashes padded to OUT_HASH_TREE_LEAF_COUNT zeros; unbalanced, NOT compressed
 *
 * The combined sibling path is the concatenation (in this order):
 *   [message siblings] + [tx siblings] + [block siblings] + [checkpoint siblings]
 *
 * The canonical builder is computeL2ToL1MembershipWitness from @aztec/stdlib/messaging.
 * It calls node.getTxReceipt(txHash) for epoch+block, then node.getL2ToL1Messages(epoch)
 * for the Fr[][][][] message array, plus node.getBlock and node.getCheckpointsDataForEpoch
 * to resolve checkpoint/block/tx indices. It returns:
 *   { epochNumber, root: Fr, leafIndex: bigint, siblingPath: SiblingPath<number> }
 *
 * The siblingPath.toBufferArray() gives Buffer[] which we hex-encode as 0x-prefixed strings.
 * The message passed to computeL2ToL1MembershipWitness must be Fr.fromHexString(expectedContent).
 */

import { createAztecNodeClient } from "@aztec/aztec.js/node";
import { Fr } from "@aztec/aztec.js/fields";
import { TxHash } from "@aztec/aztec.js/tx";
import { computeL2ToL1MembershipWitness } from "@aztec/stdlib/messaging";
import { computeL2ToL1MessageLeaf } from "@quetzal/sdk";

export interface OutboxProof {
  l2Epoch: string;
  /** v5: checkpoint count the epoch out-hash root was built from. */
  numCheckpointsInEpoch: string;
  leafIndex: string;
  siblingPath: string[];
  content: string;
}

// v5: the Outbox stores progressive per-checkpoint roots; the witness builder
// needs the epoch's roots array from L1 to pick the smallest covering count.
// getRoots(uint256) selector = 0x36f24127; returns bytes32[32] (fixed array,
// head-only encoding: 32 words back to back).
const GET_ROOTS_SELECTOR = "0x36f24127";

async function readOutboxRoots(l1RpcUrl: string, outbox: string, epoch: bigint): Promise<Fr[]> {
  const data = GET_ROOTS_SELECTOR + epoch.toString(16).padStart(64, "0");
  const resp = await fetch(l1RpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: outbox, data }, "latest"] }),
  });
  if (!resp.ok) throw new Error(`L1 eth_call failed: HTTP ${resp.status}`);
  const body = (await resp.json()) as { result?: string; error?: { message?: string } };
  if (!body.result) throw new Error(`L1 eth_call failed: ${body.error?.message ?? "no result"}`);
  const hex = body.result.replace(/^0x/, "");
  if (hex.length !== 32 * 64) throw new Error(`getRoots returned ${hex.length / 64} words, expected 32`);
  const roots: Fr[] = [];
  for (let i = 0; i < 32; i++) roots.push(Fr.fromHexString("0x" + hex.slice(i * 64, (i + 1) * 64)));
  return roots;
}

export async function buildOutboxProof(
  nodeUrl: string,
  l2TxHash: string,
  expectedContent: string,
  l1RpcUrl: string,
  l2Sender: string,
  l1Bridge: string,
): Promise<OutboxProof> {
  if (!l2TxHash.startsWith("0x")) {
    throw new Error(`l2TxHash must be 0x-prefixed, got: ${l2TxHash}`);
  }
  if (!expectedContent.startsWith("0x") || expectedContent.length !== 66) {
    throw new Error(
      `expectedContent must be 0x + 32 bytes (66 chars), got: ${expectedContent}`,
    );
  }

  const node = createAztecNodeClient(nodeUrl);
  const txHash = TxHash.fromString(l2TxHash);

  // Fr.fromHexString is the correct way to parse a 0x-prefixed 32-byte hash into an Fr.
  // computeL2ToL1MembershipWitness searches the tx's L2→L1 messages for this Fr value.
  // The Outbox commits a SCOPED leaf (sender|version|recipient|chainId|content),
  // not the raw content — searching for the content never matches.
  const messageFr = Fr.fromHexString(
    computeL2ToL1MessageLeaf({
      l2Sender,
      rollupVersion: BigInt((await node.getNodeInfo()).rollupVersion),
      l1Recipient: l1Bridge,
      chainId: BigInt((await node.getNodeInfo()).l1ChainId),
      content: expectedContent,
    }),
  );

  // v5 signature: (node, outboxOrRoots, message, txHashOrReceipt). Hand it a
  // reader so it can fetch the roots for whichever epoch the tx landed in;
  // the outbox address comes from the node's own L1 contract registry.
  const nodeInfo = await node.getNodeInfo();
  const outboxAddress = nodeInfo.l1ContractAddresses.outboxAddress.toString();
  const rootsReader = {
    getRoots: (epoch: bigint | number) => readOutboxRoots(l1RpcUrl, outboxAddress, BigInt(epoch)),
  };
  const witness = await computeL2ToL1MembershipWitness(node, rootsReader, messageFr, txHash);

  if (!witness) {
    throw new Error(
      `L2 tx ${l2TxHash} not found or not yet in a finalized epoch. ` +
        `Ensure the tx is mined and the epoch is proven on L1 before calling this tool.`,
    );
  }

  const { epochNumber, numCheckpointsInEpoch, leafIndex, siblingPath } = witness;

  // siblingPath is SiblingPath<number>; toBufferArray() returns Buffer[]
  const siblingPathHex = siblingPath
    .toBufferArray()
    .map((buf: Buffer) => `0x${buf.toString("hex")}`);

  return {
    l2Epoch: epochNumber.toString(),
    numCheckpointsInEpoch: numCheckpointsInEpoch.toString(),
    leafIndex: leafIndex.toString(),
    siblingPath: siblingPathHex,
    content: expectedContent,
  };
}
