// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.27;

/**
 * @title Data Structures Library
 * @notice Mirrors @aztec/l1-artifacts@4.2.1 DataStructures + adds Quetzal Sub-5b
 *         domain-separator tag constants for the four bridge flow content hashes.
 */
library DataStructures {
    struct L1Actor {
        address actor;
        uint256 chainId;
    }

    struct L2Actor {
        bytes32 actor;
        uint256 version;
    }

    struct L1ToL2Msg {
        L1Actor sender;
        L2Actor recipient;
        bytes32 content;
        bytes32 secretHash;
        uint256 index;
    }

    struct L2ToL1Msg {
        L2Actor sender;
        L1Actor recipient;
        bytes32 content;
    }

    /// @notice Quetzal Sub-5b domain-separation tags for the four bridge flow
    ///         content hashes. MUST be kept in sync byte-for-byte with
    ///         contracts/token/src/main.nr globals DEPOSIT_PUBLIC_TAG /
    ///         DEPOSIT_PRIVATE_TAG / WITHDRAW_PUBLIC_TAG / WITHDRAW_PRIVATE_TAG.
    ///         The L1 portal commits these values + the L2 Token reconstructs
    ///         the matching content hash via sha256_to_field.
    ///
    ///         Values are ASCII-padded labels ("ZSWAP_DP_" / "ZSWAP_WD_") with a
    ///         1-byte discriminant packed into the low 10 bytes, zero-prefixed so
    ///         all values fit in BN254 field. The leading zero bytes guarantee
    ///         field-element fit (value < BN254 modulus).
    bytes32 internal constant DEPOSIT_PUBLIC_TAG   = bytes32(uint256(0x000000000000000000000000000000000000000000005a535741505f44505f01));
    bytes32 internal constant DEPOSIT_PRIVATE_TAG  = bytes32(uint256(0x000000000000000000000000000000000000000000005a535741505f44505f02));
    bytes32 internal constant WITHDRAW_PUBLIC_TAG  = bytes32(uint256(0x000000000000000000000000000000000000000000005a535741505f57445f03));
    /// @notice WITHDRAW_PRIVATE_TAG — used by L2 exit_to_l1_private and consumed by
    ///         L1 TokenBridge.withdrawPrivate. Distinct from WITHDRAW_PUBLIC_TAG so
    ///         the two flows produce non-colliding content hashes; an exit emitted
    ///         with the private tag CANNOT be replayed against the public withdraw
    ///         function (different content hash).
    bytes32 internal constant WITHDRAW_PRIVATE_TAG = bytes32(uint256(0x000000000000000000000000000000000000000000005a535741505f57445f04));
}
