// Quick L1→L2 message status check for both the deposit and drip.
import { createAztecNodeClient } from "@aztec/aztec.js/node";
import { Fr } from "@aztec/aztec.js/fields";

const NODE_URL = process.env.AZTEC_NODE_URL!;

async function main() {
  const node = createAztecNodeClient(NODE_URL) as unknown as {
    getL1ToL2MessageMembershipWitness: (block: string, msg: Fr) => Promise<unknown | undefined>;
  };

  // Deposit's message_hash isn't directly stored; check via the existing leafIndex query.
  // From state: messageIndex=94183424 (USDC deposit), DRIP_MESSAGE_LEAF_INDEX=94190592 (fee-juice).
  // But getL1ToL2MessageMembershipWitness takes a message Fr, not a leaf index.
  // We have the deposit's secretHash from the L1 event; the message hash is what L1Inbox emitted.
  // From recover-drip output: drip's messageHash = 0x00eb47249595fbe31e29303b5ee89d953ed6b150b11aac432e36dfcd18795d1d.
  // Deposit's messageHash wasn't captured, but the bridge.ts deposit() returns it from L1Inbox.MessageSent.

  // Check just the drip's message:
  const dripMsgHash = "0x00eb47249595fbe31e29303b5ee89d953ed6b150b11aac432e36dfcd18795d1d";
  console.log(`checking drip messageHash ${dripMsgHash} ...`);
  const witness = await node.getL1ToL2MessageMembershipWitness("latest", Fr.fromHexString(dripMsgHash));
  console.log("drip witness:", witness === undefined ? "NOT IN TREE YET" : "IN TREE ✓");
  if (witness) console.log(JSON.stringify(witness, (_k, v) => typeof v === "bigint" ? v.toString() : v, 2));
}
main().catch(e => { console.error(e); process.exit(1); });
