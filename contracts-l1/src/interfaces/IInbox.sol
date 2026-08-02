// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.27;

import {DataStructures} from "../lib/DataStructures.sol";

/**
 * @title  IInbox — Aztec L1→L2 message inbox interface.
 * @notice Mirrors @aztec/l1-artifacts@4.2.1 IInbox surface.
 */
interface IInbox {
    struct InboxState {
        bytes16 rollingHash;
        uint64 totalMessagesInserted;
        uint64 inProgress;
    }

    event MessageSent(uint256 indexed checkpointNumber, uint256 index, bytes32 indexed hash, bytes16 rollingHash);
    event InboxSynchronized(uint256 indexed inProgress);

    function sendL2Message(DataStructures.L2Actor memory _recipient, bytes32 _content, bytes32 _secretHash)
        external
        returns (bytes32, uint256);

    function consume(uint256 _toConsume) external returns (bytes32);

    function catchUp(uint256 _pendingCheckpointNumber) external;

    function getFeeAssetPortal() external view returns (address);

    function getRoot(uint256 _checkpointNumber) external view returns (bytes32);

    function getState() external view returns (InboxState memory);

    function getTotalMessagesInserted() external view returns (uint64);

    function getInProgress() external view returns (uint64);
}
