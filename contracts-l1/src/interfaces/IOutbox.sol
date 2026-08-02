// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.27;

import {DataStructures} from "../lib/DataStructures.sol";
import {Epoch} from "../lib/TimeMath.sol";

/**
 * @title  IOutbox — Aztec L2→L1 message outbox interface.
 * @notice Mirrors aztec-packages v5.0.0-rc.2 IOutbox surface: the epoch's
 *         out-hash tree is now progressive per checkpoint, so insert/consume/
 *         getRootData carry `numCheckpointsInEpoch` and roots are stored per
 *         checkpoint-count (keyed by `numCheckpointsInEpoch - 1`).
 */
interface IOutbox {
    /// v5 upstream bound for the per-epoch roots array (ConstantsGen.sol).
    /// Declared here as a named constant is not allowed in interfaces; see
    /// MAX_CHECKPOINTS_PER_EPOCH = 32 wherever getRoots() is decoded off-chain.
    event RootAdded(Epoch indexed epoch, uint256 indexed numCheckpointsInEpoch, bytes32 root);
    event MessageConsumed(Epoch indexed epoch, bytes32 indexed root, bytes32 indexed messageHash, uint256 leafId);

    function insert(Epoch _epoch, uint256 _numCheckpointsInEpoch, bytes32 _root) external;

    function consume(
        DataStructures.L2ToL1Msg calldata _message,
        Epoch _epoch,
        uint256 _numCheckpointsInEpoch,
        uint256 _leafIndex,
        bytes32[] calldata _path
    ) external;

    function hasMessageBeenConsumedAtEpoch(Epoch _epoch, uint256 _leafId) external view returns (bool);

    function getRootData(Epoch _epoch, uint256 _numCheckpointsInEpoch) external view returns (bytes32);

    function getRoots(Epoch _epoch) external view returns (bytes32[32] memory);
}
