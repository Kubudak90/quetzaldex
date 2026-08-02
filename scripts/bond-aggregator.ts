// Bond the daemon's aggregator wallet (clearing-wallet-state.json, 0x2296) as a
// bonded aggregator on the registry, so close_epoch_and_clear_verified passes the
// `caller is not a bonded aggregator` gate. Admin (minter) funds the bond via
// mint_to_private; the aggregator wallet then calls register().
//
//   AZTEC_NODE_URL=https://rpc.testnet.aztec-labs.com pnpm tsx scripts/bond-aggregator.ts
import { readFileSync } from "node:fs";
import { Fr, Fq } from "@aztec/aztec.js/fields";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { createAztecNodeClient, waitForNode } from "@aztec/aztec.js/node";
import { EmbeddedWallet } from "@aztec/wallets/embedded";
import { QuetzalClient } from "../sdk/src/index.js";
import { TokenContract } from "../tests/integration/generated/Token.js";
import { AggregatorRegistryContract } from "../tests/integration/generated/AggregatorRegistry.js";

const NODE = process.env.AZTEC_NODE_URL ?? "https://rpc.testnet.aztec-labs.com";
const cfg = JSON.parse(readFileSync("quetzal.config.json", "utf8"));
const m1 = JSON.parse(readFileSync("testnet-m1-state.json", "utf8"));
const agg = JSON.parse(readFileSync("clearing-wallet-state.json", "utf8"));
const AGG_URL = process.env.AGG_URL ?? "http://194.163.136.1:3001";

const node = createAztecNodeClient(NODE);
await waitForNode(node);

async function reg(w: any, addr: AztecAddress, artifact: any) {
  const inst = await (node as any).getContract(addr);
  if (inst && w.registerContract) await w.registerContract(inst, artifact);
}

// admin (minter)
const adminWallet = await EmbeddedWallet.create(node, { ephemeral: true, pxe: { proverEnabled: true } });
const adminAcct = await adminWallet.createSchnorrAccount(
  Fr.fromString(m1.secret), Fr.fromString(m1.salt), Fq.fromString(m1.signingKey));
const admin = (await adminAcct.getAccount()).getAddress();

// aggregator wallet (0x2296 — the daemon's submitter)
const aggWallet = await EmbeddedWallet.create(node, { ephemeral: true, pxe: { proverEnabled: true } });
const aggAcct = await aggWallet.createSchnorrAccount(
  Fr.fromString(agg.secret), Fr.fromString(agg.salt), Fq.fromString(agg.signingKey));
const aggAddr = (await aggAcct.getAccount()).getAddress();
console.log("admin:", admin.toString());
console.log("aggregator:", aggAddr.toString());

const regAddr = AztecAddress.fromStringUnsafe(cfg.aggregatorRegistry);
await reg(adminWallet, regAddr, (AggregatorRegistryContract as any).artifact);
const registry = await AggregatorRegistryContract.at(regAddr, adminWallet);

const bondAmount = BigInt(
  (await registry.methods.get_bond_amount().simulate({ from: admin })).result);
const isReg = (await registry.methods.is_registered(aggAddr).simulate({ from: admin })).result;
console.log("bond_amount:", bondAmount.toString(), "| 0x2296 already registered:", isReg);

if (isReg) {
  console.log("already registered — nothing to do.");
} else {
  // admin mints the bond to the aggregator's PUBLIC balance (public state — no
  // cross-PXE note discovery needed).
  const tUSDCAddr = AztecAddress.fromStringUnsafe(cfg.tUSDC);
  await reg(adminWallet, tUSDCAddr, (TokenContract as any).artifact);
  const tUSDCAdmin = await TokenContract.at(tUSDCAddr, adminWallet);
  console.log(`minting ${bondAmount} tUSDC -> 0x2296 (public) ...`);
  await tUSDCAdmin.methods.mint_to_public(aggAddr, bondAmount).send({ from: admin });
  console.log("mint_to_public OK");

  // 0x2296 self-moves public -> private (its OWN PXE creates the note, so it
  // sees the balance the register escrow needs).
  await reg(aggWallet, tUSDCAddr, (TokenContract as any).artifact);
  const tUSDCAgg = await TokenContract.at(tUSDCAddr, aggWallet);
  console.log(`0x2296 transfer_public_to_private(${bondAmount}) ...`);
  await tUSDCAgg.methods.transfer_public_to_private(aggAddr, aggAddr, bondAmount, 0).send({ from: aggAddr });
  console.log("public->private OK");

  // aggregator registers (escrows the bond).
  const client = await QuetzalClient.connect({
    network: "alpha-testnet",
    nodeUrl: NODE,
    account: { type: "external-pxe", wallet: aggWallet, address: aggAddr } as never,
    l1: cfg.l1 as never,
    contracts: {
      orderbook: cfg.orderbook, tUSDC: cfg.tUSDC, tETH: cfg.tETH, tBTC: cfg.tBTC,
      pools: cfg.pools, treasury: cfg.treasury, aggregatorRegistry: cfg.aggregatorRegistry,
    },
  });
  console.log("registering 0x2296 as bonded aggregator ...");
  const r = await client.aggregator.register({ url: AGG_URL });
  console.log("register OK:", JSON.stringify(r));
}

// confirm
const bondedAfter = BigInt(
  (await registry.methods.get_bonded_amount(aggAddr).simulate({ from: admin })).result);
console.log("bonded_amount(0x2296) AFTER:", bondedAfter.toString(),
  bondedAfter > 0n ? "✅ BONDED" : "❌ still 0");
