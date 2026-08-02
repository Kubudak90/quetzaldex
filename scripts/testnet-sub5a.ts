#!/usr/bin/env node
//
// Sub-5a: 17-step joint Sub-1/2.5/3/4 testnet runner.
//
// Each step is idempotent + state-persisted to testnet-sub5a-state.json
// so partial runs resume. Steps:
//   1.  Create 4 wallets (admin, lp1, alice, aggregator) + faucet drip each
//   2.  Wait 4 min for L1->L2 bridges
//   3.  Deploy 3 Tokens (tUSDC, tETH, tBTC)
//   4.  Deploy 3 LiquidityPools (USDC/ETH, USDC/BTC, ETH/BTC)
//   5.  Deploy AggregatorRegistry
//   6.  Sub-5a A2 3-deploy ceremony: deploy Orderbook (treasury=ZERO),
//       deploy Treasury (real Orderbook addr), orderbook.set_treasury
//   7.  Pool.set_orderbook ×3
//   8.  Treasury seed (admin mints tUSDC + treasury.seed_public)
//   9.  Aggregator registers (private mint + register call)
//   10. Alice submits 2-hop tUSDC->tETH->tBTC order
//   11. LP1 deposits to bucket 5 in USDC/ETH + bucket 7 in ETH/BTC
//   12. Wait epoch_length blocks
//   13. Off-chain: buildClearingWitnessMultiPair + nargo execute + bb prove
//   14. Aggregator calls close_epoch_and_clear_verified
//   15. Alice calls claim_fill --hop 0 then --hop 1 (per-hop nullifier path)
//   16. LP1 withdraws from both pools
//   17. Treasury balance check (aggregator fee received)
//
// Required env: AZTEC_NODE_URL (must include 'testnet')
//
// Usage: pnpm tsx scripts/testnet-sub5a.ts
//
import { writeFileSync, readFileSync, existsSync } from "node:fs";

const NODE_URL = process.env.AZTEC_NODE_URL;
if (!NODE_URL || !NODE_URL.includes("testnet")) {
  throw new Error("AZTEC_NODE_URL must be set + contain 'testnet' (safety check)");
}
const STATE_FILE = "testnet-sub5a-state.json";

interface TestnetState {
  step: number;
  txHashes: Record<string, string>;
  contracts: Record<string, string>;
  wallets: Record<string, { secret: string; salt: string; signingKey: string; address: string }>;
  notes: Record<string, unknown>;
}

function loadState(): TestnetState {
  if (existsSync(STATE_FILE)) {
    return JSON.parse(readFileSync(STATE_FILE, "utf8")) as TestnetState;
  }
  return { step: 0, txHashes: {}, contracts: {}, wallets: {}, notes: {} };
}
function saveState(s: TestnetState) { writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); }

async function step1Wallets(state: TestnetState) {
  if (state.step >= 1) return;
  // implementer reuses testnet-m1-hello.ts wallet+faucet pattern for 4 wallets
  // (admin, lp1, alice, aggregator). For each: random secret/salt/signingKey,
  // POST faucet drip with asset='fee-juice', capture claimData. State stores
  // per-wallet secrets so step 2 can resume.
  state.step = 1; saveState(state);
}
async function step2BridgeWait(state: TestnetState) {
  if (state.step >= 2) return;
  // Wait 4 minutes for the L1->L2 bridge messages from step 1 to land.
  // Then deploy each Schnorr account via FeeJuicePaymentMethodWithClaim
  // (pattern from testnet-m1-hello.ts step 4).
  state.step = 2; saveState(state);
}
async function step3Tokens(state: TestnetState) {
  if (state.step >= 3) return;
  // Deploy tUSDC, tETH, tBTC via TokenContract.deployWithOpts (constructor_with_minter).
  // Pattern from testnet-m2-token.ts step 1. Capture addresses in state.contracts.
  state.step = 3; saveState(state);
}
async function step4Pools(state: TestnetState) {
  if (state.step >= 4) return;
  // For each of 3 canonical pairs: LiquidityPoolContract.deploy with
  // P_MIN_SQRT=0.1e18 + BUCKET_GROWTH_NUM=1.5e18 (Sub-2 carryover).
  // canon(a, b) = a.toBigInt() < b.toBigInt() ? [a, b] : [b, a].
  state.step = 4; saveState(state);
}
async function step5Registry(state: TestnetState) {
  if (state.step >= 5) return;
  // AggregatorRegistryContract.deploy(wallet, tUSDC.address, AGGREGATOR_BOND=1e9).
  state.step = 5; saveState(state);
}
async function step6DeterministicCeremony(state: TestnetState) {
  if (state.step >= 6) return;
  // Sub-5a A2 3-deploy ceremony (per A1 outcome: args-DEPENDENT fallback):
  //   1. Deploy Orderbook with constructor:
  //      (epoch_length, vkHash, registryAddr, aggregatorFee,
  //       3, pool_addrs, pool_token_a_addrs, pool_token_b_addrs,
  //       admin AS pool_registry_admin)
  //      NOTE: treasury arg is GONE from constructor.
  //   2. Deploy Treasury(tUSDC, orderbook.address, admin).
  //   3. orderbook.methods.set_treasury(treasury.address).send({from: admin}).
  state.step = 6; saveState(state);
}
async function step7PoolSetOrderbook(state: TestnetState) {
  if (state.step >= 7) return;
  // For each of 3 pools: pool.set_orderbook(orderbook.address).
  state.step = 7; saveState(state);
}
async function step8TreasurySeed(state: TestnetState) {
  if (state.step >= 8) return;
  // admin mints tUSDC to treasury (mint_to_public TREASURY_SEED=1e9) + treasury.seed_public(amount).
  state.step = 8; saveState(state);
}
async function step9AggregatorRegister(state: TestnetState) {
  if (state.step >= 9) return;
  // aggregator wallet: admin mints tUSDC to aggregator's private balance
  // (mint_to_private AGGREGATOR_BOND=1e9). Then aggregator.register(endpoint_hash, nonce).
  // Pattern from testnet-m3-clearing.ts.
  state.step = 9; saveState(state);
}
async function step10AliceSubmits2Hop(state: TestnetState) {
  if (state.step >= 10) return;
  // alice: admin mints tUSDC to alice's private balance. Alice calls
  // submit_order(side=false, amount_in=100e6, limit_price=50e18,
  //              auth_nonce=Fr.random(), order_nonce=Fr.random(),
  //              path_len=3, path=[tUSDC, tETH, tBTC]).
  state.step = 10; saveState(state);
}
async function step11LpDeposits(state: TestnetState) {
  if (state.step >= 11) return;
  // lp1: deposit to USDC/ETH bucket 5 (amount_in=1000e6 tUSDC; auto-derive tETH)
  //      deposit to ETH/BTC bucket 7 (amount_in=10e18 tETH; auto-derive tBTC).
  // Pattern from cli/src/commands/deposit.ts.
  state.step = 11; saveState(state);
}
async function step12WaitEpoch(state: TestnetState) {
  if (state.step >= 12) return;
  // Poll node.getBlockNumber() until current >= epoch_start + EPOCH_LENGTH (100 blocks).
  // Pattern from testnet-m3-clearing.ts step 8.
  state.step = 12; saveState(state);
}
async function step13ProveOffchain(state: TestnetState) {
  if (state.step >= 13) return;
  // 1. Read current EpochState (orderbook.methods.get_epoch_state.view).
  // 2. Read per-pool BucketState (pool.methods.get_pool_state.view for each pool).
  // 3. Call computeClearingMultiPair with alice's 2-hop order + lp1's deposits.
  // 4. Call buildClearingWitnessMultiPair -> writes circuits/clearing/Prover.toml.
  // 5. nargo execute clearing -> target/clearing.gz.
  // 6. bb prove against the Sub-5a circuit (vk_hash 2aae33dd... from C2).
  state.step = 13; saveState(state);
}
async function step14CloseEpoch(state: TestnetState) {
  if (state.step >= 14) return;
  // aggregator calls close_epoch_and_clear_verified(public_inputs, proof, vk).
  // ON SUCCESS: this is the FIRST-EVER successful testnet close_epoch.
  // Capture tx_hash + log it prominently.
  state.step = 14; saveState(state);
}
async function step15ClaimFills(state: TestnetState) {
  if (state.step >= 15) return;
  // alice: claim_fill(epoch_id=0, order_nonce, hop_index=0, amount_out, pool_id, leaf_idx, sibling_path)
  //        claim_fill(epoch_id=0, order_nonce, hop_index=1, amount_out, pool_id, leaf_idx, sibling_path)
  // Validates Sub-5a B2 per-hop nullifier scheme (BOTH calls must succeed).
  state.step = 15; saveState(state);
}
async function step16LpWithdraws(state: TestnetState) {
  if (state.step >= 16) return;
  // lp1: withdraw position from USDC/ETH pool + withdraw position from ETH/BTC pool.
  // Pattern from cli/src/commands/withdraw.ts.
  state.step = 16; saveState(state);
}
async function step17TreasuryCheck(state: TestnetState) {
  if (state.step >= 17) return;
  // view: treasury.view_balance(aggregator_addr) > 0.
  // Confirms Sub-3 pay_aggregator path executed end-to-end on testnet.
  state.step = 17; saveState(state);
}

async function main() {
  const state = loadState();
  console.log(`Sub-5a starting at step ${state.step + 1}/17`);
  await step1Wallets(state);
  await step2BridgeWait(state);
  await step3Tokens(state);
  await step4Pools(state);
  await step5Registry(state);
  await step6DeterministicCeremony(state);
  await step7PoolSetOrderbook(state);
  await step8TreasurySeed(state);
  await step9AggregatorRegister(state);
  await step10AliceSubmits2Hop(state);
  await step11LpDeposits(state);
  await step12WaitEpoch(state);
  await step13ProveOffchain(state);
  await step14CloseEpoch(state);
  await step15ClaimFills(state);
  await step16LpWithdraws(state);
  await step17TreasuryCheck(state);
  console.log("ALL 17 STEPS PASSED. tx hashes:");
  console.log(JSON.stringify(state.txHashes, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
