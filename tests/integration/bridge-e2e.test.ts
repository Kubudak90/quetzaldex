/**
 * Sub-5b e2e: L1↔L2 bridge end-to-end.
 *
 * Status: DORMANT pending the dev stack (anvil:18545 + aztec:18080).
 * Docker is broken on this dev box (per memory/project_week05c_integration_gap.md);
 * the test is structurally laid out so a future session with a live stack
 * can fill in the implementation.
 *
 * Scenarios:
 *   E1: USDC deposit → 1-hop trade → withdraw round trip.
 *       Maker approves USDCBridge to spend 100 Sepolia USDC (or anvil-mock),
 *       calls depositToL2Private(amount, secretHash), waits for the L1→L2
 *       message to land on Aztec, calls aUSDC.claim_private with the secret
 *       preimage and message_leaf_index. Maker then submits a 1-hop Quetzal
 *       order swapping aUSDC → aWETH. After epoch_close + clearing, maker
 *       claims the hop fill, calls aWETH.exit_to_l1_public(amount, l1_recipient),
 *       waits for the L2→L1 epoch finalization, runs quetzal bridge claim-l1
 *       to produce a cast send command, then runs withdraw on L1 to release
 *       the WETH. Assertion: maker's L1 USDC balance went down by 100, L1
 *       WETH balance went up by the post-trade amount.
 *
 *   E2: WETH deposit → 1-hop trade → withdraw round trip.
 *       Mirror of E1 but with WETHBridge / aWETH first, trading toward
 *       aUSDC + exiting to USDC on L1.
 *
 * Both scenarios require:
 *   - anvil running on 18545 with deployed mock L1 USDC + WETH + Inbox + Outbox
 *   - aztec sandbox running on 18080
 *   - scripts/deploy-bridge.ts run with NETWORK=local (and the gaps E1 documented:
 *     forge broadcast log parsing + L2 wallet bootstrap)
 *   - bb prove ClientIVC pipeline available (~5-6 min wallclock per clearing)
 *
 * F2 (scripts/testnet-sub5b-bridge.ts) is the equivalent test against the
 * live Aztec testnet + Sepolia, which is the runnable validation path until
 * Docker is restored.
 */
import { describe, it } from "node:test";

describe("Sub-5b bridge e2e", { skip: true }, () => {
  it("E1: USDC L1->L2 deposit -> 1-hop trade -> WETH L2->L1 withdraw", () => {
    // Wire when dev stack is restored. Reference scripts/testnet-m1-hello.ts
    // for the wallet+faucet+claim pattern + cli/src/commands/bridge.ts for
    // the claim/exit/claim-l1 surface.
  });

  it("E2: WETH L1->L2 deposit -> 1-hop trade -> USDC L2->L1 withdraw", () => {
    // Mirror of E1: WETHBridge.depositToL2Private -> aWETH.claim_private ->
    // submit_order (aWETH -> aUSDC) -> epoch_close + clearing -> hop fill
    // claim -> aUSDC.exit_to_l1_public -> L2->L1 finalization ->
    // quetzal bridge claim-l1 -> USDC withdraw on L1.
  });
});
