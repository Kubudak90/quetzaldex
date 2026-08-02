// sdk/src/aggregator.ts
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { Fr } from "@aztec/aztec.js/fields";
import { poseidon2Hash } from "@aztec/foundation/crypto/poseidon";
import type { QuetzalClient } from "./client.js";
import type { QuetzalContracts } from "./types.js";
import { ConfigError, OrderError } from "./errors.js";

function requireRegistry(client: QuetzalClient): { contracts: QuetzalContracts; registry: string } {
  const contracts = client.config.contracts;
  if (!contracts) {
    throw new ConfigError(
      "MISSING_ENV",
      "QuetzalClient.config.contracts not set; pass `contracts` to QuetzalClient.connect()",
    );
  }
  if (!contracts.aggregatorRegistry) {
    throw new ConfigError(
      "MISSING_ENV",
      "config.contracts.aggregatorRegistry not set — deploy Sub-3 AggregatorRegistry first.",
    );
  }
  return { contracts, registry: contracts.aggregatorRegistry };
}

/**
 * Canonical URL → Field hash. Mirrors cli/src/reveal.ts:hashUrl so on-chain
 * endpoint_hash registration + maker-side reveal-broadcast hash both produce
 * the same Field for the same URL string.
 */
export async function hashUrl(url: string): Promise<Fr> {
  const bytes = new TextEncoder().encode(url);
  // M6: chunk into 31-byte limbs. A URL of 32+ bytes as a single bigint is >= the
  // field modulus, so poseidon2Hash threw for any longer endpoint. A URL <= 31 bytes
  // yields ONE limb identical to the old whole-URL bigint, so existing (short-URL)
  // endpoint-hash registrations are unchanged. MUST match cli/src/reveal.ts:hashUrl.
  const limbs: bigint[] = [];
  for (let i = 0; i < bytes.length; i += 31) {
    limbs.push(BigInt("0x" + Buffer.from(bytes.subarray(i, i + 31)).toString("hex")));
  }
  return poseidon2Hash(limbs.length ? limbs : [0n]);
}

export interface AggregatorEntry {
  id: number;
  address: string;
  endpointHash: string;
}

/** One populated hop fill + its depth-6 Merkle inclusion path (claim_fill inputs). */
export interface HopProofLeaf {
  order_nonce: string; // Fr-canonical 0x hex
  hop_index: number;
  amount_out: string; // decimal bigint string
  pool_id: number;
  leaf_index: number;
  sibling_path: string[]; // length 6, 0x hex
}

/** Response of the aggregator's GET /proof — everything claim_fill needs. */
export interface HopProofResponse {
  epoch_id: number;
  fills_root: string;
  fills: HopProofLeaf[];
}

export class AggregatorApi {
  constructor(private client: QuetzalClient) {}

  async register(opts: { url: string }): Promise<{ txHash: string; endpointHash: string }> {
    const { registry } = requireRegistry(this.client);
    const endpointHash = await hashUrl(opts.url);
    const { loadAggregatorRegistryContract } = await import("./internal/contracts.js");
    const AggregatorRegistryContract = await loadAggregatorRegistryContract();
    const reg = await AggregatorRegistryContract.at(
      AztecAddress.fromStringUnsafe(registry),
      this.client.wallet,
    );
    const nonce = Fr.random();
    const tx = await reg.methods.register(endpointHash, nonce).send({ from: this.client.address });
    // `.send({from})` is awaited (the tx mines); read the real hash from `.receipt`.
    // The prior `.wait?.()` was a no-op (resolved result has no `.wait`). (aztec.js 4.x)
    const receipt = (tx as { receipt?: { txHash?: { toString: () => string } } }).receipt;
    return {
      txHash: receipt?.txHash?.toString() ?? "",
      endpointHash: endpointHash.toString(),
    };
  }

  async unregister(): Promise<{ txHash: string }> {
    const { registry } = requireRegistry(this.client);
    const { loadAggregatorRegistryContract } = await import("./internal/contracts.js");
    const AggregatorRegistryContract = await loadAggregatorRegistryContract();
    const reg = await AggregatorRegistryContract.at(
      AztecAddress.fromStringUnsafe(registry),
      this.client.wallet,
    );
    const tx = await reg.methods.unregister(new Fr(0n)).send({ from: this.client.address });
    // `.send({from})` is awaited (the tx mines); read the real hash from `.receipt`.
    // The prior `.wait?.()` was a no-op (resolved result has no `.wait`). (aztec.js 4.x)
    const receipt = (tx as { receipt?: { txHash?: { toString: () => string } } }).receipt;
    return { txHash: receipt?.txHash?.toString() ?? "" };
  }

  async list(): Promise<AggregatorEntry[]> {
    const { registry } = requireRegistry(this.client);
    const { loadAggregatorRegistryContract } = await import("./internal/contracts.js");
    const AggregatorRegistryContract = await loadAggregatorRegistryContract();
    const reg = await AggregatorRegistryContract.at(
      AztecAddress.fromStringUnsafe(registry),
      this.client.wallet,
    );
    const countSim = await reg.methods
      .get_aggregator_count()
      .simulate({ from: this.client.address });
    const count = Number((countSim as { result: bigint }).result);
    const out: AggregatorEntry[] = [];
    for (let id = 1; id <= count; id++) {
      const addrSim = await reg.methods
        .get_aggregator_by_id(id)
        .simulate({ from: this.client.address });
      const addrField = (addrSim as { result: { inner?: bigint } | bigint }).result;
      const addrBigInt =
        typeof addrField === "bigint" ? addrField : (addrField as { inner: bigint }).inner;
      if (addrBigInt === 0n) continue;
      const addr = AztecAddress.fromBigIntUnsafe(addrBigInt);
      const hashSim = await reg.methods.get_endpoint_hash(addr).simulate({ from: this.client.address });
      const hash = (hashSim as { result: bigint }).result;
      out.push({
        id,
        address: addr.toString(),
        endpointHash: `0x${hash.toString(16)}`,
      });
    }
    return out;
  }

  /**
   * Broadcast a reveal to all bonded aggregators.  The URL→address manifest
   * is supplied by the caller (CLI looks up its own JSON file; future
   * front-end embeddings may use a hard-coded list).
   *
   * The reveal payload shape is intentionally untyped here — the SDK does
   * not own the Sub-3 reveal schema (lives in aggregator/).  Callers pass
   * the JSON payload they intend POSTed.
   */
  async broadcastReveal(opts: {
    payload: Record<string, unknown>;
    manifest: Record<string, string>; // addrHex → URL
  }): Promise<{ pushed: number; skipped: number }> {
    const { registry } = requireRegistry(this.client);
    const { loadAggregatorRegistryContract } = await import("./internal/contracts.js");
    const AggregatorRegistryContract = await loadAggregatorRegistryContract();
    const reg = await AggregatorRegistryContract.at(
      AztecAddress.fromStringUnsafe(registry),
      this.client.wallet,
    );
    const countSim = await reg.methods.get_aggregator_count().simulate({ from: this.client.address });
    const count = Number((countSim as { result: bigint }).result);

    const targets: { url: string; addr: string }[] = [];
    for (let id = 1; id <= count; id++) {
      const addrSim = await reg.methods
        .get_aggregator_by_id(id)
        .simulate({ from: this.client.address });
      const addrField = (addrSim as { result: { inner?: bigint } | bigint }).result;
      const addrBigInt =
        typeof addrField === "bigint" ? addrField : (addrField as { inner: bigint }).inner;
      if (addrBigInt === 0n) continue;
      const addrHex = `0x${addrBigInt.toString(16).padStart(64, "0")}`;
      const url = opts.manifest[addrHex] || opts.manifest[`0x${addrBigInt.toString(16)}`];
      if (!url) continue;
      const addr = AztecAddress.fromBigIntUnsafe(addrBigInt);
      const hashSim = await reg.methods.get_endpoint_hash(addr).simulate({ from: this.client.address });
      const onchainHashRaw = (hashSim as { result: { inner?: bigint } | bigint }).result;
      const onchainHash =
        typeof onchainHashRaw === "bigint"
          ? onchainHashRaw
          : (onchainHashRaw as { inner: bigint }).inner;
      const computedHash = await hashUrl(url);
      if (computedHash.toBigInt() !== onchainHash) continue;
      targets.push({ url, addr: addrHex });
    }
    let pushed = 0;
    let skipped = 0;
    await Promise.allSettled(
      targets.map(async (t) => {
        try {
          const res = await fetch(`${t.url}/reveal`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(opts.payload),
          });
          if (res.ok) pushed += 1;
          else skipped += 1;
        } catch {
          skipped += 1;
        }
      }),
    );
    return { pushed, skipped };
  }

  /**
   * Post a reveal directly to a known aggregator URL. Bypasses the on-chain
   * AggregatorRegistry — for use when the aggregator URL is known
   * out-of-band (e.g., a Vercel env var pointing at our prod aggregator).
   *
   * Returns true on HTTP 200, false otherwise. Doesn't throw on network
   * errors — caller handles UX via try/catch.
   */
  async directReveal(url: string, payload: Record<string, unknown>): Promise<boolean> {
    try {
      const res = await fetch(`${url}/reveal`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  /**
   * Sub-4 browser claim path: fetch the hop-fill Merkle proof for a filled order
   * from the aggregator's GET /proof (same-origin Vercel proxy at `${base}/proof`).
   * Returns every populated hop with its depth-6 inclusion path — exactly the
   * inputs claim_fill needs. The nonce is sent unpadded (`0x${n.toString(16)}`);
   * the server normalizes it to the snapshot's Fr-canonical form.
   *
   * Unlike directReveal, this THROWS on failure (404 = not filled yet, etc.) so
   * the caller's claim flow surfaces a real error rather than a silent no-op.
   */
  async fetchHopProof(
    baseUrl: string,
    opts: { orderNonce: bigint | string; hopIndex?: number; epochId?: number },
  ): Promise<HopProofResponse> {
    const nonceHex =
      typeof opts.orderNonce === "string" ? opts.orderNonce : `0x${opts.orderNonce.toString(16)}`;
    const params = new URLSearchParams({ order_nonce: nonceHex });
    if (opts.hopIndex !== undefined) params.set("hop_index", String(opts.hopIndex));
    if (opts.epochId !== undefined) params.set("epoch_id", String(opts.epochId));
    const res = await fetch(`${baseUrl}/proof?${params.toString()}`, {
      method: "GET",
      headers: { Accept: "application/json" },
    });
    if (!res.ok) {
      let detail = "";
      try {
        detail = ((await res.json()) as { error?: string }).error ?? "";
      } catch {
        /* non-JSON error body — fall through with status only */
      }
      throw new OrderError(
        "UNKNOWN",
        `hop-proof fetch failed (${res.status})${detail ? `: ${detail}` : ""}`,
      );
    }
    const j = (await res.json().catch(() => null)) as HopProofResponse | null;
    if (!j || typeof j.epoch_id !== "number" || !Array.isArray(j.fills)) {
      throw new OrderError("UNKNOWN", `malformed hop-proof response from ${baseUrl}/proof`);
    }
    return j;
  }
}
