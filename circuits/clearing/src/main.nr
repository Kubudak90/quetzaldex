mod types;
mod binding;
mod pricing;
mod amm;
mod merkle;
mod buckets;
mod test;

use types::{
    BucketState, FillLeaf, OrderPreimagePath, PoolClearing,
    INVALID_POOL_ID, MAX_ACTIVE_BUCKETS_PER_EPOCH, MAX_ACTIVE_POOLS_PER_EPOCH,
    MAX_ORDERS_PER_EPOCH, NUM_BUCKETS,
};

// 2 * MAX_ORDERS_PER_EPOCH = 64. Spelled out as a literal because Noir 1.0-beta
// does not currently accept arithmetic on a `pub global` inside type positions.
global MAX_FILLS: u32 = 64;

fn main(
    // ===== Public inputs (123 fields after flatten) =====
    // Sub-1 binding (4)
    order_acc:    pub Field,
    cancel_acc:   pub Field,
    order_count:  pub u32,
    cancel_count: pub u32,
    // Sub-1 5d-4 Merkle settlement root (1)
    fills_root:   pub Field,
    // Sub-4 active-pool count (1)
    active_pool_count:     pub u32,
    // Sub-4 per-pool clearings (3 * 39 = 117; +token_lo/hi +pool_state_commitment)
    active_pool_clearings: pub [PoolClearing; MAX_ACTIVE_POOLS_PER_EPOCH],

    // ===== Private witnesses =====
    orders:              [OrderPreimagePath; MAX_ORDERS_PER_EPOCH],
    cancelled_indices:   [u32;               MAX_ORDERS_PER_EPOCH],
    fills:               [FillLeaf;          64],
    fills_len:           u32,
    fill_to_order_index: [u32;               64],
    pool_bucket_states_before: [[BucketState; MAX_ACTIVE_BUCKETS_PER_EPOCH]; MAX_ACTIVE_POOLS_PER_EPOCH],
    pool_bucket_states_after:  [[BucketState; MAX_ACTIVE_BUCKETS_PER_EPOCH]; MAX_ACTIVE_POOLS_PER_EPOCH],
    pool_sqrt_p_before:        [u128;        MAX_ACTIVE_POOLS_PER_EPOCH],
    pool_token_pairs:          [[Field; 2];  MAX_ACTIVE_POOLS_PER_EPOCH],
) {
    // ========================================================================
    // A. Sub-1 binding (Sub-4 hash includes path words).
    // ========================================================================
    assert(order_count <= MAX_ORDERS_PER_EPOCH, "order_count exceeds cap");
    assert(cancel_count <= order_count, "cancel_count > order_count");
    assert(fills_len <= MAX_FILLS, "fills_len exceeds cap");
    assert(active_pool_count <= MAX_ACTIVE_POOLS_PER_EPOCH, "active_pool_count > cap");

    let replayed_order_acc = binding::replay_chain_with_path(orders, order_count);
    assert(replayed_order_acc == order_acc, "order_acc replay mismatch");
    let replayed_cancel_acc =
        binding::replay_cancel_chain_with_path(orders, cancelled_indices, cancel_count, order_count);
    assert(replayed_cancel_acc == cancel_acc, "cancel_acc replay mismatch");
    let is_cancelled = binding::derive_is_cancelled(cancelled_indices, cancel_count, order_count);

    // ========================================================================
    // B. Per-fill eligibility + per-hop payout + pool resolution.
    // ========================================================================
    for f in 0..64 {
        if (f as u32) < fills_len {
            let order_idx = fill_to_order_index[f];
            assert(order_idx < order_count, "fill_to_order_index >= order_count");

            // Scan-and-pick the order (constraint-safe dynamic index).
            let mut order_j: OrderPreimagePath = orders[0];
            for k in 0..MAX_ORDERS_PER_EPOCH {
                if (k as u32) == order_idx { order_j = orders[k]; }
            }

            // Filled order must not be cancelled.
            let mut j_is_cancelled: bool = false;
            for k in 0..MAX_ORDERS_PER_EPOCH {
                if (k as u32) == order_idx { j_is_cancelled = is_cancelled[k]; }
            }
            assert(!j_is_cancelled, "filled order was cancelled");

            // Nonce binding: fill must reference the order's nonce.
            assert(fills[f].order_nonce == order_j.order_nonce, "fill nonce mismatch");

            let hop = fills[f].hop_index;
            assert((hop == 0) | (hop == 1), "invalid hop_index");
            // SETTLE-INV v1: 2-hop fills are disabled. claim_fill pays BOTH legs of a
            // 2-hop order while the intermediate is also pushed to pool1 as *_to_pool --
            // an unfixable double-spend without a claim_fill redesign. Reject any fill
            // on a 2-hop order so only 1-hop settlement is reachable.
            assert(order_j.path_len == 2, "2-hop fills disabled (SETTLE-INV v1)");
            if order_j.path_len == 2 {
                assert(hop == 0, "1-hop order has no hop=1 fill");
            }

            // Derive the canonical (token_in, token_out) for this hop.
            let token_in: Field = if hop == 0 { order_j.path[0] } else { order_j.path[1] };
            let token_out: Field = if hop == 0 { order_j.path[1] } else { order_j.path[2] };

            // Find the active pool slot whose canonical pair matches this hop's (token_in, token_out).
            // Canonical ordering uses the bottom 128 bits of the Field as the comparison key;
            // the witness builder MUST produce `pool_token_pairs` using the same convention.
            // (Noir's bin-crate Field has no `<` operator, so we can't use the contract's full-Field compare here.)
            let (lo, hi) = if (token_in as u128) < (token_out as u128) {
                (token_in, token_out)
            } else {
                (token_out, token_in)
            };
            let mut pool_slot: u32 = INVALID_POOL_ID;
            for p in 0..MAX_ACTIVE_POOLS_PER_EPOCH {
                if (p as u32) < active_pool_count {
                    let pair = pool_token_pairs[p];
                    if (pair[0] == lo) & (pair[1] == hi) {
                        pool_slot = p as u32;
                    }
                }
            }
            assert(pool_slot != INVALID_POOL_ID, "fill's hop pair not in active pools");

            // Look up clearing_price for the resolved pool slot.
            let mut p_star: u128 = 0 as u128;
            for p in 0..MAX_ACTIVE_POOLS_PER_EPOCH {
                if (p as u32) == pool_slot { p_star = active_pool_clearings[p].clearing_price; }
            }

            // 1-hop eligibility check (2-hop composite handled in block C).
            if order_j.path_len == 2 {
                assert(pricing::eligible_with_p(order_j.side, order_j.limit_price, p_star),
                       "1-hop ineligible at P");
            }

            // Per-fill payout is NO LONGER pinned to payout_at_price(P*) here. That
            // forward per-fill floor overshot the pool's real aggregate output by the
            // rounding/CoW gap and underflowed the orderbook on claim_fill (the
            // conservation bug, masked in prod by a manual float). Block C2 below pins
            // amount_out via the SETTLE-INV solvency + anti-grief invariants instead.
            assert(fills[f].pool_id == pool_slot, "fill pool_id != resolved pool slot");
        }
    }

    // ========================================================================
    // B'. Sub-5a: 1-hop DoS resistance check.
    // Every eligible non-cancelled 1-hop order MUST appear in fills[].
    // 2-hop orders are handled by block C atomicity below; this restores
    // the Sub-1 sec 6.3 DoS guarantee that was inadvertently dropped in
    // Sub-4 D2's multi-pool generalization.
    // ========================================================================
    let mut is_filled: [bool; MAX_ORDERS_PER_EPOCH] = [false; MAX_ORDERS_PER_EPOCH];
    for f in 0..64 {
        if (f as u32) < fills_len {
            let oi = fill_to_order_index[f];
            for k in 0..MAX_ORDERS_PER_EPOCH {
                if (k as u32) == oi { is_filled[k] = true; }
            }
        }
    }

    for k in 0..MAX_ORDERS_PER_EPOCH {
        if (k as u32) < order_count {
            let order_k = orders[k];
            if (order_k.path_len == 2) & (!is_cancelled[k]) {
                let (lo, hi) = if (order_k.path[0] as u128) < (order_k.path[1] as u128) {
                    (order_k.path[0], order_k.path[1])
                } else {
                    (order_k.path[1], order_k.path[0])
                };
                let mut p_slot: u32 = INVALID_POOL_ID;
                for p in 0..MAX_ACTIVE_POOLS_PER_EPOCH {
                    if (p as u32) < active_pool_count {
                        let pair = pool_token_pairs[p];
                        if (pair[0] == lo) & (pair[1] == hi) { p_slot = p as u32; }
                    }
                }
                if p_slot != INVALID_POOL_ID {
                    let mut p_star: u128 = 0 as u128;
                    for p in 0..MAX_ACTIVE_POOLS_PER_EPOCH {
                        if (p as u32) == p_slot {
                            p_star = active_pool_clearings[p].clearing_price;
                        }
                    }
                    if pricing::eligible_with_p(order_k.side, order_k.limit_price, p_star) {
                        assert(is_filled[k], "eligible 1-hop order missing from fills (DoS)");
                    }
                }
                // If pool is inactive this epoch, the 1-hop order carries forward.
            }
        }
    }

    // ========================================================================
    // C. 2-hop composite eligibility + atomicity.
    // ========================================================================
    let mut hop0_count: [u8; MAX_ORDERS_PER_EPOCH] = [0; MAX_ORDERS_PER_EPOCH];
    let mut hop1_count: [u8; MAX_ORDERS_PER_EPOCH] = [0; MAX_ORDERS_PER_EPOCH];
    for f in 0..64 {
        if (f as u32) < fills_len {
            let oi = fill_to_order_index[f];
            let h  = fills[f].hop_index;
            for k in 0..MAX_ORDERS_PER_EPOCH {
                if (k as u32) == oi {
                    if h == 0 { hop0_count[k] = hop0_count[k] + 1; }
                    else      { hop1_count[k] = hop1_count[k] + 1; }
                }
            }
        }
    }
    for k in 0..MAX_ORDERS_PER_EPOCH {
        if (k as u32) < order_count {
            let order_k = orders[k];
            if (order_k.path_len == 3) & (!is_cancelled[k]) {
                // SETTLE-INV v1: 2-hop is disabled. An eligible-or-not 2-hop order may
                // never have any leg filled (block B also rejects every 2-hop fill).
                // Atomicity is trivially preserved: zero legs is a valid "not filled".
                assert((hop0_count[k] == 0) & (hop1_count[k] == 0), "2-hop disabled");
            } else if (order_k.path_len == 2) & (!is_cancelled[k]) {
                // 1-hop multiplicity: a filled 1-hop order must have exactly one hop0
                // leg and no hop1 leg. (hop1_count is already structurally 0 here via
                // block B's "1-hop order has no hop=1 fill" assert; restated for a
                // complete circuit-level fill-multiplicity invariant.) Unfilled 1-hop
                // orders on inactive pools carry forward (no constraint).
                let filled = (hop0_count[k] != 0) | (hop1_count[k] != 0);
                if filled {
                    assert((hop0_count[k] == 1) & (hop1_count[k] == 0),
                           "1-hop needs exactly hop0");
                }
            }
        }
    }

    // ========================================================================
    // C2. SETTLE-INV: per-(pool,token) SOLVENCY + intra-group anti-grief floor.
    //
    // Replaces the old per-fill `amount_out == payout_at_price(P*)` pin (removed in
    // block B), which overshot the pool's real aggregate output by the rounding/CoW
    // gap and underflowed the orderbook on claim_fill (the conservation bug, masked
    // in prod by a manual token float). Two fee-agnostic invariants, BOTH satisfied
    // by the aggregator's conservation-exact kernel fills (computeClearing
    // distributes the true side total pro-rata, last-fill-absorbs-residual):
    //
    //   (c) SOLVENCY (per active pool, per pool token T):
    //         Sum payout_T + to_pool_T  <=  from_pool_T + escrow_T
    //       The orderbook holds escrow_T (filled makers' gross input in T) and
    //       receives from_pool_T (T out of the pool); it spends to_pool_T (T into
    //       the pool) + payouts. This guarantees claim_fill can NEVER underflow the
    //       orderbook's public balance, so the manual float is no longer needed.
    //       (M17: the 0.3% LP fee is FORWARDED to the pool -- to_pool_T is GROSS,
    //       post-fee adds + fee_rec -- so the inequality holds with only the floor
    //       round-trip dust as slack; conservation-exact kernels satisfy it exactly.)
    //
    //   (b) ANTI-GRIEF FLOOR (per fill):
    //         amount_out >= mul_div(avail_floor_T, amount_in, sum_in_group)
    //       where avail_floor_T  = avail_T - feeAllowance_T,
    //             avail_T        = from_pool_T + escrow_T - to_pool_T  (saturating),
    //             feeAllowance_T = ceil_fee_from_net(to_pool_T - fee_rec_T) - fee_rec_T
    //                              (saturating; fee_rec_T = recovered_fee, M17).
    //       Each filled maker gets at least its pro-rata share of avail_floor, so a
    //       cheating aggregator cannot underpay a filled maker by more than ~1 raw unit
    //       of its fair value.
    //
    //   WHY this allowance (SETTLE-INV floor-fix, re-based by M17): avail =
    //   from_pool + GROSS escrow - to_pool overcounts the kernel's true net payout
    //   xTotal by exactly what the orderbook retains. Pre-M17 that was the whole
    //   withheld LP fee; post-M17 the fee is FORWARDED (to_pool is GROSS = net adds
    //   + fee_rec) and the orderbook retains only the floor round-trip dust
    //   retained' = feeWithheld - fee_rec. Since feeWithheld <= ceil_fee_from_net(net)
    //   (the proven worst case over all gross->net floorings, net = to_pool - fee_rec),
    //   allowance' = ceil_fee_from_net(net) - fee_rec >= retained' -- so
    //   avail_floor_T <= xTotal_T (never bricks an honest clear) while staying ~1 raw
    //   unit above the dust (the SETTLE-INV tightness is preserved; keying the
    //   allowance off gross to_pool instead would have regressed underpay to ~0.3%).
    //   Solvency (c) bounds overpay/drain.
    //
    // a_*/token_lo and b_*/token_hi pair by the u128-canonical convention the
    // orderbook stores pool_token_a/b in (block D'' + the pool_id pair binding in
    // _apply_verified_clearing). 2-hop is disabled (block B asserts path_len==2), so
    // every fill is one hop: bid output=path[1] in=path[0]; ask output=path[0]
    // in=path[1] (mirrors claim_fill's output-token derivation in the orderbook).
    // A fill receiving token_lo escrows token_hi and vice-versa, so escrow_lo
    // (token_lo escrowed) == Sum amount_in of token_hi receivers (sum_hi), and v.v.
    // ========================================================================
    let mut pay_lo: [u128; MAX_ACTIVE_POOLS_PER_EPOCH] = [0 as u128; MAX_ACTIVE_POOLS_PER_EPOCH];
    let mut pay_hi: [u128; MAX_ACTIVE_POOLS_PER_EPOCH] = [0 as u128; MAX_ACTIVE_POOLS_PER_EPOCH];
    let mut sum_lo: [u128; MAX_ACTIVE_POOLS_PER_EPOCH] = [0 as u128; MAX_ACTIVE_POOLS_PER_EPOCH];
    let mut sum_hi: [u128; MAX_ACTIVE_POOLS_PER_EPOCH] = [0 as u128; MAX_ACTIVE_POOLS_PER_EPOCH];
    for f in 0..64 {
        if (f as u32) < fills_len {
            let order_idx = fill_to_order_index[f];
            let mut order_f: OrderPreimagePath = orders[0];
            for k in 0..MAX_ORDERS_PER_EPOCH {
                if (k as u32) == order_idx { order_f = orders[k]; }
            }
            // 1-hop output token (path_len == 2 enforced in block B). Mirrors
            // claim_fill: ask (side=true) receives path[0]; bid (side=false) path[1].
            let out_token: Field = if order_f.side { order_f.path[0] } else { order_f.path[1] };
            let in_amt: u128 = order_f.amount_in;
            let pslot: u32 = fills[f].pool_id; // == resolved slot (block B asserts pool_id == pool_slot)
            for p in 0..MAX_ACTIVE_POOLS_PER_EPOCH {
                if (p as u32) == pslot {
                    if out_token == active_pool_clearings[p].token_lo {
                        pay_lo[p] = pay_lo[p] + fills[f].amount_out;
                        sum_lo[p] = sum_lo[p] + in_amt;
                    } else {
                        pay_hi[p] = pay_hi[p] + fills[f].amount_out;
                        sum_hi[p] = sum_hi[p] + in_amt;
                    }
                }
            }
        }
    }

    // (c) SOLVENCY per active pool, per token. escrow_lo == sum_hi, escrow_hi == sum_lo.
    for p in 0..MAX_ACTIVE_POOLS_PER_EPOCH {
        if (p as u32) < active_pool_count {
            assert(
                pricing::token_solvent(
                    pay_lo[p], active_pool_clearings[p].swap.a_to_pool,
                    active_pool_clearings[p].swap.a_from_pool, sum_hi[p],
                ),
                "token_lo solvency",
            );
            assert(
                pricing::token_solvent(
                    pay_hi[p], active_pool_clearings[p].swap.b_to_pool,
                    active_pool_clearings[p].swap.b_from_pool, sum_lo[p],
                ),
                "token_hi solvency",
            );
        }
    }

    // avail_floor_T = (from_pool_T + escrow_T - to_pool_T) - feeAllowance_T, with
    // feeAllowance_T = saturating_sub(ceil_fee_from_net(net_T), fee_rec_T) and
    // net_T = saturating_sub(to_pool_T, fee_rec_T) -- M17: to_pool is GROSS, the fee
    // is forwarded, and the orderbook retains only the floor round-trip dust
    // (feeWithheld - fee_rec). ceil_fee_from_net(net) >= feeWithheld for every input,
    // so feeAllowance_T >= the dust and avail_floor_T <= the kernel's true net payout
    // xTotal_T -- the floor (b) below never bricks honest CoW (one-sided OR thin
    // asymmetric) while keeping underpay bounded to ~1 raw unit.
    let mut avail_floor_lo: [u128; MAX_ACTIVE_POOLS_PER_EPOCH] = [0 as u128; MAX_ACTIVE_POOLS_PER_EPOCH];
    let mut avail_floor_hi: [u128; MAX_ACTIVE_POOLS_PER_EPOCH] = [0 as u128; MAX_ACTIVE_POOLS_PER_EPOCH];
    for p in 0..MAX_ACTIVE_POOLS_PER_EPOCH {
        if (p as u32) < active_pool_count {
            let avail_lo = pricing::saturating_sub(
                active_pool_clearings[p].swap.a_from_pool + sum_hi[p],
                active_pool_clearings[p].swap.a_to_pool,
            );
            let avail_hi = pricing::saturating_sub(
                active_pool_clearings[p].swap.b_from_pool + sum_lo[p],
                active_pool_clearings[p].swap.b_to_pool,
            );
            // M17: to_pool is GROSS (net adds + forwarded fee), so retained is only
            // the floor round-trip dust feeWithheld - fee_rec. allowance' =
            // ceil_fee_from_net(net) - fee_rec (saturating, net = to_pool - fee_rec)
            // covers that dust for every input (test m17_fee_allowance_covers_dust_
            // after_forwarding) while keeping the floor's ~1-raw-unit tightness --
            // reusing the OLD gross-keyed formula here would have silently regressed
            // the underpay bound back to ~0.3%.
            let (fee_rec_lo, fee_rec_hi) = crate::buckets::recovered_fee(
                pool_bucket_states_before[p],
                active_pool_clearings[p].swap.active_bucket_deltas,
            );
            let net_lo = pricing::saturating_sub(
                active_pool_clearings[p].swap.a_to_pool, fee_rec_lo);
            let net_hi = pricing::saturating_sub(
                active_pool_clearings[p].swap.b_to_pool, fee_rec_hi);
            let fee_lo = pricing::saturating_sub(pricing::ceil_fee_from_net(net_lo), fee_rec_lo);
            let fee_hi = pricing::saturating_sub(pricing::ceil_fee_from_net(net_hi), fee_rec_hi);
            avail_floor_lo[p] = pricing::saturating_sub(avail_lo, fee_lo);
            avail_floor_hi[p] = pricing::saturating_sub(avail_hi, fee_hi);
        }
    }

    // (b) ANTI-GRIEF FLOOR: each fill gets >= its pro-rata share of avail_floor.
    for f in 0..64 {
        if (f as u32) < fills_len {
            let order_idx = fill_to_order_index[f];
            let mut order_f: OrderPreimagePath = orders[0];
            for k in 0..MAX_ORDERS_PER_EPOCH {
                if (k as u32) == order_idx { order_f = orders[k]; }
            }
            let out_token: Field = if order_f.side { order_f.path[0] } else { order_f.path[1] };
            let in_amt: u128 = order_f.amount_in;
            let pslot: u32 = fills[f].pool_id;
            let mut floor_base: u128 = 0 as u128;
            let mut sum_group: u128 = 0 as u128;
            for p in 0..MAX_ACTIVE_POOLS_PER_EPOCH {
                if (p as u32) == pslot {
                    if out_token == active_pool_clearings[p].token_lo {
                        floor_base = avail_floor_lo[p];
                        sum_group = sum_lo[p];
                    } else {
                        floor_base = avail_floor_hi[p];
                        sum_group = sum_hi[p];
                    }
                }
            }
            assert(sum_group != 0 as u128, "settle: empty receive group");
            // Floor each maker at its pro-rata share of avail_floor (a fee-discounted
            // lower bound on the kernel payout): bounds underpay to ~0.3% without
            // bricking honest CoW (avail itself overcounts the CoW fee; see header).
            let fshare = pricing::floor_share(floor_base, in_amt, sum_group);
            assert(fills[f].amount_out >= fshare, "fill below pro-rata floor share");
        }
    }

    // ========================================================================
    // D. Per-pool Sub-2.5 bucket evolution.
    // ========================================================================
    for p in 0..MAX_ACTIVE_POOLS_PER_EPOCH {
        if (p as u32) < active_pool_count {
            let pc = active_pool_clearings[p];
            let mut sqrt_p_chain: u128 = pool_sqrt_p_before[p];
            for k in 0..MAX_ACTIVE_BUCKETS_PER_EPOCH {
                let d = pc.swap.active_bucket_deltas[k];
                if d.bucket_id < NUM_BUCKETS {
                    sqrt_p_chain = crate::buckets::assert_bucket_step(
                        pool_bucket_states_before[p][k],
                        pool_bucket_states_after[p][k],
                        d,
                        sqrt_p_chain,
                    );
                }
            }
            assert(sqrt_p_chain == pc.swap.current_sqrt_price_after,
                   "pool sqrt_p chain != current_sqrt_price_after");
            // H12: bound this pool's total minted fee-per-share to the fee collected.
            crate::buckets::assert_pool_fee_conservation(
                pool_bucket_states_before[p],
                pc.swap.active_bucket_deltas,
                pc.swap.a_to_pool,
                pc.swap.b_to_pool,
            );
        }
    }

    // ========================================================================
    // D'. #1: bind each active pool's emitted commitment to its priced
    // before-state. The contract recomputes this from LIVE state (Task 5) and
    // reverts on mismatch, so a fabricated before-state cannot drain a pool.
    // ========================================================================
    for p in 0..MAX_ACTIVE_POOLS_PER_EPOCH {
        if (p as u32) < active_pool_count {
            // #1 (soundness): bind active_bucket_count to the actual active slots
            // so the commitment's cutoff cannot be under-reported. Slot i is active
            // (i < count) IFF it carries a real bucket_id (< NUM_BUCKETS). Padding
            // slots use bucket_id 0xffff (>= NUM_BUCKETS); see aggregator
            // clearing-cycle.ts. This also aligns block D's `bucket_id < NUM_BUCKETS`
            // processing cutoff with the commitment/pool-apply `active_bucket_count` cutoff.
            let abc = active_pool_clearings[p].swap.active_bucket_count;
            for i in 0..MAX_ACTIVE_BUCKETS_PER_EPOCH {
                let is_active = (i as u32) < abc;
                let has_real_bucket =
                    active_pool_clearings[p].swap.active_bucket_deltas[i].bucket_id < NUM_BUCKETS;
                assert(is_active == has_real_bucket,
                       "active_bucket_count != active bucket slots");
            }
            let expected = crate::buckets::pool_state_commitment(
                pool_sqrt_p_before[p],
                pool_bucket_states_before[p],
                active_pool_clearings[p].swap.active_bucket_deltas,
                active_pool_clearings[p].swap.active_bucket_count,
            );
            assert(active_pool_clearings[p].swap.pool_state_commitment == expected,
                   "pool_state_commitment mismatch");
        }
    }

    // ========================================================================
    // D''. #3: expose the priced canonical pair per active pool as a public,
    // proof-bound value. Block B already matched each hop's (lo,hi) against
    // pool_token_pairs[p]; here we bind the PUBLIC token_lo/token_hi to it so
    // the orderbook (Task 7) can assert the registry pool selected by pc.pool_id
    // actually holds this pair.
    // ========================================================================
    for p in 0..MAX_ACTIVE_POOLS_PER_EPOCH {
        if (p as u32) < active_pool_count {
            assert(active_pool_clearings[p].token_lo == pool_token_pairs[p][0],
                   "token_lo != pool_token_pairs[p][0]");
            assert(active_pool_clearings[p].token_hi == pool_token_pairs[p][1],
                   "token_hi != pool_token_pairs[p][1]");
        }
    }

    // ========================================================================
    // E. Merkle fills_root over hop-fill leaves (64-leaf tree).
    // ========================================================================
    let mut leaves: [Field; 64] = [0; 64];
    for i in 0..64 {
        if (i as u32) < fills_len {
            // R1: bind the filled order's OWNER into the leaf. The owner is looked up
            // from the order this fill maps to (fill_to_order_index, already asserted
            // < order_count). orders[].owner is part of each order's c_i, so it is
            // bound to the on-chain order_acc -- a malicious prover cannot substitute
            // a different owner. The contract recomputes the leaf with msg_sender, so
            // only the real maker can claim.
            let order_idx = fill_to_order_index[i];
            let mut fill_owner: Field = orders[0].owner;
            for k in 0..MAX_ORDERS_PER_EPOCH {
                if (k as u32) == order_idx { fill_owner = orders[k].owner; }
            }
            leaves[i] = crate::merkle::hop_fill_leaf(
                fill_owner, fills[i].order_nonce, fills[i].hop_index, fills[i].amount_out, fills[i].pool_id);
        } else {
            leaves[i] = crate::merkle::hop_fill_leaf(0 as Field, 0 as Field, 0 as u8, 0 as u128, 0 as u32);
        }
    }
    let computed_root = crate::merkle::merkle_root_64(leaves);
    assert(computed_root == fills_root, "fills_root mismatch");
}
