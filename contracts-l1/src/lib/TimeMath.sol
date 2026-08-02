// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.27;

/// @notice Minimal mirror of @aztec/l1-artifacts@4.2.1 shared/libraries/TimeMath.sol.
///         Only `Epoch` is consumed by the IOutbox interface; we mirror the user-defined
///         value type so our portal calldata matches the rollup's expected shape.
type Timestamp is uint256;
type Slot is uint256;
type Epoch is uint256;
