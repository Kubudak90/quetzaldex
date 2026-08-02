// Browser-friendly L2→L1 outbox proof builder.
// Ports tools/outbox-proof/src/build-proof.ts (Node binary) for use in the
// browser PXE — same canonical helper, Aztec v5 unbalanced Merkle semantics
// (Epoch → Checkpoints → Blocks → Transactions → Messages).
//
// v5: the Outbox stores PROGRESSIVE per-checkpoint roots for each epoch
// (keyed by numCheckpointsInEpoch - 1), so building a witness now requires
// the epoch's roots array read from the L1 Outbox contract. The caller
// supplies an L1 read source (`rpcUrl` or a raw `ethCall`); the outbox
// address is discovered from the Aztec node's getNodeInfo().
//
// Run from the browser via
// `await buildOutboxProof(nodeUrl, l2TxHash, expectedContent, { rpcUrl })`.
// On success returns the concatenated sibling path + leaf index + epoch number
// + numCheckpointsInEpoch for the L1 bridge's withdraw() call.
//
// See tools/outbox-proof/src/build-proof.ts header for the full mechanics writeup.

import { createAztecNodeClient } from "@aztec/aztec.js/node";
import { Fr } from "@aztec/aztec.js/fields";
import { TxHash } from "@aztec/aztec.js/tx";
import { computeL2ToL1MembershipWitness } from "@aztec/stdlib/messaging";
import { computeL2ToL1MessageLeaf } from "./sha256-content.js";

export class OutboxProofShapeError extends Error {
  constructor(msg: string) {
    super(`[outbox-proof] ${msg}`);
    this.name = "OutboxProofShapeError";
  }
}

export class OutboxProofNotReadyError extends Error {
  constructor(l2TxHash: string) {
    super(
      `[outbox-proof] L2 tx ${l2TxHash} not found or not yet in a finalised epoch. ` +
        `Ensure the tx is mined and the epoch is proven on L1 before calling.`,
    );
    this.name = "OutboxProofNotReadyError";
  }
}

export interface OutboxProof {
  l2Epoch: string;
  /** v5: checkpoint count the epoch out-hash root was built from. */
  numCheckpointsInEpoch: string;
  leafIndex: string;
  /** Concatenated [message + tx + block + checkpoint] sibling path, hex strings. */
  siblingPath: `0x${string}`[];
  content: `0x${string}`;
}

/**
 * L1 read source for the Outbox roots. Either a plain JSON-RPC URL (an
 * eth_call is issued directly, no wallet needed) or a caller-supplied
 * `ethCall` (e.g. backed by window.ethereum / a wagmi public client).
 */
export type OutboxL1Source =
  | { rpcUrl: string }
  | { ethCall: (to: `0x${string}`, data: `0x${string}`) => Promise<`0x${string}`> };

/**
 * Who emitted the message and where it is headed. Required because the Outbox
 * commits a SCOPED leaf (sender + recipient + content), not the raw content —
 * see computeL2ToL1MessageLeaf.
 */
export interface OutboxMessageScope {
  /** L2 token that emitted the exit (0x + 32 bytes). */
  l2Sender: string;
  /** L1 TokenBridge the exit targets (0x + 20 bytes). */
  l1Bridge: string;
}

const OUTBOX_GET_ROOTS_ABI = [
  {
    type: "function",
    name: "getRoots",
    stateMutability: "view",
    inputs: [{ name: "_epoch", type: "uint256" }],
    // v5 Outbox returns bytes32[MAX_CHECKPOINTS_PER_EPOCH] (fixed 32).
    outputs: [{ name: "", type: "bytes32[32]" }],
  },
] as const;

async function readOutboxRoots(
  l1: OutboxL1Source,
  outboxAddress: `0x${string}`,
  epoch: bigint,
): Promise<Fr[]> {
  const { encodeFunctionData, decodeFunctionResult } = await import("viem");
  const data = encodeFunctionData({
    abi: OUTBOX_GET_ROOTS_ABI,
    functionName: "getRoots",
    args: [epoch],
  });
  let raw: `0x${string}`;
  if ("ethCall" in l1) {
    raw = await l1.ethCall(outboxAddress, data);
  } else {
    const resp = await fetch(l1.rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_call",
        params: [{ to: outboxAddress, data }, "latest"],
      }),
    });
    if (!resp.ok) {
      throw new OutboxProofShapeError(`L1 eth_call failed: HTTP ${resp.status}`);
    }
    const body = (await resp.json()) as { result?: `0x${string}`; error?: { message?: string } };
    if (!body.result) {
      throw new OutboxProofShapeError(
        `L1 eth_call failed: ${body.error?.message ?? "no result"}`,
      );
    }
    raw = body.result;
  }
  const roots = decodeFunctionResult({
    abi: OUTBOX_GET_ROOTS_ABI,
    functionName: "getRoots",
    data: raw,
  }) as readonly `0x${string}`[];
  return roots.map((hex) => Fr.fromHexString(hex));
}

export async function buildOutboxProof(
  nodeUrl: string,
  l2TxHash: string,
  expectedContent: string,
  l1: OutboxL1Source,
  scope: OutboxMessageScope,
): Promise<OutboxProof> {
  if (!l2TxHash.startsWith("0x") || l2TxHash.length !== 66) {
    throw new OutboxProofShapeError(`l2TxHash must be 0x + 32 bytes (66 chars), got: ${l2TxHash}`);
  }
  if (!expectedContent.startsWith("0x") || expectedContent.length !== 66) {
    throw new OutboxProofShapeError(
      `expectedContent must be 0x + 32 bytes (66 chars), got: ${expectedContent}`,
    );
  }

  const node = createAztecNodeClient(nodeUrl);
  const txHash = TxHash.fromString(l2TxHash);

  // v5: the witness builder needs the epoch's progressive roots from the L1
  // Outbox. Discover the outbox address from the node, then hand the helper a
  // reader so it can fetch the roots for whichever epoch the tx landed in.
  const nodeInfo = await node.getNodeInfo();
  const outboxAddress = nodeInfo.l1ContractAddresses.outboxAddress.toString() as `0x${string}`;

  // The Outbox commits the SCOPED leaf, not the raw content: searching for the
  // content never matches (every withdraw proof then fails "does not exist").
  const leaf = computeL2ToL1MessageLeaf({
    l2Sender: scope.l2Sender,
    rollupVersion: BigInt(nodeInfo.rollupVersion),
    l1Recipient: scope.l1Bridge,
    chainId: BigInt(nodeInfo.l1ChainId),
    content: expectedContent,
  });
  const messageFr = Fr.fromHexString(leaf);
  const rootsReader = {
    getRoots: (epoch: bigint | number) => readOutboxRoots(l1, outboxAddress, BigInt(epoch)),
  };

  const witness = await computeL2ToL1MembershipWitness(node, rootsReader, messageFr, txHash);
  if (!witness) {
    throw new OutboxProofNotReadyError(l2TxHash);
  }

  const { epochNumber, numCheckpointsInEpoch, leafIndex, siblingPath } = witness;
  const siblingPathHex = siblingPath
    .toBufferArray()
    .map((buf: Uint8Array) => {
      const hex = Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
      return `0x${hex}` as `0x${string}`;
    });

  return {
    l2Epoch: epochNumber.toString(),
    numCheckpointsInEpoch: numCheckpointsInEpoch.toString(),
    leafIndex: leafIndex.toString(),
    siblingPath: siblingPathHex,
    content: expectedContent as `0x${string}`,
  };
}
