import type { Command } from "commander";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { Fr } from "@aztec/aztec.js/fields";
import { OrderbookContract } from "../../../tests/integration/generated/Orderbook.js";
import { loadConfig } from "../config.js";
import { openCli } from "../wallet.js";
import { parseField } from "@quetzal/sdk";
import { isDecoy } from "@quetzal/sdk/privacy/decoy-registry";
import { findEpochForNonceHop, readHopSnapshot } from "../../../aggregator/src/snapshot.js";

const DEFAULT_SNAPSHOT_DIR = process.env.ZSWAP_SNAPSHOT_DIR ?? "aggregator/snapshots";

// ---------------------------------------------------------------------------
// Sub-4 snapshot types (hop-fill format) — kept in CLI because they depend on
// the aggregator's snapshot writer.  SDK claim_fill only exposes the plain
// Sub-1 2-arg API today (see SDK follow-up for snapshot integration).
// ---------------------------------------------------------------------------

interface HopFillLeafJson {
  order_nonce: string;
  hop_index: number;
  amount_out: string;
  pool_id: number;
  leaf_index: number;
}

interface HopSnapshotJson {
  epoch_id: number;
  fills_root: string;
  hop_fills: HopFillLeafJson[];
  hop_paths: Record<string, string[]>;
}

function loadHopSnapshot(snapshotsDir: string, epochId: number): HopSnapshotJson {
  // The aggregator now writes this exact shape (writeHopSnapshot, Sub-4 wired).
  return readHopSnapshot(snapshotsDir, epochId) as HopSnapshotJson;
}

function computeHopMerkleProof(
  snap: HopSnapshotJson,
  leaf: HopFillLeafJson,
): { leaf_index: number; sibling_path: Fr[] } {
  // hop_paths is keyed by `${order_nonce}:${hop_index}` (a 2-hop order shares one
  // nonce across two leaves, so the key MUST include hop_index). leaf_index comes
  // from the aggregator-authoritative leaf position — never recompute ordering.
  const key = `${leaf.order_nonce}:${leaf.hop_index}`;
  const siblings = snap.hop_paths[key];
  if (!siblings) {
    throw new Error(
      `no sibling path for ${key} in epoch-${snap.epoch_id} snapshot ` +
        `(hop_paths has ${Object.keys(snap.hop_paths).length} entries)`,
    );
  }
  if (siblings.length !== 6) {
    throw new Error(`expected 6 sibling hashes for ${key}, got ${siblings.length}`);
  }
  return { leaf_index: leaf.leaf_index, sibling_path: siblings.map((s) => Fr.fromString(s)) };
}

async function claimSingleHop(
  client: Awaited<ReturnType<typeof openCli>>["client"],
  config: ReturnType<typeof loadConfig>,
  orderNonce: Fr,
  hop: 0 | 1,
  snapshotsDir: string,
  epochId: number,
): Promise<void> {
  const snap = loadHopSnapshot(snapshotsDir, epochId);

  const nonceHex = orderNonce.toString();
  const leaf = snap.hop_fills.find((f) => f.order_nonce === nonceHex && f.hop_index === hop);
  if (!leaf) {
    throw new Error(`no fill for nonce=${nonceHex} hop=${hop} in epoch-${epochId} snapshot`);
  }
  if (leaf.amount_out === "0") {
    throw new Error(
      `order ${nonceHex} hop ${hop} has amount_out = 0 (not filled). ` +
        `Use cancel_order during the next OPEN epoch instead.`,
    );
  }

  const merkleProof = computeHopMerkleProof(snap, leaf);

  const orderbook = await OrderbookContract.at(
    AztecAddress.fromStringUnsafe(config.orderbook),
    client.wallet,
  );
  const orderbookDyn = orderbook as unknown as {
    methods: {
      claim_fill: (
        epochId: number,
        orderNonce: Fr,
        hopIndex: bigint,
        amountOut: bigint,
        poolId: bigint,
        leafIndex: bigint,
        siblingPath: Fr[],
      ) => { send: (args: { from: AztecAddress }) => Promise<unknown> };
    };
  };
  await orderbookDyn.methods
    .claim_fill(
      epochId,
      orderNonce,
      BigInt(hop),
      BigInt(leaf.amount_out),
      BigInt(leaf.pool_id),
      BigInt(merkleProof.leaf_index),
      merkleProof.sibling_path,
    )
    .send({ from: client.address });

  console.log(
    `claimed hop=${hop} amount=${leaf.amount_out} token via pool ${leaf.pool_id} ` +
      `for order ${nonceHex} (epoch ${epochId}, leaf_index ${merkleProof.leaf_index})`,
  );
}

export function registerClaim(program: Command): void {
  program
    .command("claim")
    .description("claim the output of a filled order via Merkle inclusion proof")
    .requiredOption("--nonce <field>", "order-identity nonce of the filled order")
    .option("--epoch <num>", "epoch_id the order was filled in (auto-discovered if omitted)")
    .option(
      "--hop <n>",
      "which hop fill to claim: 0, 1, or 'all' (default: 0). Use 'all' to claim both hops of a 2-hop order sequentially.",
      "0",
    )
    .option(
      "--snapshots <dir>",
      "directory containing aggregator/snapshots/epoch-<N>.json (default: aggregator/snapshots; override via $ZSWAP_SNAPSHOT_DIR)",
      DEFAULT_SNAPSHOT_DIR,
    )
    .option(
      "--no-filter-decoys",
      "force claim-fill even on known decoy nonces (default: skip via maker-local registry; saves gas)",
    )
    .action(async (_opts, cmd: Command) => {
      const opts = cmd.optsWithGlobals();
      const orderNonce = new Fr(parseField(String(opts.nonce)));
      const snapshotsDir: string = opts.snapshots as string;
      const hopOpt = String(opts.hop);

      if (hopOpt !== "0" && hopOpt !== "1" && hopOpt !== "all") {
        throw new Error(`--hop must be 0, 1, or 'all', got '${hopOpt}'`);
      }

      const nonceHex = orderNonce.toString();
      const epochId: number | null =
        opts.epoch !== undefined
          ? Number(opts.epoch)
          : findEpochForNonceHop(snapshotsDir, nonceHex);
      if (epochId === null) {
        throw new Error(
          `could not locate a snapshot file containing nonce ${nonceHex} under ${snapshotsDir}. ` +
            `Pass --epoch <N> explicitly, or check the aggregator wrote a snapshot for that epoch.`,
        );
      }

      const config = loadConfig(opts.config);
      const { client } = await openCli(config, Number(opts.account));

      const filterDecoys = opts.filterDecoys !== false;
      if (filterDecoys && isDecoy(client.address.toString(), nonceHex)) {
        console.log(
          `Skipping claim-fill for nonce ${nonceHex}: known decoy (amount_out=0). ` +
            `Use --no-filter-decoys to force a (wasted) tx.`,
        );
        await client.stop();
        return;
      }
      try {
        if (hopOpt === "all") {
          await claimSingleHop(client, config, orderNonce, 0, snapshotsDir, epochId);
          await claimSingleHop(client, config, orderNonce, 1, snapshotsDir, epochId);
        } else {
          const hop = Number(hopOpt) as 0 | 1;
          await claimSingleHop(client, config, orderNonce, hop, snapshotsDir, epochId);
        }
      } finally {
        await client.stop();
      }
    });
}
