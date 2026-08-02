//! Week 5d-4: Merkle settlement root over the 32-slot fills array.
//!
//! Mirrors the contract-side claim_fill verifier and the JS-side
//! `aggregator/src/merkle.ts` bit-for-bit. Leaf := poseidon2([order_nonce, amount_out as Field]).
//! Empty slots use leaf = poseidon2([0, 0]); order_nonce 0 is reserved as the empty sentinel
//! and a real submission must never use it (asserted at submit_order time by the contract).

use crate::types::MAX_ORDERS_PER_EPOCH;

/// Hash one fill slot to its Merkle leaf.
pub fn fill_leaf(order_nonce: Field, amount_out: u128) -> Field {
    poseidon::poseidon2::Poseidon2::hash([order_nonce, amount_out as Field], 2)
}

/// Compute the root of a depth-5 Merkle tree over `leaves` using Poseidon2.
/// Caller passes already-hashed leaves (use `fill_leaf` per slot, including empty slots).
pub fn merkle_root_32(leaves: [Field; MAX_ORDERS_PER_EPOCH]) -> Field {
    // Explicit per-level unroll to avoid dead constraint gates that the
    // single-loop `for i in 0..16 { if (i as u32) < half }` form would emit
    // in rounds 2-5 (where half < 16). Each level halves the active width.

    // Level 0: 32 leaves -> 16 nodes.
    let mut level1: [Field; 16] = [0; 16];
    for i in 0..16 {
        level1[i] = poseidon::poseidon2::Poseidon2::hash(
            [leaves[2 * i], leaves[2 * i + 1]],
            2,
        );
    }
    // Level 1: 16 -> 8.
    let mut level2: [Field; 8] = [0; 8];
    for i in 0..8 {
        level2[i] = poseidon::poseidon2::Poseidon2::hash(
            [level1[2 * i], level1[2 * i + 1]],
            2,
        );
    }
    // Level 2: 8 -> 4.
    let mut level3: [Field; 4] = [0; 4];
    for i in 0..4 {
        level3[i] = poseidon::poseidon2::Poseidon2::hash(
            [level2[2 * i], level2[2 * i + 1]],
            2,
        );
    }
    // Level 3: 4 -> 2.
    let mut level4: [Field; 2] = [0; 2];
    for i in 0..2 {
        level4[i] = poseidon::poseidon2::Poseidon2::hash(
            [level3[2 * i], level3[2 * i + 1]],
            2,
        );
    }
    // Level 4: 2 -> 1 (the root).
    poseidon::poseidon2::Poseidon2::hash([level4[0], level4[1]], 2)
}

// ============================================================================
// Sub-4: 64-leaf hop-fill Merkle tree.
// ============================================================================

/// Sub-4 + R1: hop-fill leaf = poseidon2([owner, order_nonce, hop_index, amount_out, pool_id]).
/// `owner` is the filled maker's address as a Field. It is bound into the leaf so the
/// contract's claim_fill (which recomputes the leaf with owner = msg_sender) can only be
/// satisfied by the real maker -- this closes cross-maker theft. MUST stay byte-identical
/// to aggregator/src/merkle.ts::buildHopFillsTree and the contract claim_fill leaf.
pub fn hop_fill_leaf(owner: Field, nonce: Field, hop_index: u8, amount_out: u128, pool_id: u32) -> Field {
    poseidon::poseidon2::Poseidon2::hash(
        [owner, nonce, hop_index as Field, amount_out as Field, pool_id as Field],
        5,
    )
}

/// Sub-4: 64-leaf Merkle reduction. Explicit per-level unroll mirrors merkle_root_32
/// to avoid the dead-gate emission pattern of a single guarded loop. 6 levels:
/// 64 -> 32 -> 16 -> 8 -> 4 -> 2 -> 1.
pub fn merkle_root_64(leaves: [Field; 64]) -> Field {
    // Level 0: 64 leaves -> 32 nodes.
    let mut level1: [Field; 32] = [0; 32];
    for i in 0..32 {
        level1[i] = poseidon::poseidon2::Poseidon2::hash(
            [leaves[2 * i], leaves[2 * i + 1]],
            2,
        );
    }
    // Level 1: 32 -> 16.
    let mut level2: [Field; 16] = [0; 16];
    for i in 0..16 {
        level2[i] = poseidon::poseidon2::Poseidon2::hash(
            [level1[2 * i], level1[2 * i + 1]],
            2,
        );
    }
    // Level 2: 16 -> 8.
    let mut level3: [Field; 8] = [0; 8];
    for i in 0..8 {
        level3[i] = poseidon::poseidon2::Poseidon2::hash(
            [level2[2 * i], level2[2 * i + 1]],
            2,
        );
    }
    // Level 3: 8 -> 4.
    let mut level4: [Field; 4] = [0; 4];
    for i in 0..4 {
        level4[i] = poseidon::poseidon2::Poseidon2::hash(
            [level3[2 * i], level3[2 * i + 1]],
            2,
        );
    }
    // Level 4: 4 -> 2.
    let mut level5: [Field; 2] = [0; 2];
    for i in 0..2 {
        level5[i] = poseidon::poseidon2::Poseidon2::hash(
            [level4[2 * i], level4[2 * i + 1]],
            2,
        );
    }
    // Level 5: 2 -> 1 (root).
    poseidon::poseidon2::Poseidon2::hash([level5[0], level5[1]], 2)
}
