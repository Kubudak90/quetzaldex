// sdk/src/bridge.ts
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { Fr } from "@aztec/aztec.js/fields";
import { computeSecretHash } from "@aztec/stdlib/hash";
import type { WalletClient } from "viem";
import type { QuetzalClient } from "./client.js";
import type { ScheduledExit, QuetzalContracts, NetworkConfig } from "./types.js";
import { BridgeError, ConfigError } from "./errors.js";
import { buildSplitSchedule, loadBridgeState, saveBridgeState } from "./privacy/bridge-schedule.js";
import { queryRecentDeposits, isRoundTripRisk } from "./privacy/bridge-history.js";
import { classifyAmount, formatAdvisory, resolveTokenDecimals } from "./privacy/amount-heuristic.js";
import { computeWithdrawContent } from "./util/sha256-content.js";

/**
 * Shape that `interaction.send({ from })` RESOLVES to in aztec.js 4.x
 * (TxSendResultMined, @aztec/aztec.js .../contract/interaction_options): the tx
 * has ALREADY been mined by the time the promise resolves, and the receipt carries
 * txHash/status. There is NO `.wait()` method on this value — the pre-4.x
 * `.send().wait()` / `.send().wait?.()` form is a no-op (a Promise has no `.wait`)
 * and silently discards the tx + swallows reverts. Always `await .send()` and read
 * `.receipt`.
 */
type TxSendResult = {
  receipt?: {
    txHash?: { toString: () => string };
    blockNumber?: number;
    status?: string;
    error?: string;
    hasExecutionReverted?: () => boolean;
  };
};

export interface BridgeDepositInput {
  token: string;
  amount: bigint;
  isPrivate: boolean;
}

export interface BridgeDepositResult {
  l1TxHash: string;
  messageIndex: bigint;
  /**
   * Fr preimage of secretHash. MUST be persisted by the caller (e.g., localStorage)
   * before this function returns — loss is permanent and the deposit cannot be claimed.
   * Never transmit to a server.
   */
  secret?: string;
  /**
   * SHA-256 hash of `secret`. Safe to log; used by the L1 bridge contract and
   * `BridgeApi.getMessageReady` polling.
   */
  secretHash?: string;
  /**
   * L1→L2 inbox message hash (0x-prefixed 32-byte hex). This is what
   * `BridgeApi.getMessageReady` takes — it's the L1Inbox tree leaf value.
   *
   * Source: parsed from the `MessageSent(uint256 indexed checkpointNumber,
   * uint256 index, bytes32 indexed hash, bytes16 rollingHash)` event that
   * `IInbox.sendL2Message()` emits inside the same deposit tx. May be `undefined`
   * if no matching MessageSent log was found in the receipt (defensive fallback;
   * UI should treat as "polling disabled" in that case).
   */
  messageHash?: `0x${string}`;
}

export interface BridgeClaimInput {
  token: string;
  amount: bigint;
  isPrivate: boolean;
  secret?: Fr | string;
  messageIndex: Fr | string;
}

export interface BridgeExitInput {
  token: string;
  amount: bigint;
  l1Recipient: string;
  isPrivate?: boolean;
  splitInto?: number;
  intervalDays?: number;
  ackRound?: boolean;
  ackDelay?: boolean;
  relayerFee?: bigint;
}

export interface BridgeTickInput {
  autoClaim?: boolean;
}

// NOTE: The real on-chain withdraw ABI (verified against
// contracts-l1/out/TokenBridge.sol/TokenBridge.json) differs from the
// Sub-7c plan's draft in four ways:
//   1. There is NO single `withdraw(recipient, amount, withdrawIsPrivate, ...)` —
//      instead there are TWO separate functions: `withdraw` (public) and
//      `withdrawPrivate` (private). isPrivate routes to the correct function.
//   2. Args are reordered: `amount` comes FIRST, then `recipient`.
//   3. The block-number param is named `l2Epoch` (not `l2BlockNumber`).
//   4. There is no `withdrawIsPrivate` boolean parameter at all.
export interface PrepareL1WithdrawInput {
  token: string;
  amount: bigint;
  l1Recipient: `0x${string}`;
  isPrivate: boolean;
  siblingPath: `0x${string}`[];
  /** Aztec L2 epoch (block number) at which the exit was included. */
  l2Epoch: bigint;
  /** v5: checkpoint count the epoch out-hash root was built from (from the
   *  outbox proof / membership witness). */
  numCheckpointsInEpoch: bigint;
  leafIndex: bigint;
  /** L22: the L2 token address the exit was emitted under. Defaults to the current
   *  configured L2 token address (config.contracts.tUSDC / tETH / tBTC); pass the
   *  OLD address for exits made before a migration. */
  l2Sender?: `0x${string}`;
}

export interface PrepareL1WithdrawResult {
  to: `0x${string}`;
  data: `0x${string}`;
}

// ─── L1 bridge ABI fragments (TokenBridge.sol, contracts-l1/src/TokenBridge.sol) ──

const ERC20_APPROVE_ABI = [
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

// NOTE: actual on-chain ABI differs from the Sub-7c plan's draft ABI in two
// ways verified against contracts-l1/out/TokenBridge.sol/TokenBridge.json:
//   1. The L1 ERC20 getter is `l1Token()`, NOT `underlyingToken()` (which is
//      the FeeJuicePortal's name — different contract).
//   2. The emitted event is `DepositInitiated`, NOT `DepositToAztecPublic`
//      (also a FeeJuicePortal artifact). DepositInitiated has shape:
//        (address indexed sender,
//         bytes32 indexed l2Recipient,
//         uint256 amount,
//         bytes32 secretHash,
//         uint256 messageIndex,
//         bool    isPrivate)
//      Topic0: 0x6d427fdb35b9c2ae11c4374e424fdc75bd8ae80001f74d846ea70bf7233af909
//      Data layout (non-indexed): amount | secretHash | messageIndex | isPrivate
const BRIDGE_DEPOSIT_ABI = [
  {
    type: "function",
    name: "depositToL2Public",
    stateMutability: "nonpayable",
    inputs: [
      { name: "amount", type: "uint256" },
      { name: "l2Recipient", type: "bytes32" },
      { name: "secretHash", type: "bytes32" },
    ],
    outputs: [
      { name: "messageHash", type: "bytes32" },
      { name: "messageIndex", type: "uint256" },
    ],
  },
  {
    type: "function",
    name: "depositToL2Private",
    stateMutability: "nonpayable",
    inputs: [
      { name: "amount", type: "uint256" },
      { name: "secretHash", type: "bytes32" },
    ],
    outputs: [
      { name: "messageHash", type: "bytes32" },
      { name: "messageIndex", type: "uint256" },
    ],
  },
  {
    type: "function",
    name: "l1Token",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "event",
    name: "DepositInitiated",
    inputs: [
      { name: "sender", type: "address", indexed: true },
      { name: "l2Recipient", type: "bytes32", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
      { name: "secretHash", type: "bytes32", indexed: false },
      { name: "messageIndex", type: "uint256", indexed: false },
      { name: "isPrivate", type: "bool", indexed: false },
    ],
  },
] as const;

export const DEPOSIT_INITIATED_TOPIC =
  "0x6d427fdb35b9c2ae11c4374e424fdc75bd8ae80001f74d846ea70bf7233af909" as const;

// L1Inbox.MessageSent(uint256 indexed checkpointNumber, uint256 index,
// bytes32 indexed hash, bytes16 rollingHash). The `hash` topic IS the
// L1→L2 message hash that getMessageReady() polls (i.e., the leaf value of
// the inbox tree). Verified via:
//   keccak256("MessageSent(uint256,uint256,bytes32,bytes16)")
// Layout: topics = [topic0, checkpointNumber, hash] ; indexed hash is topics[2].
export const INBOX_MESSAGE_SENT_TOPIC =
  "0xe3afb584bcff3adb9d452d2e1ccbcd4aee164ae2a8cdab637aecf866a53fbb77" as const;

// Minimal ABI fragment to let viem.decodeEventLog parse MessageSent without
// pulling in the full IInbox ABI. The contract isn't TokenBridge — it's the
// L1Inbox emitting from within TokenBridge.depositToL2{Public,Private}() — so
// we keep it scoped here.
const INBOX_MESSAGE_SENT_ABI = [
  {
    type: "event",
    name: "MessageSent",
    inputs: [
      { name: "checkpointNumber", type: "uint256", indexed: true },
      { name: "index", type: "uint256", indexed: false },
      { name: "hash", type: "bytes32", indexed: true },
      { name: "rollingHash", type: "bytes16", indexed: false },
    ],
  },
] as const;

// Verified against contracts-l1/out/TokenBridge.sol/TokenBridge.json.
// Note: two separate functions (withdraw / withdrawPrivate) rather than one
// function with an isPrivate bool — and args are (amount, recipient, l2Epoch,
// numCheckpointsInEpoch, leafIndex, siblingPath), NOT (recipient, amount,
// withdrawIsPrivate, ...). v5: the outbox stores progressive per-checkpoint
// roots, so the bridge forwards numCheckpointsInEpoch to outbox.consume.
const BRIDGE_WITHDRAW_ABI = [
  {
    type: "function",
    name: "withdraw",
    stateMutability: "nonpayable",
    inputs: [
      { name: "amount", type: "uint256" },
      { name: "recipient", type: "address" },
      { name: "l2Epoch", type: "uint256" },
      { name: "numCheckpointsInEpoch", type: "uint256" },
      { name: "leafIndex", type: "uint256" },
      { name: "siblingPath", type: "bytes32[]" },
      { name: "l2Sender", type: "bytes32" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "withdrawPrivate",
    stateMutability: "nonpayable",
    inputs: [
      { name: "amount", type: "uint256" },
      { name: "recipient", type: "address" },
      { name: "l2Epoch", type: "uint256" },
      { name: "numCheckpointsInEpoch", type: "uint256" },
      { name: "leafIndex", type: "uint256" },
      { name: "siblingPath", type: "bytes32[]" },
      { name: "l2Sender", type: "bytes32" },
    ],
    outputs: [],
  },
] as const;

// ─── Validators / helpers ────────────────────────────────────────────────────

export function validateBridgeExitInput(input: BridgeExitInput): void {
  if (input.amount <= 0n) {
    throw new BridgeError("UNKNOWN", "amount must be > 0");
  }
  if (!input.l1Recipient) {
    throw new BridgeError("UNKNOWN", "l1Recipient required");
  }
}

function requireContracts(client: QuetzalClient): QuetzalContracts {
  const c = client.config.contracts;
  if (!c) {
    throw new ConfigError(
      "MISSING_ENV",
      "QuetzalClient.config.contracts not set; pass `contracts` to QuetzalClient.connect()",
    );
  }
  return c;
}

function resolveTokenAddress(contracts: QuetzalContracts, alias: string): string {
  // Accept legacy (tUSDC/tETH/tBTC), bridged (aUSDC/aWETH/aWBTC), and bare UI
  // ids (USDC/WETH/wBTC/ETH/BTC) as aliases for the same underlying contracts.
  // Since 2026-06 the DEX tokens are HYBRID (mintable AND bridge-claimable) and the
  // L1 bridges are repointed at them (setL2TokenAddress), so the aUSDC/aWETH/aWBTC
  // bridge aliases correctly resolve to the same tradeable token a deposit claims into.
  const map: Record<string, string | undefined> = {
    USDC: contracts.tUSDC,
    tUSDC: contracts.tUSDC,
    aUSDC: contracts.tUSDC,
    WETH: contracts.tETH,
    ETH: contracts.tETH,
    tETH: contracts.tETH,
    aWETH: contracts.tETH,
    wBTC: contracts.tBTC,
    BTC: contracts.tBTC,
    tBTC: contracts.tBTC,
    aWBTC: contracts.tBTC,
  };
  const addr = map[alias];
  if (!addr) {
    throw new BridgeError(
      "UNKNOWN",
      `unknown token alias '${alias}'. Known: USDC/tUSDC/aUSDC, WETH/ETH/tETH/aWETH, wBTC/BTC/tBTC/aWBTC.`,
    );
  }
  return addr;
}

function validateL1Address(addr: string): void {
  if (!addr.startsWith("0x") || addr.length !== 42) {
    throw new BridgeError(
      "UNKNOWN",
      `l1Recipient must be a 0x-prefixed 20-byte L1 address, got: ${addr}`,
    );
  }
}

function toFr(v: Fr | string): Fr {
  if (typeof v !== "string") return v;
  if (v.startsWith("0x")) return Fr.fromString(v);
  return new Fr(BigInt(v));
}

function resolveL1Bridge(
  l1: NonNullable<NetworkConfig["l1"]>,
  token: string,
): `0x${string}` {
  // Accept legacy (tUSDC/tETH/tBTC), bridged (aUSDC/aWETH/aWBTC), and bare UI
  // ids (USDC/WETH/wBTC/ETH/BTC) as aliases for the same L1 bridge contracts.
  const map: Record<string, string | undefined> = {
    USDC: l1.usdcBridge,
    tUSDC: l1.usdcBridge,
    aUSDC: l1.usdcBridge,
    WETH: l1.wethBridge,
    ETH: l1.wethBridge,
    tETH: l1.wethBridge,
    aWETH: l1.wethBridge,
    wBTC: l1.wbtcBridge,
    BTC: l1.wbtcBridge,
    tBTC: l1.wbtcBridge,
    aWBTC: l1.wbtcBridge,
  };
  const addr = map[token];
  if (!addr) {
    throw new BridgeError(
      "UNKNOWN",
      `unknown token alias '${token}' for L1 bridge. Known: USDC/tUSDC/aUSDC, WETH/ETH/tETH/aWETH, wBTC/BTC/tBTC/aWBTC.`,
    );
  }
  return addr as `0x${string}`;
}

// L22: resolve the current L2 token contract address for a given token alias.
/**
 * The (l2Sender, l1Bridge) pair an outbox membership proof needs: the Outbox
 * commits a SCOPED leaf that binds both, so buildOutboxProof cannot derive the
 * leaf from the content alone. Resolved from the same config the exit used, so
 * a caller can never prove against a bridge the exit did not target.
 */
export function resolveOutboxScope(
  config: NetworkConfig,
  token: string,
): { l2Sender: `0x${string}`; l1Bridge: `0x${string}` } {
  if (!config.l1) {
    throw new BridgeError("UNKNOWN", "config.l1 is required to resolve the outbox scope");
  }
  return {
    l2Sender: resolveL2Token(config.contracts, token),
    l1Bridge: resolveL1Bridge(config.l1, token),
  };
}

// Mirrors resolveL1Bridge but looks up config.contracts (Aztec addresses).
function resolveL2Token(
  contracts: QuetzalContracts | undefined,
  token: string,
): `0x${string}` {
  if (!contracts) {
    throw new BridgeError(
      "UNKNOWN",
      "config.contracts is required to resolve the default l2Sender; pass input.l2Sender explicitly or set contracts in your QuetzalClient config.",
    );
  }
  const map: Record<string, string | undefined> = {
    USDC: contracts.tUSDC,
    tUSDC: contracts.tUSDC,
    aUSDC: contracts.tUSDC,
    WETH: contracts.tETH,
    ETH: contracts.tETH,
    tETH: contracts.tETH,
    aWETH: contracts.tETH,
    wBTC: contracts.tBTC,
    BTC: contracts.tBTC,
    tBTC: contracts.tBTC,
    aWBTC: contracts.tBTC,
  };
  const addr = map[token];
  if (!addr) {
    throw new BridgeError(
      "UNKNOWN",
      `cannot resolve L2 token address for '${token}'; pass input.l2Sender explicitly.`,
    );
  }
  // L22: the withdraw ABI encodes l2Sender as bytes32 (an Aztec address is a 32-byte
  // field). Validate the width here so a malformed config value fails with a clear
  // message instead of a cryptic viem BytesSizeMismatch at encode time.
  if (!/^0x[0-9a-fA-F]{64}$/.test(addr)) {
    throw new BridgeError(
      "UNKNOWN",
      `resolved L2 token address for '${token}' is not a 0x-prefixed 32-byte value: ${addr}`,
    );
  }
  return addr as `0x${string}`;
}

// ─── Module-level helpers (exported for test mockability) ────────────────────

export const _internals = {
  async getNode(nodeUrl: string) {
    const { createAztecNodeClient } = await import("@aztec/aztec.js/node");
    return createAztecNodeClient(nodeUrl);
  },
  async getViem() {
    const viem = await import("viem");
    const chains = await import("viem/chains");
    return {
      createPublicClient: viem.createPublicClient,
      http: viem.http,
      decodeEventLog: viem.decodeEventLog,
      encodeFunctionData: viem.encodeFunctionData,
      sepolia: chains.sepolia,
    };
  },
};

// ─── Public API ───────────────────────────────────────────────────────────────

export class BridgeApi {
  constructor(private client: QuetzalClient) {}

  /**
   * L1->L2 deposit. Browser-friendly viem-backed implementation:
   *   1. Validate token alias → L1 bridge address (via config.l1.{usdc,weth,wbtc}Bridge).
   *   2. Read the underlying L1 ERC20 from `TokenBridge.l1Token()`.
   *   3. Generate a fresh claim secret (Fr.random) + poseidon2 hash; the
   *      secret never leaves the browser. The caller uses it later for
   *      client.bridge.claim().
   *   4. ERC20.approve(bridge, amount).
   *   5. TokenBridge.depositToL2{Public,Private}(amount, l2Recipient, secretHash).
   *   6. Parse the DepositInitiated event log → messageIndex.
   *
   * NOTE on private deposits: the current implementation re-uses the same
   * secretHash for both `secretHashForRedeemingMintedNotes` and
   * `secretHashForL2MessageConsumption` (depositToL2Private only takes one
   * secretHash today). Production hardening (separate secrets) is deferred
   * to Sub-7d.
   */
  async deposit(
    input: BridgeDepositInput,
    l1Wallet: WalletClient,
  ): Promise<BridgeDepositResult> {
    const l1 = this.client.config.l1;
    if (!l1) {
      throw new BridgeError(
        "UNKNOWN",
        "config.l1 (usdcBridge/wethBridge/wbtcBridge) is required for deposit",
      );
    }
    const l1Bridge = resolveL1Bridge(l1, input.token);

    const account = l1Wallet.account;
    if (!account) {
      throw new BridgeError(
        "UNKNOWN",
        "l1Wallet must be a connected viem WalletClient with an account",
      );
    }

    const { createPublicClient, http, decodeEventLog, sepolia } = await _internals.getViem();
    const publicClient = createPublicClient({
      // TODO(Sub-7d): derive chain from l1Wallet.chain instead of hardcoding sepolia
      chain: sepolia,
      transport: http(l1.rpcUrl ?? "https://sepolia.drpc.org"),
    });

    // Read L1 ERC20 from the bridge (TokenBridge.l1Token()).
    const l1TokenAddr = (await publicClient.readContract({
      address: l1Bridge,
      abi: BRIDGE_DEPOSIT_ABI,
      functionName: "l1Token",
    })) as `0x${string}`;

    // Generate the L1→L2 claim secret in the browser (never leaves it).
    const secretFr = Fr.random();
    const secretHashFr = await computeSecretHash(secretFr);
    const secretHashHex = secretHashFr.toString() as `0x${string}`;

    // Recipient on L2: padded to 32 bytes (Aztec address format).
    const l2RecipientBytes32 = this.client.address.toString() as `0x${string}`;

    // 1. approve the bridge to spend the user's ERC20.
    // TODO(Sub-7d): derive chain from l1Wallet.chain instead of hardcoding sepolia
    const approveHash = await l1Wallet.writeContract({
      address: l1TokenAddr,
      abi: ERC20_APPROVE_ABI,
      functionName: "approve",
      args: [l1Bridge, input.amount],
      account,
      chain: sepolia,
    });
    await publicClient.waitForTransactionReceipt({ hash: approveHash });

    // 2. bridge deposit (Public takes l2Recipient + secretHash; Private takes only secretHash).
    let depositHash: `0x${string}`;
    if (input.isPrivate) {
      // TODO(Sub-7d): derive chain from l1Wallet.chain instead of hardcoding sepolia
      depositHash = await l1Wallet.writeContract({
        address: l1Bridge,
        abi: BRIDGE_DEPOSIT_ABI,
        functionName: "depositToL2Private",
        args: [input.amount, secretHashHex],
        account,
        chain: sepolia,
      });
    } else {
      // TODO(Sub-7d): derive chain from l1Wallet.chain instead of hardcoding sepolia
      depositHash = await l1Wallet.writeContract({
        address: l1Bridge,
        abi: BRIDGE_DEPOSIT_ABI,
        functionName: "depositToL2Public",
        args: [input.amount, l2RecipientBytes32, secretHashHex],
        account,
        chain: sepolia,
      });
    }
    const receipt = await publicClient.waitForTransactionReceipt({ hash: depositHash });

    // Parse the DepositInitiated event log for messageIndex.
    const depositLog = receipt.logs.find(
      (log: { topics?: readonly string[]; data?: string }) =>
        log.topics?.[0]?.toLowerCase() === DEPOSIT_INITIATED_TOPIC,
    );
    if (!depositLog) {
      throw new BridgeError(
        "UNKNOWN",
        "deposit succeeded but DepositInitiated event not found in receipt logs",
      );
    }
    // Decode via viem (typed, robust against event-schema drift) rather than
    // manual byte-slice arithmetic.
    const decoded = decodeEventLog({
      abi: BRIDGE_DEPOSIT_ABI,
      eventName: "DepositInitiated",
      topics: (depositLog as { topics: [`0x${string}`, ...`0x${string}`[]] }).topics,
      data: (depositLog as { data: `0x${string}` }).data,
    });
    const messageIndex = (decoded.args as { messageIndex: bigint }).messageIndex;

    // Sub-7c Task 12: parse the L1Inbox.MessageSent event from the same receipt
    // to surface the L1→L2 message hash (the leaf value of the inbox tree).
    // ClaimTab polls this via getMessageReady() until the sequencer finalises
    // the message. Solidity write-function return values do NOT survive a
    // JSON-RPC call, so this MUST come from event logs.
    let messageHash: `0x${string}` | undefined;
    const messageSentLog = receipt.logs.find(
      (log: { topics?: readonly string[]; data?: string }) =>
        log.topics?.[0]?.toLowerCase() === INBOX_MESSAGE_SENT_TOPIC,
    );
    if (messageSentLog) {
      try {
        const decodedSent = decodeEventLog({
          abi: INBOX_MESSAGE_SENT_ABI,
          eventName: "MessageSent",
          topics: (messageSentLog as { topics: [`0x${string}`, ...`0x${string}`[]] }).topics,
          data: (messageSentLog as { data: `0x${string}` }).data,
        });
        messageHash = (decodedSent.args as { hash: `0x${string}` }).hash;
      } catch {
        // Defensive: if the Inbox schema drifts, fall through with undefined.
        // UI treats undefined as "polling disabled" (acceptable degradation;
        // user can still claim manually after the ~4-15min L1→L2 window).
      }
    }

    return {
      l1TxHash: depositHash,
      messageIndex,
      secret: secretFr.toString(),
      secretHash: secretHashHex,
      messageHash,
    };
  }

  /**
   * Returns `true` when the given L1→L2 deposit message hash has membership in
   * the Aztec inbox tree — i.e. the sequencer has finalised it and a claim can
   * now succeed.  Browser UI polls this every 30 s to flip a pending claim from
   * 'Waiting' to 'Ready to claim'.
   *
   * @param messageHash  0x-prefixed 32-byte hex string (64 hex chars + "0x" = 66 chars total)
   * @throws {BridgeError} if messageHash is malformed
   */
  async getMessageReady(messageHash: `0x${string}`): Promise<boolean> {
    if (!/^0x[0-9a-fA-F]{64}$/.test(messageHash)) {
      throw new BridgeError(
        "UNKNOWN",
        `messageHash must be 0x + 32 bytes (66 chars) of valid hex, got: ${messageHash}`,
      );
    }
    const node = await _internals.getNode(this.client.config.nodeUrl);
    const witness = await node.getL1ToL2MessageMembershipWitness("latest", Fr.fromHexString(messageHash));
    return witness !== undefined;
  }

  async claim(input: BridgeClaimInput): Promise<{ l2TxHash: string }> {
    const contracts = requireContracts(this.client);
    const tokenAddress = resolveTokenAddress(contracts, input.token);
    if (input.secret === undefined) {
      throw new BridgeError(
        "UNKNOWN",
        "claim requires the deposit's secret preimage (both claim_public and claim_private bind compute_secret_hash(secret) into the consumed message)",
      );
    }
    const secret = toFr(input.secret);
    const messageIndex = toFr(input.messageIndex);

    const { loadTokenContract } = await import("./internal/contracts.js");
    const TokenContract = await loadTokenContract();
    const token = await TokenContract.at(AztecAddress.fromStringUnsafe(tokenAddress), this.client.wallet);
    const tokenDyn = token as unknown as {
      methods: {
        claim_public: (
          to: AztecAddress,
          amount: bigint,
          secret: Fr,
          messageLeafIndex: Fr,
        ) => { send: (args: { from: AztecAddress }) => Promise<TxSendResult> };
        claim_private: (
          to: AztecAddress,
          amount: bigint,
          secret: Fr,
          messageLeafIndex: Fr,
        ) => { send: (args: { from: AztecAddress }) => Promise<TxSendResult> };
      };
    };
    const fn = input.isPrivate ? "claim_private" : "claim_public";
    // aztec.js 4.x: `.send({ from })` is async and ALREADY waits for mining,
    // resolving to { receipt, ...offchainOutput }. The previous `.send().wait?.()`
    // form silently no-op'd (a Promise has no `.wait`): claim() returned INSTANTLY
    // with an empty hash while the real claim tx was fire-and-forgotten and any
    // revert was swallowed — the cause of "Claim says claimed instantly but no
    // funds arrive". Await the send, read `.receipt`, and throw on a missing or
    // reverted receipt so the UI surfaces real failures (orders.ts:305-315 pattern).
    const sendResult = await tokenDyn.methods[fn](
      this.client.address,
      input.amount,
      secret,
      messageIndex,
    ).send({ from: this.client.address });
    const receipt = sendResult.receipt;
    if (!receipt || receipt.hasExecutionReverted?.() === true) {
      throw new BridgeError(
        "UNKNOWN",
        `claim ${fn} did not mine successfully: status=${receipt?.status ?? "none"}` +
          (receipt?.error ? ` error=${receipt.error}` : ""),
      );
    }
    return { l2TxHash: receipt.txHash?.toString() ?? "" };
  }

  async exit(
    input: BridgeExitInput,
  ): Promise<{ l2TxHash: string } | { scheduledExits: ScheduledExit[] }> {
    validateBridgeExitInput(input);
    validateL1Address(input.l1Recipient);
    const contracts = requireContracts(this.client);
    const tokenAddress = resolveTokenAddress(contracts, input.token);
    const usePrivate = input.isPrivate !== false;

    // D2: amount-pattern fingerprint advisory (re-thrown so CLI can surface it)
    const decimals = resolveTokenDecimals(input.token);
    const heuristic = classifyAmount(input.amount, decimals);
    if (heuristic.classification !== "natural" && input.ackRound !== true) {
      const advisory = formatAdvisory(heuristic, decimals, input.token.toUpperCase());
      throw new BridgeError(
        "UNKNOWN",
        `${advisory} Pass ackRound=true to acknowledge + proceed.`,
      );
    }

    // C2: round-trip pre-check via L1 logs (best-effort; skipped if l1 config missing)
    const l1 = this.client.config.l1;
    const bridgeAddrs = [l1?.usdcBridge, l1?.wethBridge, l1?.wbtcBridge]
      .filter((x): x is string => !!x)
      .map((s) => s as `0x${string}`);
    const l1MakerAddr = (l1?.makerAddr ?? process.env.L1_MAKER_ADDR ?? "") as `0x${string}`;
    if (l1?.rpcUrl && bridgeAddrs.length > 0 && l1MakerAddr) {
      let records: Awaited<ReturnType<typeof queryRecentDeposits>>;
      try {
        records = await queryRecentDeposits(l1.rpcUrl, bridgeAddrs, l1MakerAddr, 7);
      } catch {
        records = [];
      }
      const { risk, matched } = isRoundTripRisk(input.amount, records, 5);
      if (risk && matched && input.ackDelay !== true) {
        throw new BridgeError(
          "UNKNOWN",
          `Round-trip detection risk: matching deposit ${matched.amount} ${input.token} ${Math.floor((Date.now() / 1000 - matched.timestamp) / 86400)}d ago. Pass ackDelay=true to acknowledge.`,
        );
      }
    }

    // C3: split path
    const splitInto = input.splitInto ?? 1;
    const intervalDays = input.intervalDays ?? 3;
    if (splitInto > 1) {
      const newExits = buildSplitSchedule(
        input.token,
        input.amount,
        input.l1Recipient,
        splitInto,
        intervalDays,
        usePrivate, // H5: preserve the requested privacy mode into each scheduled leg
      );
      const state = loadBridgeState();
      state.scheduledExits.push(...newExits);
      saveBridgeState(state);
      return { scheduledExits: newExits };
    }

    // Single-exit submit path
    const { loadTokenContract } = await import("./internal/contracts.js");
    const TokenContract = await loadTokenContract();
    const token = await TokenContract.at(AztecAddress.fromStringUnsafe(tokenAddress), this.client.wallet);
    const tokenDyn = token as unknown as {
      methods: {
        exit_to_l1_public: (
          amount: bigint,
          l1Recipient: Fr,
        ) => { send: (args: { from: AztecAddress }) => Promise<TxSendResult> };
        exit_to_l1_private: (
          amount: bigint,
          l1Recipient: Fr,
        ) => { send: (args: { from: AztecAddress }) => Promise<TxSendResult> };
      };
    };
    const l1RecipientFr = new Fr(BigInt(input.l1Recipient));
    const fn = usePrivate ? "exit_to_l1_private" : "exit_to_l1_public";
    // aztec.js 4.x: await `.send({ from })` (already waits for mining) and read
    // `.receipt`. The previous `.send().wait()` form threw at runtime — the
    // resolved result has no `.wait` — so exits/withdraws were broken outright.
    const sendResult = await tokenDyn.methods[fn](input.amount, l1RecipientFr).send({
      from: this.client.address,
    });
    const receipt = sendResult.receipt;
    if (!receipt || receipt.hasExecutionReverted?.() === true) {
      throw new BridgeError(
        "UNKNOWN",
        `exit ${fn} did not mine successfully: status=${receipt?.status ?? "none"}` +
          (receipt?.error ? ` error=${receipt.error}` : ""),
      );
    }
    const l2TxHash = receipt.txHash?.toString() ?? "";

    // Optional relayer-fee queue on Treasury (Sub-5c D3).
    const relayerFee = input.relayerFee ?? 0n;
    if (relayerFee > 0n) {
      if (!contracts.treasury) {
        throw new BridgeError(
          "UNKNOWN",
          "relayerFee > 0 but config.contracts.treasury is not set",
        );
      }
      const expectedContent = computeWithdrawContent(input.l1Recipient, input.amount, usePrivate);
      const { loadTreasuryContract } = await import("./internal/contracts.js");
      const TreasuryContract = await loadTreasuryContract();
      const treasury = await TreasuryContract.at(
        AztecAddress.fromStringUnsafe(contracts.treasury),
        this.client.wallet,
      );
      const treasuryDyn = treasury as unknown as {
        methods: {
          queue_relayer_claim: (
            l2TxHash: Fr,
            expectedContent: Fr,
            l1Recipient: Fr,
            amount: bigint,
            fee: bigint,
          ) => { send: (args: { from: AztecAddress }) => Promise<unknown> };
        };
      };
      await treasuryDyn.methods
        .queue_relayer_claim(
          Fr.fromString(l2TxHash),
          Fr.fromString(expectedContent),
          l1RecipientFr,
          input.amount,
          relayerFee,
        )
        .send({ from: this.client.address });
    }

    return { l2TxHash };
  }

  async tick(input: BridgeTickInput = {}): Promise<{ processedCount: number }> {
    const contracts = requireContracts(this.client);
    const state = loadBridgeState();
    const now = Math.floor(Date.now() / 1000);
    let processed = 0;
    let changed = false;

    for (const exit of state.scheduledExits) {
      if (exit.status === "pending" && exit.submitAfterUnix <= now) {
        try {
          const tokenL2Addr = resolveTokenAddress(contracts, exit.token);
          const { loadTokenContract } = await import("./internal/contracts.js");
          const TokenContract = await loadTokenContract();
          const token = await TokenContract.at(
            AztecAddress.fromStringUnsafe(tokenL2Addr),
            this.client.wallet,
          );
          const tokenDyn = token as unknown as {
            methods: {
              exit_to_l1_public: (
                amount: bigint,
                l1Recipient: Fr,
              ) => { send: (args: { from: AztecAddress }) => Promise<TxSendResult> };
              exit_to_l1_private: (
                amount: bigint,
                l1Recipient: Fr,
              ) => { send: (args: { from: AztecAddress }) => Promise<TxSendResult> };
            };
          };
          const l1RecipientFr = new Fr(BigInt(exit.l1Recipient));
          const amountBig = BigInt(exit.amount);
          // H5: honor the leg's requested privacy mode. Legacy records without the
          // flag read as false (public), preserving old behavior for in-flight state.
          const legPrivate = exit.isPrivate === true;
          // aztec.js 4.x: await `.send({ from })` and read `.receipt` (no `.wait()`).
          // A throw here is caught below, leaving status "pending" for a later retry.
          const sendResult = await (legPrivate
            ? tokenDyn.methods.exit_to_l1_private(amountBig, l1RecipientFr)
            : tokenDyn.methods.exit_to_l1_public(amountBig, l1RecipientFr)
          ).send({ from: this.client.address });
          const receipt = sendResult.receipt;
          if (!receipt || receipt.hasExecutionReverted?.() === true) {
            throw new BridgeError(
              "UNKNOWN",
              `scheduled exit did not mine: status=${receipt?.status ?? "none"}`,
            );
          }
          exit.status = "submitted";
          exit.l2TxHash = receipt.txHash?.toString() ?? "";
          exit.l2EpochAtSubmit = receipt.blockNumber ?? null;
          processed++;
          changed = true;
        } catch {
          /* leave status pending so a later tick retries */
        }
      } else if (exit.status === "submitted" && input.autoClaim === true) {
        // L1 auto-claim path (Sub-5c C4) is wired in the CLI today; the SDK
        // tick body delegates the L1 step to the CLI for now (operator path).
        // Surface a no-op so the SDK call stays side-effect-free for L1 here.
      }
    }
    if (changed) saveBridgeState(state);
    return { processedCount: processed };
  }

  /**
   * Composes the L1 bridge `withdraw` / `withdrawPrivate` calldata without
   * requiring the caller to depend on viem ABI types.
   *
   * The wizard passes the returned `{ to, data }` directly to MetaMask's
   * `eth_sendTransaction`. Inputs (siblingPath, l2Epoch, numCheckpointsInEpoch,
   * leafIndex) come from `buildOutboxProof` (util/outbox-proof.ts, Task 1).
   *
   * ABI note: the real TokenBridge.sol has TWO separate functions — `withdraw`
   * for public exits and `withdrawPrivate` for private exits — with args
   * `(amount, recipient, l2Epoch, numCheckpointsInEpoch, leafIndex, siblingPath,
   * l2Sender)`. There is no single function taking an isPrivate bool.
   */
  async prepareL1Withdraw(input: PrepareL1WithdrawInput): Promise<PrepareL1WithdrawResult> {
    const l1 = this.client.config.l1;
    if (!l1) {
      throw new BridgeError("UNKNOWN", "config.l1 is required for prepareL1Withdraw");
    }
    const bridgeAddr = resolveL1Bridge(l1, input.token);
    const { encodeFunctionData } = await _internals.getViem();
    const functionName = input.isPrivate ? "withdrawPrivate" : "withdraw";
    // L22: l2Sender identifies which L2 token contract emitted the exit note.
    // Defaults to the current configured L2 token address (config.contracts.tUSDC /
    // tETH / tBTC). Pass the OLD address explicitly for exits made before a migration.
    const l2Sender =
      input.l2Sender ?? resolveL2Token(this.client.config.contracts, input.token);
    const data = encodeFunctionData({
      abi: BRIDGE_WITHDRAW_ABI,
      functionName,
      args: [
        input.amount,
        input.l1Recipient,
        input.l2Epoch,
        input.numCheckpointsInEpoch,
        input.leafIndex,
        input.siblingPath,
        l2Sender,
      ] as const,
    });
    return { to: bridgeAddr, data };
  }
}
