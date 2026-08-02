// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.27;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {AccessControlUpgradeable} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import {PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import {ReentrancyGuardUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";

import {IInbox} from "./interfaces/IInbox.sol";
import {IOutbox} from "./interfaces/IOutbox.sol";
import {DataStructures} from "./lib/DataStructures.sol";
import {Epoch} from "./lib/TimeMath.sol";

/// @title  TokenBridge — Aztec L1↔L2 portal for canonical ERC20s.
/// @notice One instance per (L1 ERC20, L2 Token) pair. Governance is split
///         across two roles: GOVERNANCE_ROLE (7-day governance TimelockController
///         in production) and EMERGENCY_PAUSER_ROLE (0-day emergency
///         TimelockController fronted by a 2-of-3 emergency multisig).
contract TokenBridge is
    Initializable,
    UUPSUpgradeable,
    AccessControlUpgradeable,
    PausableUpgradeable,
    ReentrancyGuardUpgradeable
{
    using SafeERC20 for IERC20;

    IERC20 public l1Token;
    bytes32 public l2TokenAddress;

    /// @dev Set once at `initialize`; intentionally has no governance setter.
    ///      If Aztec changes the rollup version deploy a new TokenBridge instance
    ///      rather than mutating this value.
    uint256 public l2Version;

    /// @dev Set once at `initialize`; intentionally has no governance setter.
    ///      If Aztec relocates the Inbox, deploy a new TokenBridge instance
    ///      rather than mutating this value.
    IInbox public inbox;

    /// @dev Set once at `initialize`; intentionally has no governance setter.
    ///      If Aztec relocates the Outbox, deploy a new TokenBridge instance
    ///      rather than mutating this value.
    IOutbox public outbox;

    /// @dev Maximum total ERC20 tokens (by `l1Token.balanceOf(address(this))`) that
    ///      may be held by this bridge at any one time. A value of 0 means UNLIMITED
    ///      (no cap enforcement). To block all deposits use `pause()` instead; do NOT
    ///      use `setMaxTvl(0)` expecting it to block deposits — it will not.
    ///
    ///      IMPORTANT: `_enforceTvlCap` reads `l1Token.balanceOf(address(this))` and
    ///      projects the post-deposit total assuming the token transfers `amount`
    ///      exactly. Not safe with fee-on-transfer / deflationary tokens. Quetzal
    ///      launches with USDC + WETH which are standard ERC20s. Adding any
    ///      non-standard token requires reviewing this assumption.
    uint256 public maxTvl;

    /// @notice Tracks a deposit for potential 90-day-windowed recovery.
    /// @dev `amount` is a full `uint256` so the recovery record can never truncate the
    ///      deposited amount (Finding #10). The struct is only ever stored as a mapping
    ///      value, so widening this field does not shift any base-slot contract state.
    struct Deposit {
        uint256 amount;
        uint64  timestamp;
        bool    isPrivate;
    }

    /// @notice Per-deposit record keyed by keccak256(sender, secretHash). Lookup
    ///         enables the 3-phase recoverDeposit flow: a maker who lost their L2
    ///         wallet can request → governance approves → maker executes the
    ///         on-L1 refund. Only the original depositor (msg.sender match) can
    ///         recover, so secret-knowledge alone is insufficient.
    mapping(bytes32 => Deposit) public deposits;

    /// @notice Maker-flagged deposits awaiting governance review.
    mapping(bytes32 => bool) public pendingRecoveries;

    /// @notice Governance-approved deposits awaiting maker execution.
    mapping(bytes32 => bool) public approvedRecoveries;

    /// @notice H14: when each recovery was approved. executeRecovery only honors an
    ///         approval for APPROVAL_TTL after it was granted. Governance verifies the
    ///         L2 message is unconsumed AT approval time, but Aztec inbox messages stay
    ///         claimable indefinitely, so without an expiry a depositor could approve,
    ///         THEN claim on L2, then execute the L1 refund — double-spend. The TTL
    ///         bounds that race and forces re-verification before each approval.
    mapping(bytes32 => uint256) public approvalTimestamps;

    /// @dev L22: L2 sender addresses whose emitted L2->L1 exits this bridge will consume.
    ///      Always includes the current l2TokenAddress; setL2TokenAddress adds the OLD
    ///      address so in-flight exits survive a token migration. Deposits always use the
    ///      current l2TokenAddress only.
    mapping(bytes32 => bool) public allowedL2Senders;

    /// @notice The governance TimelockController, bound at initialize. Storage
    ///         (not just an AccessControl role) because `_authorizeUpgrade` gates
    ///         on `msg.sender == governanceTimelock` DIRECTLY — see below. Appended
    ///         after allowedL2Senders to keep the storage layout append-only.
    /// @dev    INV-005 fix: role-based upgrade authority is delegable. The DEFAULT_ADMIN
    ///         (the timelock itself) could `grantRole(GOVERNANCE_ROLE, someEOA)` and that
    ///         EOA would then call `upgradeToAndCall` with NO timelock delay — the one-time
    ///         grant is delayed, but every subsequent upgrade is instant. Binding upgrades
    ///         to the timelock ADDRESS makes the authority non-delegable: only the timelock
    ///         contract (behind its delay + multisig) can ever authorize an implementation
    ///         swap, regardless of who holds GOVERNANCE_ROLE.
    address public governanceTimelock;

    /// @notice How long a recovery approval stays executable (H14). Kept short so
    ///         governance's off-chain "L2 message still unconsumed" check is fresh.
    uint256 public constant APPROVAL_TTL = 48 hours;

    /// @notice Role allowed to invoke governance functions (setMaxTvl,
    ///         setL2TokenAddress, withdrawTreasuryDust, _authorizeUpgrade).
    ///         In production this is the 7-day governance TimelockController.
    bytes32 public constant GOVERNANCE_ROLE       = keccak256("GOVERNANCE_ROLE");

    /// @notice Role allowed to invoke pause/unpause. In production this is the
    ///         delay-0 emergency TimelockController fronted by a separate
    ///         emergency multisig (2-of-3) so security incidents bypass the
    ///         7-day governance window.
    ///         The role is its OWN admin (set in initialize via _setRoleAdmin):
    ///         governance cannot revoke it. Only existing emergency-role holders
    ///         may rotate emergency-role membership.
    bytes32 public constant EMERGENCY_PAUSER_ROLE = keccak256("EMERGENCY_PAUSER_ROLE");

    event DepositInitiated(
        address indexed sender,
        bytes32 indexed l2Recipient,
        uint256 amount,
        bytes32 secretHash,
        uint256 messageIndex,
        bool isPrivate
    );
    event WithdrawCompleted(
        address indexed recipient,
        uint256 amount,
        uint256 l2Epoch,
        uint256 leafIndex
    );
    event MaxTvlUpdated(uint256 oldCap, uint256 newCap);
    event L2TokenAddressUpdated(bytes32 oldAddr, bytes32 newAddr);
    /// @notice v5 reset-recovery: the bridge was re-pointed at a new Aztec rollup
    ///         deployment (testnet resets redeploy inbox/outbox with a new version).
    event AztecTargetUpdated(
        uint256 oldL2Version, uint256 newL2Version, address oldInbox, address newInbox, address oldOutbox, address newOutbox
    );
    event DepositTracked(address indexed sender, bytes32 indexed secretHash, uint256 amount, bool isPrivate);
    event RecoveryRequested(address indexed sender, bytes32 indexed secretHash, uint256 amount);
    event RecoveryApproved(bytes32 indexed key);
    event RecoveryApprovalRevoked(bytes32 indexed key);
    event RecoveryExecuted(address indexed sender, bytes32 indexed secretHash, address indexed l1Recipient, uint256 amount);

    /// @notice Deposit would push the bridge's token balance above `maxTvl`.
    error TvlCapExceeded(uint256 attempted, uint256 cap);
    /// @notice Caller passed a zero token amount where a non-zero value is required.
    error ZeroAmount();
    /// @notice Caller passed a zero address/bytes32 where a non-zero value is required.
    error ZeroAddress();
    /// @notice The bridge's primary `l1Token` cannot be swept via `withdrawTreasuryDust`.
    error CannotSweepL1Token();
    /// @notice No deposit record found for (msg.sender, secretHash).
    error NoSuchDeposit();
    /// @notice 90-day waiting period has not elapsed since the deposit.
    error DepositTooRecent();
    /// @notice No pending recovery request found for the given key.
    error NoSuchRequest();
    /// @notice Recovery has not been approved by governance.
    error NotApproved();
    /// @notice H14: the recovery approval is older than APPROVAL_TTL and was cleared.
    error ApprovalExpired();
    /// @notice A deposit was attempted before governance set a non-zero `l2TokenAddress`.
    ///         Deposits made with a zero L2 actor are unrecoverable on L2; reject them.
    error L2TokenNotSet();
    /// @notice A deposit record already exists for (msg.sender, secretHash). Re-using the
    ///         same key would silently overwrite the earlier record and destroy its
    ///         recoverDeposit rights, so the second deposit is rejected (fail-safe).
    error DepositKeyInUse();
    /// @notice L21: the L2 claim_* functions take amount as u128. A deposit above
    ///         uint128 max commits a content hash no L2 call can reconstruct -- the
    ///         funds would be escrowed with only the 90-day recovery path available.
    ///         Fail fast before escrow to protect depositors.
    error AmountExceedsL2Max();
    /// @notice L22: the l2Sender passed to withdraw/withdrawPrivate is not the current
    ///         l2TokenAddress and has never been registered via setL2TokenAddress.
    error UnknownL2Sender();
    /// @notice SEC-002: the governance and emergency timelocks were the same address.
    error TimelocksMustDiffer();
    /// @notice INV-005: `upgradeToAndCall` caller was not the governance timelock
    ///         (a delegated GOVERNANCE_ROLE holder can no longer authorize upgrades).
    error NotGovernanceTimelock();

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @notice One-shot initializer. Two timelocks are required: a governance
    ///         timelock (typically 7-day delay) for setMaxTvl/setL2TokenAddress/
    ///         withdrawTreasuryDust/upgrades, and an emergency timelock (typically
    ///         0-day delay) for pause/unpause.
    /// @param _l1Token             The L1 ERC20 token this bridge accepts.
    /// @param _l2TokenAddress      Aztec L2 token contract address (as bytes32 Aztec AztecAddress).
    /// @param _l2Version           Aztec rollup version; used when addressing L2 actors.
    /// @param _inbox               Aztec Inbox contract for L1→L2 messages.
    /// @param _outbox              Aztec Outbox contract for L2→L1 messages.
    /// @param _governanceTimelock  Governance timelock (GOVERNANCE_ROLE + DEFAULT_ADMIN_ROLE).
    /// @param _emergencyTimelock   Emergency timelock (EMERGENCY_PAUSER_ROLE).
    /// @param _maxTvl              Initial TVL cap; 0 = unlimited. See `maxTvl` for full semantics.
    function initialize(
        IERC20 _l1Token,
        bytes32 _l2TokenAddress,
        uint256 _l2Version,
        IInbox _inbox,
        IOutbox _outbox,
        address _governanceTimelock,
        address _emergencyTimelock,
        uint256 _maxTvl
    ) external initializer {
        if (address(_l1Token) == address(0)) revert ZeroAddress();
        if (address(_inbox) == address(0)) revert ZeroAddress();
        if (address(_outbox) == address(0)) revert ZeroAddress();
        if (_governanceTimelock == address(0)) revert ZeroAddress();
        if (_emergencyTimelock == address(0)) revert ZeroAddress();
        // SEC-002 fix: the two timelocks must be DISTINCT. If they were the same
        // address it would hold GOVERNANCE_ROLE + DEFAULT_ADMIN_ROLE *and*
        // EMERGENCY_PAUSER_ROLE, collapsing the pause/upgrade separation the
        // threat model calls absolute ("emergency role cannot upgrade"). Enforce
        // it on-chain instead of relying on deployment discipline.
        if (_governanceTimelock == _emergencyTimelock) revert TimelocksMustDiffer();

        __AccessControl_init();
        __Pausable_init();
        __UUPSUpgradeable_init();
        __ReentrancyGuard_init();

        _grantRole(DEFAULT_ADMIN_ROLE,    _governanceTimelock);
        _grantRole(GOVERNANCE_ROLE,        _governanceTimelock);
        _grantRole(EMERGENCY_PAUSER_ROLE,  _emergencyTimelock);
        // I-2 trust-model hardening: EMERGENCY_PAUSER_ROLE is self-admin so the
        // governance timelock cannot silently revoke the emergency multisig's
        // pause authority. Only existing emergency-role holders can grant or
        // revoke the role on others.
        _setRoleAdmin(EMERGENCY_PAUSER_ROLE, EMERGENCY_PAUSER_ROLE);

        l1Token = _l1Token;
        l2TokenAddress = _l2TokenAddress;
        l2Version = _l2Version;
        inbox = _inbox;
        outbox = _outbox;
        maxTvl = _maxTvl;
        // INV-005 fix: remember the timelock ADDRESS so _authorizeUpgrade can bind
        // to it directly (non-delegable), not just to the delegable GOVERNANCE_ROLE.
        governanceTimelock = _governanceTimelock;
        if (_l2TokenAddress != bytes32(0)) allowedL2Senders[_l2TokenAddress] = true;
    }

    // ── Deposit flow (L1 → L2) ────────────────────────────────────────────────

    /// @notice Deposit `amount` tokens to a public L2 recipient. The L2 recipient's
    ///         address is visible on-chain. Funds are escrowed on L1 until the L2
    ///         contract mints the corresponding L2 tokens.
    /// @param amount      Token amount to deposit; must be > 0.
    /// @param l2Recipient Aztec L2 recipient address (as bytes32); must be non-zero.
    /// @param secretHash  Secret hash for the L1→L2 message; used by the L2 side to
    ///                    claim the message privately.
    /// @return messageHash  Hash of the L1→L2 message published to the Inbox.
    /// @return messageIndex Index of the message within the Inbox tree.
    function depositToL2Public(uint256 amount, bytes32 l2Recipient, bytes32 secretHash)
        external
        whenNotPaused
        nonReentrant
        returns (bytes32 messageHash, uint256 messageIndex)
    {
        if (amount == 0) revert ZeroAmount();
        if (l2Recipient == bytes32(0)) revert ZeroAddress();
        // Finding #9: reject deposits made before governance has set a real L2 token
        // actor. Sending to a zero L2 actor would escrow funds on L1 that can never be
        // claimed on L2. `setL2TokenAddress` must run before deposits are accepted.
        if (l2TokenAddress == bytes32(0)) revert L2TokenNotSet();
        _enforceTvlCap(amount);

        // L21: the L2 claim_* take amount as u128; a deposit above uint128 max commits a
        // content hash no L2 call can reconstruct -> escrowed with only the 90-day recovery
        // path. Fail fast before escrow.
        if (amount > type(uint128).max) revert AmountExceedsL2Max();

        // Finding #10: prevent a second deposit on the same (sender, secretHash) key from
        // silently overwriting an earlier record and destroying its recoverDeposit rights.
        bytes32 trackKey = keccak256(abi.encode(msg.sender, secretHash));
        if (deposits[trackKey].amount != 0) revert DepositKeyInUse();

        // CEI (deposit-reentrancy fix): write the deposit record BEFORE the external
        // calls (safeTransferFrom, inbox.sendL2Message). With the effect after the
        // interactions, a reentrant token callback could re-enter on the same
        // (sender, secretHash) key — the not-yet-written DepositKeyInUse guard sees
        // zero and passes, letting a second escrow overwrite the first depositor's
        // recovery record. nonReentrant also blocks re-entry; the two are
        // defense-in-depth. The full `amount` is stored without truncation (Finding #10).
        deposits[trackKey] = Deposit({
            amount: amount,
            timestamp: uint64(block.timestamp),
            isPrivate: false
        });
        emit DepositTracked(msg.sender, secretHash, amount, false);

        l1Token.safeTransferFrom(msg.sender, address(this), amount);

        bytes32 content = _depositContent(l2Recipient, amount, secretHash, DataStructures.DEPOSIT_PUBLIC_TAG);
        DataStructures.L2Actor memory recipient = DataStructures.L2Actor({
            actor: l2TokenAddress,
            version: l2Version
        });
        (messageHash, messageIndex) = inbox.sendL2Message(recipient, content, secretHash);

        emit DepositInitiated(msg.sender, l2Recipient, amount, secretHash, messageIndex, false);
    }

    /// @notice Deposit `amount` tokens to a hidden (private) L2 recipient. The recipient
    ///         is determined on L2 by whoever knows the preimage of `secretHash`. No
    ///         l2Recipient argument is passed; privacy is achieved via the secret.
    /// @param amount     Token amount to deposit; must be > 0.
    /// @param secretHash Secret hash for the L1→L2 message; the holder of the preimage
    ///                   claims the private L2 tokens.
    /// @return messageHash  Hash of the L1→L2 message published to the Inbox.
    /// @return messageIndex Index of the message within the Inbox tree.
    function depositToL2Private(uint256 amount, bytes32 secretHash)
        external
        whenNotPaused
        nonReentrant
        returns (bytes32 messageHash, uint256 messageIndex)
    {
        if (amount == 0) revert ZeroAmount();
        // Finding #9: reject deposits made before governance has set a real L2 token
        // actor. Sending to a zero L2 actor would escrow funds on L1 that can never be
        // claimed on L2. `setL2TokenAddress` must run before deposits are accepted.
        if (l2TokenAddress == bytes32(0)) revert L2TokenNotSet();
        _enforceTvlCap(amount);

        // L21: the L2 claim_* take amount as u128; a deposit above uint128 max commits a
        // content hash no L2 call can reconstruct -> escrowed with only the 90-day recovery
        // path. Fail fast before escrow.
        if (amount > type(uint128).max) revert AmountExceedsL2Max();

        // Finding #10: prevent a second deposit on the same (sender, secretHash) key from
        // silently overwriting an earlier record and destroying its recoverDeposit rights.
        bytes32 trackKey = keccak256(abi.encode(msg.sender, secretHash));
        if (deposits[trackKey].amount != 0) revert DepositKeyInUse();

        // CEI (deposit-reentrancy fix): effect before interactions — see the
        // depositToL2Public twin for the full rationale. Store the full `amount`
        // without truncation (Finding #10).
        deposits[trackKey] = Deposit({
            amount: amount,
            timestamp: uint64(block.timestamp),
            isPrivate: true
        });
        emit DepositTracked(msg.sender, secretHash, amount, true);

        l1Token.safeTransferFrom(msg.sender, address(this), amount);

        bytes32 content = _depositContent(bytes32(0), amount, secretHash, DataStructures.DEPOSIT_PRIVATE_TAG);
        DataStructures.L2Actor memory recipient = DataStructures.L2Actor({
            actor: l2TokenAddress,
            version: l2Version
        });
        (messageHash, messageIndex) = inbox.sendL2Message(recipient, content, secretHash);

        emit DepositInitiated(msg.sender, bytes32(0), amount, secretHash, messageIndex, true);
    }

    // ── Withdraw flow (L2 → L1) ───────────────────────────────────────────────

    /// @notice Consume a finalised L2→L1 exit message from the Outbox and transfer
    ///         `amount` tokens to `recipient`. The caller must supply a valid Merkle
    ///         proof (siblingPath + leafIndex) against the Outbox root for `l2Epoch`.
    /// @param amount       Token amount to withdraw; must be > 0.
    /// @param recipient    L1 address to receive the tokens; must be non-zero.
    /// @param l2Epoch      L2 epoch in which the exit message was included.
    /// @param numCheckpointsInEpoch  Checkpoint count the epoch root was built from
    ///                     (v5 outbox stores progressive per-checkpoint roots).
    /// @param leafIndex    Leaf position of the exit message in the Outbox Merkle tree.
    /// @param siblingPath  Merkle sibling hashes for proof verification.
    /// @param l2Sender     L2 token address that emitted the exit (current or a previously
    ///                     registered address -- see L22 allowedL2Senders).
    function withdraw(
        uint256 amount,
        address recipient,
        uint256 l2Epoch,
        uint256 numCheckpointsInEpoch,
        uint256 leafIndex,
        bytes32[] calldata siblingPath,
        bytes32 l2Sender
    ) external whenNotPaused {
        if (amount == 0) revert ZeroAmount();
        if (recipient == address(0)) revert ZeroAddress();
        // L22: accept exits emitted by the current token OR a previously-rotated token.
        if (l2Sender != l2TokenAddress && !allowedL2Senders[l2Sender]) revert UnknownL2Sender();

        bytes32 content = _withdrawContent(recipient, amount, DataStructures.WITHDRAW_PUBLIC_TAG);

        DataStructures.L2ToL1Msg memory message = DataStructures.L2ToL1Msg({
            sender: DataStructures.L2Actor({actor: l2Sender, version: l2Version}),
            recipient: DataStructures.L1Actor({actor: address(this), chainId: block.chainid}),
            content: content
        });
        outbox.consume(message, Epoch.wrap(l2Epoch), numCheckpointsInEpoch, leafIndex, siblingPath);

        l1Token.safeTransfer(recipient, amount);
        emit WithdrawCompleted(recipient, amount, l2Epoch, leafIndex);
    }

    /// @notice Sub-5c B3: L2→L1 message consumer for WITHDRAW_PRIVATE_TAG content
    ///         emitted by the L2 Token's exit_to_l1_private path. Identical to
    ///         withdraw() except the content-hash domain tag is the PRIVATE
    ///         variant, so the L2-emitted message can only be consumed via
    ///         this entry point (no cross-mode confusion).
    /// @param l2Sender L2 token address that emitted the exit (current or previously
    ///                 registered -- see L22 allowedL2Senders).
    function withdrawPrivate(
        uint256 amount,
        address recipient,
        uint256 l2Epoch,
        uint256 numCheckpointsInEpoch,
        uint256 leafIndex,
        bytes32[] calldata siblingPath,
        bytes32 l2Sender
    ) external whenNotPaused {
        if (amount == 0) revert ZeroAmount();
        if (recipient == address(0)) revert ZeroAddress();
        // L22: accept exits emitted by the current token OR a previously-rotated token.
        if (l2Sender != l2TokenAddress && !allowedL2Senders[l2Sender]) revert UnknownL2Sender();

        bytes32 content = _withdrawContent(recipient, amount, DataStructures.WITHDRAW_PRIVATE_TAG);
        DataStructures.L2ToL1Msg memory message = DataStructures.L2ToL1Msg({
            sender: DataStructures.L2Actor({actor: l2Sender, version: l2Version}),
            recipient: DataStructures.L1Actor({actor: address(this), chainId: block.chainid}),
            content: content
        });
        outbox.consume(message, Epoch.wrap(l2Epoch), numCheckpointsInEpoch, leafIndex, siblingPath);
        l1Token.safeTransfer(recipient, amount);
        emit WithdrawCompleted(recipient, amount, l2Epoch, leafIndex);
    }

    /// @return The current L1 token balance held in escrow by this bridge contract.
    function totalLocked() external view returns (uint256) {
        return l1Token.balanceOf(address(this));
    }

    // ── Recovery flow (Sub-5c) ────────────────────────────────────────────────

    /// @notice Sub-5c B2/B3: maker requests recovery of a deposit whose L2 claim
    ///         path has been unreachable for 90+ days (lost L2 wallet, no PXE
    ///         access, etc.). This creates an on-chain recovery request; phase 2
    ///         (approveRecovery) requires governance multisig manual verification
    ///         that the L2 message remains unconsumed; phase 3 (executeRecovery)
    ///         releases funds back to the original depositor.
    ///
    ///         Only the original depositor (msg.sender match at deposit time) can
    ///         call. The 90-day waiting period is enforced; the L2-consumption
    ///         check happens off-chain at governance approval time.
    function requestRecovery(bytes32 secretHash) external {
        bytes32 key = keccak256(abi.encode(msg.sender, secretHash));
        Deposit memory d = deposits[key];
        if (d.amount == 0) revert NoSuchDeposit();
        if (block.timestamp < uint256(d.timestamp) + 90 days) revert DepositTooRecent();
        pendingRecoveries[key] = true;
        emit RecoveryRequested(msg.sender, secretHash, d.amount);
    }

    /// @notice Sub-5c B2/B3: phase 2 — governance multisig approves a pending
    ///         recovery after manually verifying the L2 message is still
    ///         unconsumed. The off-chain check is the trust-minimization
    ///         boundary (L1 cannot read L2 nullifier state directly).
    function approveRecovery(bytes32 key) external onlyRole(GOVERNANCE_ROLE) {
        if (!pendingRecoveries[key]) revert NoSuchRequest();
        approvedRecoveries[key] = true;
        approvalTimestamps[key] = block.timestamp; // H14: approval is only valid for APPROVAL_TTL
        emit RecoveryApproved(key);
    }

    /// @notice H14: governance can revoke a still-unexecuted approval within the TTL
    ///         window (e.g. it detects the L2 message was consumed after approving).
    function revokeRecoveryApproval(bytes32 key) external onlyRole(GOVERNANCE_ROLE) {
        delete approvedRecoveries[key];
        delete approvalTimestamps[key];
        emit RecoveryApprovalRevoked(key);
    }

    /// @notice Sub-5c B2/B3: phase 3 — original depositor executes the approved
    ///         recovery. msg.sender match against the deposit's (sender,
    ///         secretHash) key is the access control: an attacker who knows the
    ///         secret but is not the original depositor cannot recover. State is
    ///         fully cleared on success to prevent re-recovery.
    function executeRecovery(bytes32 secretHash, address l1Recipient) external whenNotPaused {
        // M18: executeRecovery is the only other path that moves l1Token out of escrow,
        // so it must honor the emergency pause — otherwise EMERGENCY_PAUSER_ROLE cannot
        // stop already-approved recoveries draining the bridge during an incident.
        if (l1Recipient == address(0)) revert ZeroAddress();
        bytes32 key = keccak256(abi.encode(msg.sender, secretHash));
        if (!approvedRecoveries[key]) revert NotApproved();
        // H14: a stale approval can no longer vouch that the L2 message is unconsumed,
        // so reject it. The approval stays on-chain (this revert would roll back any
        // delete anyway) but is permanently unexecutable while expired; governance
        // must re-verify and re-approve (or revokeRecoveryApproval to clean it up).
        if (block.timestamp > approvalTimestamps[key] + APPROVAL_TTL) revert ApprovalExpired();
        uint256 amount = deposits[key].amount;
        delete deposits[key];
        delete pendingRecoveries[key];
        delete approvedRecoveries[key];
        delete approvalTimestamps[key];
        l1Token.safeTransfer(l1Recipient, amount);
        emit RecoveryExecuted(msg.sender, secretHash, l1Recipient, amount);
    }

    // ── Governance ────────────────────────────────────────────────────────────

    /// @notice Pause all deposit and withdraw operations. Use this to block deposits
    ///         rather than `setMaxTvl(0)` — see `maxTvl` for why.
    function pause() external onlyRole(EMERGENCY_PAUSER_ROLE) { _pause(); }

    /// @notice Resume deposit and withdraw operations after a pause.
    function unpause() external onlyRole(EMERGENCY_PAUSER_ROLE) { _unpause(); }

    /// @notice Update the TVL cap. A value of 0 means UNLIMITED (no cap enforcement).
    ///         To block all new deposits use `pause()` instead; setting this to 0 does
    ///         NOT block deposits.
    function setMaxTvl(uint256 newCap) external onlyRole(GOVERNANCE_ROLE) {
        emit MaxTvlUpdated(maxTvl, newCap);
        maxTvl = newCap;
    }

    /// @notice Update the L2 token address. Allows governance to point the bridge to
    ///         a new L2 token deployment (e.g. after a token migration).
    /// @param newAddr New Aztec L2 token address (as bytes32); must be non-zero.
    function setL2TokenAddress(bytes32 newAddr) external onlyRole(GOVERNANCE_ROLE) {
        if (newAddr == bytes32(0)) revert ZeroAddress();
        emit L2TokenAddressUpdated(l2TokenAddress, newAddr);
        // L22: keep the outgoing address valid for exits already burned on L2 but not yet
        // consumed on L1, and allow the incoming address for future exits.
        if (l2TokenAddress != bytes32(0)) allowedL2Senders[l2TokenAddress] = true;
        allowedL2Senders[newAddr] = true;
        l2TokenAddress = newAddr;
    }

    /// @notice Re-point the bridge at a new Aztec rollup deployment. Aztec testnet
    ///         resets deploy a fresh inbox/outbox with a new rollup version; the L2
    ///         token's portal address is immutable, so the bridge must keep its L1
    ///         address and rebind its Aztec target instead of being redeployed.
    ///         Governance-gated (same trust level as upgrades — governance already
    ///         fully controls this contract via UUPS).
    /// @dev    In-flight messages against the OLD rollup become unclaimable by
    ///         construction after a reset (the old rollup is dead); pending
    ///         recovery approvals should be re-checked by governance before use.
    function setAztecTarget(uint256 _l2Version, IInbox _inbox, IOutbox _outbox)
        external
        onlyRole(GOVERNANCE_ROLE)
    {
        if (address(_inbox) == address(0)) revert ZeroAddress();
        if (address(_outbox) == address(0)) revert ZeroAddress();
        emit AztecTargetUpdated(
            l2Version, _l2Version, address(inbox), address(_inbox), address(outbox), address(_outbox)
        );
        l2Version = _l2Version;
        inbox = _inbox;
        outbox = _outbox;
    }

    /// @notice Rescue accidentally sent ERC20 tokens (other than the bridged `l1Token`).
    ///         Cannot be used to drain the bridge's escrowed `l1Token` balance.
    function withdrawTreasuryDust(IERC20 token, uint256 amount, address to) external onlyRole(GOVERNANCE_ROLE) {
        if (address(token) == address(l1Token)) revert CannotSweepL1Token();
        if (to == address(0)) revert ZeroAddress();
        token.safeTransfer(to, amount);
    }

    /// @dev UUPS upgrade gate. INV-005 fix: bound to the governance timelock
    ///      ADDRESS, not the GOVERNANCE_ROLE. A role is delegable — DEFAULT_ADMIN
    ///      (the timelock) could grant it to an EOA that then upgrades with no
    ///      delay. An address is not: only the timelock contract itself (behind
    ///      its delay + multisig) can authorize an implementation swap, whatever
    ///      the role table says. The emergency multisig (EMERGENCY_PAUSER_ROLE
    ///      only) still cannot reach this path.
    function _authorizeUpgrade(address) internal view override {
        if (msg.sender != governanceTimelock) revert NotGovernanceTimelock();
    }

    // ── Internal ──────────────────────────────────────────────────────────────

    function _enforceTvlCap(uint256 amount) internal view {
        if (maxTvl == 0) return;
        uint256 newTotal = l1Token.balanceOf(address(this)) + amount;
        if (newTotal > maxTvl) revert TvlCapExceeded(newTotal, maxTvl);
    }

    // L1↔L2 content hash uses sha256 truncated to 31 bytes + a zero
    // prefix byte (matching the Aztec L1↔L2 protocol convention from
    // Hash.sha256ToField). The L2 Noir side reconstructs the same hash
    // via aztec::protocol::hash::sha256_to_field over the same field serialization.
    function _depositContent(bytes32 l2Recipient, uint256 amount, bytes32 secretHash, bytes32 tag)
        internal pure returns (bytes32)
    {
        return _sha256ToField(abi.encode(l2Recipient, amount, secretHash, tag));
    }

    // Generic content-hash helper used by both withdraw() (PUBLIC tag) and
    // withdrawPrivate() (PRIVATE tag). The tag parameter is the only
    // distinguishing factor between the two L2→L1 paths.
    function _withdrawContent(address recipient, uint256 amount, bytes32 tag)
        internal pure returns (bytes32)
    {
        return _sha256ToField(abi.encode(bytes32(uint256(uint160(recipient))), amount, tag));
    }

    /// @notice sha256 truncated to 31 bytes + zero-prefixed to 32, matching
    ///         Aztec's L1↔L2 content-hash convention (Hash.sha256ToField).
    function _sha256ToField(bytes memory data) internal pure returns (bytes32) {
        return bytes32(bytes.concat(new bytes(1), bytes31(sha256(data))));
    }
}
