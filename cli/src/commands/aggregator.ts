import type { Command } from "commander";
import { loadConfig } from "../config.js";
import { openCli } from "../wallet.js";

export function registerAggregator(program: Command): void {
  const agg = program.command("aggregator").description("manage aggregator registration");

  agg
    .command("register")
    .description("register the current account as a bonded aggregator")
    // L13: --bond was a dead required option that the SDK and contract both ignore
    // (the registry escrows its own fixed bond_amount constant on every register call).
    // Dropped to avoid misleading operators about how much is actually escrowed.
    .requiredOption("--url <https-url>", "HTTPS reveal endpoint URL")
    .action(async (_opts, cmd: Command) => {
      const opts = cmd.optsWithGlobals();
      const config = loadConfig(opts.config);
      if (!config.aggregatorRegistry) {
        throw new Error(
          "config.aggregatorRegistry not set - run scripts/deploy-tokens.ts to deploy Sub-3 contracts",
        );
      }
      const { client } = await openCli(config, Number(opts.account));
      try {
        const url = String(opts.url);
        const result = await client.aggregator.register({ url });
        console.log(
          `registered as aggregator with URL ${url} (endpoint hash ${result.endpointHash})`,
        );
      } finally {
        await client.stop();
      }
    });

  agg
    .command("list")
    .description("list all registered aggregators (id, address, endpoint hash)")
    .action(async (_opts, cmd: Command) => {
      const opts = cmd.optsWithGlobals();
      const config = loadConfig(opts.config);
      if (!config.aggregatorRegistry) {
        throw new Error("config.aggregatorRegistry not set");
      }
      const { client } = await openCli(config, Number(opts.account));
      try {
        const entries = await client.aggregator.list();
        if (entries.length === 0) {
          console.log("(no aggregators registered)");
          return;
        }
        for (const e of entries) {
          console.log(`id=${e.id} addr=${e.address} endpoint_hash=${e.endpointHash}`);
        }
      } finally {
        await client.stop();
      }
    });

  agg
    .command("unregister")
    .description("unregister the current account and reclaim the bond")
    .action(async (_opts, cmd: Command) => {
      const opts = cmd.optsWithGlobals();
      const config = loadConfig(opts.config);
      if (!config.aggregatorRegistry) {
        throw new Error("config.aggregatorRegistry not set");
      }
      const { client } = await openCli(config, Number(opts.account));
      try {
        await client.aggregator.unregister();
        console.log("unregistered + bond returned");
      } finally {
        await client.stop();
      }
    });
}
