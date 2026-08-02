import { spawn } from "node:child_process";
import { Fr } from "@aztec/aztec.js/fields";
import { createAztecNodeClient } from "@aztec/aztec.js/node";
import { TxHash } from "@aztec/aztec.js/tx";

/**
 * Sub-5b / Sub-5c A3: L2→L1 Outbox proof retrieval interface.
 *
 * After a maker calls aUSDC.exit_to_l1_*, they need three values to
 * call USDCBridge.withdraw on L1:
 *   - l2Epoch: the rollup epoch containing the L2→L1 message
 *   - leafIndex: the leaf position in that epoch's Outbox tree
 *   - siblingPath: Merkle proof from leaf to Outbox root
 *
 * Sub-5c A3: buildOutboxProof is now a thin spawn wrapper around the
 * audit-isolated subprocess binary tools/outbox-proof/dist/quetzal-outbox-proof.mjs.
 * The binary delegates to computeL2ToL1MembershipWitness from @aztec/stdlib/messaging,
 * which builds the full 4-level combined sibling path internally.
 *
 * Override the binary path via QUETZAL_OUTBOX_PROOF_BIN env var.
 */

export interface OutboxLookup {
  /** L2 rollup epoch containing the L2→L1 message. */
  l2Epoch: bigint;

  /** Flat leaf index across the epoch's outbox tree (matches IOutbox.consume's _leafIndex). */
  leafIndex: bigint;

  /** Hex-encoded 32-byte content hash committed on L2. */
  content: string;
}

export interface OutboxProof extends OutboxLookup {
  /** v5: checkpoint count the epoch out-hash root was built from. */
  numCheckpointsInEpoch: bigint;
  /** Hex-encoded sibling hashes from leaf to Outbox root. */
  siblingPath: string[];
}

/**
 * Look up which (l2Epoch, leafIndex) holds a specific L2→L1 message.
 *
 * Implements the search via two aztec.js node calls:
 *   1. getTxEffect(txHash) → epoch number for the tx
 *   2. getL2ToL1Messages(epoch) → nested Fr[][][][] of message hashes
 *      indexed by [checkpoint][block][tx][message]. The Aztec
 *      Outbox flattens this into a single leaf-indexed tree per epoch.
 *
 * @param nodeUrl          Aztec node RPC URL
 * @param l2TxHash         L2 tx hash of the exit_to_l1_* call (0x-prefixed)
 * @param expectedContent  0x-prefixed bytes32 the maker computed locally
 * @returns OutboxLookup or throws if not found
 */
export async function lookupOutboxMessage(
  nodeUrl: string,
  l2TxHash: string,
  expectedContent: string,
): Promise<OutboxLookup> {
  if (!l2TxHash.startsWith("0x")) {
    throw new Error(`l2TxHash must be 0x-prefixed, got: ${l2TxHash}`);
  }
  if (!expectedContent.startsWith("0x") || expectedContent.length !== 66) {
    throw new Error(
      `expectedContent must be a 0x-prefixed 32-byte hash (66 chars total), got: ${expectedContent}`,
    );
  }

  const node = createAztecNodeClient(nodeUrl);
  // Cast through unknown — TxHash.fromString is the canonical constructor;
  // if aztec.js renames it across versions, surface the failure clearly.
  const txHash = (TxHash as unknown as { fromString: (s: string) => TxHash }).fromString(l2TxHash);

  // 1. Find which epoch contained the tx
  const effect = await (node as unknown as {
    getTxEffect: (h: TxHash) => Promise<
      { data?: { l2ToL1Msgs?: Fr[] }; l2BlockNumber?: number; epochNumber?: number } | undefined
    >;
  }).getTxEffect(txHash);

  if (!effect) {
    throw new Error(`L2 tx ${l2TxHash} not found (not yet mined? wrong node URL?)`);
  }

  // The IndexedTxEffect type wraps a TxEffect with DataInBlock metadata.
  // The exact field shape varies across aztec.js versions; cast and probe.
  const epochField =
    (effect as unknown as { epochNumber?: number; epoch?: number; data?: { epoch?: number } });
  const epoch = epochField.epochNumber ?? epochField.epoch ?? epochField.data?.epoch;
  if (epoch === undefined || epoch === null) {
    throw new Error(
      `getTxEffect returned no epoch info for ${l2TxHash}. ` +
      `Cannot determine which epoch's outbox holds the L2→L1 message.`,
    );
  }
  const l2Epoch = BigInt(epoch);

  // 2. Enumerate all L2→L1 messages in that epoch
  const messages = await (node as unknown as {
    getL2ToL1Messages: (epoch: number | bigint) => Promise<Fr[][][][]>;
  }).getL2ToL1Messages(Number(l2Epoch));

  // 3. Flatten + locate our content hash
  // messages[checkpointIdx][blockIdx][txIdx][msgIdx] → Fr
  // The Outbox tree is constructed by flattening in [checkpoint][block][tx][msg] order.
  const expectedLower = expectedContent.toLowerCase();
  let flatLeafIndex = 0n;
  let found = false;
  outer: for (const checkpoint of messages) {
    for (const block of checkpoint) {
      for (const tx of block) {
        for (const msg of tx) {
          const msgHex = (msg as Fr).toString().toLowerCase();
          if (msgHex === expectedLower) {
            found = true;
            break outer;
          }
          flatLeafIndex += 1n;
        }
      }
    }
  }

  if (!found) {
    throw new Error(
      `L2→L1 message with content ${expectedContent} not found in epoch ${l2Epoch}. ` +
      `Either (a) the L2 tx hasn't been included in a finalized epoch yet (wait), ` +
      `(b) the content hash you computed locally doesn't match what L2 emitted ` +
      `(re-derive via sha256_to_field(abi.encode(l1_recipient, amount, WITHDRAW_PUBLIC_TAG))), or ` +
      `(c) the node is out of sync. ` +
      `Tx receipt blockNumber + epoch: ${JSON.stringify({ epoch: l2Epoch.toString() })}.`,
    );
  }

  return { l2Epoch, leafIndex: flatLeafIndex, content: expectedContent };
}

/**
 * Full proof builder. Returns { l2Epoch, leafIndex, siblingPath, content }.
 *
 * Sub-5c A3: delegates to the audit-isolated subprocess binary
 * tools/outbox-proof/dist/quetzal-outbox-proof.mjs, which calls
 * computeL2ToL1MembershipWitness from @aztec/stdlib/messaging for the
 * full 4-level combined sibling path.
 *
 * Override binary path via QUETZAL_OUTBOX_PROOF_BIN env var.
 *
 * @param nodeUrl          Aztec node RPC URL
 * @param l2TxHash         L2 tx hash of the exit_to_l1_* call
 * @param expectedContent  0x-prefixed bytes32 content hash
 * @returns OutboxProof with complete siblingPath
 */
export async function buildOutboxProof(
  nodeUrl: string,
  l2TxHash: string,
  expectedContent: string,
  l1RpcUrl: string,
  l2Sender: string,
  l1Bridge: string,
): Promise<OutboxProof> {
  const binPath =
    process.env.QUETZAL_OUTBOX_PROOF_BIN ??
    `${process.cwd()}/tools/outbox-proof/dist/quetzal-outbox-proof.mjs`;

  return new Promise((resolve, reject) => {
    // L14: use process.execPath so the child runs under the same Node.js binary
    // as the CLI regardless of PATH (important for cron / minimal-PATH environments).
    const child = spawn(process.execPath, [
      binPath,
      "--node-url", nodeUrl,
      "--l2-tx-hash", l2TxHash,
      "--expected-content", expectedContent,
      "--l1-rpc-url", l1RpcUrl,
      "--l2-sender", l2Sender,
      "--l1-bridge", l1Bridge,
    ]);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d));
    child.stderr.on("data", (d: Buffer) => (stderr += d));
    // L14: handle spawn-level failures (ENOENT, EMFILE, EAGAIN) so the Promise
    // rejects cleanly instead of throwing an uncaught exception that kills the CLI.
    child.on("error", (e) =>
      reject(new Error(`failed to spawn quetzal-outbox-proof (${binPath}): ${e.message}`)),
    );
    child.on("exit", (code: number | null) => {
      if (code !== 0) {
        return reject(new Error(`quetzal-outbox-proof exited ${code}: ${stderr.trim()}`));
      }
      try {
        const raw = JSON.parse(stdout) as {
          l2Epoch: string;
          numCheckpointsInEpoch: string;
          leafIndex: string;
          siblingPath: string[];
          content: string;
        };
        resolve({
          l2Epoch: BigInt(raw.l2Epoch),
          numCheckpointsInEpoch: BigInt(raw.numCheckpointsInEpoch),
          leafIndex: BigInt(raw.leafIndex),
          siblingPath: raw.siblingPath,
          content: raw.content,
        });
      } catch (e) {
        reject(
          new Error(
            `quetzal-outbox-proof returned non-JSON stdout: ${stdout}; stderr: ${stderr}`,
          ),
        );
      }
    });
  });
}

/**
 * Format an OutboxProof as a ready-to-run 'cast send' command for the L1
 * TokenBridge.withdraw or .withdrawPrivate call. Lets the maker paste it
 * directly into Foundry without manually building calldata.
 *
 * @param proof          OutboxProof from buildOutboxProof
 * @param bridgeAddress  L1 portal address (USDCBridge / WETHBridge / wBTCBridge)
 * @param amount         token amount (smallest unit)
 * @param l1Recipient    0x-prefixed L1 recipient address
 * @param l2Sender       0x-prefixed bytes32 L2 token address that emitted the
 *                       exit (L22; current or previously-registered token)
 * @param functionName   "withdraw" (default; consumes WITHDRAW_PUBLIC_TAG)
 *                       or "withdrawPrivate" (consumes WITHDRAW_PRIVATE_TAG)
 */
export function formatProofForCastSend(
  proof: OutboxProof,
  bridgeAddress: string,
  amount: bigint,
  l1Recipient: string,
  l2Sender: string,
  functionName: "withdraw" | "withdrawPrivate" = "withdraw",
): string {
  if (!bridgeAddress.startsWith("0x") || bridgeAddress.length !== 42) {
    throw new Error(`bridgeAddress must be a 0x-prefixed 20-byte address, got: ${bridgeAddress}`);
  }
  if (!l1Recipient.startsWith("0x") || l1Recipient.length !== 42) {
    throw new Error(`l1Recipient must be a 0x-prefixed 20-byte address, got: ${l1Recipient}`);
  }
  if (!l2Sender.startsWith("0x") || l2Sender.length !== 66) {
    throw new Error(`l2Sender must be a 0x-prefixed 32-byte address, got: ${l2Sender}`);
  }
  const sig = `${functionName}(uint256,address,uint256,uint256,uint256,bytes32[],bytes32)`;
  const siblingArray = `[${proof.siblingPath.join(",")}]`;
  return [
    `cast send ${bridgeAddress} \\`,
    `  "${sig}" \\`,
    `  ${amount} ${l1Recipient} ${proof.l2Epoch} ${proof.numCheckpointsInEpoch} ${proof.leafIndex} '${siblingArray}' ${l2Sender}`,
  ].join("\n");
}
