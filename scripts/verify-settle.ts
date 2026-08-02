// Verify the #1 settlement fix: does computeCi(the new reveal) fold to the
// on-chain order_acc? If yes, the aggregator's clearing replay WILL match.
import { readFileSync } from "node:fs";
import { Fr, Fq } from "@aztec/aztec.js/fields";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { createAztecNodeClient, waitForNode } from "@aztec/aztec.js/node";
import { EmbeddedWallet } from "@aztec/wallets/embedded";
import { poseidon2Hash } from "../node_modules/.pnpm/@aztec+foundation@4.3.0/node_modules/@aztec/foundation/dest/crypto/poseidon/index.js";
import { OrderbookContract } from "../tests/integration/generated/Orderbook.js";

const NODE = process.env.AZTEC_NODE_URL ?? "https://rpc.testnet.aztec-labs.com";
const m1 = JSON.parse(readFileSync("testnet-m1-state.json", "utf8"));
const cfg = JSON.parse(readFileSync("quetzal.config.json", "utf8"));
const st = JSON.parse(readFileSync("sub9-e2e-smoke-nethermind-state.json", "utf8"));
const rp = st.revealPayload;
if (!rp) throw new Error("no revealPayload in smoke state");

const node = createAztecNodeClient(NODE);
await waitForNode(node);
const wallet = await EmbeddedWallet.create(node, { ephemeral: true, pxe: { proverEnabled: true } });
const am = await wallet.createSchnorrAccount(Fr.fromString(m1.secret), Fr.fromString(m1.salt), Fq.fromString(m1.signingKey));
const admin = (await am.getAccount()).getAddress();
const obAddr = AztecAddress.fromStringUnsafe(cfg.orderbook);
const inst = await (node as any).getContract(obAddr);
if (inst && typeof (wallet as any).registerContract === "function") {
  await (wallet as any).registerContract(inst, (OrderbookContract as any).artifact);
}
const ob = await OrderbookContract.at(obAddr, wallet);
const sim: any = await ob.methods.get_epoch().simulate({ from: admin });
const ep = sim.result ?? sim;
const onChainAcc = BigInt(ep.order_acc?.toString?.() ?? ep.order_acc);
const orderCount = Number(ep.order_count ?? 0);
const epochId = Number(ep.epoch_id ?? 0);

// computeCi(reveal) — byte-identical to aggregator/src/validate.ts + the contract
const ci = (await poseidon2Hash([
  BigInt(rp.owner),
  rp.side ? 1n : 0n,
  BigInt(rp.amount_in),
  BigInt(rp.limit_price),
  BigInt(rp.order_nonce),
  BigInt(rp.submitted_at_block),
  BigInt(rp.path_len),
  BigInt(rp.path[0]),
  BigInt(rp.path[1]),
  BigInt(rp.path[2]),
])).toBigInt();
const folded = (await poseidon2Hash([0n, ci])).toBigInt();
const hex = (b: bigint) => "0x" + b.toString(16).padStart(64, "0");

console.log("on-chain epoch_id:", epochId, "order_count:", orderCount);
console.log("on-chain order_acc:", hex(onChainAcc));
console.log("computeCi(reveal):", hex(ci));
console.log("folded poseidon2([0,ci]):", hex(folded));
console.log("reveal submitted_at_block:", rp.submitted_at_block, "(mined was", st.submittedOrder?.blockNumber, ")");
if (orderCount === 1 && folded === onChainAcc) {
  console.log("✅ MATCH — reveal reproduces on-chain order_acc → aggregator clearing WILL settle this order.");
} else if (orderCount !== 1) {
  console.log(`(order_count=${orderCount}; single-order fold check only valid when count==1)`);
} else {
  console.log("❌ MISMATCH — reveal does NOT reproduce on-chain order_acc.");
}
