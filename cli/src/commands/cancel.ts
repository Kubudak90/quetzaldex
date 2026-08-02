import type { Command } from "commander";
import { Fr } from "@aztec/aztec.js/fields";
import { parseField } from "@quetzal/sdk";
import { listDecoys, loadDecoyRegistry, saveDecoyRegistry } from "@quetzal/sdk/privacy/decoy-registry";
import { loadConfig } from "../config.js";
import { openCli } from "../wallet.js";

export function registerCancel(program: Command): void {
  program
    .command("cancel")
    .description("cancel a resting order and reclaim its escrow")
    .requiredOption("--nonce <field>", "order-identity nonce (from `quetzal order` / `quetzal orders`)")
    .action(async (_opts, cmd: Command) => {
      const opts = cmd.optsWithGlobals();
      const orderNonce = parseField(String(opts.nonce));
      const config = loadConfig(opts.config);
      const { client } = await openCli(config, Number(opts.account));
      try {
        await client.orders.cancelOrder({ nonce: orderNonce });
        console.log(
          `order 0x${orderNonce.toString(16)} cancelled; escrow returned to your private balance`,
        );
      } finally {
        await client.stop();
      }
    });
}

export function registerCancelDecoys(program: Command): void {
  program
    .command("cancel-decoys")
    .description("batch-cancel all decoy orders from the maker-local registry (refunds escrows)")
    .requiredOption("--epoch <n>", "epoch id (informational; cancel_order uses order_nonce only)")
    .action(async (_opts, cmd: Command) => {
      const opts = cmd.optsWithGlobals();
      const config = loadConfig(opts.config);
      const { client } = await openCli(config, Number(opts.account));
      try {
        const decoys = listDecoys(client.address.toString());
        if (decoys.length === 0) {
          console.log("No decoys recorded in registry. Nothing to cancel.");
          return;
        }
        console.log(`Cancelling ${decoys.length} decoy orders...`);
        const succeeded: string[] = [];
        for (const nonceHex of decoys) {
          try {
            await client.orders.cancelOrder({ nonce: Fr.fromString(nonceHex).toBigInt() });
            console.log(`  cancelled ${nonceHex}`);
            succeeded.push(nonceHex);
          } catch (e) {
            console.error(`  failed ${nonceHex}: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
        // Clean registry of successfully-cancelled nonces
        const reg = loadDecoyRegistry(client.address.toString());
        for (const n of succeeded) delete reg[n];
        saveDecoyRegistry(client.address.toString(), reg);
        console.log(`Done. Cancelled ${succeeded.length}/${decoys.length}; registry cleaned.`);
      } finally {
        await client.stop();
      }
    });
}
