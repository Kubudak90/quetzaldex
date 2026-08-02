// Shared types for the Quetzal clearing circuit. Matches:
// - contracts/pool/src/main.nr's ClearingSwap (10 u128 fields).
// - contracts/orderbook/src/main.nr's FillEntry (order_nonce + amount_out).
// - contracts/orderbook/src/main.nr's OrderNote (the per-order preimage).

pub global MAX_ORDERS_PER_EPOCH: u32 = 32;

/// Aggregator's per-order payout (public input to the circuit).
pub struct FillEntry {
    pub order_nonce: Field,
    pub amount_out: u128,
}

/// Sub-2.5: the aggregate flow + sparse per-bucket delta the orderbook applies
/// to the LiquidityPool. 34 fields: 4 aggregate flows + sqrt_p_after + bucket_count
/// + 4 BucketDelta (7 fields each = 28).
pub struct ClearingSwap {
    pub a_to_pool:                u128,
    pub b_to_pool:                u128,
    pub a_from_pool:              u128,
    pub b_from_pool:              u128,
    pub current_sqrt_price_after: u128,
    pub pool_state_commitment:    Field,
    pub active_bucket_count:      u32,
    pub active_bucket_deltas:     [BucketDelta; MAX_ACTIVE_BUCKETS_PER_EPOCH],
}

/// One submitted order's preimage; the private witness has [OrderPreimage; 32].
pub struct OrderPreimage {
    pub side:               bool,
    pub amount_in:          u128,
    pub limit_price:        u128,
    pub order_nonce:        Field,
    pub submitted_at_block: u32,
    pub owner:              Field,
}

// ============================================================================
// Sub-2: Concentrated-liquidity bucket types.
// ============================================================================

/// Sub-2: a single bucket's immutable price bounds.
pub struct BucketBounds {
    pub sqrt_lower: u128,  // sqrt(P_lower), 1e18-scaled Q-format
    pub sqrt_upper: u128,  // sqrt(P_upper), 1e18-scaled Q-format
}

/// Sub-2: per-bucket runtime state.
pub struct BucketState {
    pub reserve_a: u128,
    pub reserve_b: u128,
    pub liquidity: u128,
    pub cum_fee_a_per_share: u128,
    pub cum_fee_b_per_share: u128,
}

/// Sub-2: sparse per-bucket delta emitted by the clearing circuit.
pub struct BucketDelta {
    pub bucket_id: u32,
    pub reserve_a_add: u128,
    pub reserve_a_sub: u128,
    pub reserve_b_add: u128,
    pub reserve_b_sub: u128,
    pub cum_fee_a_per_share_increment: u128,
    pub cum_fee_b_per_share_increment: u128,
}

/// Sub-2: number of buckets (deploy-time constant).
pub global NUM_BUCKETS: u32 = 16;
/// Sub-2: maximum buckets touched by a single clearing.
pub global MAX_ACTIVE_BUCKETS_PER_EPOCH: u32 = 4;

// ============================================================================
// Sub-4: Multi-pair routing types.
// ============================================================================

/// Sub-4: cap on pools touched per clearing.
pub global MAX_ACTIVE_POOLS_PER_EPOCH: u32 = 3;
/// Sub-4: padding sentinel for unused pool slots (matches contracts/orderbook).
pub global INVALID_POOL_ID: u32 = 0xFFFFFFFF;

/// Sub-4: per-pool clearing payload. Matches contracts/orderbook PoolClearing.
pub struct PoolClearing {
    pub pool_id: u32,
    pub clearing_price: u128,
    pub token_lo: Field,
    pub token_hi: Field,
    pub swap: ClearingSwap,    // 34-field Sub-2.5 carryover
}

/// Sub-4: per-hop fill leaf used in the 64-leaf Merkle tree.
pub struct FillLeaf {
    pub order_nonce: Field,
    pub hop_index: u8,
    pub amount_out: u128,
    pub pool_id: u32,
}

/// Sub-4: order preimage with explicit path.
pub struct OrderPreimagePath {
    pub side: bool,
    pub amount_in: u128,
    pub limit_price: u128,
    pub order_nonce: Field,
    pub submitted_at_block: u32,
    pub owner: Field,
    pub path_len: u8,
    pub path: [Field; 3],
}
