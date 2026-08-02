use aztec::macros::aztec;

#[aztec]
pub contract LiquidityPool {
    use aztec::{
        macros::{
            functions::{external, initializer, only_self},
            notes::note,
            storage::storage,
        },
        messages::delivery::MessageDelivery,
        note::{
            constants::MAX_NOTES_PER_PAGE,
            note_getter_options::NoteGetterOptions,
            note_interface::NoteProperties,
            note_viewer_options::NoteViewerOptions,
        },
        protocol::{
            address::AztecAddress,
            hash::poseidon2_hash,
            traits::{Deserialize, FromField, Packable, Serialize},
        },
        state_vars::{Map, Owned, PrivateSet, PublicImmutable, PublicMutable},
        utils::comparison::Comparator,
    };

    use token::Token;

    /// Fixed-point scale for the MasterChef cumulative-fee-per-share counters.
    global FEE_SCALE: u128 = 1_000_000_000_000_000_000;

    /// Unconstrained hint: computes `floor(sqrt(x))` by binary search. Its result is
    /// NOT trusted - `integer_sqrt` constrains it.
    #[contract_library_method]
    unconstrained fn sqrt_hint(x: u128) -> u128 {
        if x < 2 as u128 {
            x
        } else {
            let mut lo: u128 = 1 as u128;
            let mut hi: u128 = x;
            // 128 iterations is enough to converge for any u128 input.
            for _ in 0..128 {
                if lo < hi {
                    let mid = lo + (hi - lo + 1 as u128) / 2 as u128;
                    // mid <= x / mid  is  mid*mid <= x  without overflowing.
                    if mid <= x / mid {
                        lo = mid;
                    } else {
                        hi = mid - 1 as u128;
                    }
                }
            }
            lo
        }
    }

    /// `floor(sqrt(x))`, constrained. Returns the largest `s` with `s*s <= x`.
    ///
    /// Verification avoids forming `(s+1)*(s+1)` (which can overflow u128 for the
    /// largest inputs): `x < (s+1)^2` is equivalent to `x - s*s <= 2*s`.
    #[contract_library_method]
    pub fn integer_sqrt(x: u128) -> u128 {
        // Safety: `s` is verified to be floor(sqrt(x)) by the two asserts below.
        let s = unsafe { sqrt_hint(x) };
        let sq = s * s;
        assert(sq <= x, "integer_sqrt: hint too large");
        assert(x - sq <= 2 as u128 * s, "integer_sqrt: hint too small");
        s
    }

    /// Sub-2: PoolState collapses to (reserves cache + current_sqrt_price).
    /// Per-bucket liquidity + cum_fee accounting moves into BucketState.
    #[derive(Deserialize, Eq, Packable, Serialize)]
    pub struct PoolState {
        pub reserve_a: u128,           // cached sum across buckets
        pub reserve_b: u128,           // cached sum across buckets
        pub current_sqrt_price: u128,  // global pool sqrt_P; drives bucket activation
    }

    /// Sub-2: per-bucket runtime state. 16 of these in storage as
    /// Map<u32, PublicMutable<BucketState>>.
    #[derive(Deserialize, Eq, Packable, Serialize)]
    pub struct BucketState {
        pub reserve_a: u128,
        pub reserve_b: u128,
        pub liquidity: u128,
        pub cum_fee_a_per_share: u128,
        pub cum_fee_b_per_share: u128,
    }

    /// Sub-2: number of buckets (deploy-time constant).
    pub global NUM_BUCKETS: u32 = 16;
    /// Sub-2: maximum buckets touched in a single clearing.
    pub global MAX_ACTIVE_BUCKETS_PER_EPOCH: u32 = 4;
    // FEE_SCALE already defined at line 29 (kept from Sub-1).

    /// Private note representing one LP position. Sub-2 adds `bucket_id`.
    #[derive(Deserialize, Eq, Packable, Serialize)]
    #[note]
    pub struct PositionNote {
        pub bucket_id: u32,
        pub lp_share: u128,
        pub cum_fee_a_per_share_at_deposit: u128,
        pub cum_fee_b_per_share_at_deposit: u128,
        pub nonce: Field,
        pub owner: AztecAddress,
    }

    /// Sub-2: sparse per-bucket delta the orderbook hands to apply_clearing.
    #[derive(Deserialize, Eq, Packable, Serialize)]
    pub struct BucketDelta {
        pub bucket_id: u32,
        pub reserve_a_add: u128,
        pub reserve_a_sub: u128,
        pub reserve_b_add: u128,
        pub reserve_b_sub: u128,
        pub cum_fee_a_per_share_increment: u128,
        pub cum_fee_b_per_share_increment: u128,
    }

    /// Sub-2: clearing swap relayed by the orderbook to the pool.
    /// Aggregate flows + sparse per-bucket deltas (MAX_ACTIVE_BUCKETS_PER_EPOCH=4).
    #[derive(Deserialize, Eq, Packable, Serialize)]
    pub struct ClearingSwap {
        pub a_to_pool: u128,
        pub b_to_pool: u128,
        pub a_from_pool: u128,
        pub b_from_pool: u128,
        pub active_bucket_deltas: [BucketDelta; 4],
        pub active_bucket_count: u32,
        pub current_sqrt_price_after: u128,
        pub pool_state_commitment: Field,
    }

    #[storage]
    struct Storage<Context> {
        positions: Owned<PrivateSet<PositionNote, Context>, Context>,
        pool_state: PublicMutable<PoolState, Context>,
        token_a_addr: PublicImmutable<AztecAddress, Context>,
        token_b_addr: PublicImmutable<AztecAddress, Context>,
        orderbook_addr: PublicMutable<AztecAddress, Context>,
        /// Sub-Audit-#3: deploy-time admin authorized to wire the orderbook
        /// via the one-shot `set_orderbook` setter. Prevents front-running the
        /// post-deploy wiring with an attacker-controlled orderbook address.
        admin: PublicImmutable<AztecAddress, Context>,
        /// Sub-2: p_min and growth let us derive bucket bounds on demand
        /// (avoids storing a [BucketBounds; 16] PublicImmutable, which is
        /// awkward with aztec-nr 4.2.0's serialization).
        p_min_sqrt: PublicImmutable<u128, Context>,
        bucket_growth_num: PublicImmutable<u128, Context>,
        /// Sub-2: per-bucket state. Keyed by bucket_id in 0..NUM_BUCKETS.
        buckets: Map<u32, PublicMutable<BucketState, Context>, Context>,
        /// M17 (fee pot): forwarded LP fees per bucket, held OUTSIDE BucketState so
        /// they are never claimable as pro-rata principal (final-review C1). Withdraw
        /// pays `earned` from here, capped at the pot balance.
        fee_pot_a: Map<u32, PublicMutable<u128, Context>, Context>,
        fee_pot_b: Map<u32, PublicMutable<u128, Context>, Context>,
    }

    /// Sub-2 deploy-time initializer.
    /// - p_min_sqrt: sqrt(P_min), 1e18-scaled (lower bound of bucket 0)
    /// - bucket_growth_num: per-bucket sqrt-multiplier, 1e18-scaled
    ///   (e.g., 1.5e18 = 1.5x sqrt growth, equivalent to 2.25x price growth per bucket)
    #[external("public")]
    #[initializer]
    fn constructor(
        token_a: AztecAddress,
        token_b: AztecAddress,
        p_min_sqrt: u128,
        bucket_growth_num: u128,
        admin: AztecAddress,
    ) {
        self.storage.token_a_addr.initialize(token_a);
        self.storage.token_b_addr.initialize(token_b);
        self.storage.p_min_sqrt.initialize(p_min_sqrt);
        self.storage.bucket_growth_num.initialize(bucket_growth_num);
        self.storage.admin.initialize(admin);
        self.storage.pool_state.write(PoolState {
            reserve_a: 0 as u128,
            reserve_b: 0 as u128,
            current_sqrt_price: p_min_sqrt,
        });
        self.storage.orderbook_addr.write(AztecAddress::from_field(0));
        // bucket states default to all-zero (Map default).
    }

    // ============================ CLEARING WIRING ============================

    /// One-shot setter for the OrderbookContract address. The Pool is deployed
    /// before the Orderbook, so the address is wired in post-deploy. Settable
    /// exactly once (the stored value starts at the zero address), so it cannot
    /// be re-pointed later.
    #[external("public")]
    fn set_orderbook(orderbook: AztecAddress) {
        // Audit-#3: gate the wiring to the deploy-time admin. Without this, an
        // attacker could front-run the legitimate wiring with a malicious
        // orderbook address and drain the pool via apply_clearing.
        let admin = self.storage.admin.read();
        assert(self.msg_sender() == admin, "only admin may set orderbook");
        let current = self.storage.orderbook_addr.read();
        assert(current == AztecAddress::from_field(0), "orderbook already set");
        self.storage.orderbook_addr.write(orderbook);
    }

    /// Helper: compute bucket bounds from the stored p_min_sqrt + growth_num.
    /// sqrt_lower[bucket_id] = p_min_sqrt * (growth_num/SCALE)^bucket_id.
    /// sqrt_upper[bucket_id] = sqrt_lower[bucket_id] * growth_num/SCALE.
    #[contract_library_method]
    fn compute_bucket_bounds(p_min_sqrt: u128, growth_num: u128, bucket_id: u32) -> (u128, u128) {
        let mut sqrt_lower = p_min_sqrt;
        for i in 0..16 {
            if (i as u32) < bucket_id {
                sqrt_lower = sqrt_lower * growth_num / FEE_SCALE;
            }
        }
        let sqrt_upper = sqrt_lower * growth_num / FEE_SCALE;
        (sqrt_lower, sqrt_upper)
    }

    /// Sub-2 apply_clearing. Iterates active_bucket_deltas[0..count] applying
    /// per-bucket reserve adds/subs + fee-per-share increments. Underflow-
    /// guarded. Updates global PoolState aggregate cache + current_sqrt_price.
    /// Token movements: the orderbook pushes *_to_pool (trader inputs) INTO
    /// this pool BEFORE calling apply_clearing (audit #2 conservation fix).
    /// Outbound transfers (*_from_pool, pool->orderbook) are executed inside
    /// this function so the pool is both the `from` and the auth source.
    #[external("public")]
    fn apply_clearing(swap: ClearingSwap) {
        let orderbook = self.storage.orderbook_addr.read();
        assert(self.msg_sender() == orderbook, "not the orderbook");

        // #1: bind the applied deltas to LIVE pool state. Field order MUST match
        // circuits/clearing/src/buckets.nr::pool_state_commitment EXACTLY (25 elems,
        // [sqrt_p_before, (bucket_id, reserve_a, reserve_b, liquidity, cum_fee_a,
        // cum_fee_b) * active_count], inactive slots zero-padded). Read BEFORE any
        // mutation. poseidon2_hash here == the circuit's Poseidon2::hash(_, 25)
        // (same proven parity as the orderbook's c_i recompute).
        let ps = self.storage.pool_state.read();
        let mut commit_input: [Field; 25] = [0; 25];
        commit_input[0] = ps.current_sqrt_price as Field;
        for i in 0..4 {
            if (i as u32) < swap.active_bucket_count {
                let d = swap.active_bucket_deltas[i];
                let b = self.storage.buckets.at(d.bucket_id).read();
                let base = 1 + i * 6;
                commit_input[base + 0] = d.bucket_id as Field;
                commit_input[base + 1] = b.reserve_a as Field;
                commit_input[base + 2] = b.reserve_b as Field;
                commit_input[base + 3] = b.liquidity as Field;
                commit_input[base + 4] = b.cum_fee_a_per_share as Field;
                commit_input[base + 5] = b.cum_fee_b_per_share as Field;
            }
        }
        let live_commitment = poseidon2_hash(commit_input);
        assert(live_commitment == swap.pool_state_commitment, "pool state commitment mismatch");

        // Bind the aggregate flow fields to the proven per-bucket deltas
        // (deriveAggregateFlows defines them; re-check on-chain so a malicious
        // aggregator cannot move tokens inconsistent with the proof).
        // M17: to_pool is GROSS -- post-fee reserve adds PLUS the LP fee derived
        // from the cum_fee increments (fee_fwd = inc * liquidity / FEE_SCALE,
        // floor; plain u128 ops per the MVP overflow convention, see the deposit
        // note above). The same fee is credited to the bucket's fee pot below
        // (never bucket reserves -- reserves are principal-claimable), so the
        // cum_fee_per_share credit is token-backed (floor subadditivity makes
        // every withdrawal pattern against it solvent).
        let mut sum_a_add: u128 = 0;
        let mut sum_a_sub: u128 = 0;
        let mut sum_b_add: u128 = 0;
        let mut sum_b_sub: u128 = 0;
        let mut fee_fwd_a: u128 = 0;
        let mut fee_fwd_b: u128 = 0;
        for i in 0..4 {
            if (i as u32) < swap.active_bucket_count {
                let d = swap.active_bucket_deltas[i];
                assert(d.bucket_id < NUM_BUCKETS, "delta bucket_id out of range");
                let liq = self.storage.buckets.at(d.bucket_id).read().liquidity;
                sum_a_add = sum_a_add + d.reserve_a_add;
                sum_a_sub = sum_a_sub + d.reserve_a_sub;
                sum_b_add = sum_b_add + d.reserve_b_add;
                sum_b_sub = sum_b_sub + d.reserve_b_sub;
                fee_fwd_a = fee_fwd_a + d.cum_fee_a_per_share_increment * liq / FEE_SCALE;
                fee_fwd_b = fee_fwd_b + d.cum_fee_b_per_share_increment * liq / FEE_SCALE;
            }
        }
        assert(swap.a_to_pool == sum_a_add + fee_fwd_a, "a_to_pool != adds + forwarded fee");
        assert(swap.a_from_pool == sum_a_sub, "a_from_pool != sum reserve_a_sub");
        assert(swap.b_to_pool == sum_b_add + fee_fwd_b, "b_to_pool != adds + forwarded fee");
        assert(swap.b_from_pool == sum_b_sub, "b_from_pool != sum reserve_b_sub");

        if swap.a_from_pool > 0 as u128 {
            self.call(Token::at(self.storage.token_a_addr.read()).transfer_public_to_public(
                self.address, orderbook, swap.a_from_pool, 0,
            ));
        }
        if swap.b_from_pool > 0 as u128 {
            self.call(Token::at(self.storage.token_b_addr.read()).transfer_public_to_public(
                self.address, orderbook, swap.b_from_pool, 0,
            ));
        }

        // Apply per-bucket deltas. Hardcoded MAX_ACTIVE_BUCKETS_PER_EPOCH=4
        // unroll; the active_bucket_count guard skips unused slots.
        for i in 0..4 {
            if (i as u32) < swap.active_bucket_count {
                let delta = swap.active_bucket_deltas[i];
                assert(delta.bucket_id < NUM_BUCKETS, "delta bucket_id out of range");
                let mut bucket = self.storage.buckets.at(delta.bucket_id).read();
                // M17 (fee pot): the forwarded LP fee goes to the bucket's fee pot,
                // NOT bucket reserves -- reserves are principal-claimable pro-rata
                // (share * reserve / liquidity), so crediting the fee there would let
                // it be claimed twice (once as principal, once as earned). Bucket
                // reserves stay NET, matching the clearing circuit's after-state
                // math. Same formula as the binding assert above; liquidity is
                // invariant during a clearing, so this recompute equals fee_fwd's
                // terms and the pot receives exactly what the orderbook transferred.
                let fee_a = delta.cum_fee_a_per_share_increment * bucket.liquidity / FEE_SCALE;
                let fee_b = delta.cum_fee_b_per_share_increment * bucket.liquidity / FEE_SCALE;
                if fee_a > 0 as u128 {
                    let pot_a = self.storage.fee_pot_a.at(delta.bucket_id).read();
                    self.storage.fee_pot_a.at(delta.bucket_id).write(pot_a + fee_a);
                }
                if fee_b > 0 as u128 {
                    let pot_b = self.storage.fee_pot_b.at(delta.bucket_id).read();
                    self.storage.fee_pot_b.at(delta.bucket_id).write(pot_b + fee_b);
                }
                bucket.reserve_a = bucket.reserve_a + delta.reserve_a_add;
                assert(bucket.reserve_a >= delta.reserve_a_sub, "bucket A underflow");
                bucket.reserve_a = bucket.reserve_a - delta.reserve_a_sub;
                bucket.reserve_b = bucket.reserve_b + delta.reserve_b_add;
                assert(bucket.reserve_b >= delta.reserve_b_sub, "bucket B underflow");
                bucket.reserve_b = bucket.reserve_b - delta.reserve_b_sub;
                bucket.cum_fee_a_per_share =
                    bucket.cum_fee_a_per_share + delta.cum_fee_a_per_share_increment;
                bucket.cum_fee_b_per_share =
                    bucket.cum_fee_b_per_share + delta.cum_fee_b_per_share_increment;
                self.storage.buckets.at(delta.bucket_id).write(bucket);
            }
        }

        // Update global aggregate cache + current_sqrt_price.
        let pool = self.storage.pool_state.read();
        self.storage.pool_state.write(PoolState {
            reserve_a: pool.reserve_a + swap.a_to_pool - swap.a_from_pool,
            reserve_b: pool.reserve_b + swap.b_to_pool - swap.b_from_pool,
            current_sqrt_price: swap.current_sqrt_price_after,
        });
    }

    // ============================ DEPOSIT ============================

    /// Supply liquidity. `amount_a` / `amount_b` are the maxima the LP is willing to
    /// provide; the V2 ratio match uses only the proportional `used_a` / `used_b` and
    /// escrows exactly those (the unmatched remainder never leaves the LP's wallet).
    ///
    /// `hint` is the caller's snapshot of the live `PoolState`; the privately-computed
    /// shares are validated by `_apply_deposit`, which asserts the hint still matches
    /// the actual state at mine time.
    ///
    /// Note on overflow: the share-math products are plain `u128`. For the MVP's
    /// test-token amounts they never overflow; a pathologically large deposit would
    /// overflow and revert (a safe failure - no fund loss, no share inflation).
    /// Sub-2 deposit: provide liquidity to a specific bucket.
    /// - bucket_id: 0..15 (the LP's chosen price range)
    /// - amount_a, amount_b: maxima the LP is willing to deposit
    /// - hint_pool, hint_bucket: live state snapshots for optimistic concurrency
    /// - nonce_*: authwit nonces for Token escrow + refund
    /// - position_nonce: random identity nonce for the PositionNote
    ///
    /// V3 math: L_used = min(L_a, L_b) (in-range), or single-sided when bucket
    /// is below/above pool's current sqrt_price. Surplus side refunded to LP's
    /// PRIVATE balance (no principal loss).
    #[external("private")]
    fn deposit(
        bucket_id: u32,
        amount_a: u128, amount_b: u128,
        hint_pool: PoolState, hint_bucket: BucketState,
        nonce_a: Field, nonce_b: Field, position_nonce: Field,
    ) {
        assert(bucket_id < NUM_BUCKETS, "bucket_id out of range");
        assert((amount_a > 0 as u128) | (amount_b > 0 as u128),
               "amount_a or amount_b must be positive");

        // L17: deposit and withdraw must agree on the nonce domain. withdraw asserts
        // position_nonce != 0 (its pop_notes select key); without this guard a zero-nonce
        // PositionNote could be minted here and then never withdrawn (every withdraw
        // reverts on that assert), permanently locking the LP's principal + fees.
        assert(position_nonce != 0, "position_nonce must be non-zero");

        let lp = self.msg_sender();
        let token_a = self.storage.token_a_addr.read();
        let token_b = self.storage.token_b_addr.read();

        // Escrow everything the LP offered; refund the surplus side below.
        if amount_a > 0 as u128 {
            self.call(Token::at(token_a).transfer_private_to_public(
                lp, self.address, amount_a, nonce_a,
            ));
        }
        if amount_b > 0 as u128 {
            self.call(Token::at(token_b).transfer_private_to_public(
                lp, self.address, amount_b, nonce_b,
            ));
        }

        // Compute V3 deposit math on the hint's sqrt_price + bucket bounds.
        let p_min_sqrt = self.storage.p_min_sqrt.read();
        let growth_num = self.storage.bucket_growth_num.read();
        let (sqrt_lower, sqrt_upper) = compute_bucket_bounds(p_min_sqrt, growth_num, bucket_id);
        let bounds = buckets::BucketBounds { sqrt_lower, sqrt_upper };
        let math = buckets::compute_deposit(amount_a, amount_b, hint_pool.current_sqrt_price, bounds);

        assert(math.l_used > 0 as u128, "deposit too small for any liquidity");

        // Refund the surplus.
        let refund_a = amount_a - math.used_a;
        let refund_b = amount_b - math.used_b;
        if refund_a > 0 as u128 {
            self.call(Token::at(token_a).transfer_public_to_private(
                self.address, lp, refund_a, 0,
            ));
        }
        if refund_b > 0 as u128 {
            self.call(Token::at(token_b).transfer_public_to_private(
                self.address, lp, refund_b, 0,
            ));
        }

        // Commit the PositionNote.
        let position = PositionNote {
            bucket_id,
            lp_share: math.l_used,
            cum_fee_a_per_share_at_deposit: hint_bucket.cum_fee_a_per_share,
            cum_fee_b_per_share_at_deposit: hint_bucket.cum_fee_b_per_share,
            nonce: position_nonce,
            owner: lp,
        };
        self.storage.positions.at(lp).insert(position).deliver(MessageDelivery::onchain_constrained());

        // Apply state mutations under hint validation.
        self.enqueue_self._apply_deposit_to_bucket(
            bucket_id, math.used_a, math.used_b, math.l_used, hint_pool, hint_bucket,
        );
    }

    /// Public callback: assert hints match live state, mutate bucket + aggregate cache.
    #[external("public")]
    #[only_self]
    fn _apply_deposit_to_bucket(
        bucket_id: u32,
        used_a: u128, used_b: u128, l_used: u128,
        hint_pool: PoolState, hint_bucket: BucketState,
    ) {
        let actual_pool = self.storage.pool_state.read();
        assert(actual_pool == hint_pool, "pool_state changed; retry");
        let actual_bucket = self.storage.buckets.at(bucket_id).read();
        assert(actual_bucket == hint_bucket, "bucket_state changed; retry");

        self.storage.buckets.at(bucket_id).write(BucketState {
            reserve_a: actual_bucket.reserve_a + used_a,
            reserve_b: actual_bucket.reserve_b + used_b,
            liquidity: actual_bucket.liquidity + l_used,
            cum_fee_a_per_share: actual_bucket.cum_fee_a_per_share,
            cum_fee_b_per_share: actual_bucket.cum_fee_b_per_share,
        });
        self.storage.pool_state.write(PoolState {
            reserve_a: actual_pool.reserve_a + used_a,
            reserve_b: actual_pool.reserve_b + used_b,
            current_sqrt_price: actual_pool.current_sqrt_price,
        });
    }

    // ============================ WITHDRAW ============================

    /// Sub-2 withdraw. Burns the PositionNote, returns principal + accrued
    /// fees from the position's bucket to the LP's PRIVATE balance.
    ///
    /// Principal = (lp_share / bucket.liquidity) * bucket.reserves.
    /// Fees = lp_share * (cum_fee_now - cum_fee_at_deposit) / FEE_SCALE.
    /// M17 (fee pot): fees are paid from the bucket's fee pot (capped at its
    /// balance); principal is paid from NET bucket reserves. hint_fee_pot_a/b
    /// follow the same optimistic-concurrency pattern as hint_bucket.
    #[external("private")]
    fn withdraw(
        position_nonce: Field,
        hint_pool: PoolState,
        hint_bucket: BucketState,
        hint_fee_pot_a: u128, hint_fee_pot_b: u128,
        nonce_a: Field, nonce_b: Field,
    ) {
        let lp = self.msg_sender();
        assert(position_nonce != 0, "position_nonce must be non-zero");

        // Pop the LP's PositionNote matching this nonce.
        let options = NoteGetterOptions::new().select(
            PositionNote::properties().nonce,
            Comparator.EQ,
            position_nonce,
        ).set_limit(1);
        let notes = self.storage.positions.at(lp).pop_notes(options);
        assert(notes.len() == 1, "position not found");
        let position = notes.get(0);
        assert(position.owner == lp, "not position owner");

        // Compute earned fees + principal from the hint values.
        let fee_a_delta =
            hint_bucket.cum_fee_a_per_share - position.cum_fee_a_per_share_at_deposit;
        let fee_b_delta =
            hint_bucket.cum_fee_b_per_share - position.cum_fee_b_per_share_at_deposit;
        // M17 (fee pot): cap earned at the pot balance. Across J clearings the
        // accumulated claim floor(share * SUM(inc) / SCALE) can exceed the credited
        // SUM floor(L * inc_j / SCALE) by up to J-1 raw units (floor accumulation);
        // the cap turns that would-be brick into a <= dust loss for the LP.
        let earned_a_claim = position.lp_share * fee_a_delta / FEE_SCALE;
        let earned_b_claim = position.lp_share * fee_b_delta / FEE_SCALE;
        let earned_a = if earned_a_claim > hint_fee_pot_a { hint_fee_pot_a } else { earned_a_claim };
        let earned_b = if earned_b_claim > hint_fee_pot_b { hint_fee_pot_b } else { earned_b_claim };

        let principal_a = if hint_bucket.liquidity == 0 as u128 {
            0 as u128
        } else {
            position.lp_share * hint_bucket.reserve_a / hint_bucket.liquidity
        };
        let principal_b = if hint_bucket.liquidity == 0 as u128 {
            0 as u128
        } else {
            position.lp_share * hint_bucket.reserve_b / hint_bucket.liquidity
        };

        let payout_a = principal_a + earned_a;
        let payout_b = principal_b + earned_b;

        let token_a = self.storage.token_a_addr.read();
        let token_b = self.storage.token_b_addr.read();
        if payout_a > 0 as u128 {
            self.call(Token::at(token_a).transfer_public_to_private(
                self.address, lp, payout_a, nonce_a,
            ));
        }
        if payout_b > 0 as u128 {
            self.call(Token::at(token_b).transfer_public_to_private(
                self.address, lp, payout_b, nonce_b,
            ));
        }

        self.enqueue_self._apply_withdraw_from_bucket(
            position.bucket_id, position.lp_share,
            principal_a, principal_b, earned_a, earned_b,
            hint_pool, hint_bucket,
            hint_fee_pot_a, hint_fee_pot_b,
        );
    }

    #[external("public")]
    #[only_self]
    fn _apply_withdraw_from_bucket(
        bucket_id: u32,
        lp_share: u128,
        principal_a: u128, principal_b: u128,
        earned_a: u128, earned_b: u128,
        hint_pool: PoolState, hint_bucket: BucketState,
        hint_fee_pot_a: u128, hint_fee_pot_b: u128,
    ) {
        let actual_pool = self.storage.pool_state.read();
        assert(actual_pool == hint_pool, "pool_state changed; retry");
        let actual_bucket = self.storage.buckets.at(bucket_id).read();
        assert(actual_bucket == hint_bucket, "bucket_state changed; retry");
        let actual_pot_a = self.storage.fee_pot_a.at(bucket_id).read();
        let actual_pot_b = self.storage.fee_pot_b.at(bucket_id).read();
        assert(actual_pot_a == hint_fee_pot_a, "fee_pot changed; retry");
        assert(actual_pot_b == hint_fee_pot_b, "fee_pot changed; retry");

        let total_out_a = principal_a + earned_a;
        let total_out_b = principal_b + earned_b;
        // M17 (fee pot): principal comes from NET bucket reserves; earned comes
        // from the fee pot. The two channels are independently token-backed.
        assert(actual_bucket.reserve_a >= principal_a, "bucket reserve_a underflow");
        assert(actual_bucket.reserve_b >= principal_b, "bucket reserve_b underflow");
        assert(actual_pot_a >= earned_a, "fee_pot_a underflow");
        assert(actual_pot_b >= earned_b, "fee_pot_b underflow");
        assert(actual_bucket.liquidity >= lp_share, "bucket liquidity underflow");
        assert(actual_pool.reserve_a >= total_out_a, "pool reserve_a underflow");
        assert(actual_pool.reserve_b >= total_out_b, "pool reserve_b underflow");

        self.storage.buckets.at(bucket_id).write(BucketState {
            reserve_a: actual_bucket.reserve_a - principal_a,
            reserve_b: actual_bucket.reserve_b - principal_b,
            liquidity: actual_bucket.liquidity - lp_share,
            cum_fee_a_per_share: actual_bucket.cum_fee_a_per_share,
            cum_fee_b_per_share: actual_bucket.cum_fee_b_per_share,
        });
        self.storage.fee_pot_a.at(bucket_id).write(actual_pot_a - earned_a);
        self.storage.fee_pot_b.at(bucket_id).write(actual_pot_b - earned_b);
        self.storage.pool_state.write(PoolState {
            reserve_a: actual_pool.reserve_a - total_out_a,
            reserve_b: actual_pool.reserve_b - total_out_b,
            current_sqrt_price: actual_pool.current_sqrt_price,
        });
    }

    /// Sub-2 utility: read bucket state by id.
    #[external("utility")]
    unconstrained fn get_bucket(bucket_id: u32) -> BucketState {
        self.storage.buckets.at(bucket_id).read()
    }

    /// M17 utility: read a bucket's token-A fee pot (for withdraw hint construction).
    #[external("utility")]
    unconstrained fn get_fee_pot_a(bucket_id: u32) -> u128 {
        self.storage.fee_pot_a.at(bucket_id).read()
    }

    /// M17 utility: read a bucket's token-B fee pot (for withdraw hint construction).
    #[external("utility")]
    unconstrained fn get_fee_pot_b(bucket_id: u32) -> u128 {
        self.storage.fee_pot_b.at(bucket_id).read()
    }

    /// Sub-2 utility: expose p_min_sqrt for off-chain bucket-bound computation.
    #[external("utility")]
    unconstrained fn get_p_min_sqrt() -> u128 {
        self.storage.p_min_sqrt.read()
    }

    /// Sub-2 utility: expose growth_num for off-chain bucket-bound computation.
    #[external("utility")]
    unconstrained fn get_bucket_growth_num() -> u128 {
        self.storage.bucket_growth_num.read()
    }

    // ============================ UNCONSTRAINED GETTERS ============================

    #[external("utility")]
    unconstrained fn get_pool_state() -> PoolState {
        self.storage.pool_state.read()
    }

    #[external("utility")]
    unconstrained fn get_token_a_addr() -> AztecAddress {
        self.storage.token_a_addr.read()
    }

    #[external("utility")]
    unconstrained fn get_token_b_addr() -> AztecAddress {
        self.storage.token_b_addr.read()
    }

    /// Resting LP positions owned by `owner` (up to MAX_NOTES_PER_PAGE, UNORDERED).
    /// `owner` is explicit because utility functions are simulated and only the owner's
    /// PXE can resolve the encrypted notes.
    #[external("utility")]
    unconstrained fn get_positions(owner: AztecAddress) -> BoundedVec<PositionNote, MAX_NOTES_PER_PAGE> {
        self.storage.positions.at(owner).view_notes(NoteViewerOptions::new())
    }

    pub mod buckets;
    pub mod test;
}
