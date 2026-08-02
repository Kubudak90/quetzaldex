/**
 * Golden vector for the SCOPED L2→L1 message leaf — the value the Aztec Outbox
 * actually commits, and therefore the only value a withdraw membership proof can
 * search for.
 *
 * Why this file exists: buildOutboxProof used to search for the raw portal
 * `content`. Deposits were green for hours, but EVERY withdraw proof failed with
 * "the L2ToL1Message you are trying to prove inclusion of does not exist",
 * because `TxEffect.l2ToL1Msgs` carries this scoped hash (which binds the
 * emitting L2 contract and the target L1 portal) rather than the content. The
 * vector below is not synthetic: it is the message a REAL exit_to_l1_public
 * emitted on the v5 testnet, read straight back off the chain.
 */
import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { computeL2ToL1MessageLeaf, computeWithdrawContent } from "./sha256-content.js";

// tETH.exit_to_l1_public(1e12, 0xcF58…) on Aztec v5 testnet (rollup 2787991301),
// L2 tx 0x02c8f21466971b1a812e35b6f67e0b02d202681cb69106d30ba99c86a32b5b8c.
const L2_TETH = "0x26e11e60dcbe653d42766c1b9a05af3e5f10af42b6429a0b9c454072ccdbe243";
const L1_WETH_BRIDGE = "0x3f5aab58fcef4da7d7de18dad88d83e5b97afe2d";
const ROLLUP_VERSION = 2787991301n;
const SEPOLIA = 11155111n;
const L1_RECIPIENT = "0xcF582A37AaE1E580b63666587FFa42d84169bA62";
const AMOUNT = 1_000_000_000_000n;

// Read off-chain from the tx effect's l2ToL1Msgs.
const ON_CHAIN_LEAF = "0x00f2f453b00646c1b9e6a36120658550a3a02daead370c022b3bf57f67c64840";
// What the portal hashed into the message (what we used to — wrongly — prove).
const CONTENT = "0x0084090ea45019c8bc43471a72b719811ca7ecd8066ccba5ff7da92c7d6a144f";

describe("computeL2ToL1MessageLeaf — the value the Outbox commits", () => {
  it("reproduces a REAL on-chain exit message leaf", () => {
    const content = computeWithdrawContent(L1_RECIPIENT, AMOUNT, false);
    assert.equal(content, CONTENT, "content vector drifted");

    const leaf = computeL2ToL1MessageLeaf({
      l2Sender: L2_TETH,
      rollupVersion: ROLLUP_VERSION,
      l1Recipient: L1_WETH_BRIDGE,
      chainId: SEPOLIA,
      content,
    });
    assert.equal(leaf, ON_CHAIN_LEAF);
  });

  it("the leaf is NOT the content (the bug this pins)", () => {
    assert.notEqual(ON_CHAIN_LEAF, CONTENT);
  });

  it("binds the emitting L2 contract — a different sender yields a different leaf", () => {
    const other = computeL2ToL1MessageLeaf({
      l2Sender: "0x1214ccce9d5314f37e8ee04f8b12daae43ed721a5c7949e272f529a9a7267ef4", // tUSDC
      rollupVersion: ROLLUP_VERSION,
      l1Recipient: L1_WETH_BRIDGE,
      chainId: SEPOLIA,
      content: CONTENT,
    });
    assert.notEqual(other, ON_CHAIN_LEAF);
  });

  it("binds the target L1 portal — a different bridge yields a different leaf", () => {
    const other = computeL2ToL1MessageLeaf({
      l2Sender: L2_TETH,
      rollupVersion: ROLLUP_VERSION,
      l1Recipient: "0x219ffbb6a504fcd69ae80d1e70db699b48a9936b", // usdcBridge
      chainId: SEPOLIA,
      content: CONTENT,
    });
    assert.notEqual(other, ON_CHAIN_LEAF);
  });

  it("binds the rollup version — a reset network yields a different leaf", () => {
    const other = computeL2ToL1MessageLeaf({
      l2Sender: L2_TETH,
      rollupVersion: ROLLUP_VERSION + 1n,
      l1Recipient: L1_WETH_BRIDGE,
      chainId: SEPOLIA,
      content: CONTENT,
    });
    assert.notEqual(other, ON_CHAIN_LEAF);
  });

  it("rejects malformed inputs instead of hashing garbage", () => {
    assert.throws(
      () => computeL2ToL1MessageLeaf({
        l2Sender: "0xdeadbeef",
        rollupVersion: ROLLUP_VERSION,
        l1Recipient: L1_WETH_BRIDGE,
        chainId: SEPOLIA,
        content: CONTENT,
      }),
      /l2Sender must be 0x \+ 32 bytes/,
    );
    assert.throws(
      () => computeL2ToL1MessageLeaf({
        l2Sender: L2_TETH,
        rollupVersion: ROLLUP_VERSION,
        l1Recipient: L2_TETH, // 32 bytes, not an address
        chainId: SEPOLIA,
        content: CONTENT,
      }),
      /l1Recipient must be 0x \+ 20 bytes/,
    );
  });
});
