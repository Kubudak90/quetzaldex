#!/usr/bin/env node
// resume-on-recovery.ts — run THE MOMENT the Aztec testnet resumes block production.
// One-shot assessment: is it the SAME network (contracts intact) or a RESET, and
// exactly what claim-fill state we're in. Uses an EPHEMERAL PXE (no orphaned anchor
// from the reorg). Read-only. Default node = drpc (works while aztec-labs is down).
//
//   AZTEC_NODE_URL=https://aztec-testnet.drpc.org pnpm tsx scripts/resume-on-recovery.ts
import { readFileSync } from "node:fs";
import { Fr, Fq } from "@aztec/aztec.js/fields";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { createAztecNodeClient, waitForNode } from "@aztec/aztec.js/node";
import { EmbeddedWallet } from "@aztec/wallets/embedded";
import { TokenContract } from "../tests/integration/generated/Token.js";
import { OrderbookContract } from "../tests/integration/generated/Orderbook.js";
import { LiquidityPoolContract } from "../tests/integration/generated/LiquidityPool.js";

const NODE_URL = process.env.AZTEC_NODE_URL ?? "https://aztec-testnet.drpc.org";
const EXPECT_ROLLUP = 4127419662;          // the network our contracts live on
const EXPECT_VK = "0x059e8255eff089dbf5c43c5f44df34f0c046c9212d342b120e4daf170cef83f0".toLowerCase();
const FROZEN_AT = 118673;

async function main() {
  const c = JSON.parse(readFileSync("quetzal.config.json", "utf8"));
  const st = JSON.parse(readFileSync("sub9-e2e-state.json", "utf8"));
  const node = createAztecNodeClient(NODE_URL); await waitForNode(node);
  const info = await node.getNodeInfo();
  const tip = await node.getBlockNumber();
  console.log(`[resume] node=${NODE_URL} rollupVersion=${info.rollupVersion} tip=${tip}`);

  // 1) advancing past the freeze?
  if (tip <= FROZEN_AT) {
    console.log(`[resume] ⛔ tip ${tip} still <= frozen ${FROZEN_AT} — chain NOT resumed yet. Abort.`);
    return;
  }
  console.log(`[resume] ✅ tip advanced past ${FROZEN_AT} → block production RESUMED`);

  // 2) same network?
  if (Number(info.rollupVersion) !== EXPECT_ROLLUP) {
    console.log(`[resume] ⚠️ rollupVersion ${info.rollupVersion} != ${EXPECT_ROLLUP} → TESTNET RESET / NEW NETWORK.`);
    console.log(`[resume]    → our contracts are gone. Re-run the full cascade deploy (redeploy-orderbook-only.ts) + re-seed + re-cutover.`);
    return;
  }
  console.log(`[resume] ✅ same network (rollupVersion ${EXPECT_ROLLUP})`);

  // Ephemeral PXE → clean reads (no reorg-orphaned anchor). Re-derive sub9 acct for `from`.
  const wallet = await EmbeddedWallet.create(node, { ephemeral: true, pxe: { proverEnabled: false } });
  const am = await wallet.createSchnorrAccount(Fr.fromString(st.childSecret), Fr.fromString(st.childSalt), Fq.fromString(st.childSigningKey));
  const from = (await am.getAccount()).getAddress();

  // 3) contracts intact?
  try {
    const ob = await OrderbookContract.at(AztecAddress.fromStringUnsafe(c.orderbook), wallet);
    const vk = (await ob.methods.get_clearing_vk_hash().simulate({ from })) as { result?: bigint } | bigint;
    const vkVal = typeof vk === "object" && vk && "result" in vk ? (vk as { result: bigint }).result : vk;
    const vkHex = "0x" + BigInt(vkVal as bigint).toString(16).padStart(64, "0");
    console.log(`[resume] orderbook ${c.orderbook.slice(0,12)} vk_hash=${vkHex} ${vkHex.toLowerCase() === EXPECT_VK ? "✅ matches (intact)" : "⚠️ MISMATCH"}`);
    const fr = (await ob.methods.get_fills_root(5).simulate({ from })) as { result?: bigint } | bigint;
    const frVal = typeof fr === "object" && fr && "result" in fr ? (fr as { result: bigint }).result : fr;
    console.log(`[resume] fills_root(5)=${frVal}  (non-zero = epoch-5 clearing survived; 0 = reorged away, aggregator will re-clear order 0x0051e43d)`);
  } catch (e) {
    console.log(`[resume] ⚠️ orderbook read FAILED (${(e as Error).message.slice(0,100)}) → contracts likely gone → redeploy.`);
    await wallet.stop(); return;
  }

  // 4) pool 0 + orderbook balances (claim readiness)
  const pool0 = await LiquidityPoolContract.at(AztecAddress.fromStringUnsafe(c.pools[0].address), wallet);
  const ps = (await pool0.methods.get_pool_state().simulate({ from })) as { result: Record<string, bigint> };
  console.log(`[resume] pool0 reserve_a(tETH)=${BigInt(ps.result.reserve_a)} reserve_b(tUSDC)=${BigInt(ps.result.reserve_b)}`);
  const tETH = await TokenContract.at(AztecAddress.fromStringUnsafe(c.tETH), wallet);
  const obTeth = BigInt(((await tETH.methods.balance_of_public(AztecAddress.fromStringUnsafe(c.orderbook)).simulate({ from })) as { result: bigint }).result);
  console.log(`[resume] orderbook public tETH=${obTeth}`);

  console.log(`\n[resume] VERDICT: same network + contracts intact. Next:`);
  console.log(`  • restart aggregator (drpc) if not running; let it re-clear epoch with the CONSERVATION-FIXED code`);
  console.log(`  • place a fresh order (sub9 smoke) OR claim the re-cleared order → claim-fill-e2e.ts (amount_out should == aFromPool, no topup needed)`);
  console.log(`  • then cancel_order test + frontend cutover`);
  await wallet.stop();
}
main().catch((e) => { console.error("[resume] FAIL:", e); process.exit(1); });
