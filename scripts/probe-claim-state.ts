#!/usr/bin/env node
// probe-claim-state.ts — diagnose claim_fill payout underflow.
// Checks: orderbook.get_fills_root(epoch), pool 0 reserves, and public token
// balances of orderbook + treasury for tETH (token A) + tUSDC (token B).
import { readFileSync } from "node:fs";
import { Fr, Fq } from "@aztec/aztec.js/fields";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { createAztecNodeClient, waitForNode } from "@aztec/aztec.js/node";
import { EmbeddedWallet } from "@aztec/wallets/embedded";
import { TokenContract } from "../tests/integration/generated/Token.js";
import { OrderbookContract } from "../tests/integration/generated/Orderbook.js";
import { LiquidityPoolContract } from "../tests/integration/generated/LiquidityPool.js";

const NODE_URL = process.env.AZTEC_NODE_URL ?? "https://rpc.testnet.aztec-labs.com";
const EPOCH = Number(process.env.EPOCH ?? "5");

async function pub(token: TokenContract, who: AztecAddress, from: AztecAddress): Promise<bigint> {
  return BigInt(((await token.methods.balance_of_public(who).simulate({ from })) as { result: bigint }).result);
}

async function main() {
  const c = JSON.parse(readFileSync("quetzal.config.json", "utf8"));
  const st = JSON.parse(readFileSync("sub9-e2e-state.json", "utf8"));
  const node = createAztecNodeClient(NODE_URL); await waitForNode(node);
  const wallet = await EmbeddedWallet.create(node, { ephemeral: false, pxe: { proverEnabled: false, dataDirectory: "./sub9-e2e-pxe" } });
  const am = await wallet.createSchnorrAccount(Fr.fromString(st.childSecret), Fr.fromString(st.childSalt), Fq.fromString(st.childSigningKey));
  const from = (await am.getAccount()).getAddress();
  console.log(`[probe] nodeTip=${await node.getBlockNumber()} epoch=${EPOCH}`);

  const ob = await OrderbookContract.at(AztecAddress.fromStringUnsafe(c.orderbook), wallet);
  const fr = (await ob.methods.get_fills_root(EPOCH).simulate({ from })) as { result?: unknown } | bigint;
  const frVal = typeof fr === "object" && fr !== null && "result" in fr ? (fr as { result: unknown }).result : fr;
  console.log(`[probe] orderbook.get_fills_root(${EPOCH}) = ${frVal}  (0 => no clearing recorded)`);

  const pool0 = await LiquidityPoolContract.at(AztecAddress.fromStringUnsafe(c.pools[0].address), wallet);
  const ps = (await pool0.methods.get_pool_state().simulate({ from })) as { result: Record<string, bigint> };
  console.log(`[probe] pool0 reserve_a(tETH)=${BigInt(ps.result.reserve_a)} reserve_b(tUSDC)=${BigInt(ps.result.reserve_b)} sqrt_p=${BigInt(ps.result.current_sqrt_price)}`);

  const tETH = await TokenContract.at(AztecAddress.fromStringUnsafe(c.tETH), wallet);
  const tUSDC = await TokenContract.at(AztecAddress.fromStringUnsafe(c.tUSDC), wallet);
  const obAddr = AztecAddress.fromStringUnsafe(c.orderbook);
  const trAddr = AztecAddress.fromStringUnsafe(c.treasury);
  console.log(`[probe] ORDERBOOK ${c.orderbook.slice(0,12)} public tETH=${await pub(tETH, obAddr, from)}  tUSDC=${await pub(tUSDC, obAddr, from)}`);
  console.log(`[probe] TREASURY  ${c.treasury.slice(0,12)} public tETH=${await pub(tETH, trAddr, from)}  tUSDC=${await pub(tUSDC, trAddr, from)}`);
  console.log(`[probe] (amount_out owed to maker = 99699958 tETH atomic)`);
  await wallet.stop();
}
main().catch((e) => { console.error("[probe] FAIL:", e); process.exit(1); });
