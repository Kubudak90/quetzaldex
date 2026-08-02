import type { Command } from "commander";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { Fr } from "@aztec/aztec.js/fields";
import { TokenContract } from "../../../tests/integration/generated/Token.js";
import { loadConfig } from "../config.js";
import { openCli } from "../wallet.js";
import { validateSplitOptions } from "../bridge/split-validation.js";
import { parseField } from "@quetzal/sdk";
import { loadBridgeState } from "@quetzal/sdk/privacy/bridge-schedule";
import {
  queryRecentDeposits,
  isRoundTripRisk,
} from "@quetzal/sdk/privacy/bridge-history";
import {
  classifyAmount,
  formatAdvisory,
  resolveTokenDecimals,
} from "@quetzal/sdk/privacy/amount-heuristic";
import { computeWithdrawContent } from "@quetzal/sdk";
import { buildOutboxProof, formatProofForCastSend, lookupOutboxMessage } from "../bridge-helpers.js";

function resolveTokenAddress(config: ReturnType<typeof loadConfig>, alias: string): string {
  const map: Record<string, string | undefined> = {
    tUSDC: config.tUSDC,
    aUSDC: config.tUSDC,
    tETH: config.tETH,
    aWETH: config.tETH,
    tBTC: config.tBTC,
    aWBTC: config.tBTC,
  };
  const addr = map[alias];
  if (!addr) {
    throw new Error(
      `unknown token alias '${alias}'. Known: tUSDC/aUSDC, tETH/aWETH, tBTC/aWBTC.`,
    );
  }
  return addr;
}

function validateL1Address(addr: string): void {
  if (!addr.startsWith("0x") || addr.length !== 42) {
    throw new Error(`--l1-recipient must be a 0x-prefixed 20-byte L1 address, got: ${addr}`);
  }
}

export function registerBridge(program: Command): void {
  const bridge = program.command("bridge").description("L1<>L2 bridge operations (Sub-5b)");

  // ── bridge claim ─────────────────────────────────────────────────────────
  bridge
    .command("claim")
    .description("Claim an L1->L2 deposit on Aztec L2 (consumes an Inbox message)")
    .requiredOption("--token <alias>", "token alias: tUSDC|aUSDC|tETH|aWETH|tBTC|aWBTC")
    .requiredOption("--amount <units>", "amount in token's smallest unit (uint128)")
    .requiredOption("--secret <field>", "0x-prefixed Field preimage of L1 secret_hash")
    .requiredOption(
      "--message-index <field>",
      "Inbox leaf index returned by L1 portal at deposit time",
    )
    .option("--no-private", "use claim_public (default is claim_private — privacy-maximalist)")
    .action(async (_opts, cmd: Command) => {
      const opts = cmd.optsWithGlobals();
      const config = loadConfig(opts.config);
      const amount = BigInt(opts.amount);
      const secret = new Fr(parseField(String(opts.secret)));
      const messageIndex = new Fr(parseField(String(opts.messageIndex)));
      const usePrivate = opts.private !== false;

      const { client } = await openCli(config, Number(opts.account));
      try {
        await client.bridge.claim({
          token: String(opts.token),
          amount,
          isPrivate: usePrivate,
          secret,
          messageIndex,
        });
        const fn = usePrivate ? "claim_private" : "claim_public";
        console.log(`${fn} OK: ${amount} ${opts.token} → ${client.address.toString()}`);
      } finally {
        await client.stop();
      }
    });

  // ── bridge exit ──────────────────────────────────────────────────────────
  bridge
    .command("exit")
    .description("Emit an L2->L1 withdraw message (burns L2 balance, queues Outbox msg)")
    .requiredOption("--token <alias>", "token alias: tUSDC|aUSDC|tETH|aWETH|tBTC|aWBTC")
    .requiredOption("--amount <units>", "amount to withdraw (uint128)")
    .requiredOption("--l1-recipient <addr>", "0x-prefixed L1 recipient address (20 bytes)")
    .option(
      "--no-private",
      "use exit_to_l1_public (default is exit_to_l1_private — privacy-maximalist)",
    )
    .option(
      "--relayer-fee <amount>",
      "opt-in relayer fee in token's smallest unit (0 = no relayer; default 0)",
      "0",
    )
    .option("--ack-delay", "acknowledge round-trip risk warning + proceed with exit")
    .option("--ack-round", "acknowledge round-amount fingerprint warning + proceed with exit")
    .option(
      "--split-into <n>",
      "split into N partial withdrawals staggered over time (default 1 = no split)",
      "1",
    )
    .option(
      "--interval-days <d>",
      "days between split exits (used with --split-into > 1; default 3)",
      "3",
    )
    .action(async (_opts, cmd: Command) => {
      const opts = cmd.optsWithGlobals();
      const config = loadConfig(opts.config);
      const amount = BigInt(opts.amount);
      const l1RecipientHex = String(opts.l1Recipient);
      validateL1Address(l1RecipientHex);
      const usePrivate = opts.private !== false;
      const tokenAlias = String(opts.token);
      // Resolve early to catch unknown aliases before opening PXE.
      resolveTokenAddress(config, tokenAlias);

      if (usePrivate) {
        console.log(
          "INFO: exit_to_l1_private uses WITHDRAW_PRIVATE_TAG content. After this L2 tx " +
            "settles to L1, claim via:  pnpm quetzal bridge claim-l1 --private --l2-tx <hash> ... " +
            "(or use --relayer-fee here to delegate the L1 step to a bonded aggregator).",
        );
      }

      // ── D2: amount-pattern advisory ────────────────────────────────────
      const decimals = resolveTokenDecimals(tokenAlias);
      const heuristic = classifyAmount(amount, decimals);
      if (heuristic.classification !== "natural") {
        const advisory = formatAdvisory(heuristic, decimals, tokenAlias.toUpperCase());
        console.warn(advisory);
        if (opts.ackRound !== true) {
          console.warn(
            "Pass --ack-round to acknowledge + proceed, or rerun with a perturbed amount.",
          );
          process.exit(1);
        }
      }

      // ── C2: round-trip risk pre-check ──────────────────────────────────
      const ackDelay = opts.ackDelay === true;
      const l1RpcUrl = config.l1?.rpcUrl ?? "";
      const bridgeAddrs = [config.l1?.usdcBridge, config.l1?.wethBridge, config.l1?.wbtcBridge]
        .filter(Boolean) as `0x${string}`[];
      if (l1RpcUrl && bridgeAddrs.length > 0) {
        const l1MakerAddr = (process.env.L1_MAKER_ADDR ?? "") as `0x${string}`;
        if (!l1MakerAddr) {
          console.warn(
            "Skipping round-trip pre-check: L1_MAKER_ADDR not set. Set env L1_MAKER_ADDR=0x... to enable.",
          );
        } else {
          let records: Awaited<ReturnType<typeof queryRecentDeposits>>;
          try {
            records = await queryRecentDeposits(l1RpcUrl, bridgeAddrs, l1MakerAddr, 7);
          } catch (e) {
            console.warn(
              `Round-trip pre-check failed (L1 query error): ${e instanceof Error ? e.message : String(e)}. ` +
                `Proceeding with exit; set --ack-delay to suppress this warning explicitly.`,
            );
            records = [];
          }
          const { risk, matched } = isRoundTripRisk(amount, records, 5);
          if (risk && matched && !ackDelay) {
            const daysAgo = Math.floor((Date.now() / 1000 - matched.timestamp) / 86400);
            console.error("");
            console.error("Round-trip detection risk");
            console.error("");
            console.error(
              `You deposited ${matched.amount} on ${new Date(matched.timestamp * 1000).toISOString()} (${daysAgo} days ago).`,
            );
            console.error(`You're now exiting ${amount} -- within +/-5% of that deposit's amount.`);
            console.error("");
            console.error(
              `Observers on Etherscan can correlate L1 deposit + L1 withdraw timing + amount`,
            );
            console.error(
              `and infer this is the same wallet round-tripping through Quetzal's L2 privacy.`,
            );
            console.error(`L2 privacy stays intact; the L1 boundary becomes traceable.`);
            console.error("");
            console.error("Mitigations:");
            console.error("  - Wait >=7 days from last matching-size deposit (recommended: 14 days)");
            console.error("  - Use --split-into N to break exit into smaller staggered withdrawals (Sub-6a C3)");
            console.error("  - Use --ack-delay if you've considered the trade-off");
            console.error("");
            console.error("Aborting. Re-run with --ack-delay to proceed.");
            process.exit(1);
          }
        }
      }

      // ── C3: multi-hop split path ───────────────────────────────────────
      const splitInto = Number(opts.splitInto);
      const intervalDays = Number(opts.intervalDays);
      const relayerFee = BigInt(opts.relayerFee);
      // M8/M9: reject a NaN/out-of-range split (which silently exits the full amount
      // at once, degrading privacy) and a relayer fee combined with --split-into
      // (silently dropped by the scheduler).
      validateSplitOptions({ splitInto, intervalDays, relayerFee });

      const { client } = await openCli(config, Number(opts.account));
      try {
        const exitResult = await client.bridge.exit({
          token: tokenAlias,
          amount,
          l1Recipient: l1RecipientHex,
          isPrivate: usePrivate,
          splitInto,
          intervalDays,
          ackRound: true, // CLI already surfaced + ack'd advisory; suppress SDK re-check.
          ackDelay: true, // ditto for round-trip
          relayerFee,
        });

        if ("scheduledExits" in exitResult) {
          console.log(`Scheduled ${exitResult.scheduledExits.length} partial exits:`);
          for (const e of exitResult.scheduledExits) {
            const when = new Date(e.submitAfterUnix * 1000).toISOString();
            console.log(
              `  ${e.id}  ${e.amount} ${e.token}  -> ${e.l1Recipient}  submit after ${when}`,
            );
          }
          console.log("");
          console.log("Run 'quetzal bridge tick' periodically to submit pending exits.");
          console.log("Run 'quetzal bridge status' to see schedule progress.");
          return;
        }

        const fn = usePrivate ? "exit_to_l1_private" : "exit_to_l1_public";
        console.log(
          `${fn} submitted; query Outbox proof + claim on L1 via 'quetzal bridge claim-l1'`,
        );
        if (relayerFee > 0n) {
          if (!config.treasury) {
            console.error(
              "WARNING: --relayer-fee > 0 but config.treasury is not set. Skipping relayer queue. " +
                "Either set config.treasury or omit --relayer-fee for the manual L1 cast send path.",
            );
          } else {
            console.log(`Relayer fee ${relayerFee} → queued Treasury claim`);
            console.log(
              `  queued. A bonded relayer should pick this up within ~60s + submit L1 withdraw.`,
            );
          }
        }
      } finally {
        await client.stop();
      }
    });

  // ── bridge claim-l1 ──────────────────────────────────────────────────────
  bridge
    .command("claim-l1")
    .description("Print the L1 cast-send command needed to consume a pending L2→L1 withdraw")
    .requiredOption("--l2-tx <hash>", "L2 tx hash of the exit_to_l1_* call")
    .requiredOption("--l1-recipient <addr>", "0x-prefixed L1 recipient address")
    .requiredOption("--amount <units>", "token amount (smallest unit)")
    .requiredOption(
      "--bridge <addr>",
      "0x-prefixed L1 portal address (USDCBridge or WETHBridge or wBTCBridge)",
    )
    .requiredOption(
      "--content <hex>",
      "expected 0x-prefixed bytes32 content hash committed by L2",
    )
    .option(
      "--private",
      "use withdrawPrivate L1 function (matches L2's exit_to_l1_private); default is withdraw",
    )
    .action(async (_opts, cmd: Command) => {
      const opts = cmd.optsWithGlobals();
      const config = loadConfig(opts.config);
      const isPrivate = opts.private === true;
      const functionName = isPrivate ? "withdrawPrivate" : "withdraw";
      // v5: the outbox witness needs the epoch's roots read from L1.
      const l1RpcForProof = config.l1?.rpcUrl;
      if (!l1RpcForProof) {
        throw new Error("config.l1.rpcUrl is required (v5 outbox proof reads roots from L1)");
      }
      // L22: l2Sender = the L2 token that emitted the exit; resolve by which
      // bridge the caller is claiming against.
      const bridgeArg = String(opts.bridge).toLowerCase();
      const l2SenderByBridge: Record<string, string | undefined> = {
        [String(config.l1?.usdcBridge ?? "").toLowerCase()]: config.tUSDC,
        [String(config.l1?.wethBridge ?? "").toLowerCase()]: config.tETH,
        [String(config.l1?.wbtcBridge ?? "").toLowerCase()]: config.tBTC,
      };
      const l2Sender = l2SenderByBridge[bridgeArg];
      if (!l2Sender) {
        throw new Error(
          `--bridge ${opts.bridge} does not match config.l1.{usdcBridge,wethBridge,wbtcBridge}; ` +
            `cannot resolve the L2 sender token address`,
        );
      }
      let proof;
      try {
        proof = await buildOutboxProof(
          config.nodeUrl,
          String(opts.l2Tx),
          String(opts.content),
          l1RpcForProof,
          l2Sender,
          String(opts.bridge),
        );
      } catch (e) {
        console.error(String(e instanceof Error ? e.message : e));
        console.error("");
        console.error("Running lookup-only path...");
        const lookup = await lookupOutboxMessage(
          config.nodeUrl,
          String(opts.l2Tx),
          String(opts.content),
        );
        console.error(`L2 epoch:     ${lookup.l2Epoch}`);
        console.error(`Leaf index:   ${lookup.leafIndex}`);
        console.error(`Content hash: ${lookup.content}`);
        console.error("");
        console.error(
          "Construct siblingPath via Aztec's L1 portal manager helper " +
            "(see @aztec/aztec.js/dest/ethereum/portal_manager.js withdrawFunds signature), " +
            "then paste into the cast send template below replacing <SIBLING_PATH>:",
        );
        const template = [
          `cast send ${String(opts.bridge)} \\`,
          `  "${functionName}(uint256,address,uint256,uint256,uint256,bytes32[],bytes32)" \\`,
          `  ${BigInt(opts.amount)} ${String(opts.l1Recipient)} ${lookup.l2Epoch} <NUM_CHECKPOINTS_IN_EPOCH> ${lookup.leafIndex} <SIBLING_PATH> ${l2Sender}`,
        ].join("\n");
        console.log(template);
        return;
      }
      const cmdLine = formatProofForCastSend(
        proof,
        String(opts.bridge),
        BigInt(opts.amount),
        String(opts.l1Recipient),
        l2Sender,
        functionName,
      );
      console.log(cmdLine);
    });

  // ── bridge status ────────────────────────────────────────────────────────
  bridge
    .command("status")
    .description("show pending scheduled exits + statuses")
    .action(() => {
      const state = loadBridgeState();
      if (state.scheduledExits.length === 0) {
        console.log("No scheduled exits.");
        return;
      }
      console.log(`Pending scheduled exits (${state.scheduledExits.length}):`);
      for (const e of state.scheduledExits) {
        const when = new Date(e.submitAfterUnix * 1000).toISOString();
        console.log(
          `  ${e.id}  ${e.amount} ${e.token}  -> ${e.l1Recipient}  [${e.status}]  ${when}`,
        );
      }
    });

  // ── bridge tick ──────────────────────────────────────────────────────────
  // The SDK's BridgeApi.tick handles the pending->submitted L2 submit;
  // the L1 auto-claim leg stays CLI-local because it pulls L1 RPC + viem
  // wiring + the outbox-proof subprocess binary that the SDK delegates to
  // the CLI as an environment-specific concern.
  bridge
    .command("tick")
    .description(
      "submit pending scheduled exits whose window has opened (and optionally auto-claim on L1)",
    )
    .option("--auto-claim", "also auto-submit L1 withdraw after the L2 epoch settles")
    .action(async (_opts, cmd: Command) => {
      const opts = cmd.optsWithGlobals();
      const config = loadConfig(opts.config);
      const { client } = await openCli(config, Number(opts.account));
      try {
        const result = await client.bridge.tick({ autoClaim: opts.autoClaim === true });
        console.log(`Tick complete. processed=${result.processedCount}.`);

        // L1 auto-claim leg: still CLI-local (SDK tick returns after L2-only).
        if (opts.autoClaim === true) {
          const state = loadBridgeState();
          const l1Cfg = config.l1;
          if (!l1Cfg) {
            console.warn(`config.l1 not set; cannot auto-claim L1 withdrawals`);
            return;
          }
          const bridgeMap: Record<string, string | undefined> = {
            tUSDC: l1Cfg.usdcBridge,
            aUSDC: l1Cfg.usdcBridge,
            tETH: l1Cfg.wethBridge,
            aWETH: l1Cfg.wethBridge,
            tBTC: l1Cfg.wbtcBridge,
            aWBTC: l1Cfg.wbtcBridge,
          };
          const l1Pk = process.env.L1_PRIVATE_KEY;
          if (!l1Pk) {
            console.warn(`L1_PRIVATE_KEY env var unset; cannot claim L1 withdrawals`);
            return;
          }
          const { createWalletClient, createPublicClient, http, parseAbi } = await import("viem");
          const { privateKeyToAccount } = await import("viem/accounts");
          const { mainnet, sepolia } = await import("viem/chains");
          const l1RpcUrl = l1Cfg.rpcUrl ?? "";
          if (!l1RpcUrl) {
            console.warn(`config.l1.rpcUrl not set; cannot submit L1 tx`);
            return;
          }
          const chain = l1RpcUrl.includes("sepolia") ? sepolia : mainnet;
          const pkHex = (l1Pk.startsWith("0x") ? l1Pk : `0x${l1Pk}`) as `0x${string}`;
          const account = privateKeyToAccount(pkHex);
          const walletClient = createWalletClient({
            account,
            chain,
            transport: http(l1RpcUrl),
          });
          // M7: to confirm a claim actually landed (not just that the tx was sent),
          // wait for the L1 receipt before marking the exit "done".
          const publicClient = createPublicClient({ chain, transport: http(l1RpcUrl) });
          const tokenBridgeAbi = parseAbi([
            "function withdraw(uint256 amount, address recipient, uint256 l2Epoch, uint256 numCheckpointsInEpoch, uint256 leafIndex, bytes32[] siblingPath, bytes32 l2Sender)",
            "function withdrawPrivate(uint256 amount, address recipient, uint256 l2Epoch, uint256 numCheckpointsInEpoch, uint256 leafIndex, bytes32[] siblingPath, bytes32 l2Sender)",
          ]);
          // L22: exit token -> L2 token address that emitted it (bytes32 sender).
          const l2SenderMap: Record<string, string | undefined> = {
            tUSDC: config.tUSDC,
            aUSDC: config.tUSDC,
            tETH: config.tETH,
            aWETH: config.tETH,
            tBTC: config.tBTC,
            aWBTC: config.tBTC,
          };
          for (const exit of state.scheduledExits) {
            if (exit.status !== "submitted") continue;
            if (!exit.l2TxHash || exit.l2EpochAtSubmit === null) continue;
            const l1BridgeAddr = bridgeMap[exit.token];
            if (!l1BridgeAddr) continue;
            console.log(`Checking L1 claim eligibility for ${exit.id}...`);
            try {
              const expectedContent = computeWithdrawContent(
                exit.l1Recipient,
                BigInt(exit.amount),
                false,
              );
              const exitL2Sender = l2SenderMap[exit.token];
              if (!exitL2Sender) {
                console.warn(`  -> no L2 token address in config for ${exit.token}; skipping`);
                continue;
              }
              const proof = await buildOutboxProof(
                config.nodeUrl,
                exit.l2TxHash,
                expectedContent,
                l1RpcUrl,
                exitL2Sender,
                l1BridgeAddr,
              );
              const siblingPathBytes = proof.siblingPath.map(
                (h) => (h.startsWith("0x") ? h : `0x${h}`) as `0x${string}`,
              );
              const l1TxHash = await walletClient.writeContract({
                address: l1BridgeAddr as `0x${string}`,
                abi: tokenBridgeAbi,
                functionName: "withdraw",
                args: [
                  BigInt(exit.amount),
                  exit.l1Recipient as `0x${string}`,
                  proof.l2Epoch,
                  proof.numCheckpointsInEpoch,
                  proof.leafIndex,
                  siblingPathBytes,
                  exitL2Sender as `0x${string}`,
                ],
              });
              // M7: mark "done" only when the L1 receipt confirms success; on a
              // revert leave the status "submitted" so the next tick retries.
              const receipt = await publicClient.waitForTransactionReceipt({ hash: l1TxHash });
              if (receipt.status === "success") {
                exit.status = "done";
                console.log(`  -> claimed on L1 (l1_tx ${l1TxHash})`);
              } else {
                console.error(`  -> L1 claim tx ${l1TxHash} reverted (status=${receipt.status}); leaving "submitted" to retry`);
              }
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              console.error(`  -> L1 claim FAILED: ${msg}; will retry on next tick`);
            }
          }
          // Persist any "done" status changes from the L1 claim leg.
          const { saveBridgeState } = await import("@quetzal/sdk/privacy/bridge-schedule");
          saveBridgeState(state);
        }
      } finally {
        await client.stop();
      }
    });
}

// Reference imports to keep tree-shaking from dropping codegen bindings the CLI
// may still touch via dyn casts elsewhere (e.g. claim.ts).
void TokenContract;
void AztecAddress;
