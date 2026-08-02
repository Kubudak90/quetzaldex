#!/usr/bin/env node
//
// read-pools.ts — read-only pool state inspector for the configured pools.
//
// Reports per pool: aggregate reserves + current_sqrt_price, which bucket the
// price sits in, and the funded buckets (liquidity > 0) with their reserves —
// so you can see at a glance whether a pool is single-sided (reserve_b == 0)
// or two-sided. No on-chain writes.
//
// Usage:
//   AZTEC_NODE_URL=https://rpc.testnet.aztec-labs.com \
//   STATIC_MAX_FEE_PER_L2_GAS=200000000 \
//   pnpm tsx scripts/read-pools.ts
//
import { readFileSync, existsSync } from "node:fs";
import { Fr, Fq } from "@aztec/aztec.js/fields";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { createAztecNodeClient, waitForNode } from "@aztec/aztec.js/node";
import { EmbeddedWallet } from "@aztec/wallets/embedded";
import { GasFees } from "@aztec/stdlib/gas";
import { LiquidityPoolContract } from "../tests/integration/generated/LiquidityPool.js";

const NODE_URL = process.env.AZTEC_NODE_URL ?? "https://rpc.testnet.aztec-labs.com";
const PXE_DIR = process.env.SEED_LP_PXE_DIR ?? "./testnet-m4-pxe";
const NUM_BUCKETS = 16;

interface M1State { secret: string; salt: string; signingKey: string; address: string }
interface Qconfig {
  admin: string; tUSDC: string; tETH: string; tBTC?: string;
  pools: Array<{ pool_id: number; token_a: string; token_b: string; address: string }>;
  bucketPMinSqrt: string; bucketGrowthNum: string;
}

function bucketBounds(pMin: bigint, growth: bigint, id: number): { lo: bigint; hi: bigint } {
  const SCALE = 10n ** 18n;
  let lo = pMin;
  for (let i = 0; i < id; i++) lo = (lo * growth) / SCALE;
  return { lo, hi: (lo * growth) / SCALE };
}

async function main(): Promise<void> {
  const m1 = JSON.parse(readFileSync("testnet-m1-state.json", "utf8")) as M1State;
  const config = JSON.parse(readFileSync("quetzal.config.json", "utf8")) as Qconfig;
  const addrToKey: Record<string, string> = {
    [config.tUSDC.toLowerCase()]: "tUSDC", [config.tETH.toLowerCase()]: "tETH",
  };
  if (config.tBTC) addrToKey[config.tBTC.toLowerCase()] = "tBTC";

  const raw = createAztecNodeClient(NODE_URL);
  await waitForNode(raw);
  const sL2 = process.env.STATIC_MAX_FEE_PER_L2_GAS;
  const sDa = process.env.STATIC_MAX_FEE_PER_DA_GAS ?? "0";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const node: any = sL2 ? new Proxy(raw as any, { get(t, p, r) {
    if (p === "getCurrentMinFees") return async () => new GasFees(BigInt(sDa), BigInt(sL2));
    const v = Reflect.get(t, p, r); return typeof v === "function" ? v.bind(t) : v;
  } }) : raw;

  const wallet = await EmbeddedWallet.create(node, {
    ephemeral: false, pxe: { proverEnabled: false, dataDirectory: PXE_DIR },
  });
  const mgr = await wallet.createSchnorrAccount(Fr.fromString(m1.secret), Fr.fromString(m1.salt), Fq.fromString(m1.signingKey));
  const admin = (await mgr.getAccount()).getAddress();
  console.log(`node=${NODE_URL}  admin=${admin.toString().slice(0, 12)}…`);

  const pMin = BigInt(config.bucketPMinSqrt);
  const growth = BigInt(config.bucketGrowthNum);

  for (const pe of config.pools) {
    const pool = await LiquidityPoolContract.at(AztecAddress.fromStringUnsafe(pe.address), wallet);
    const ps = ((await pool.methods.get_pool_state().simulate({ from: admin })) as { result: Record<string, bigint | number> }).result;
    const rA = BigInt(ps.reserve_a), rB = BigInt(ps.reserve_b), sp = BigInt(ps.current_sqrt_price);
    const aKey = addrToKey[pe.token_a.toLowerCase()] ?? "?", bKey = addrToKey[pe.token_b.toLowerCase()] ?? "?";
    // which bucket is the price in?
    let priceBucket = -1;
    for (let i = 0; i < NUM_BUCKETS; i++) { const b = bucketBounds(pMin, growth, i); if (sp >= b.lo && sp < b.hi) { priceBucket = i; break; } }
    const twoSided = rB > 0n;
    console.log(`\n=== pool ${pe.pool_id}  (token_a=${aKey}, token_b=${bKey})  ${pe.address.slice(0, 12)}… ===`);
    console.log(`  reserve_a=${rA}  reserve_b=${rB}  sqrt_p=${sp}  priceBucket=${priceBucket}`);
    console.log(`  TWO-SIDED: ${twoSided ? "YES" : "NO (single-sided — reserve_b=0)"}`);
    const funded: string[] = [];
    for (let i = 0; i < NUM_BUCKETS; i++) {
      const b = ((await pool.methods.get_bucket(i).simulate({ from: admin })) as { result: Record<string, bigint | number> }).result;
      const L = BigInt(b.liquidity);
      if (L > 0n) funded.push(`    bucket ${i}: L=${L} rA=${BigInt(b.reserve_a)} rB=${BigInt(b.reserve_b)}`);
    }
    console.log(funded.length ? "  funded buckets:\n" + funded.join("\n") : "  funded buckets: NONE (pool empty)");
  }
  const stop = (wallet as unknown as { stop?: () => Promise<void> }).stop;
  if (typeof stop === "function") await stop.call(wallet);
}
main().catch((e) => { console.error(e); process.exit(1); });
