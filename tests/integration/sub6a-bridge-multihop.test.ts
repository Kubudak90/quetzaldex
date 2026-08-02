// tests/integration/sub6a-bridge-multihop.test.ts
// Sub-6a C5 dormant integration scaffold.
//
// End-to-end test of the multi-hop bridge exit + tick + claim flow.
// Requires: anvil + aztec sandbox + USDC bridge deployed.
// Mirrors the dormant pattern from sub5b-bridge-e2e + sub6a-bulk-escrow.
//
// To enable: remove the throw + wire actual fixtures.

import { test } from "node:test";

test("Sub-6a multi-hop bridge exit produces 3 staggered L1 withdrawals", { skip: true }, async () => {
  // Setup:
  //   1. Spin up anvil + aztec sandbox (docker-compose)
  //   2. Deploy USDC TokenBridge.sol via DeployAllBridges.s.sol
  //   3. Wallet onboard via testnet-m1-hello pattern
  //   4. depositToL2Private 3M USDC -> claim_private aUSDC on L2
  //
  // Action:
  //   5. quetzal bridge exit --token aUSDC --amount 3_000_000 --recipient 0x...
  //      --split-into 3 --interval-days 0 (use 0 for test fast-forward)
  //   6. Read ~/.quetzal/bridge-state.json -> assert 3 scheduled exits, total = 3M
  //   7. fast-forward EVM time + call 'quetzal bridge tick' 3 times
  //   8. assert each L2 exit produced an L2->L1 message
  //   9. 'quetzal bridge tick --auto-claim' 3 times after epoch finality
  //  10. assert 3 L1 withdrawals processed via cast call to TokenBridge.withdraw
  //  11. assert bridge-state.json shows all 3 status='done'

  throw new Error("Sub-6a C5 dormant scaffold; remove skip + wire fixtures to run.");
});

test("Sub-6a bridge advisory blocks exit on amount match without --ack-delay", { skip: true }, async () => {
  // Setup:
  //   1. Spin up anvil + aztec sandbox
  //   2. Deploy USDC TokenBridge.sol
  //   3. depositToL2Private 1.0 USDC from L1_MAKER_ADDR -> L2 wallet
  //
  // Action:
  //   4. quetzal bridge exit --token aUSDC --amount 1_030_000 --recipient L1_MAKER_ADDR
  //      (i.e., 1.03 USDC within 5% tolerance of the 1.0 USDC deposit)
  //   5. assert: exit fails with non-zero exit code + advisory warning printed
  //   6. quetzal bridge exit ... --ack-delay
  //   7. assert: exit succeeds, advisory shown but proceeds

  throw new Error("Sub-6a C5 dormant scaffold; remove skip + wire fixtures to run.");
});
