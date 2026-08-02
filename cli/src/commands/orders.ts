import type { Command } from "commander";
import { loadConfig } from "../config.js";
import { openCli } from "../wallet.js";

export function registerOrders(program: Command): void {
  program
    .command("orders")
    .description("list the account's resting orders")
    .action(async (_opts, cmd: Command) => {
      const opts = cmd.optsWithGlobals();
      const config = loadConfig(opts.config);
      const { client } = await openCli(config, Number(opts.account));
      try {
        const rows = await client.reads.getOrders();
        if (rows.length === 0) {
          console.log("no resting orders");
          return;
        }
        console.log(`resting orders for account ${opts.account}:`);
        for (const r of rows) {
          console.log(
            `  nonce=0x${r.nonce.toString(16)}  side=${r.side ? "sell" : "buy"}  ` +
              `amount=${r.amount_in}  limit=${r.limit_price}  block=${r.submitted_at_block}`,
          );
        }
      } finally {
        await client.stop();
      }
    });
}
