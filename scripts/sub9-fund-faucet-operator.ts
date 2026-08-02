#!/usr/bin/env node
//
// Sub-9.1 fix: seed the faucet operator (= admin) with public tUSDC + tETH
// for the freshly-redeployed Sub-9 tokens. Without this seed, the faucet's
// drain detection (`tUSDCBal < tUSDCAmount * drainThresholdMultiplier`) trips
// and every /api/drip returns 503 "faucet drained".
//
// We mint to PUBLIC balance because the faucet's checkDrained() reads
// `balance_of_public(operator)`.
//
// Idempotent: skips minting when admin's public balance already meets the
// drain floor (10× per-drip amount).
//
import { readFileSync } from "node:fs";
import { Fr, Fq } from "@aztec/aztec.js/fields";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { createAztecNodeClient, waitForNode } from "@aztec/aztec.js/node";
import { EmbeddedWallet } from "@aztec/wallets/embedded";
import { TokenContract } from "../tests/integration/generated/Token.js";

const NODE_URL = process.env.AZTEC_NODE_URL ?? "https://rpc.testnet.aztec-labs.com";
if (!NODE_URL.includes("testnet")) {
  throw new Error(`AZTEC_NODE_URL must contain 'testnet' (safety check). Got: ${NODE_URL}`);
}

const M1_STATE = "testnet-m1-state.json";
const CONFIG   = "quetzal.config.json";
const PXE_DIR  = process.env.SEED_LP_PXE_DIR ?? "./testnet-m4-pxe";

// Match faucet's per-drip + drain-threshold defaults so that one fund call
// keeps the faucet healthy for tens of drips.
const TUSDC_PUBLIC = 10n * 1_000n * 1_000_000n;            // 10_000 tUSDC (atomic, 6 dec)
const TETH_PUBLIC  = 10n * 5n * (10n ** 17n);              // 5 tETH    (atomic, 18 dec → 5e18 = 5 tETH)
// tUSDC drain floor = 1e9 * 10 = 1e10 atomic. We mint 10K tUSDC = 1e10. Match.
// tETH  drain floor = 5e17 * 10 = 5e18 atomic. We mint 5 tETH      = 5e18. Match.

async function readPublicBalance(token: TokenContract, owner: AztecAddress): Promise<bigint> {
  const sim = await token.methods.balance_of_public(owner).simulate({ from: owner });
  return BigInt((sim as { result: bigint | number }).result);
}

interface M1State { secret: string; salt: string; signingKey: string; address: string; }
interface QConfig { admin: string; tUSDC: string; tETH: string; }

async function main(): Promise<void> {
  const m1 = JSON.parse(readFileSync(M1_STATE, "utf8")) as M1State;
  const cfg = JSON.parse(readFileSync(CONFIG, "utf8")) as QConfig;

  const node = createAztecNodeClient(NODE_URL);
  await waitForNode(node);
  console.log(`[fund-faucet] node OK; node block=${await (node as unknown as { getBlockNumber: () => Promise<number> }).getBlockNumber()}`);

  const wallet = await EmbeddedWallet.create(node, {
    ephemeral: false,
    pxe: { proverEnabled: true, dataDirectory: PXE_DIR },
  });
  const secret    = Fr.fromString(m1.secret);
  const salt      = Fr.fromString(m1.salt);
  const signingKey = Fq.fromString(m1.signingKey);
  const accountMgr = await wallet.createSchnorrAccount(secret, salt, signingKey);
  const admin = (await accountMgr.getAccount()).getAddress();
  if (admin.toString().toLowerCase() !== cfg.admin.toLowerCase()) {
    throw new Error(`admin mismatch: derived ${admin} vs config ${cfg.admin}`);
  }
  console.log(`[fund-faucet] admin: ${admin.toString()}`);

  const tUSDC = await TokenContract.at(AztecAddress.fromStringUnsafe(cfg.tUSDC), wallet);
  const tETH  = await TokenContract.at(AztecAddress.fromStringUnsafe(cfg.tETH ), wallet);

  const balUSDC = await readPublicBalance(tUSDC, admin);
  console.log(`[fund-faucet] admin tUSDC public balance: ${balUSDC}`);
  if (balUSDC < TUSDC_PUBLIC) {
    const need = TUSDC_PUBLIC - balUSDC;
    console.log(`[fund-faucet]   minting ${need} tUSDC public to admin ...`);
    const t0 = Date.now();
    await tUSDC.methods.mint_to_public(admin, need).send({ from: admin });
    console.log(`[fund-faucet]   minted (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  } else {
    console.log(`[fund-faucet]   already above floor; skipping`);
  }

  const balETH = await readPublicBalance(tETH, admin);
  console.log(`[fund-faucet] admin tETH  public balance: ${balETH}`);
  if (balETH < TETH_PUBLIC) {
    const need = TETH_PUBLIC - balETH;
    console.log(`[fund-faucet]   minting ${need} tETH  public to admin ...`);
    const t0 = Date.now();
    await tETH.methods.mint_to_public(admin, need).send({ from: admin });
    console.log(`[fund-faucet]   minted (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  } else {
    console.log(`[fund-faucet]   already above floor; skipping`);
  }

  const balUSDCAfter = await readPublicBalance(tUSDC, admin);
  const balETHAfter  = await readPublicBalance(tETH,  admin);
  console.log(`[fund-faucet] DONE. admin public balances: tUSDC=${balUSDCAfter} tETH=${balETHAfter}`);

  await wallet.stop();
}

main().catch((e) => {
  console.error(`[fund-faucet] FAILED:`, e);
  process.exit(1);
});
