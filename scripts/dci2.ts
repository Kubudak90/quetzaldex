import { poseidon2Hash } from "../node_modules/.pnpm/@aztec+foundation@4.3.0/node_modules/@aztec/foundation/dest/crypto/poseidon/index.js";
const owner = 0x2253611df01455a48400476b293f2ac86f38fd8977a78e7cfff7ac467b85fce2n;
const order_nonce = 0x00fa6fa5b821e90e0697382a14a235ea6baa1291cb374e0f61323f0276bf785en;
const tUSDC = 0x2365f7da7668d8471b387f2a6946359cd431d3ed6f5af5cf227b4d26f6277a50n;
const tETH = 0x2f295ee5dff385343675815acec5e3cbd21c64d37062e3186eec10ee983f5a73n;
const TARGET_AGG = "0x2f94cbb1f77748b7af565ed1a561200aedf692e6f339c3e10ef4d6b653f3f9b1";
const ONCHAIN = "0x1d944e6db11bf1a838fe415a87ecfdeca01bc50b36c8ae1ade60e3c1b4f73df7";
async function fold(sab: bigint, plen: bigint, p0: bigint, p1: bigint, p2: bigint) {
  const c = await poseidon2Hash([owner, 1n, 1000000n, 1000000000000000n, order_nonce, sab, plen, p0, p1, p2]);
  return (await poseidon2Hash([0n, c.toBigInt()])).toBigInt();
}
const hex = (b: bigint) => "0x" + b.toString(16).padStart(64, "0");
const combos: [string, bigint, bigint, bigint, bigint, bigint][] = [
  ["sab=102099 path[tETH,tUSDC]", 102099n, 2n, tETH, tUSDC, 0n],
  ["sab=102099 path[0,0,0]", 102099n, 2n, 0n, 0n, 0n],
  ["sab=102100 path[tETH,tUSDC]", 102100n, 2n, tETH, tUSDC, 0n],
  ["sab=102100 path[0,0,0]", 102100n, 2n, 0n, 0n, 0n],
  ["sab=102099 path[tUSDC,tETH]", 102099n, 2n, tUSDC, tETH, 0n],
];
for (const [l, sab, pl, p0, p1, p2] of combos) {
  const f = hex(await fold(sab, pl, p0, p1, p2));
  const m = f.toLowerCase() === TARGET_AGG.toLowerCase() ? " == AGG REPLAYED" : (f.toLowerCase() === ONCHAIN.toLowerCase() ? " == ON-CHAIN" : "");
  console.log(l, "->", f.slice(0, 20) + "…", m);
}
