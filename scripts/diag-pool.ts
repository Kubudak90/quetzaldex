#!/usr/bin/env node
// diag-pool.ts — read-only diagnostic: dump get_pool_state() + get_bucket(0..N)
// for one or more pool addresses, to see reserves / current price / funded buckets.
// Reuses the sub9 wallet (already in PXE). No state mutation, no secrets committed.
//
// Usage:
//   POOLS=0x2e8c4544...,0x2be10854... pnpm tsx scripts/diag-pool.ts
//   (defaults to new pool 0 + legacy pool 0 from quetzal.config.json)
import { readFileSync } from "node:fs";
import { Fr, Fq } from "@aztec/aztec.js/fields";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { createAztecNodeClient, waitForNode } from "@aztec/aztec.js/node";
import { EmbeddedWallet } from "@aztec/wallets/embedded";
import { LiquidityPoolContract } from "../tests/integration/generated/LiquidityPool.js";

const NODE_URL = process.env.AZTEC_NODE_URL ?? "https://rpc.testnet.aztec-labs.com";
const PXE_DIR = "./sub9-e2e-pxe";
const NBUCKETS = Number(process.env.NBUCKETS ?? "14");

async function readPool(pool: LiquidityPoolContract, from: AztecAddress, label: string) {
  const ps = (await pool.methods.get_pool_state().simulate({ from })) as { result: Record<string, bigint | number> };
  const r = ps.result;
  console.log(`\n=== ${label} ===`);
  console.log(`  reserve_a=${BigInt(r.reserve_a)}  reserve_b=${BigInt(r.reserve_b)}  current_sqrt_price=${BigInt(r.current_sqrt_price)}`);
  let fundedCount = 0;
  for (let i = 0; i < NBUCKETS; i++) {
    try {
      const b = (await pool.methods.get_bucket(i).simulate({ from })) as { result: Record<string, bigint | number> };
      const br = b.result;
      const liq = BigInt(br.liquidity);
      if (liq > 0n) {
        fundedCount++;
        console.log(`  bucket[${i}]: liquidity=${liq}  reserve_a=${BigInt(br.reserve_a)}  reserve_b=${BigInt(br.reserve_b)}`);
      }
    } catch (e) {
      console.log(`  bucket[${i}]: read failed (${(e as Error).message.slice(0, 60)})`);
    }
  }
  if (fundedCount === 0) console.log(`  (no funded buckets in 0..${NBUCKETS - 1})`);
}

async function main() {
  const config = JSON.parse(readFileSync("quetzal.config.json", "utf8"));
  const state = JSON.parse(readFileSync("sub9-e2e-state.json", "utf8"));
  const defaults = [
    { addr: config.pools[0].address, label: `NEW pool 0 (${config.pools[0].address.slice(0, 10)})` },
    // Previous-deployment pools are only present right after a redeploy
    // (redeploy-testnet.ts archives them under m4_legacy); skip when absent.
    ...(config.m4_postSub92_legacy?.pools?.[0]
      ? [{ addr: config.m4_postSub92_legacy.pools[0].address, label: `OLD pool 0 (${config.m4_postSub92_legacy.pools[0].address.slice(0, 10)})` }]
      : []),
  ];
  const targets = process.env.POOLS
    ? process.env.POOLS.split(",").map((a) => ({ addr: a.trim(), label: a.trim().slice(0, 12) }))
    : defaults;

  const node = createAztecNodeClient(NODE_URL); await waitForNode(node);
  const wallet = await EmbeddedWallet.create(node, { ephemeral: false, pxe: { proverEnabled: false, dataDirectory: PXE_DIR } });
  const am = await wallet.createSchnorrAccount(Fr.fromString(state.childSecret), Fr.fromString(state.childSalt), Fq.fromString(state.childSigningKey));
  const from = (await am.getAccount()).getAddress();
  console.log(`[diag] from=${from.toString()} nodeTip=${await node.getBlockNumber()} pMinSqrt=${config.bucketPMinSqrt} growth=${config.bucketGrowthNum}`);

  for (const t of targets) {
    const pool = await LiquidityPoolContract.at(AztecAddress.fromStringUnsafe(t.addr), wallet);
    await readPool(pool, from, t.label);
  }
  await wallet.stop();
}
main().catch((e) => { console.error("[diag] FAIL:", e); process.exit(1); });
