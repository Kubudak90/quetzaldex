// read-only: clearing wallet (0x2296) bonded_amount on the registry + fee-juice.
import { readFileSync } from "node:fs";
import { Fr, Fq } from "@aztec/aztec.js/fields";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { createAztecNodeClient, waitForNode } from "@aztec/aztec.js/node";
import { EmbeddedWallet } from "@aztec/wallets/embedded";
import { AggregatorRegistryContract } from "../tests/integration/generated/AggregatorRegistry.js";
import { TokenContract } from "../tests/integration/generated/Token.js";

const NODE = process.env.AZTEC_NODE_URL!;
const cfg = JSON.parse(readFileSync("quetzal.config.json", "utf8"));
const agg = JSON.parse(readFileSync("clearing-wallet-state.json", "utf8"));
const node = createAztecNodeClient(NODE); await waitForNode(node);
const w = await EmbeddedWallet.create(node, { ephemeral: true, pxe: { proverEnabled: false } });
const acct = await w.createSchnorrAccount(Fr.fromString(agg.secret), Fr.fromString(agg.salt), Fq.fromString(agg.signingKey));
const addr = (await acct.getAccount()).getAddress();
console.log("clearing wallet:", addr.toString());
const regAddr = AztecAddress.fromStringUnsafe(cfg.aggregatorRegistry ?? cfg.registry);
console.log("registry:", regAddr.toString());
const inst = await (node as any).getContract(regAddr);
if (inst && (w as any).registerContract) await (w as any).registerContract(inst, (AggregatorRegistryContract as any).artifact);
const registry = await AggregatorRegistryContract.at(regAddr, w);
try {
  const bonded = BigInt((await registry.methods.get_bonded_amount(addr).simulate({ from: addr })).result);
  console.log("bonded_amount:", bonded.toString(), bonded > 0n ? "BONDED ✅" : "NOT BONDED ❌");
} catch (e) { console.log("bond read failed:", (e as Error).message.slice(0, 160)); }
try {
  const { ProtocolContractAddress } = await import("@aztec/protocol-contracts");
  const fj = await TokenContract.at(ProtocolContractAddress.FeeJuice, w);
  const bal = BigInt((await fj.methods.balance_of_public(addr).simulate({ from: addr })).result);
  console.log("feeJuice public:", bal.toString(), bal > 0n ? "FUNDED ✅" : "ZERO ❌");
} catch (e) { console.log("fj read failed:", (e as Error).message.slice(0, 160)); }
await w.stop();
