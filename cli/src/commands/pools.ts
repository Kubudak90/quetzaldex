import type { Command } from "commander";
import { loadConfig } from "../config.js";

export function registerPoolsCommand(parent: Command) {
  parent.command("pools")
    .description("List configured pools + canonical token pairs")
    .action(async (_opts, cmd: Command) => {
      const opts = cmd.optsWithGlobals();
      const config = loadConfig(opts.config);
      console.log("Configured pools:");
      for (const p of config.pools) {
        console.log(`  pool_id=${p.pool_id}  token_a=${p.token_a}  token_b=${p.token_b}  address=${p.address}`);
      }
    });
}
