// Debug: which (path, submitted_at_block) reproduces the on-chain order_acc?
// on_chain_order_acc (1 order) = poseidon2([0, c_i]). computeCi = poseidon2([
//   owner, side, amount_in, limit_price, order_nonce, submitted_at_block,
//   path_len, path0, path1, path2 ]).
import { poseidon2Hash } from "../node_modules/.pnpm/@aztec+foundation@4.3.0/node_modules/@aztec/foundation/dest/crypto/poseidon/index.js";

const ON_CHAIN_ORDER_ACC = "0x26ed2a46d4ee1d7fd5e91b1768939370f4701872088b4229684deeef394d1d22";
const AGG_REPLAYED       = "0x1e2fc37234bd3c5cc9d562acc00242199aa94cf56e97d906bff801b65088e697";

const owner = 0x2253611df01455a48400476b293f2ac86f38fd8977a78e7cfff7ac467b85fce2n;
const side = 1n;
const amount_in = 1000000n;
const limit_price = 1000000000000000n;
const order_nonce = 0x00467b684ac12cce7d65e35e9157c18647cc8dd5f0f273c3551d4b7027343fefn;
const tUSDC = 0x2365f7da7668d8471b387f2a6946359cd431d3ed6f5af5cf227b4d26f6277a50n;
const tETH  = 0x2f295ee5dff385343675815acec5e3cbd21c64d37062e3186eec10ee983f5a73n;

async function ci(sab: bigint, plen: bigint, p0: bigint, p1: bigint, p2: bigint): Promise<bigint> {
  const c = await poseidon2Hash([owner, side, amount_in, limit_price, order_nonce, sab, plen, p0, p1, p2]);
  const acc = await poseidon2Hash([0n, c.toBigInt()]);
  return acc.toBigInt();
}
const hex = (b: bigint) => "0x" + b.toString(16).padStart(64, "0");

// Candidate paths
const paths: Array<[string, bigint, bigint, bigint, bigint]> = [
  ["default[0,0,0] len2", 2n, 0n, 0n, 0n],
  ["canonical[tETH,tUSDC] len2", 2n, tETH, tUSDC, 0n],
  ["[tUSDC,tETH] len2", 2n, tUSDC, tETH, 0n],
];

console.log("target on_chain_order_acc:", ON_CHAIN_ORDER_ACC);
console.log("agg replayed (sab=101794,path=0):", AGG_REPLAYED);
// sanity: reproduce the aggregator's replayed value
console.log("repro default sab=101794:", hex(await ci(101794n, 2n, 0n, 0n, 0n)));
console.log("--- brute force ---");
let found = false;
for (const [label, plen, p0, p1, p2] of paths) {
  for (let sab = 101770n; sab <= 101800n; sab++) {
    const acc = hex(await ci(sab, plen, p0, p1, p2));
    if (acc.toLowerCase() === ON_CHAIN_ORDER_ACC.toLowerCase()) {
      console.log(`*** MATCH: path=${label} submitted_at_block=${sab} ***`);
      found = true;
    }
  }
}
if (!found) console.log("no match in sab range 101770..101800 for tested paths");
