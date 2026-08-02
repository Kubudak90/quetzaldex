import type { Command } from "commander";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { AggregatorRegistryContract } from "../../../tests/integration/generated/AggregatorRegistry.js";
import { loadConfig } from "../config.js";
import { openCli } from "../wallet.js";
import { broadcastReveal, type RevealPayload } from "../reveal.js";
import { buildOrderReveal, buildBulkReveals } from "../orders/reveal-payload.js";
import {
  classifyAmount,
  formatAdvisory,
  resolveTokenDecimals,
} from "@quetzal/sdk/privacy/amount-heuristic";

export function registerOrder(program: Command): void {
  program
    .command("order")
    .description("submit a private order")
    .requiredOption("--side <buy|sell>", "buy = deposit tUSDC, sell = deposit tETH")
    .requiredOption("--amount <n>", "input amount in the token's smallest unit")
    .requiredOption("--limit <price>", "limit price, Q-format scaled to 1e18")
    .option(
      "--path <comma-list>",
      "Token path, e.g. 'tUSDC,tETH' or 'tUSDC,tETH,tBTC'",
      "tUSDC,tETH",
    )
    .option("--ack-round", "acknowledge round-amount fingerprint warning + proceed with order")
    .option(
      "--decoys <n>",
      "number of decoy orders to submit alongside the real order (0-4; default 0 = no privacy padding). " +
        "Each decoy escrows the same amount but uses an unfillable limit_price so it doesn't fill at clearing. " +
        "Anonymity set per real order = decoys+1. " +
        "Range capped at 4 per A5 (2026-05-23) gate measurement; K=5 = 312K gates.",
      "0",
    )
    .action(async (_opts, cmd: Command) => {
      const opts = cmd.optsWithGlobals();
      const side = String(opts.side).toLowerCase();
      if (side !== "buy" && side !== "sell") {
        throw new Error(`--side must be "buy" or "sell", got "${opts.side}"`);
      }
      const realSide = side === "sell"; // false = bid (tUSDC), true = ask (tETH)
      const realAmount = BigInt(opts.amount);
      const realLimitPrice = BigInt(opts.limit);
      const decoyCount = Number(opts.decoys);
      if (!Number.isInteger(decoyCount) || decoyCount < 0 || decoyCount > 4) {
        throw new Error(`--decoys must be an integer in [0, 4], got: ${opts.decoys}`);
      }

      // D2: amount-pattern fingerprint advisory (CLI-side surface; SDK validators
      // throw on round amounts for bridge exits but place_order leaves the
      // advisory + ack-flow to the caller layer)
      const pathParts = (opts.path as string)
        .split(",")
        .map((p: string) => p.trim())
        .filter(Boolean);
      const inputTokenAlias = realSide ? pathParts[pathParts.length - 1]! : pathParts[0]!;
      const decimals = resolveTokenDecimals(inputTokenAlias);
      const heuristic = classifyAmount(realAmount, decimals);
      if (heuristic.classification !== "natural") {
        const advisory = formatAdvisory(heuristic, decimals, inputTokenAlias.toUpperCase());
        console.warn(advisory);
        if (opts.ackRound !== true) {
          console.warn(
            "Pass --ack-round to acknowledge + proceed, or rerun with a perturbed amount.",
          );
          process.exit(1);
        }
      }

      const config = loadConfig(opts.config);
      const { client } = await openCli(config, Number(opts.account));
      const owner = client.address.toString();

      // Broadcast every reveal to all bonded aggregators. Best-effort. The
      // aggregator folds submitted_at_block + side + path into c_i, so each
      // payload must be the SDK result's canonical values (built by
      // buildOrderReveal / buildBulkReveals) — a wrong or missing reveal makes the
      // epoch's order_acc replay mismatch and strands EVERY order in the epoch.
      const broadcastAll = async (payloads: RevealPayload[]): Promise<void> => {
        if (!config.aggregatorRegistry) return;
        try {
          const registry = await AggregatorRegistryContract.at(
            AztecAddress.fromStringUnsafe(config.aggregatorRegistry),
            client.wallet,
          );
          for (const payload of payloads) {
            const bcast = await broadcastReveal(payload, registry, client.address);
            console.log(
              `reveal broadcast (${payload.order_nonce.slice(0, 12)}…): ${bcast.pushed} aggregators reached, ${bcast.skipped} unreachable`,
            );
          }
        } catch (e) {
          console.warn(`reveal broadcast failed: ${(e as Error).message}`);
        }
      };

      try {
        if (decoyCount > 0) {
          const result = await client.orders.placeOrderBulk({
            side: side as "buy" | "sell",
            amount: realAmount,
            limitPrice: realLimitPrice,
            path: pathParts,
            decoyCount,
          });
          console.log(`Submitted: 1 real + ${decoyCount} decoy order(s) via submit_order_bulk`);
          console.log(`  Real order_nonce: 0x${result.realNonce.toString(16)}`);
          console.log(`  Decoy order_nonces:`);
          for (const n of result.decoyNonces) console.log(`    0x${n.toString(16)}`);
          console.log(`  Cancel decoys after clearing: quetzal cancel-decoys --epoch <N>`);
          // H7: broadcast EVERY used slot (real + decoys). The order_acc folds them
          // all, so a real-only (or zero) reveal fails the replay for the whole epoch.
          await broadcastAll(buildBulkReveals(result, owner));
          return;
        }

        // decoyCount === 0: single submit_order path
        const result = await client.orders.placeOrder({
          side: side as "buy" | "sell",
          amount: realAmount,
          limitPrice: realLimitPrice,
          path: pathParts,
        });

        console.log(`order submitted (${side}, amount ${realAmount}, limit ${realLimitPrice})`);
        console.log(`order nonce: 0x${result.orderNonce.toString(16)}`);
        console.log(
          `cancel later with: quetzal cancel --nonce 0x${result.orderNonce.toString(16)}`,
        );

        // H6: use the SDK result's canonical submitted_at_block + side (read from
        // the on-chain OrderNote), never the placeholder 0 / raw user side.
        await broadcastAll([
          buildOrderReveal(result, { amount: realAmount, limitPrice: realLimitPrice }, owner),
        ]);
      } finally {
        await client.stop();
      }
    });
}
