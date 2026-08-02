#!/usr/bin/env node
// probe-balances.ts — read sub9 child wallet's fee-juice + tUSDC/tETH (public+private).
import { readFileSync } from "node:fs";
import { Fr, Fq } from "@aztec/aztec.js/fields";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { createAztecNodeClient, waitForNode } from "@aztec/aztec.js/node";
import { EmbeddedWallet } from "@aztec/wallets/embedded";
import { TokenContract } from "../tests/integration/generated/Token.js";

const NODE_URL = process.env.AZTEC_NODE_URL ?? "https://rpc.testnet.aztec-labs.com";
async function main() {
  const config = JSON.parse(readFileSync("quetzal.config.json", "utf8"));
  const state = JSON.parse(readFileSync("sub9-e2e-state.json", "utf8"));
  const node = createAztecNodeClient(NODE_URL); await waitForNode(node);
  const wallet = await EmbeddedWallet.create(node, { ephemeral: false, pxe: { proverEnabled: false, dataDirectory: "./sub9-e2e-pxe" } });
  const am = await wallet.createSchnorrAccount(Fr.fromString(state.childSecret), Fr.fromString(state.childSalt), Fq.fromString(state.childSigningKey));
  const addr = (await am.getAccount()).getAddress();
  console.log(`[probe] child=${addr.toString()}`);

  const tUSDC = await TokenContract.at(AztecAddress.fromStringUnsafe(config.tUSDC), wallet);
  const tETH = await TokenContract.at(AztecAddress.fromStringUnsafe(config.tETH), wallet);
  const pubU = BigInt(((await tUSDC.methods.balance_of_public(addr).simulate({ from: addr })) as { result: bigint }).result);
  const privU = BigInt(((await tUSDC.methods.balance_of_private(addr).simulate({ from: addr })) as { result: bigint }).result);
  const pubE = BigInt(((await tETH.methods.balance_of_public(addr).simulate({ from: addr })) as { result: bigint }).result);
  const privE = BigInt(((await tETH.methods.balance_of_private(addr).simulate({ from: addr })) as { result: bigint }).result);
  console.log(`[probe] tUSDC  public=${pubU}  private=${privU}`);
  console.log(`[probe] tETH   public=${pubE}  private=${privE}`);

  // Fee juice balance via node public storage read on the fee juice contract.
  try {
    const { ProtocolContractAddress } = await import("@aztec/protocol-contracts");
    const feeJuice = await TokenContract.at(ProtocolContractAddress.FeeJuice, wallet);
    const fj = BigInt(((await feeJuice.methods.balance_of_public(addr).simulate({ from: addr })) as { result: bigint }).result);
    console.log(`[probe] feeJuice public=${fj}`);
  } catch (e) {
    console.log(`[probe] feeJuice read failed: ${(e as Error).message.slice(0, 120)}`);
  }
  await wallet.stop();
}
main().catch((e) => { console.error("[probe] FAIL:", e); process.exit(1); });
