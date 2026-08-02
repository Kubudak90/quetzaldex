import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Fr } from "@aztec/aztec.js/fields";
import { computeCi, replayOrderAcc, repairReveals, validateReveals } from "../src/validate.js";
import type { RevealPayload } from "../src/queue.js";

// Three orders placed sequentially in distinct anchor blocks; the on-chain acc
// folds their TRUE anchors. The reveals carry mined-block fallbacks (+1/+2
// drift) — the exact failure observed live on epochs 47/50 (2026-06-10).

function mkReveal(i: number, block: number): RevealPayload {
  return {
    epoch_id: 50,
    order_nonce: `0x${(0x1111n * BigInt(i + 1)).toString(16)}`,
    side: true,
    amount_in: String(1000 * (i + 1)),
    limit_price: "1000000000000000",
    submitted_at_block: block,
    owner: "0x289cc467e85e63670757b8b61a1285269af3e9cf326b302f331d233eaa66b32e",
    path_len: 2,
    path: ["0x1234", "0x5678", "0x0"],
  } as RevealPayload;
}

async function accFor(reveals: RevealPayload[]): Promise<Fr> {
  const cis: Fr[] = [];
  for (const r of reveals) {
    cis.push(await computeCi({
      owner: BigInt(r.owner),
      side: r.side,
      amount_in: BigInt(r.amount_in),
      limit_price: BigInt(r.limit_price),
      order_nonce: BigInt(r.order_nonce),
      submitted_at_block: r.submitted_at_block,
      path_len: r.path_len ?? 2,
      path: [BigInt(r.path![0]!), BigInt(r.path![1]!), BigInt(r.path![2]!)],
    }));
  }
  return replayOrderAcc(cis);
}

describe("repairReveals (anchor drift self-heal)", () => {
  it("repairs uniform mined-block fallback drift and matches the on-chain acc", async () => {
    const trueAnchors = [110056, 110057, 110058];
    const onChainAcc = await accFor(trueAnchors.map((b, i) => mkReveal(i, b)));

    // Reveals drifted: SDK fell back to mined blocks (+1, +1, +2).
    const drifted = [mkReveal(0, 110057), mkReveal(1, 110058), mkReveal(2, 110060)];
    assert.equal((await validateReveals(drifted, onChainAcc)).length, 0); // sanity: plain replay fails

    const repaired = await repairReveals(drifted, onChainAcc);
    assert.ok(repaired, "repair should find the true anchors");
    assert.deepEqual(repaired.validated.map((v) => v.submitted_at_block), trueAnchors);
    assert.equal(repaired.corrections.length, 3);
    // Returned order must equal the fold (canonical) order.
    const blocks = repaired.validated.map((v) => v.submitted_at_block);
    assert.deepEqual(blocks, [...blocks].sort((a, b) => a - b));
  });

  it("returns null when no in-range correction matches (tampered amount)", async () => {
    const onChainAcc = await accFor([mkReveal(0, 110056), mkReveal(1, 110057)]);
    const tampered = [mkReveal(0, 110056), { ...mkReveal(1, 110057), amount_in: "999999" }];
    assert.equal(await repairReveals(tampered, onChainAcc), null);
  });

  it("returns null when drift exceeds maxOffset", async () => {
    const onChainAcc = await accFor([mkReveal(0, 110050)]);
    const drifted = [mkReveal(0, 110060)]; // 10 blocks off, > maxOffset 3
    assert.equal(await repairReveals(drifted, onChainAcc), null);
  });

  it("passes through zero-drift reveals (corrections empty)", async () => {
    const reveals = [mkReveal(0, 110056), mkReveal(1, 110057)];
    const onChainAcc = await accFor(reveals);
    const repaired = await repairReveals(reveals, onChainAcc);
    assert.ok(repaired);
    assert.equal(repaired.corrections.length, 0);
  });
});
