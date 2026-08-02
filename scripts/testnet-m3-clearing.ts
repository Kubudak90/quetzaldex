#!/usr/bin/env node
//
// M3: Minimum-viable Sub-2.5+Sub-3 end-to-end on Aztec testnet.
//
// Single-wallet (admin-only) empty-clearing flow:
//   1. Deploy tETH (tUSDC reused from M2)
//   2. Deploy LiquidityPool
//   3. Deploy AggregatorRegistry
//   4. Deploy Orderbook (vk_hash from circuits/clearing/target)
//   5. Deploy Treasury
//   6. pool.set_orderbook
//   7. admin registers as aggregator (bonds tUSDC)
//   8. wait epoch_length blocks (EPOCH_LENGTH=10 for testnet friendliness)
//   9. close_epoch_and_clear_verified with the EMPTY-clearing proof from
//      circuits/clearing/target/proof.bin + vk.bin (from Sub-2.5 Task E1)
//
// SUCCESS = epoch advances from 0 to 1 with no fills, no buckets touched.
//
// Usage: pnpm tsx scripts/testnet-m3-clearing.ts
// State: testnet-m3-state.json
//
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { Fr, Fq } from "@aztec/aztec.js/fields";
import { createAztecNodeClient, waitForNode } from "@aztec/aztec.js/node";
import { EmbeddedWallet } from "@aztec/wallets/embedded";
import { FeeJuicePaymentMethodWithClaim } from "@aztec/aztec.js/fee";
import { TokenContract } from "../tests/integration/generated/Token.js";
import { OrderbookContract } from "../tests/integration/generated/Orderbook.js";
import { LiquidityPoolContract } from "../tests/integration/generated/LiquidityPool.js";
import { AggregatorRegistryContract } from "../tests/integration/generated/AggregatorRegistry.js";
import { TreasuryContract } from "../tests/integration/generated/Treasury.js";

const RPC_URL = "https://rpc.testnet.aztec-labs.com";
const M1_STATE = "testnet-m1-state.json";
const M2_STATE = "testnet-m2-state.json";
const M3_STATE = "testnet-m3-state.json";

// Bucket schema (matches Sub-2 deploy script).
const P_MIN_SQRT = 100_000_000_000_000_000n;          // 0.1e18
const BUCKET_GROWTH_NUM = 1_500_000_000_000_000_000n; // 1.5e18

// Sub-3 economic parameters.
const AGGREGATOR_BOND = 1_000_000_000n;
const TREASURY_SEED   = 1_000_000_000n;
const AGGREGATOR_FEE  = 500_000n;

// Testnet-friendly epoch length (each Aztec block ~24s; 10 blocks ~= 4 min).
const EPOCH_LENGTH = 10;

const TETH_NAME = "tETH".padEnd(31, "\0");
const TETH_SYMBOL = "tETH".padEnd(31, "\0");
const TETH_DECIMALS = 18;

interface M3State {
  step: number;
  tUSDCAddress?: string;   // M3 deploys its own tUSDC (M2's lives in a different PXE)
  tETHAddress?: string;
  poolAddress?: string;
  registryAddress?: string;
  orderbookAddress?: string;
  treasuryAddress?: string;
  registerTx?: string;
  closeEpochTx?: string;
  epochAfterClose?: number;
}

function loadM3State(): M3State {
  if (existsSync(M3_STATE)) return JSON.parse(readFileSync(M3_STATE, "utf8")) as M3State;
  return { step: 0 };
}
function saveM3State(s: M3State) {
  writeFileSync(M3_STATE, JSON.stringify(s, null, 2));
}

function readVkHash(): Fr {
  const buf = readFileSync("circuits/clearing/target/vk.bin/vk_hash");
  if (buf.length !== 32) throw new Error(`expected 32-byte vk_hash, got ${buf.length}`);
  return Fr.fromBuffer(buf as Buffer);
}

async function main() {
  if (!existsSync(M1_STATE)) throw new Error(`${M1_STATE} not found`);
  if (!existsSync(M2_STATE)) throw new Error(`${M2_STATE} not found`);
  const m1 = JSON.parse(readFileSync(M1_STATE, "utf8")) as {
    secret: string; salt: string; signingKey: string; address: string;
  };
  const m2 = JSON.parse(readFileSync(M2_STATE, "utf8")) as {
    tUSDCAddress: string;
  };

  const state = loadM3State();
  console.log(`[M3] starting; resuming from step ${state.step}`);

  const node = createAztecNodeClient(RPC_URL);
  await waitForNode(node);

  // Non-ephemeral so PXE retains contract instances + class metadata across
  // resumed runs (the M3 script does idempotent chunked execution).
  const wallet = await EmbeddedWallet.create(node, {
    ephemeral: false,
    pxe: {
      proverEnabled: true,
      dataDirectory: "./testnet-m3-pxe",
    },
  });

  // Recreate admin from M1 state.
  const secret = Fr.fromString(m1.secret);
  const salt = Fr.fromString(m1.salt);
  const signingKey = Fq.fromString(m1.signingKey);
  const adminManager = await wallet.createSchnorrAccount(secret, salt, signingKey);
  const admin = (await adminManager.getAccount()).getAddress();
  console.log(`[M3] admin: ${admin.toString()}`);

  // Step 0a: deploy tUSDC fresh (M2's lives in a different ephemeral PXE)
  if (!state.tUSDCAddress) {
    console.log(`[M3] step 0a: deploying tUSDC fresh ...`);
    const t0 = Date.now();
    const TUSDC_NAME = "tUSDC".padEnd(31, "\0");
    const TUSDC_SYMBOL = "tUSDC".padEnd(31, "\0");
    const TUSDC_DECIMALS = 6;
    const tUSDCDeploy = await TokenContract.deployWithOpts(
      { wallet, method: "constructor_with_minter" },
      TUSDC_NAME, TUSDC_SYMBOL, TUSDC_DECIMALS, admin,
    ).send({ from: admin });
    state.tUSDCAddress = tUSDCDeploy.contract.address.toString();
    saveM3State(state);
    console.log(`[M3] step 0a OK; tUSDC=${state.tUSDCAddress} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  } else {
    console.log(`[M3] step 0a cached; tUSDC=${state.tUSDCAddress}`);
  }
  const tUSDCAddr = Fr.fromString(state.tUSDCAddress!);
  const tUSDC = await TokenContract.at(tUSDCAddr, wallet);

  // Step 1: deploy tETH
  if (state.step < 1) {
    console.log(`[M3] step 1: deploying tETH ...`);
    const t0 = Date.now();
    const tETHDeploy = await TokenContract.deployWithOpts(
      { wallet, method: "constructor_with_minter" },
      TETH_NAME, TETH_SYMBOL, TETH_DECIMALS, admin,
    ).send({ from: admin });
    state.tETHAddress = tETHDeploy.contract.address.toString();
    state.step = 1;
    saveM3State(state);
    console.log(`[M3] step 1 OK; tETH=${state.tETHAddress} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  } else {
    console.log(`[M3] step 1 cached; tETH=${state.tETHAddress}`);
  }
  const tETHAddr = Fr.fromString(state.tETHAddress!);

  // Step 2: deploy Pool
  if (state.step < 2) {
    console.log(`[M3] step 2: deploying LiquidityPool ...`);
    const t0 = Date.now();
    const poolDeploy = await LiquidityPoolContract.deploy(
      wallet, tUSDCAddr, tETHAddr, P_MIN_SQRT, BUCKET_GROWTH_NUM,
      admin, // Audit-#3: deploy-time admin; only this address may call set_orderbook
    ).send({ from: admin });
    state.poolAddress = poolDeploy.contract.address.toString();
    state.step = 2;
    saveM3State(state);
    console.log(`[M3] step 2 OK; pool=${state.poolAddress} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  } else {
    console.log(`[M3] step 2 cached; pool=${state.poolAddress}`);
  }
  const poolAddr = Fr.fromString(state.poolAddress!);

  // Step 3: deploy AggregatorRegistry
  if (state.step < 3) {
    console.log(`[M3] step 3: deploying AggregatorRegistry ...`);
    const t0 = Date.now();
    const regDeploy = await AggregatorRegistryContract.deploy(
      wallet, tUSDCAddr, AGGREGATOR_BOND,
    ).send({ from: admin });
    state.registryAddress = regDeploy.contract.address.toString();
    state.step = 3;
    saveM3State(state);
    console.log(`[M3] step 3 OK; registry=${state.registryAddress} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  } else {
    console.log(`[M3] step 3 cached; registry=${state.registryAddress}`);
  }
  const registryAddr = Fr.fromString(state.registryAddress!);

  // Step 4: deploy Orderbook (with vk_hash from local circuits/clearing/target/)
  if (state.step < 4) {
    console.log(`[M3] step 4: deploying Orderbook (vk_hash bound) ...`);
    const t0 = Date.now();
    const vkHash = readVkHash();
    const obDeploy = await OrderbookContract.deploy(
      wallet,
      tUSDCAddr, tETHAddr,
      EPOCH_LENGTH,
      poolAddr,
      vkHash,
      registryAddr,
      admin,                // placeholder treasury (same MVP wart as Sub-3)
      AGGREGATOR_FEE,
    ).send({ from: admin });
    state.orderbookAddress = obDeploy.contract.address.toString();
    state.step = 4;
    saveM3State(state);
    console.log(`[M3] step 4 OK; orderbook=${state.orderbookAddress} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  } else {
    console.log(`[M3] step 4 cached; orderbook=${state.orderbookAddress}`);
  }
  const orderbookAddr = Fr.fromString(state.orderbookAddress!);

  // Step 5: deploy Treasury
  if (state.step < 5) {
    console.log(`[M3] step 5: deploying Treasury ...`);
    const t0 = Date.now();
    const trDeploy = await TreasuryContract.deploy(
      wallet, tUSDCAddr, orderbookAddr, admin,
    ).send({ from: admin });
    state.treasuryAddress = trDeploy.contract.address.toString();
    state.step = 5;
    saveM3State(state);
    console.log(`[M3] step 5 OK; treasury=${state.treasuryAddress} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  } else {
    console.log(`[M3] step 5 cached; treasury=${state.treasuryAddress}`);
  }

  // Step 6: pool.set_orderbook
  const pool = await LiquidityPoolContract.at(poolAddr, wallet);
  if (state.step < 6) {
    console.log(`[M3] step 6: pool.set_orderbook ...`);
    const t0 = Date.now();
    await pool.methods.set_orderbook(orderbookAddr).send({ from: admin });
    state.step = 6;
    saveM3State(state);
    console.log(`[M3] step 6 OK (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  } else {
    console.log(`[M3] step 6 cached`);
  }

  // Step 7: mint tUSDC to admin's PRIVATE balance (registry.register does
  // transfer_private_to_public, so admin needs private notes worth the bond).
  if (state.step < 7) {
    console.log(`[M3] step 7: minting tUSDC to admin (PRIVATE) for aggregator bond ...`);
    const t0 = Date.now();
    await tUSDC.methods.mint_to_private(admin, AGGREGATOR_BOND).send({ from: admin });
    console.log(`[M3] step 7 OK; minted ${AGGREGATOR_BOND} to admin PRIVATE (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
    state.step = 7;
    saveM3State(state);
  } else {
    console.log(`[M3] step 7 cached`);
  }

  // Step 8: admin registers as aggregator (needs tUSDC PRIVATE balance >= bond).
  const registry = await AggregatorRegistryContract.at(registryAddr, wallet);
  if (state.step < 8) {
    console.log(`[M3] step 8: aggregator register (bond=${AGGREGATOR_BOND}) ...`);
    const t0 = Date.now();
    // Standard Sub-3 register flow: register_aggregator takes URL Fields + transfer authwit
    // Looking at the existing CLI register command for reference may be necessary; the simple
    // path is: registry.register(url_field) and let it pull the bond via transfer_public_to_public.
    // For M3 minimal we assume register signature is (url_field0, url_field1, ...).
    // We'll inspect at runtime if this fails.
    // For now: register with a single-field URL placeholder. If the signature is different,
    // this throws and we adapt.
    // register(endpoint_url_hash: Field, nonce: Field)
    // For M3 minimum-viable: a random Field as endpoint hash is fine (we don't
    // actually broadcast reveals on testnet here). The CLI's hashUrl helper
    // can produce field-modulus-overflow for long URLs; bypass that.
    const endpointHash = Fr.random();
    const regNonce = Fr.random();
    await registry.methods.register(endpointHash, regNonce).send({ from: admin });
    state.registerTx = "submitted";
    state.step = 8;
    saveM3State(state);
    console.log(`[M3] step 8 OK (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  } else {
    console.log(`[M3] step 8 cached`);
  }

  // Step 9: wait epoch_length blocks
  if (state.step < 9) {
    console.log(`[M3] step 9: waiting ${EPOCH_LENGTH} blocks ...`);
    const startBlock = await node.getBlockNumber();
    const targetBlock = startBlock + EPOCH_LENGTH;
    console.log(`[M3]   current block: ${startBlock}; target: ${targetBlock}`);
    while ((await node.getBlockNumber()) < targetBlock) {
      const cur = await node.getBlockNumber();
      console.log(`[M3]   ... block ${cur}/${targetBlock}`);
      await sleep(20_000);
    }
    state.step = 9;
    saveM3State(state);
    console.log(`[M3] step 9 OK; reached block ${await node.getBlockNumber()}`);
  } else {
    console.log(`[M3] step 9 cached`);
  }

  // Step 10: close_epoch_and_clear_verified.
  // Admin's initial fee-juice (100) was depleted by 8 prior txs (deploys + mint + register).
  // We refuel via a fresh faucet drip and pay close_epoch's fee via FeeJuicePaymentMethodWithClaim.
  if (state.step < 10) {
    console.log(`[M3] step 10: close_epoch_and_clear_verified (refueling fee-juice first) ...`);
    const t0 = Date.now();

    // Request fresh fee-juice drip for admin
    console.log(`[M3]   requesting fee-juice drip ...`);
    const dripRes = await fetch("https://aztec-faucet.dev-nethermind.xyz/api/drip", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ address: admin.toString(), asset: "fee-juice" }),
    });
    const dripBody = (await dripRes.json()) as {
      success?: boolean;
      claimData?: {
        claimAmount: string;
        claimSecretHex: string;
        messageLeafIndex: string;
      };
    };
    if (!dripBody.success || !dripBody.claimData) {
      throw new Error(`fee-juice drip failed: ${JSON.stringify(dripBody)}`);
    }
    const claim = {
      claimAmount: new Fr(BigInt(dripBody.claimData.claimAmount)),
      claimSecret: Fr.fromString(dripBody.claimData.claimSecretHex),
      messageLeafIndex: BigInt(dripBody.claimData.messageLeafIndex),
    };
    console.log(`[M3]   drip OK; leafIndex=${dripBody.claimData.messageLeafIndex}`);
    console.log(`[M3]   waiting 4 min for L1->L2 bridge ...`);
    await sleep(4 * 60 * 1000);

    const paymentMethod = new FeeJuicePaymentMethodWithClaim(admin, claim);
    const orderbook = await OrderbookContract.at(orderbookAddr, wallet);

    // Read proof, vk, public_inputs from local circuits/clearing/target/
    const proofBuf = readFileSync("circuits/clearing/target/proof.bin/proof");
    const vkBuf = readFileSync("circuits/clearing/target/vk.bin/vk");

    if (proofBuf.length !== 500 * 32) {
      console.warn(`[M3] WARN: proof.bin size ${proofBuf.length}, expected ${500 * 32}`);
    }
    if (vkBuf.length !== 115 * 32) {
      console.warn(`[M3] WARN: vk.bin size ${vkBuf.length}, expected ${115 * 32}`);
    }

    // Audit #1: pass the FULL 500-field proof + 115-field VK. The old code
    // truncated the proof to 456 + padded the VK to 127, which corrupted both and
    // made recursive verify impossible. (NB: the rest of this Sub-2.5-era script
    // still builds the legacy 42-field ClearingPublic and is superseded by the
    // aggregator MP clearing path; the bridge is corrected here for correctness.)
    const proofFields: Fr[] = [];
    for (let i = 0; i < 500; i++) {
      proofFields.push(Fr.fromBuffer(proofBuf.subarray(i * 32, (i + 1) * 32) as Buffer));
    }
    const vkFields: Fr[] = [];
    for (let i = 0; i < 115; i++) {
      vkFields.push(Fr.fromBuffer(vkBuf.subarray(i * 32, (i + 1) * 32) as Buffer));
    }

    // Build the ClearingPublic struct matching the empty-clearing fixture.
    // Layout (42 fields per Sub-2.5 design):
    //   order_acc=0, cancel_acc=0, order_count=0, cancel_count=0,
    //   reserve_a=1000e18, reserve_b=1000e18, clearing_price=0,
    //   fills_root=EMPTY_ROOT, a_to_pool=0, b_to_pool=0, a_from_pool=0, b_from_pool=0,
    //   current_sqrt_price_after=1e18, active_bucket_count=0,
    //   active_bucket_deltas=[INVALID×4]
    const EMPTY_ROOT = "0x01c28fe1059ae0237b72334700697bdf465e03df03986fe05200cadeda66bd76";
    const INVALID_BUCKET_ID = 0xffff;
    const SCALE = 1_000_000_000_000_000_000n;
    const SENTINEL = {
      bucket_id: INVALID_BUCKET_ID,
      reserve_a_add: 0n, reserve_a_sub: 0n,
      reserve_b_add: 0n, reserve_b_sub: 0n,
      cum_fee_a_per_share_increment: 0n,
      cum_fee_b_per_share_increment: 0n,
    };
    const publicInputs = {
      order_acc: Fr.ZERO,
      cancel_acc: Fr.ZERO,
      order_count: 0,
      cancel_count: 0,
      reserve_a: 1000n * SCALE,
      reserve_b: 1000n * SCALE,
      clearing_price: 0n,
      fills_root: Fr.fromString(EMPTY_ROOT),
      swap: {
        a_to_pool: 0n,
        b_to_pool: 0n,
        a_from_pool: 0n,
        b_from_pool: 0n,
        current_sqrt_price_after: SCALE,
        active_bucket_count: 0,
        active_bucket_deltas: [SENTINEL, SENTINEL, SENTINEL, SENTINEL],
      },
    };

    console.log(`[M3]   submitting close_epoch_and_clear_verified with FeeJuicePaymentMethodWithClaim ...`);
    await orderbook.methods
      .close_epoch_and_clear_verified(publicInputs, proofFields, vkFields)
      .send({ from: admin, fee: { paymentMethod } });
    state.closeEpochTx = "submitted";
    state.step = 10;
    saveM3State(state);
    console.log(`[M3] step 10 OK (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  } else {
    console.log(`[M3] step 10 cached`);
  }

  await wallet.stop();
  console.log(`\n[M3] ALL STEPS PASSED. State: ${M3_STATE}`);
}

main().catch((e) => {
  console.error(`[M3] FAILED:`, e);
  process.exit(1);
});
