// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.27;

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {TokenBridge} from "../src/TokenBridge.sol";
import {IInbox} from "../src/interfaces/IInbox.sol";
import {IOutbox} from "../src/interfaces/IOutbox.sol";
import {DataStructures} from "../src/lib/DataStructures.sol";
import {Epoch} from "../src/lib/TimeMath.sol";

// M19: exposes TokenBridge's internal pure content-hash helpers for golden-vector
// assertions. Pure functions touch no state, so the disabled-initializer base ctor is fine.
contract TokenBridgeHarness is TokenBridge {
    function depositContent(bytes32 l2Recipient, uint256 amount, bytes32 secretHash, bytes32 tag)
        external pure returns (bytes32) { return _depositContent(l2Recipient, amount, secretHash, tag); }
    function withdrawContent(address recipient, uint256 amount, bytes32 tag)
        external pure returns (bytes32) { return _withdrawContent(recipient, amount, tag); }
}

// ── Mocks ─────────────────────────────────────────────────────────────────────

contract MockERC20 is IERC20 {
    string public name = "Mock";
    string public symbol = "MOCK";
    uint8 public decimals = 6;
    mapping(address => uint256) public override balanceOf;
    mapping(address => mapping(address => uint256)) public override allowance;
    uint256 public override totalSupply;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        totalSupply += amount;
        emit Transfer(address(0), to, amount);
    }

    function transfer(address to, uint256 amount) external override returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        emit Transfer(msg.sender, to, amount);
        return true;
    }

    function approve(address spender, uint256 amount) external override returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external override returns (bool) {
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
        return true;
    }
}

contract MockInbox is IInbox {
    uint256 public nextIndex;
    DataStructures.L2Actor public lastRecipient;
    bytes32 public lastContent;

    function sendL2Message(DataStructures.L2Actor memory recipient, bytes32 content, bytes32 secretHash)
        external
        returns (bytes32, uint256)
    {
        lastRecipient = recipient;
        lastContent = content;
        uint256 idx = nextIndex++;
        return (keccak256(abi.encode(content, secretHash, idx)), idx);
    }

    function consume(uint256) external pure returns (bytes32) { return bytes32(0); }
    function catchUp(uint256) external pure {}
    function getFeeAssetPortal() external pure returns (address) { return address(0); }
    function getRoot(uint256) external pure returns (bytes32) { return bytes32(0); }
    function getState() external pure returns (InboxState memory) { return InboxState(bytes16(0), 0, 0); }
    function getTotalMessagesInserted() external pure returns (uint64) { return 0; }
    function getInProgress() external pure returns (uint64) { return 0; }
}

contract MockOutbox is IOutbox {
    bool public shouldRevert;
    mapping(uint256 => mapping(uint256 => bool)) public consumed;
    // M19 Finding 2: capture the last consumed message content so withdraw integration
    // tests can assert the bridge passed the correct content hash to the outbox.
    bytes32 public lastConsumedContent;
    // L22 hardening: capture the sender actor so tests can assert the bridge builds the
    // L2ToL1Msg from l2Sender (the caller-supplied arg) and not from l2TokenAddress.
    bytes32 public lastConsumedSender;

    function setShouldRevert(bool v) external { shouldRevert = v; }

    function insert(Epoch, uint256, bytes32) external {}

    function consume(
        DataStructures.L2ToL1Msg calldata l2msg,
        Epoch epoch,
        uint256, /* numCheckpointsInEpoch */
        uint256 leafIndex,
        bytes32[] calldata
    ) external {
        if (shouldRevert) revert("outbox: invalid proof");
        uint256 e = Epoch.unwrap(epoch);
        require(!consumed[e][leafIndex], "already consumed");
        consumed[e][leafIndex] = true;
        lastConsumedContent = l2msg.content;
        lastConsumedSender = l2msg.sender.actor;
    }

    function hasMessageBeenConsumedAtEpoch(Epoch epoch, uint256 leafId) external view returns (bool) {
        return consumed[Epoch.unwrap(epoch)][leafId];
    }

    function getRootData(Epoch, uint256) external pure returns (bytes32) { return bytes32(0); }

    function getRoots(Epoch) external pure returns (bytes32[32] memory r) { return r; }
}


// Deposit-reentrancy harness: a token whose transferFrom re-enters the bridge on
// the SAME (sender, secretHash) key. Without CEI + nonReentrant, the re-entrant
// call would find the DepositKeyInUse guard unwritten and escrow a second time,
// clobbering the first deposit's recovery record.
contract ReentrantToken is IERC20 {
    string public name = "Reentrant";
    string public symbol = "RE";
    uint8 public decimals = 6;
    mapping(address => uint256) public override balanceOf;
    mapping(address => mapping(address => uint256)) public override allowance;
    uint256 public override totalSupply;

    TokenBridge public bridge;
    bytes32 public attackSecretHash;
    bool public armed;

    function setBridge(TokenBridge b, bytes32 sh) external { bridge = b; attackSecretHash = sh; }
    function arm() external { armed = true; }
    function mint(address to, uint256 a) external { balanceOf[to] += a; totalSupply += a; }
    function transfer(address to, uint256 a) external override returns (bool) {
        balanceOf[msg.sender] -= a; balanceOf[to] += a; return true;
    }
    function approve(address s, uint256 a) external override returns (bool) { allowance[msg.sender][s] = a; return true; }
    function transferFrom(address from, address to, uint256 a) external override returns (bool) {
        if (armed) {
            armed = false; // one shot
            // Re-enter on the SAME key. Must revert (nonReentrant / DepositKeyInUse via CEI).
            bridge.depositToL2Public(a, bytes32(uint256(0xfeed)), attackSecretHash);
        }
        allowance[from][msg.sender] -= a; balanceOf[from] -= a; balanceOf[to] += a; return true;
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

contract TokenBridgeTest is Test {
    TokenBridge bridge;
    MockERC20 token;
    MockInbox inbox;
    MockOutbox outbox;
    address governanceTimelock = address(0xA11CE);
    address emergencyTimelock  = address(0xE0E0);
    address alice = address(0xB0B);
    bytes32 constant L2_TOKEN = bytes32(uint256(0xa2c7e9));

    function setUp() public {
        token = new MockERC20();
        inbox = new MockInbox();
        outbox = new MockOutbox();

        // Deploy implementation + proxy + initialize in one step.
        TokenBridge impl = new TokenBridge();
        bytes memory init = abi.encodeWithSelector(
            TokenBridge.initialize.selector,
            IERC20(address(token)),
            L2_TOKEN,
            uint256(1),
            IInbox(address(inbox)),
            IOutbox(address(outbox)),
            governanceTimelock,
            emergencyTimelock,
            uint256(0) // unlimited TVL
        );
        ERC1967Proxy proxy = new ERC1967Proxy(address(impl), init);
        bridge = TokenBridge(address(proxy));

        token.mint(alice, 1_000_000_000); // 1 000 USDC at 6 decimals
    }

    // 1. Public deposit happy path: locks tokens + returns valid index
    function test_depositToL2Public_locksTokensAndEmitsMessage() public {
        vm.startPrank(alice);
        token.approve(address(bridge), 100_000_000);
        (bytes32 hash, uint256 idx) = bridge.depositToL2Public(
            100_000_000,
            bytes32(uint256(0xfeed)),
            bytes32(uint256(0xbeef))
        );
        vm.stopPrank();

        assertEq(token.balanceOf(address(bridge)), 100_000_000, "bridge locked amount");
        assertEq(token.balanceOf(alice), 900_000_000, "alice debited");
        assertEq(idx, 0, "first message index");
        assertGt(uint256(hash), 0, "non-zero message hash");
    }

    // 2. Private deposit happy path: same lock semantics, recipient hidden in payload
    function test_depositToL2Private_omitsRecipientFromMessage() public {
        vm.startPrank(alice);
        token.approve(address(bridge), 50_000_000);

        // Expect DepositInitiated(sender=alice, l2Recipient=bytes32(0), amount, secretHash, idx=0, isPrivate=true)
        // checkTopic1=true (sender indexed), checkTopic2=true (l2Recipient indexed),
        // checkTopic3=false (no third indexed field), checkData=true (verify non-indexed fields).
        vm.expectEmit(true, true, false, true, address(bridge));
        emit TokenBridge.DepositInitiated(alice, bytes32(0), 50_000_000, bytes32(uint256(0xcafe)), 0, true);

        (, uint256 idx) = bridge.depositToL2Private(50_000_000, bytes32(uint256(0xcafe)));
        vm.stopPrank();

        assertEq(token.balanceOf(address(bridge)), 50_000_000, "bridge locked private deposit amount");
        assertEq(idx, 0, "first private deposit index");
    }

    // 3. Paused portal blocks deposits
    function test_deposit_revertsWhenPaused() public {
        vm.prank(emergencyTimelock);
        bridge.pause();

        vm.startPrank(alice);
        token.approve(address(bridge), 100);
        // OZ PausableUpgradeable: EnforcedPause() — selector omitted to keep test concise
        vm.expectRevert();
        bridge.depositToL2Public(100, bytes32(uint256(0xfeed)), bytes32(uint256(0xbeef)));
        vm.stopPrank();
    }

    // 4. TVL cap is enforced (custom error TvlCapExceeded)
    function test_deposit_revertsOnTvlCap() public {
        vm.prank(governanceTimelock);
        bridge.setMaxTvl(50_000_000);

        vm.startPrank(alice);
        token.approve(address(bridge), 100_000_000);
        vm.expectRevert(
            abi.encodeWithSelector(
                TokenBridge.TvlCapExceeded.selector,
                uint256(100_000_000),
                uint256(50_000_000)
            )
        );
        bridge.depositToL2Public(100_000_000, bytes32(uint256(0xfeed)), bytes32(uint256(0xbeef)));
        vm.stopPrank();
    }

    // 5a. Zero-amount deposit reverts
    function test_deposit_revertsOnZeroAmount() public {
        vm.prank(alice);
        vm.expectRevert(TokenBridge.ZeroAmount.selector);
        bridge.depositToL2Public(0, bytes32(uint256(0xfeed)), bytes32(uint256(0xbeef)));
    }

    // 5b. Zero-recipient deposit reverts
    function test_deposit_revertsOnZeroL2Recipient() public {
        vm.startPrank(alice);
        token.approve(address(bridge), 100);
        vm.expectRevert(TokenBridge.ZeroAddress.selector);
        bridge.depositToL2Public(100, bytes32(0), bytes32(uint256(0xbeef)));
        vm.stopPrank();
    }

    // 5c. Zero-amount withdraw reverts
    function test_withdraw_revertsOnZeroAmount() public {
        bytes32[] memory proof = new bytes32[](6);
        vm.expectRevert(TokenBridge.ZeroAmount.selector);
        bridge.withdraw(0, alice, uint256(12345), uint256(1), uint256(7), proof, L2_TOKEN);
    }

    // 5d. Zero-recipient withdraw reverts
    function test_withdraw_revertsOnZeroRecipient() public {
        bytes32[] memory proof = new bytes32[](6);
        vm.expectRevert(TokenBridge.ZeroAddress.selector);
        bridge.withdraw(100, address(0), uint256(12345), uint256(1), uint256(7), proof, L2_TOKEN);
    }

    // 6. Withdraw happy path: outbox.consume succeeds → release to recipient
    function test_withdraw_releasesTokensOnValidProof() public {
        // Pre-fund bridge as if a prior deposit happened.
        token.mint(address(bridge), 100_000_000);

        bytes32[] memory proof = new bytes32[](6);
        bridge.withdraw(80_000_000, alice, uint256(12345), uint256(1), uint256(7), proof, L2_TOKEN);

        assertEq(token.balanceOf(alice), 1_000_000_000 + 80_000_000, "alice received withdrawn amount");
        assertEq(token.balanceOf(address(bridge)), 20_000_000, "bridge debited correctly");
    }

    // 6a. Double-withdrawal replay is rejected by MockOutbox's consumed[] guard
    function test_withdraw_doubleConsume_reverts() public {
        token.mint(address(bridge), 200_000_000);
        bytes32[] memory proof = new bytes32[](6);

        // First withdrawal succeeds
        bridge.withdraw(80_000_000, alice, uint256(12345), uint256(1), uint256(7), proof, L2_TOKEN);
        assertEq(token.balanceOf(alice), 1_000_000_000 + 80_000_000, "alice received first withdraw");

        // Second withdrawal with same (l2Epoch, leafIndex) must revert via Outbox replay guard
        vm.expectRevert(bytes("already consumed"));
        bridge.withdraw(80_000_000, alice, uint256(12345), uint256(1), uint256(7), proof, L2_TOKEN);
    }

    // 7. Withdraw reverts when outbox proof is invalid
    function test_withdraw_revertsOnInvalidProof() public {
        token.mint(address(bridge), 100_000_000);
        outbox.setShouldRevert(true);

        bytes32[] memory proof = new bytes32[](6);
        vm.expectRevert(bytes("outbox: invalid proof"));
        bridge.withdraw(50_000_000, alice, uint256(12345), uint256(1), uint256(7), proof, L2_TOKEN);
    }

    // 7. Paused portal blocks withdraws
    function test_withdraw_revertsWhenPaused() public {
        vm.prank(emergencyTimelock);
        bridge.pause();

        bytes32[] memory proof = new bytes32[](6);
        // OZ PausableUpgradeable: EnforcedPause() — selector omitted to keep test concise
        vm.expectRevert();
        bridge.withdraw(50_000_000, alice, uint256(12345), uint256(1), uint256(7), proof, L2_TOKEN);
    }

    // 8. pause() requires EMERGENCY_PAUSER_ROLE
    function test_pause_requiresEmergencyRole() public {
        // Called from address(this) which holds no role.
        // OZ AccessControl: AccessControlUnauthorizedAccount(address,bytes32) — selector omitted
        vm.expectRevert();
        bridge.pause();
    }

    // 9. setMaxTvl() requires GOVERNANCE_ROLE
    function test_setMaxTvl_requiresGovernanceRole() public {
        // OZ AccessControl: AccessControlUnauthorizedAccount(address,bytes32) — selector omitted
        vm.expectRevert();
        bridge.setMaxTvl(123);
    }

    // 10. withdrawTreasuryDust cannot drain l1Token
    function test_withdrawTreasuryDust_cannotDrainL1Token() public {
        token.mint(address(bridge), 100);
        vm.prank(governanceTimelock);
        vm.expectRevert(TokenBridge.CannotSweepL1Token.selector);
        bridge.withdrawTreasuryDust(IERC20(address(token)), 100, governanceTimelock);
    }

    // 11. totalLocked() reports the live ERC20 balance
    function test_totalLocked_reportsBalance() public {
        token.mint(address(bridge), 500);
        assertEq(bridge.totalLocked(), 500, "totalLocked reflects minted balance");
    }

    // 12. Role separation invariant: governance cannot pause; emergency cannot govern
    function test_governanceCannotPause_emergencyCannotGovern() public {
        // governanceTimelock holds GOVERNANCE_ROLE only; cannot pause
        vm.prank(governanceTimelock);
        vm.expectRevert();  // OZ AccessControl: AccessControlUnauthorizedAccount(governanceTimelock, EMERGENCY_PAUSER_ROLE)
        bridge.pause();

        // emergencyTimelock holds EMERGENCY_PAUSER_ROLE only; cannot setMaxTvl
        vm.prank(emergencyTimelock);
        vm.expectRevert();  // OZ AccessControl: AccessControlUnauthorizedAccount(emergencyTimelock, GOVERNANCE_ROLE)
        bridge.setMaxTvl(123);
    }

    // 13. A1 self-admin invariant: governance CANNOT revoke emergency role
    function test_governanceCannotRevokeEmergencyRole() public {
        // governanceTimelock holds DEFAULT_ADMIN_ROLE but EMERGENCY_PAUSER_ROLE's
        // admin role is EMERGENCY_PAUSER_ROLE itself (set in initialize).
        // Pre-fetch the role before vm.expectRevert so the view call doesn't consume it.
        bytes32 emergencyRole = bridge.EMERGENCY_PAUSER_ROLE();
        vm.prank(governanceTimelock);
        vm.expectRevert();  // AccessControlUnauthorizedAccount: governance lacks EMERGENCY_PAUSER_ROLE admin
        bridge.revokeRole(emergencyRole, emergencyTimelock);
    }

    // ── Sub-5c B2: recoverDeposit 3-phase flow tests ──────────────────────────────

    function test_requestRecovery_revertsBeforeWindow() public {
        vm.startPrank(alice);
        token.approve(address(bridge), 100_000_000);
        bridge.depositToL2Public(100_000_000, bytes32(uint256(0xfeed)), bytes32(uint256(0xbeef)));
        // Try to recover immediately (no 90-day wait)
        vm.expectRevert(TokenBridge.DepositTooRecent.selector);
        bridge.requestRecovery(bytes32(uint256(0xbeef)));
        vm.stopPrank();
    }

    function test_requestRecovery_revertsForUnknownDeposit() public {
        vm.prank(alice);
        vm.expectRevert(TokenBridge.NoSuchDeposit.selector);
        bridge.requestRecovery(bytes32(uint256(0xc0ffee)));
    }

    function test_recoveryHappyPath_3phase() public {
        // Phase 0: alice deposits 100 USDC
        vm.startPrank(alice);
        token.approve(address(bridge), 100_000_000);
        bridge.depositToL2Public(100_000_000, bytes32(uint256(0xfeed)), bytes32(uint256(0xbeef)));
        vm.stopPrank();

        // Skip 91 days
        vm.warp(block.timestamp + 91 days);

        // Phase 1: alice requests recovery
        vm.prank(alice);
        bridge.requestRecovery(bytes32(uint256(0xbeef)));

        // Phase 2: governance multisig approves
        bytes32 aliceKey = keccak256(abi.encode(alice, bytes32(uint256(0xbeef))));
        vm.prank(governanceTimelock);
        bridge.approveRecovery(aliceKey);

        // Phase 3: alice executes recovery to her own address
        uint256 balanceBefore = token.balanceOf(alice);
        vm.prank(alice);
        bridge.executeRecovery(bytes32(uint256(0xbeef)), alice);

        assertEq(token.balanceOf(alice), balanceBefore + 100_000_000, "alice recovered amount");
        assertEq(token.balanceOf(address(bridge)), 0, "bridge fully debited");
    }

    function test_recovery_foreignSenderCannotExecute() public {
        // Alice deposits + waits + requests + governance approves
        vm.startPrank(alice);
        token.approve(address(bridge), 100_000_000);
        bridge.depositToL2Public(100_000_000, bytes32(uint256(0xfeed)), bytes32(uint256(0xbeef)));
        vm.stopPrank();
        vm.warp(block.timestamp + 91 days);
        vm.prank(alice);
        bridge.requestRecovery(bytes32(uint256(0xbeef)));
        bytes32 aliceKey = keccak256(abi.encode(alice, bytes32(uint256(0xbeef))));
        vm.prank(governanceTimelock);
        bridge.approveRecovery(aliceKey);

        // Bob (knows the secret) attempts to execute — his msg.sender computes a
        // different key, no approval exists for that key, revert.
        address bob = address(0xB0B1);
        vm.prank(bob);
        vm.expectRevert(TokenBridge.NotApproved.selector);
        bridge.executeRecovery(bytes32(uint256(0xbeef)), bob);
    }

    function test_approveRecovery_requiresGovernance() public {
        vm.startPrank(alice);
        token.approve(address(bridge), 100_000_000);
        bridge.depositToL2Public(100_000_000, bytes32(uint256(0xfeed)), bytes32(uint256(0xbeef)));
        vm.stopPrank();
        vm.warp(block.timestamp + 91 days);
        vm.prank(alice);
        bridge.requestRecovery(bytes32(uint256(0xbeef)));

        // Alice (not governance) tries to approve — should revert
        bytes32 key = keccak256(abi.encode(alice, bytes32(uint256(0xbeef))));
        vm.prank(alice);
        vm.expectRevert();  // OZ AccessControlUnauthorizedAccount(alice, GOVERNANCE_ROLE)
        bridge.approveRecovery(key);
    }

    // ── H14: recovery approval must expire (bound the post-approval L2-claim race) ──
    function _depositRequestApprove() internal returns (bytes32 key) {
        vm.startPrank(alice);
        token.approve(address(bridge), 100_000_000);
        bridge.depositToL2Public(100_000_000, bytes32(uint256(0xfeed)), bytes32(uint256(0xbeef)));
        vm.stopPrank();
        vm.warp(block.timestamp + 91 days);
        vm.prank(alice);
        bridge.requestRecovery(bytes32(uint256(0xbeef)));
        key = keccak256(abi.encode(alice, bytes32(uint256(0xbeef))));
        vm.prank(governanceTimelock);
        bridge.approveRecovery(key);
    }

    function test_executeRecovery_revertsAfterApprovalTtl() public {
        _depositRequestApprove();
        // Past the TTL the approval is stale (governance can no longer vouch that the
        // L2 message is unconsumed) — execute must revert, blocking the double-spend.
        vm.warp(block.timestamp + bridge.APPROVAL_TTL() + 1);
        vm.prank(alice);
        vm.expectRevert(TokenBridge.ApprovalExpired.selector);
        bridge.executeRecovery(bytes32(uint256(0xbeef)), alice);
        // Still expired on retry (the revert rolled back nothing to change that).
        vm.prank(alice);
        vm.expectRevert(TokenBridge.ApprovalExpired.selector);
        bridge.executeRecovery(bytes32(uint256(0xbeef)), alice);
    }

    function test_executeRecovery_succeedsWithinTtl() public {
        _depositRequestApprove();
        vm.warp(block.timestamp + bridge.APPROVAL_TTL() - 1 hours);
        uint256 balBefore = token.balanceOf(alice);
        vm.prank(alice);
        bridge.executeRecovery(bytes32(uint256(0xbeef)), alice);
        assertEq(token.balanceOf(alice), balBefore + 100_000_000, "recovery within TTL succeeds");
    }

    function test_revokeRecoveryApproval_blocksExecute() public {
        bytes32 key = _depositRequestApprove();
        vm.prank(governanceTimelock);
        bridge.revokeRecoveryApproval(key);
        vm.prank(alice);
        vm.expectRevert(TokenBridge.NotApproved.selector);
        bridge.executeRecovery(bytes32(uint256(0xbeef)), alice);
    }

    function test_revokeRecoveryApproval_requiresGovernance() public {
        bytes32 key = _depositRequestApprove();
        vm.prank(alice);
        vm.expectRevert(); // OZ AccessControlUnauthorizedAccount(alice, GOVERNANCE_ROLE)
        bridge.revokeRecoveryApproval(key);
    }

    // M18: executeRecovery must honor the emergency pause — otherwise an approved
    // recovery can drain the bridge during an incident the pause is meant to freeze.
    function test_executeRecovery_revertsWhenPaused() public {
        _depositRequestApprove();
        vm.prank(emergencyTimelock);
        bridge.pause();
        vm.prank(alice);
        vm.expectRevert(); // OZ EnforcedPause()
        bridge.executeRecovery(bytes32(uint256(0xbeef)), alice);
    }

    // ── Audit Finding #9: deposits require a non-zero l2TokenAddress ───────────────

    // A bridge whose l2TokenAddress is still zero (init race before setL2TokenAddress)
    // must reject deposits so funds are never escrowed against a zero L2 actor.
    function _deployUnsetBridge() internal returns (TokenBridge) {
        TokenBridge impl = new TokenBridge();
        bytes memory init = abi.encodeWithSelector(
            TokenBridge.initialize.selector,
            IERC20(address(token)),
            bytes32(0),            // l2TokenAddress UNSET — mirrors DeployAllBridges init
            uint256(1),
            IInbox(address(inbox)),
            IOutbox(address(outbox)),
            governanceTimelock,
            emergencyTimelock,
            uint256(0)
        );
        ERC1967Proxy proxy = new ERC1967Proxy(address(impl), init);
        return TokenBridge(address(proxy));
    }

    function test_depositPublic_revertsWhenL2TokenUnset() public {
        TokenBridge unset = _deployUnsetBridge();
        vm.startPrank(alice);
        token.approve(address(unset), 100_000_000);
        vm.expectRevert(TokenBridge.L2TokenNotSet.selector);
        unset.depositToL2Public(100_000_000, bytes32(uint256(0xfeed)), bytes32(uint256(0xbeef)));
        vm.stopPrank();
    }

    function test_depositPrivate_revertsWhenL2TokenUnset() public {
        TokenBridge unset = _deployUnsetBridge();
        vm.startPrank(alice);
        token.approve(address(unset), 100_000_000);
        vm.expectRevert(TokenBridge.L2TokenNotSet.selector);
        unset.depositToL2Private(100_000_000, bytes32(uint256(0xbeef)));
        vm.stopPrank();
    }

    // After governance sets the L2 token, deposits succeed again — confirms the guard
    // only blocks the init-race window, not normal operation.
    function test_depositPublic_succeedsAfterL2TokenSet() public {
        TokenBridge unset = _deployUnsetBridge();
        vm.prank(governanceTimelock);
        unset.setL2TokenAddress(L2_TOKEN);

        vm.startPrank(alice);
        token.approve(address(unset), 100_000_000);
        unset.depositToL2Public(100_000_000, bytes32(uint256(0xfeed)), bytes32(uint256(0xbeef)));
        vm.stopPrank();
        assertEq(token.balanceOf(address(unset)), 100_000_000, "deposit landed after L2 token set");
    }

    // ── Audit Finding #10: amount stored as uint256 (no truncation) ───────────────

    // A deposit larger than uint128.max must be preserved exactly in the recovery
    // record, otherwise executeRecovery would refund a truncated (smaller) amount.
    function test_recovery_preservesAmountAtUint128MaxBoundary() public {
        // L21: deposits above uint128.max are now rejected before storage. Use the boundary
        // value (type(uint128).max) to confirm the uint256 Deposit field still doesn't
        // truncate and that recovery returns the full amount.
        uint256 big = uint256(type(uint128).max); // boundary: largest allowed deposit
        token.mint(alice, big);

        vm.startPrank(alice);
        token.approve(address(bridge), big);
        bridge.depositToL2Public(big, bytes32(uint256(0xfeed)), bytes32(uint256(0xbeef)));
        vm.stopPrank();

        // The stored record holds the full uint256 amount, not a truncated value.
        (uint256 storedAmount,,) = bridge.deposits(keccak256(abi.encode(alice, bytes32(uint256(0xbeef)))));
        assertEq(storedAmount, big, "deposit record preserves amount at uint128.max boundary");

        vm.warp(block.timestamp + 91 days);
        vm.prank(alice);
        bridge.requestRecovery(bytes32(uint256(0xbeef)));
        bytes32 key = keccak256(abi.encode(alice, bytes32(uint256(0xbeef))));
        vm.prank(governanceTimelock);
        bridge.approveRecovery(key);

        uint256 balBefore = token.balanceOf(alice);
        vm.prank(alice);
        bridge.executeRecovery(bytes32(uint256(0xbeef)), alice);
        assertEq(token.balanceOf(alice), balBefore + big, "recovered full untruncated amount");
    }

    // Finding #10: a second deposit on the same (sender, secretHash) key must revert
    // rather than silently overwrite the earlier record and destroy its recovery rights.
    function test_deposit_revertsOnDuplicateKey() public {
        vm.startPrank(alice);
        token.approve(address(bridge), 200_000_000);
        bridge.depositToL2Public(100_000_000, bytes32(uint256(0xfeed)), bytes32(uint256(0xbeef)));

        // Same (msg.sender, secretHash) → same key. Must revert.
        vm.expectRevert(TokenBridge.DepositKeyInUse.selector);
        bridge.depositToL2Public(100_000_000, bytes32(uint256(0xfeed)), bytes32(uint256(0xbeef)));
        vm.stopPrank();
    }

    // The duplicate-key guard is per-secretHash: a different secretHash from the same
    // sender produces a distinct key and is accepted.
    function test_deposit_distinctSecretHashSucceeds() public {
        vm.startPrank(alice);
        token.approve(address(bridge), 200_000_000);
        bridge.depositToL2Public(100_000_000, bytes32(uint256(0xfeed)), bytes32(uint256(0xbeef)));
        bridge.depositToL2Public(100_000_000, bytes32(uint256(0xfeed)), bytes32(uint256(0xcafe)));
        vm.stopPrank();

        (uint256 a1,,) = bridge.deposits(keccak256(abi.encode(alice, bytes32(uint256(0xbeef)))));
        (uint256 a2,,) = bridge.deposits(keccak256(abi.encode(alice, bytes32(uint256(0xcafe)))));
        assertEq(a1, 100_000_000, "first deposit record intact");
        assertEq(a2, 100_000_000, "second deposit record stored under distinct key");
    }

    // After a deposit's recovery is fully executed (state cleared), the same
    // (sender, secretHash) key becomes reusable for a fresh deposit.
    function test_deposit_keyReusableAfterRecovery() public {
        vm.startPrank(alice);
        token.approve(address(bridge), 200_000_000);
        bridge.depositToL2Public(100_000_000, bytes32(uint256(0xfeed)), bytes32(uint256(0xbeef)));
        vm.stopPrank();

        vm.warp(block.timestamp + 91 days);
        vm.prank(alice);
        bridge.requestRecovery(bytes32(uint256(0xbeef)));
        bytes32 key = keccak256(abi.encode(alice, bytes32(uint256(0xbeef))));
        vm.prank(governanceTimelock);
        bridge.approveRecovery(key);
        vm.prank(alice);
        bridge.executeRecovery(bytes32(uint256(0xbeef)), alice);

        // Record cleared → key free again.
        vm.prank(alice);
        bridge.depositToL2Public(100_000_000, bytes32(uint256(0xfeed)), bytes32(uint256(0xbeef)));
        (uint256 a,,) = bridge.deposits(key);
        assertEq(a, 100_000_000, "key reusable after recovery cleared the record");
    }

    // ── Sub-5c B3: withdrawPrivate tests ──────────────────────────────────────────

    function test_withdrawPrivate_releasesTokensOnValidProof() public {
        token.mint(address(bridge), 100_000_000);
        bytes32[] memory proof = new bytes32[](6);
        uint256 balanceBefore = token.balanceOf(alice);
        bridge.withdrawPrivate(50_000_000, alice, uint256(54321), uint256(1), uint256(3), proof, L2_TOKEN);
        assertEq(token.balanceOf(alice), balanceBefore + 50_000_000, "alice received private withdraw");
        assertEq(token.balanceOf(address(bridge)), 50_000_000, "bridge debited by half");
    }

    function test_withdrawPrivate_revertsWhenPaused() public {
        vm.prank(emergencyTimelock);
        bridge.pause();
        bytes32[] memory proof = new bytes32[](6);
        vm.expectRevert();  // PausableUpgradeable: EnforcedPause()
        bridge.withdrawPrivate(50_000_000, alice, uint256(54321), uint256(1), uint256(3), proof, L2_TOKEN);
    }

    // ── M19 Finding 2: withdraw integration — MockOutbox capture assertion ────────

    // Drive a real withdraw() through the bridge and assert the outbox receives the
    // correct content hash (withdrawContent(recipient, amount, WITHDRAW_PUBLIC_TAG)).
    function test_m19_withdraw_feeds_correct_content_to_outbox() public {
        TokenBridgeHarness h = new TokenBridgeHarness();
        uint256 amount = 80_000_000;
        address recipient = alice;
        uint256 l2Epoch = uint256(12345);
        uint256 leafIndex = uint256(7);

        // Pre-fund bridge (simulates prior deposits).
        token.mint(address(bridge), amount);

        bytes32[] memory proof = new bytes32[](6);
        bridge.withdraw(amount, recipient, l2Epoch, uint256(1), leafIndex, proof, bridge.l2TokenAddress());

        bytes32 expectedContent = h.withdrawContent(recipient, amount, DataStructures.WITHDRAW_PUBLIC_TAG);
        assertEq(outbox.lastConsumedContent(), expectedContent, "withdraw content mismatch");
    }

    // ── M19: golden content-hash vector tests ─────────────────────────────────────

    function test_m19_depositPublic_golden() public {
        TokenBridgeHarness h = new TokenBridgeHarness();
        bytes32 got = h.depositContent(
            bytes32(uint256(0x1111111111111111111111111111111111111111111111111111111111111111)),
            123456789,
            bytes32(uint256(0x2222222222222222222222222222222222222222222222222222222222222222)),
            DataStructures.DEPOSIT_PUBLIC_TAG
        );
        assertEq(got, 0x0082e259c24bad647156f027ed63128d24811b86968547273efa5738a375fcc7);
    }

    function test_m19_depositPrivate_golden() public {
        TokenBridgeHarness h = new TokenBridgeHarness();
        bytes32 got = h.depositContent(
            bytes32(0), 123456789,
            bytes32(uint256(0x2222222222222222222222222222222222222222222222222222222222222222)),
            DataStructures.DEPOSIT_PRIVATE_TAG
        );
        assertEq(got, 0x006439d00b4364718dd3944832245249bc88cf84840a3ee487064dd0a2671df9);
    }

    function test_m19_withdrawPublic_golden() public {
        TokenBridgeHarness h = new TokenBridgeHarness();
        bytes32 got = h.withdrawContent(
            address(0x3333333333333333333333333333333333333333), 123456789, DataStructures.WITHDRAW_PUBLIC_TAG
        );
        assertEq(got, 0x00706f0d1c76b1411fa40f1b5243f66db8fe671c26464bf1475dd4c348dcf7f6);
    }

    function test_m19_withdrawPrivate_golden() public {
        TokenBridgeHarness h = new TokenBridgeHarness();
        bytes32 got = h.withdrawContent(
            address(0x3333333333333333333333333333333333333333), 123456789, DataStructures.WITHDRAW_PRIVATE_TAG
        );
        assertEq(got, 0x006de33747bb380f044f1e16230ba9c2b88643c25aff92264cf61c910aeb1bba);
    }

    // ── L21: deposit amount must fit u128 (L2 claim_* take amount as u128) ─────────

    // A deposit amount one above uint128.max must be rejected before any token transfer.
    // The L2 claim_* functions accept amount as u128; a deposit above that limit commits
    // a content hash no L2 call can reconstruct -- escrowed with only the 90-day recovery path.
    function test_L21_depositPublic_revertsAboveUint128Max() public {
        uint256 tooBig = uint256(type(uint128).max) + 1;
        token.mint(alice, tooBig);
        vm.startPrank(alice);
        token.approve(address(bridge), tooBig);
        vm.expectRevert(TokenBridge.AmountExceedsL2Max.selector);
        bridge.depositToL2Public(tooBig, bytes32(uint256(0xfeed)), bytes32(uint256(0xbeef)));
        vm.stopPrank();
    }

    // The boundary value (exactly uint128.max) must be accepted: the guard is strictly
    // greater-than, so this deposit should proceed without AmountExceedsL2Max.
    function test_L21_depositPublic_acceptsUint128Max() public {
        uint256 ok = uint256(type(uint128).max);
        token.mint(alice, ok);
        vm.startPrank(alice);
        token.approve(address(bridge), ok);
        // Must NOT revert with AmountExceedsL2Max. TVL is unlimited (maxTvl=0 in setUp)
        // and alice has the balance, so the deposit should succeed fully.
        bridge.depositToL2Public(ok, bytes32(uint256(0xfee1)), bytes32(uint256(0xbee1)));
        vm.stopPrank();
        assertEq(token.balanceOf(address(bridge)), ok, "bridge received uint128.max deposit");
    }

    // L21: private-path coverage — depositToL2Private must also enforce the uint128 limit
    function test_L21_depositPrivate_revertsAboveUint128Max() public {
        uint256 tooBig = uint256(type(uint128).max) + 1;
        token.mint(alice, tooBig);
        vm.startPrank(alice);
        token.approve(address(bridge), tooBig);
        vm.expectRevert(TokenBridge.AmountExceedsL2Max.selector);
        bridge.depositToL2Private(tooBig, bytes32(uint256(0xcafe)));
        vm.stopPrank();
    }

    // L21: private-path boundary — exactly uint128.max must be accepted on private deposits
    function test_L21_depositPrivate_acceptsUint128Max() public {
        uint256 ok = uint256(type(uint128).max);
        token.mint(alice, ok);
        vm.startPrank(alice);
        token.approve(address(bridge), ok);
        // Must NOT revert with AmountExceedsL2Max. TVL is unlimited (maxTvl=0 in setUp)
        // and alice has the balance, so the deposit should succeed fully.
        bridge.depositToL2Private(ok, bytes32(uint256(0xcaf1)));
        vm.stopPrank();
        assertEq(token.balanceOf(address(bridge)), ok, "bridge received uint128.max private deposit");
    }

    // ── L22: dual-sender allowance -- in-flight exits survive a token migration ──────

    // After setL2TokenAddress rotates to a new token, exits that were already burned on L2
    // under the old token address must still be consumable on L1 by passing the old address.
    function test_L22_withdraw_acceptsRotatedOldSender() public {
        bytes32 oldToken = bridge.l2TokenAddress();
        bytes32 newToken = bytes32(uint256(0xc0ffee));
        vm.prank(governanceTimelock);
        bridge.setL2TokenAddress(newToken);
        // Pre-fund bridge to simulate a prior deposit.
        token.mint(address(bridge), 80_000_000);
        bytes32[] memory proof = new bytes32[](6);
        uint256 balanceBefore = token.balanceOf(alice);
        // An exit emitted under oldToken must still be consumable.
        bridge.withdraw(80_000_000, alice, uint256(12345), uint256(1), uint256(7), proof, oldToken);
        assertEq(token.balanceOf(alice), balanceBefore + 80_000_000, "alice received via old sender after rotation");
        // L22 hardening: confirm the bridge built the L2ToL1Msg from l2Sender (oldToken),
        // not from the current l2TokenAddress (newToken). A regression to building from
        // l2TokenAddress would place newToken in the message, which the Outbox would reject
        // against the burned leaf — this assert catches that before it escapes to production.
        assertEq(outbox.lastConsumedSender(), oldToken, "L2ToL1Msg sender must be built from l2Sender, not current l2TokenAddress");
    }

    // An l2Sender that has never been the l2TokenAddress must be rejected.
    function test_L22_withdraw_revertsUnknownSender() public {
        token.mint(address(bridge), 80_000_000);
        bytes32[] memory proof = new bytes32[](6);
        bytes32 bogus = bytes32(uint256(0xdead));
        vm.expectRevert(TokenBridge.UnknownL2Sender.selector);
        bridge.withdraw(80_000_000, alice, uint256(12345), uint256(1), uint256(7), proof, bogus);
    }

    // ── v5 reset-recovery: setAztecTarget ────────────────────────────────────────

    // Non-governance caller must be rejected (same trust gate as upgrades).
    function test_setAztecTarget_requiresGovernanceRole() public {
        MockInbox newInbox = new MockInbox();
        MockOutbox newOutbox = new MockOutbox();
        vm.prank(alice);
        vm.expectRevert(); // OZ AccessControlUnauthorizedAccount(alice, GOVERNANCE_ROLE)
        bridge.setAztecTarget(uint256(999), IInbox(address(newInbox)), IOutbox(address(newOutbox)));
    }

    // Governance rebinds l2Version + inbox + outbox and emits the audit event.
    function test_setAztecTarget_rebindsAndEmits() public {
        MockInbox newInbox = new MockInbox();
        MockOutbox newOutbox = new MockOutbox();
        vm.expectEmit(false, false, false, true);
        emit TokenBridge.AztecTargetUpdated(
            uint256(1), uint256(2787991301), address(inbox), address(newInbox), address(outbox), address(newOutbox)
        );
        vm.prank(governanceTimelock);
        bridge.setAztecTarget(uint256(2787991301), IInbox(address(newInbox)), IOutbox(address(newOutbox)));
        assertEq(bridge.l2Version(), uint256(2787991301));
        assertEq(address(bridge.inbox()), address(newInbox));
        assertEq(address(bridge.outbox()), address(newOutbox));

        // Deposits now route through the NEW inbox (old inbox sees no message).
        uint256 oldInboxIdx = inbox.nextIndex();
        vm.startPrank(alice);
        token.approve(address(bridge), 1_000_000);
        bridge.depositToL2Public(1_000_000, bytes32(uint256(0x12a4)), bytes32(uint256(1)));
        vm.stopPrank();
        assertEq(newInbox.nextIndex(), 1, "new inbox received the deposit message");
        assertEq(inbox.nextIndex(), oldInboxIdx, "old inbox untouched");
    }

    // Zero inbox/outbox are rejected (fail-closed on a bad governance payload).
    function test_setAztecTarget_rejectsZeroAddresses() public {
        MockOutbox newOutbox = new MockOutbox();
        vm.prank(governanceTimelock);
        vm.expectRevert(TokenBridge.ZeroAddress.selector);
        bridge.setAztecTarget(uint256(2), IInbox(address(0)), IOutbox(address(newOutbox)));

        MockInbox newInbox = new MockInbox();
        vm.prank(governanceTimelock);
        vm.expectRevert(TokenBridge.ZeroAddress.selector);
        bridge.setAztecTarget(uint256(2), IInbox(address(newInbox)), IOutbox(address(0)));
    }

    // ── L20: UUPS upgrade gate coverage ──────────────────────────────────────────

    // L20a. _authorizeUpgrade is gated by GOVERNANCE_ROLE. A non-governance caller
    // (alice holds no role) must be rejected before any implementation change occurs.
    // Every other role-gated function already has a dedicated revert test (8, 9, 12,
    // 13); this closes the only gap: the most dangerous gate (controls entire TVL).
    function test_upgrade_requiresGovernanceRole() public {
        // Deploy a second implementation. The constructor calls _disableInitializers()
        // (no state change on the proxy), so deploying it here is safe.
        TokenBridge newImpl = new TokenBridge();

        // alice holds no role on the bridge — GOVERNANCE_ROLE guard must revert.
        vm.prank(alice);
        vm.expectRevert(); // OZ AccessControlUnauthorizedAccount(alice, GOVERNANCE_ROLE)
        bridge.upgradeToAndCall(address(newImpl), "");
    }

    // M19: integration test -- drive a real depositToL2Public through the bridge and
    // assert the Inbox receives the correct content hash and the L2 actor fields.
    function test_m19_deposit_feeds_correct_content_and_actor() public {
        TokenBridgeHarness h = new TokenBridgeHarness();
        // Compute expected content for the fixture's actual inputs (reuse setUp deposit args).
        bytes32 expectedContent = h.depositContent(
            bytes32(uint256(0xfeed)),
            100_000_000,
            bytes32(uint256(0xbeef)),
            DataStructures.DEPOSIT_PUBLIC_TAG
        );
        vm.startPrank(alice);
        token.approve(address(bridge), 100_000_000);
        bridge.depositToL2Public(100_000_000, bytes32(uint256(0xfeed)), bytes32(uint256(0xbeef)));
        vm.stopPrank();
        assertEq(inbox.lastContent(), expectedContent, "deposit content mismatch");
        (bytes32 recipActor, uint256 recipVersion) = inbox.lastRecipient();
        assertEq(recipActor, L2_TOKEN, "L2 target actor mismatch");
        assertEq(recipVersion, uint256(1), "L2 version mismatch"); // setUp literal, not bridge storage
    }

    // ── Deposit CEI / reentrancy: a re-entrant token cannot double-escrow ─────────
    function test_deposit_reentrancy_reverts() public {
        ReentrantToken evil = new ReentrantToken();
        // A bridge bound to the evil token.
        TokenBridge impl = new TokenBridge();
        bytes memory init = abi.encodeWithSelector(
            TokenBridge.initialize.selector,
            IERC20(address(evil)), L2_TOKEN, uint256(1),
            IInbox(address(inbox)), IOutbox(address(outbox)),
            governanceTimelock, emergencyTimelock, uint256(0)
        );
        TokenBridge evilBridge = TokenBridge(address(new ERC1967Proxy(address(impl), init)));

        bytes32 sh = bytes32(uint256(0xbeef));
        evil.setBridge(evilBridge, sh);
        evil.mint(alice, 100_000_000);
        vm.prank(alice);
        evil.approve(address(evilBridge), type(uint256).max);
        evil.arm();

        // The outer deposit triggers transferFrom, which re-enters depositToL2Public.
        // nonReentrant makes the whole outer call revert (ReentrancyGuardReentrantCall).
        vm.prank(alice);
        vm.expectRevert();
        evilBridge.depositToL2Public(50_000_000, bytes32(uint256(0xfeed)), sh);

        // No escrow, no deposit record: the attack left nothing behind.
        bytes32 trackKey = keccak256(abi.encode(alice, sh));
        (uint256 amt,,) = evilBridge.deposits(trackKey);
        assertEq(amt, 0, "no deposit record should survive the reverted re-entrancy");
        assertEq(evil.balanceOf(address(evilBridge)), 0, "no tokens escrowed");
    }

    // The happy path still works (CEI reorder didn't break a normal deposit).
    function test_deposit_recordWrittenBeforeExternalCalls() public {
        vm.startPrank(alice);
        token.approve(address(bridge), 10_000_000);
        bridge.depositToL2Public(10_000_000, bytes32(uint256(0x1)), bytes32(uint256(0x2)));
        vm.stopPrank();
        bytes32 trackKey = keccak256(abi.encode(alice, bytes32(uint256(0x2))));
        (uint256 amt,, bool isPriv) = bridge.deposits(trackKey);
        assertEq(amt, 10_000_000, "record written");
        assertEq(isPriv, false);
        assertEq(token.balanceOf(address(bridge)), 10_000_000, "escrow completed");
    }
}
