import { createAztecNodeClient, waitForNode, type AztecNode } from "@aztec/aztec.js/node";

const NODE_URL = process.env.PXE_URL ?? process.env.AZTEC_NODE_URL ?? "http://localhost:8080";
const READY_TIMEOUT_MS = 30_000;

/**
 * Connect to a running Aztec node at PXE_URL (alias retained from earlier
 * design for compatibility; in v4.x the JSON-RPC endpoint is the Aztec node
 * itself — the PXE is now constructed in-process by the EmbeddedWallet).
 *
 * Throws after 30s if the node is not reachable. The dev stack
 * (anvil + Aztec local-network) must be started externally via:
 *
 *   scripts/dev.sh
 */
export async function connectToSandbox(): Promise<AztecNode> {
  const node = createAztecNodeClient(NODE_URL);
  await waitForReady(node);
  return node;
}

async function waitForReady(node: AztecNode): Promise<void> {
  // waitForNode has an unspecified signature across 4.2.x point releases; we
  // implement a tolerant polling wrapper that works whether or not the helper
  // accepts an options object.
  const deadline = Date.now() + READY_TIMEOUT_MS;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      await waitForNode(node);
      return;
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  throw new Error(
    `aztec node at ${NODE_URL} not reachable within ${READY_TIMEOUT_MS}ms: ${
      lastErr instanceof Error ? lastErr.message : String(lastErr)
    }`,
  );
}
