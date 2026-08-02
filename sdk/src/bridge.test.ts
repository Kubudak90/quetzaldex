// sdk/src/bridge.test.ts
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  validateBridgeExitInput,
  BridgeApi,
  _internals,
  DEPOSIT_INITIATED_TOPIC,
  INBOX_MESSAGE_SENT_TOPIC,
} from "./bridge.js";
import { BridgeError } from "./errors.js";

// ─── Minimal mock client shape for BridgeApi tests ───────────────────────────

function makeMockClient(nodeUrl = "https://node.mock") {
  return {
    config: { nodeUrl, contracts: undefined },
    wallet: {},
    address: {},
  } as unknown as Parameters<typeof BridgeApi.prototype.claim>[0] extends never
    ? never
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    : any;
}

describe("BridgeApi.getMessageReady", () => {
  // Must be a valid BN254 Fr value (< field modulus ~0x30644e...)
  const VALID_HASH = ("0x" + "00".repeat(31) + "01") as `0x${string}`;

  test("returns true when L1→L2 message is in the tree", async () => {
    const origGetNode = _internals.getNode;
    _internals.getNode = async (_url: string) => ({
      getL1ToL2MessageMembershipWitness: async (_block: unknown, _hash: unknown) => ({
        index: 42n,
        siblingPath: [],
      }),
    });
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const api = new BridgeApi(makeMockClient() as any);
      const result = await api.getMessageReady(VALID_HASH);
      assert.strictEqual(result, true);
    } finally {
      _internals.getNode = origGetNode;
    }
  });

  test("returns false when no membership witness yet", async () => {
    const origGetNode = _internals.getNode;
    _internals.getNode = async (_url: string) => ({
      getL1ToL2MessageMembershipWitness: async (_block: unknown, _hash: unknown) => undefined,
    });
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const api = new BridgeApi(makeMockClient() as any);
      const result = await api.getMessageReady(VALID_HASH);
      assert.strictEqual(result, false);
    } finally {
      _internals.getNode = origGetNode;
    }
  });

  test("rejects malformed message hash", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const api = new BridgeApi(makeMockClient() as any);
    await assert.rejects(
      () => api.getMessageReady("not-hex" as `0x${string}`),
      (err: Error) => {
        assert.ok(err instanceof BridgeError);
        assert.match(err.message, /messageHash/);
        return true;
      },
    );
  });

  test("rejects message hash with invalid hex characters", async () => {
    // "0x" + "ZZ".repeat(32) = 66 chars, correct prefix and length, invalid hex
    const badHash = ("0x" + "ZZ".repeat(32)) as `0x${string}`;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const api = new BridgeApi(makeMockClient() as any);
    await assert.rejects(
      () => api.getMessageReady(badHash),
      (err: Error) => {
        assert.ok(err instanceof BridgeError);
        assert.match(err.message, /messageHash/);
        return true;
      },
    );
  });
});

describe("validateBridgeExitInput", () => {
  test("rejects amount <= 0", () => {
    assert.throws(
      () => validateBridgeExitInput({ token: "tUSDC", amount: 0n, l1Recipient: "0xabc" }),
      BridgeError,
    );
  });
  test("rejects empty l1Recipient", () => {
    assert.throws(
      () => validateBridgeExitInput({ token: "tUSDC", amount: 1n, l1Recipient: "" }),
      BridgeError,
    );
  });
  test("accepts valid", () => {
    assert.doesNotThrow(
      () => validateBridgeExitInput({ token: "tUSDC", amount: 1n, l1Recipient: "0xabc" }),
    );
  });
});

// ─── BridgeApi.deposit ───────────────────────────────────────────────────────

describe("BridgeApi.deposit", () => {
  // DepositInitiated topic hash imported from bridge.ts (deduped against
  // the production constant — contracts-l1/src/TokenBridge.sol).

  // Build a 32-byte hex chunk from a bigint, no 0x.
  const u256Hex = (v: bigint): string => v.toString(16).padStart(64, "0");

  // Build a 32-byte hex chunk from a 0x-prefixed hex string (left-pad to 64).
  const bytes32Hex = (hex: string): string => hex.replace(/^0x/, "").padStart(64, "0");

  function makeMockClientWithL1(
    l1: {
      usdcBridge?: string;
      wethBridge?: string;
      wbtcBridge?: string;
      rpcUrl?: string;
    } | undefined,
  ) {
    return {
      config: {
        nodeUrl: "https://node.mock",
        l1,
        contracts: {
          orderbook: "0x0000000000000000000000000000000000000000000000000000000000000abc",
          tUSDC: "0x0000000000000000000000000000000000000000000000000000000000000001",
          tETH: "0x0000000000000000000000000000000000000000000000000000000000000002",
          tBTC: "0x0000000000000000000000000000000000000000000000000000000000000003",
          pools: [],
        },
      },
      wallet: {},
      address: {
        toString: () =>
          "0x1111111111111111111111111111111111111111111111111111111111111111",
      },
    } as unknown as Parameters<typeof BridgeApi.prototype.claim>[0] extends never
      ? never
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      : any;
  }

  const APPROVE_HASH =
    "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const DEPOSIT_HASH =
    "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const L1_TOKEN_ADDR = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238";
  const SENDER_ADDR = "0xfaceb00cfaceb00cfaceb00cfaceb00cfaceb00c";
  // Padded indexed bytes32 topics matching the DepositInitiated event:
  //   topics = [topic0, sender(address-padded-to-32), l2Recipient(bytes32)]
  const SENDER_TOPIC = ("0x" + bytes32Hex(SENDER_ADDR)) as `0x${string}`;
  const L2_RECIPIENT_TOPIC = ("0x" +
    bytes32Hex(
      "0x1111111111111111111111111111111111111111111111111111111111111111",
    )) as `0x${string}`;

  // Real viem decodeEventLog (used to drive the same path the production
  // code does — confirms the ABI + topic ordering all line up).
  // Optionally includes an L1Inbox.MessageSent log in the deposit receipt so
  // Sub-7c Task 12 messageHash extraction can be exercised.
  // If `malformedMessageSent` is set, emits a log with the right topic0 but
  // wrong shape (only 2 topics instead of 3) so the production try/catch
  // around decodeEventLog is exercised — verifies graceful degradation.
  const setupViemMock = (
    eventData: string,
    messageSent?: { hash: `0x${string}`; checkpointNumber?: bigint; index?: bigint },
    malformedMessageSent?: boolean,
  ) => {
    const origGetViem = _internals.getViem;
    let realDecodeEventLog: typeof import("viem").decodeEventLog;
    return {
      install: async () => {
        const viem = await import("viem");
        realDecodeEventLog = viem.decodeEventLog;
        _internals.getViem = async () => ({
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          createPublicClient: (() => ({
            readContract: async () => L1_TOKEN_ADDR,
            waitForTransactionReceipt: async ({ hash }: { hash: string }) => {
              if (hash === APPROVE_HASH) return { logs: [] };
              const logs: Array<{ topics: readonly `0x${string}`[]; data: `0x${string}` }> = [
                {
                  topics: [DEPOSIT_INITIATED_TOPIC, SENDER_TOPIC, L2_RECIPIENT_TOPIC],
                  data: eventData as `0x${string}`,
                },
              ];
              if (messageSent) {
                // MessageSent topics = [topic0, checkpointNumber(indexed),
                //                       hash(indexed)] ; data = index | rollingHash (padded to 32)
                const checkpoint = messageSent.checkpointNumber ?? 7n;
                const index = messageSent.index ?? 99n;
                const checkpointTopic = ("0x" + u256Hex(checkpoint)) as `0x${string}`;
                // rollingHash is bytes16 — viem ABI-decodes from the 32-byte
                // slot with the value left-aligned in the first 16 bytes.
                const indexHex = u256Hex(index);
                const rollingHex = "00".repeat(16) + "00".repeat(16);
                logs.push({
                  topics: [
                    INBOX_MESSAGE_SENT_TOPIC,
                    checkpointTopic,
                    messageSent.hash,
                  ],
                  data: ("0x" + indexHex + rollingHex) as `0x${string}`,
                });
              }
              if (malformedMessageSent) {
                // Right topic0, wrong shape: only 2 topics instead of 3 (missing
                // the indexed `hash` topic). viem.decodeEventLog will throw
                // because the indexed args don't match the ABI fragment.
                logs.push({
                  topics: [
                    INBOX_MESSAGE_SENT_TOPIC,
                    ("0x" + u256Hex(7n)) as `0x${string}`,
                  ],
                  data: "0x" as `0x${string}`,
                });
              }
              return { logs };
            },
          })) as unknown as typeof import("viem").createPublicClient,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          http: ((_url?: string) => undefined) as any,
          decodeEventLog: realDecodeEventLog,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          sepolia: { id: 11155111 } as any,
        });
      },
      restore: () => {
        _internals.getViem = origGetViem;
      },
    };
  };

  test("happy path (public): approves + bridges + returns secret + messageIndex", async () => {
    const writeCalls: Array<{ functionName: string; args: readonly unknown[] }> = [];
    const MESSAGE_INDEX = 42n;

    // event data layout (non-indexed, in order):
    //   amount (uint256) | secretHash (bytes32) | messageIndex (uint256) | isPrivate (bool)
    const eventData =
      "0x" +
      u256Hex(1_000_000n) +
      u256Hex(0n) +
      u256Hex(MESSAGE_INDEX) +
      u256Hex(0n);

    const mockWallet = {
      account: { address: SENDER_ADDR as `0x${string}` },
      writeContract: async (args: { functionName: string; args: readonly unknown[] }) => {
        writeCalls.push({ functionName: args.functionName, args: args.args });
        if (args.functionName === "approve") return APPROVE_HASH;
        return DEPOSIT_HASH;
      },
    };

    const viemMock = setupViemMock(eventData);
    await viemMock.install();

    try {
      const api = new BridgeApi(
        makeMockClientWithL1({
          usdcBridge: "0x000000000000000000000000000000000000a55c",
          rpcUrl: "https://sepolia.mock",
        }),
      );
      const result = await api.deposit(
        { token: "tUSDC", amount: 1_000_000n, isPrivate: false },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        mockWallet as any,
      );
      assert.strictEqual(result.l1TxHash, DEPOSIT_HASH);
      assert.strictEqual(result.messageIndex, MESSAGE_INDEX);
      assert.ok(result.secret, "expected secret");
      assert.match(result.secret!, /^0x[0-9a-f]{1,64}$/);
      assert.ok(result.secretHash, "expected secretHash");
      assert.match(result.secretHash!, /^0x[0-9a-f]{1,64}$/);
      assert.strictEqual(writeCalls.length, 2);
      assert.strictEqual(writeCalls[0].functionName, "approve");
      assert.strictEqual(writeCalls[1].functionName, "depositToL2Public");
      // depositToL2Public(amount, l2Recipient, secretHash) -> 3 args
      assert.strictEqual(writeCalls[1].args.length, 3);
    } finally {
      viemMock.restore();
    }
  });

  test("happy path (private): isPrivate:true uses depositToL2Private with 2 args", async () => {
    const writeCalls: Array<{ functionName: string; args: readonly unknown[] }> = [];
    const MESSAGE_INDEX = 99n;

    const eventData =
      "0x" +
      u256Hex(2_500_000n) +
      u256Hex(0n) +
      u256Hex(MESSAGE_INDEX) +
      u256Hex(1n); // isPrivate = true

    const mockWallet = {
      account: { address: SENDER_ADDR as `0x${string}` },
      writeContract: async (args: { functionName: string; args: readonly unknown[] }) => {
        writeCalls.push({ functionName: args.functionName, args: args.args });
        if (args.functionName === "approve") return APPROVE_HASH;
        return DEPOSIT_HASH;
      },
    };

    const viemMock = setupViemMock(eventData);
    await viemMock.install();

    try {
      const api = new BridgeApi(
        makeMockClientWithL1({
          usdcBridge: "0x000000000000000000000000000000000000a55c",
          rpcUrl: "https://sepolia.mock",
        }),
      );
      const result = await api.deposit(
        { token: "tUSDC", amount: 2_500_000n, isPrivate: true },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        mockWallet as any,
      );
      assert.strictEqual(result.l1TxHash, DEPOSIT_HASH);
      assert.strictEqual(result.messageIndex, MESSAGE_INDEX);
      assert.ok(result.secret, "expected secret");
      assert.match(result.secret!, /^0x[0-9a-f]{1,64}$/);
      assert.ok(result.secretHash, "expected secretHash");
      assert.match(result.secretHash!, /^0x[0-9a-f]{1,64}$/);
      assert.strictEqual(writeCalls.length, 2);
      assert.strictEqual(writeCalls[0].functionName, "approve");
      assert.strictEqual(writeCalls[1].functionName, "depositToL2Private");
      // depositToL2Private(amount, secretHash) -> 2 args (no l2Recipient)
      assert.strictEqual(writeCalls[1].args.length, 2);
    } finally {
      viemMock.restore();
    }
  });

  test("Sub-7c Task 12: messageHash parsed from L1Inbox.MessageSent log", async () => {
    const MESSAGE_INDEX = 42n;
    const EXPECTED_MSG_HASH = ("0x" +
      "deadbeef".repeat(8)) as `0x${string}`; // 64 hex chars

    const eventData =
      "0x" +
      u256Hex(1_000_000n) +
      u256Hex(0n) +
      u256Hex(MESSAGE_INDEX) +
      u256Hex(0n);

    const mockWallet = {
      account: { address: SENDER_ADDR as `0x${string}` },
      writeContract: async (args: { functionName: string; args: readonly unknown[] }) => {
        return args.functionName === "approve" ? APPROVE_HASH : DEPOSIT_HASH;
      },
    };

    const viemMock = setupViemMock(eventData, { hash: EXPECTED_MSG_HASH });
    await viemMock.install();
    try {
      const api = new BridgeApi(
        makeMockClientWithL1({
          usdcBridge: "0x000000000000000000000000000000000000a55c",
          rpcUrl: "https://sepolia.mock",
        }),
      );
      const result = await api.deposit(
        { token: "tUSDC", amount: 1_000_000n, isPrivate: false },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        mockWallet as any,
      );
      assert.strictEqual(
        result.messageHash,
        EXPECTED_MSG_HASH,
        "messageHash should be parsed from the L1Inbox.MessageSent log",
      );
    } finally {
      viemMock.restore();
    }
  });

  test("Sub-7c Task 12: messageHash undefined when MessageSent log missing (defensive)", async () => {
    const MESSAGE_INDEX = 42n;
    const eventData =
      "0x" +
      u256Hex(1_000_000n) +
      u256Hex(0n) +
      u256Hex(MESSAGE_INDEX) +
      u256Hex(0n);

    const mockWallet = {
      account: { address: SENDER_ADDR as `0x${string}` },
      writeContract: async (args: { functionName: string; args: readonly unknown[] }) => {
        return args.functionName === "approve" ? APPROVE_HASH : DEPOSIT_HASH;
      },
    };

    const viemMock = setupViemMock(eventData /* no messageSent */);
    await viemMock.install();
    try {
      const api = new BridgeApi(
        makeMockClientWithL1({
          usdcBridge: "0x000000000000000000000000000000000000a55c",
          rpcUrl: "https://sepolia.mock",
        }),
      );
      const result = await api.deposit(
        { token: "tUSDC", amount: 1_000_000n, isPrivate: false },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        mockWallet as any,
      );
      // messageIndex still surfaces (DepositInitiated event), but messageHash
      // is undefined so the UI falls back to "polling disabled" semantics.
      assert.strictEqual(result.messageIndex, MESSAGE_INDEX);
      assert.strictEqual(result.messageHash, undefined);
    } finally {
      viemMock.restore();
    }
  });

  test("Sub-7c Task 12: messageHash undefined when MessageSent log is malformed (defensive)", async () => {
    // Right topic0 but wrong shape (only 2 topics instead of the expected 3).
    // The production try/catch around viem.decodeEventLog should swallow the
    // error and surface messageHash: undefined — exactly the same graceful
    // degradation as the "log missing" case. UI then treats this as "polling
    // disabled" and falls back to user-driven manual claim.
    const MESSAGE_INDEX = 42n;
    const eventData =
      "0x" +
      u256Hex(1_000_000n) +
      u256Hex(0n) +
      u256Hex(MESSAGE_INDEX) +
      u256Hex(0n);

    const mockWallet = {
      account: { address: SENDER_ADDR as `0x${string}` },
      writeContract: async (args: { functionName: string; args: readonly unknown[] }) => {
        return args.functionName === "approve" ? APPROVE_HASH : DEPOSIT_HASH;
      },
    };

    const viemMock = setupViemMock(eventData, undefined, true /* malformedMessageSent */);
    await viemMock.install();
    try {
      const api = new BridgeApi(
        makeMockClientWithL1({
          usdcBridge: "0x000000000000000000000000000000000000a55c",
          rpcUrl: "https://sepolia.mock",
        }),
      );
      const result = await api.deposit(
        { token: "tUSDC", amount: 1_000_000n, isPrivate: false },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        mockWallet as any,
      );
      assert.strictEqual(result.messageIndex, MESSAGE_INDEX);
      assert.strictEqual(
        result.messageHash,
        undefined,
        "messageHash should be undefined when MessageSent log is malformed (try/catch swallows the decode error)",
      );
    } finally {
      viemMock.restore();
    }
  });

  test("rejects when L1 config missing", async () => {
    const api = new BridgeApi(makeMockClientWithL1(undefined));
    await assert.rejects(
      () =>
        api.deposit(
          { token: "tUSDC", amount: 1n, isPrivate: false },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          { account: { address: "0xabc" } } as any,
        ),
      (err: Error) => {
        assert.ok(err instanceof BridgeError);
        assert.match(err.message, /config\.l1/);
        return true;
      },
    );
  });

  test("rejects unknown token alias", async () => {
    const api = new BridgeApi(
      makeMockClientWithL1({
        usdcBridge: "0x000000000000000000000000000000000000a55c",
      }),
    );
    await assert.rejects(
      () =>
        api.deposit(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          { token: "junk", amount: 1n, isPrivate: false } as any,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          { account: { address: "0xabc" } } as any,
        ),
      (err: Error) => {
        assert.ok(err instanceof BridgeError);
        assert.match(err.message, /unknown token/);
        return true;
      },
    );
  });
});

// ─── BridgeApi.claim — secret guard (L8) ────────────────────────────────────

describe("BridgeApi.claim — secret guard (L8)", () => {
  function makeMockClientWithContracts() {
    return {
      config: {
        nodeUrl: "https://node.mock",
        contracts: {
          tUSDC: "0x" + "01".repeat(32),
          tETH:  "0x" + "02".repeat(32),
          tBTC:  "0x" + "03".repeat(32),
          orderbook: "0x" + "04".repeat(32),
          pools: [],
        },
      },
      wallet: {},
      address: {},
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as unknown as any;
  }

  test("rejects public claim when secret is omitted (L8)", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const api = new BridgeApi(makeMockClientWithContracts() as any);
    await assert.rejects(
      () => api.claim({ token: "tUSDC", amount: 1n, isPrivate: false, messageIndex: "0x01" }),
      (err: Error) => {
        assert.ok(err instanceof BridgeError, `expected BridgeError, got ${err.constructor.name}`);
        assert.match(err.message, /secret/);
        return true;
      },
    );
  });

  test("rejects private claim when secret is omitted (L8)", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const api = new BridgeApi(makeMockClientWithContracts() as any);
    await assert.rejects(
      () => api.claim({ token: "tUSDC", amount: 1n, isPrivate: true, messageIndex: "0x01" }),
      (err: Error) => {
        assert.ok(err instanceof BridgeError, `expected BridgeError, got ${err.constructor.name}`);
        assert.match(err.message, /secret/);
        return true;
      },
    );
  });
});

// ─── BridgeApi.prepareL1Withdraw ─────────────────────────────────────────────

describe("BridgeApi.prepareL1Withdraw", () => {
  function makeMockClientWithL1(l1: { usdcBridge?: string; wethBridge?: string } | undefined) {
    return {
      config: {
        nodeUrl: "https://node.mock",
        l1,
        contracts: {
          orderbook: "0x" + "dd".repeat(32),
          tUSDC: "0x" + "ff".repeat(32),
          tETH: "0x" + "ee".repeat(32),
          pools: [],
        },
      },
      wallet: {},
      address: { toString: () => "0x" + "11".repeat(32) },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as unknown as any;
  }

  test("returns calldata for withdraw call on the right bridge", async () => {
    const client = makeMockClientWithL1({ usdcBridge: "0x" + "aa".repeat(20) });
    const bridge = new BridgeApi(client);
    const result = await bridge.prepareL1Withdraw({
      token: "aUSDC",
      amount: 1_000_000n,
      l1Recipient: "0xcF582A37AaE1E580b63666587FFa42d84169bA62" as `0x${string}`,
      isPrivate: false,
      siblingPath: [("0x" + "11".repeat(32)) as `0x${string}`],
      l2Epoch: 100n,
      numCheckpointsInEpoch: 1n,
      leafIndex: 5n,
    });
    assert.strictEqual(result.to, "0x" + "aa".repeat(20));
    assert.match(result.data, /^0x[0-9a-f]+$/);
  });

  test("rejects unknown token alias", async () => {
    const client = makeMockClientWithL1({ usdcBridge: "0x" + "aa".repeat(20) });
    const bridge = new BridgeApi(client);
    await assert.rejects(
      () =>
        bridge.prepareL1Withdraw({
          token: "junk",
          amount: 1n,
          l1Recipient: ("0x" + "11".repeat(20)) as `0x${string}`,
          isPrivate: false,
          siblingPath: [],
          l2Epoch: 1n,
          numCheckpointsInEpoch: 1n,
          leafIndex: 0n,
        }),
      (err: Error) => {
        assert.ok(err instanceof BridgeError);
        assert.match(err.message, /unknown token/);
        return true;
      },
    );
  });

  // Sub-7c D2 follow-up: bare UI ids ("USDC"/"WETH"/"wBTC") that the frontend
  // tabs pass through must resolve to the same bridge as the t*/a* aliases.
  // Pre-fix: every L1 withdraw threw `unknown token alias 'USDC'` silently.
  test("Sub-7c D2 follow-up: bare UI id 'USDC' resolves to usdcBridge", async () => {
    const client = makeMockClientWithL1({ usdcBridge: "0x" + "aa".repeat(20) });
    const bridge = new BridgeApi(client);
    const result = await bridge.prepareL1Withdraw({
      token: "USDC",
      amount: 1_000_000n,
      l1Recipient: "0xcF582A37AaE1E580b63666587FFa42d84169bA62" as `0x${string}`,
      isPrivate: false,
      siblingPath: [("0x" + "11".repeat(32)) as `0x${string}`],
      l2Epoch: 100n,
      numCheckpointsInEpoch: 1n,
      leafIndex: 5n,
    });
    assert.strictEqual(result.to, "0x" + "aa".repeat(20));
    assert.match(result.data, /^0x[0-9a-f]+$/);
  });
});
