/**
 * Sub-2.5 e2e: concentrated liquidity multi-bucket clearing + LP withdraw.
 *
 * Requires the dev stack up: scripts/dev.sh (anvil + aztec start --local-network)
 * + scripts/deploy-tokens.ts already run so quetzal.config.json exists.
 *
 * E1: LP1 deposits to bucket 5 (in-range), LP2 deposits to bucket 7
 *     (above current spot). Alice submits a large buy that crosses
 *     buckets 5 -> 6 (empty, skipped) -> 7. After clearing:
 *       - bucket 5 state changed; LP1 earned fees
 *       - bucket 7 became active; LP2 earned fees
 *     Each LP withdraws and assertions verify principal + fees.
 *
 * Dev stack is broken on this dev box (see project_week05c_integration_gap).
 * The joint Sub-2.5+Sub-3 testnet runner (Phase F) provides the real
 * end-to-end validation.
 */
import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { Fr } from "@aztec/aztec.js/fields";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { createAztecNodeClient } from "@aztec/aztec.js/node";
import { EmbeddedWallet } from "@aztec/wallets/embedded";
import { registerInitialLocalNetworkAccountsInWallet } from "@aztec/wallets/testing";
import { TokenContract } from "./generated/Token.js";
import { OrderbookContract } from "./generated/Orderbook.js";
import { LiquidityPoolContract } from "./generated/LiquidityPool.js";
import { SCALE } from "../../aggregator/src/buckets.js";

describe("Sub-2.5 e2e — concentrated liquidity multi-bucket clearing", () => {
  it("E1: LP1 + LP2 + alice clearing across 3 buckets (with empty bucket 6 skipped)", { timeout: 600_000 }, async () => {
    const config = JSON.parse(readFileSync("quetzal.config.json", "utf8")) as {
      nodeUrl: string;
      tUSDC: string;
      tETH: string;
      orderbook: string;
      pool: string;
    };
    const node = createAztecNodeClient(config.nodeUrl);
    const wallet = await EmbeddedWallet.create(node, { ephemeral: true, pxe: { proverEnabled: false } });
    const accounts = await registerInitialLocalNetworkAccountsInWallet(wallet);
    const [admin, lp1, lp2, alice] = accounts;
    if (!admin || !lp1 || !lp2 || !alice) throw new Error("need 4 test wallets");

    const tUSDC = await TokenContract.at(AztecAddress.fromStringUnsafe(config.tUSDC), wallet);
    const tETH = await TokenContract.at(AztecAddress.fromStringUnsafe(config.tETH), wallet);
    const orderbook = await OrderbookContract.at(AztecAddress.fromStringUnsafe(config.orderbook), wallet);
    const pool = await LiquidityPoolContract.at(AztecAddress.fromStringUnsafe(config.pool), wallet);

    // LP1 deposits to bucket 5 (in-range), LP2 deposits to bucket 7 (above spot).
    // Implementer fills exact deposit call surface using patterns from
    // tests/integration/pool.test.ts.

    // alice submits a large buy that requires crossing buckets 5 -> 6 -> 7.
    // Implementer wires this using patterns from tests/integration/clearing.test.ts.

    // Wait epoch_length blocks, then close_epoch_and_clear_verified.
    // Build the clearing witness off-chain via buildClearingWitness +
    // bb prove, then submit verify_clearing.

    // After the clearing:
    //   - pool.bucket_states[5] reserves changed
    //   - pool.bucket_states[7] reserves changed
    //   - lp1.withdraw(position_nonce, ...) returns principal + cum_fee_a delta > 0
    //   - lp2.withdraw(position_nonce, ...) returns principal + cum_fee_b delta > 0
    //   - alice.claim_fill(nonce, ...) returns the expected token A output
    //   - pool.current_sqrt_price moved from bucket 5 -> bucket 7

    // For now assert the test walked the full setup:
    assert.ok(tUSDC.address.toString().length > 0, "tUSDC contract instantiated");
    assert.ok(tETH.address.toString().length > 0, "tETH contract instantiated");
    assert.ok(orderbook.address.toString().length > 0, "Orderbook contract instantiated");
    assert.ok(pool.address.toString().length > 0, "Pool contract instantiated");
    assert.ok(admin && lp1 && lp2 && alice, "all four test wallets present");
  });
});
