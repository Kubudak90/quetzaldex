use aztec::macros::aztec;

/// H13: an order belongs to the CURRENT epoch iff its anchor block is at/after the epoch
/// open. submit_order's own epoch-open check runs at the same anchor block and the epoch
/// is OPEN only from opened_at_block, so this is the exact same-epoch membership test. A
/// prior-epoch order (anchor before this epoch opened) must NOT fold into cancel_acc.
/// Free crate-root fn (the #[aztec] contract macro rejects non-method fns inside the
/// contract block); referenced as `crate::should_fold_cancel` from the contract + tests.
pub fn should_fold_cancel(submitted_at_block: u32, opened_at_block: u32) -> bool {
    submitted_at_block >= opened_at_block
}

/// M16: bare close_epoch wipes order_acc/cancel_acc, so during the clearing grace
/// window a NON-EMPTY epoch may only be bare-closed by a registry-bonded caller
/// (the aggregator's no-cross fallback); the intended path is
/// close_epoch_and_clear_verified. Empty epochs (order_count == 0) close freely --
/// there is nothing bound to the accumulators to grief. At or after
/// closes_at_block + grace anyone may close (liveness backstop if every bonded
/// aggregator is dead). grace == 0 degenerates to the pre-M16 behavior.
/// Free crate-root fn (the #[aztec] macro rejects non-method fns inside the
/// contract block); referenced as `crate::bare_close_needs_bond`.
pub fn bare_close_needs_bond(order_count: u32, block: u32, closes_at_block: u32, grace: u32) -> bool {
    (order_count != 0) & (block < closes_at_block + grace)
}

#[aztec]
pub contract Orderbook {
    use aztec::{
        keys::getters::get_public_keys,
        macros::{
            functions::{external, initializer, internal, only_self, view},
            notes::note,
            storage::storage,
        },
        messages::delivery::MessageDelivery,
        note::{
            ConfirmedNote,
            constants::MAX_NOTES_PER_PAGE,
            note_getter_options::{NoteGetterOptions, PropertySelector},
            note_interface::{NoteHash, NoteProperties},
            note_viewer_options::NoteViewerOptions,
        },
        protocol::{
            address::AztecAddress,
            traits::{Deserialize, Serialize},
        },
        state_vars::{Map, Owned, PrivateSet, PublicImmutable, PublicMutable},
        utils::comparison::Comparator,
    };

    use token::Token;
    use pool::LiquidityPool;
    use aggregator_registry::AggregatorRegistry;
    use treasury::Treasury;
    use aztec::protocol::{hash::poseidon2_hash, traits::{FromField, Hash, Packable, ToField}};

    /// Maximum number of input notes for note-sweeping flows. Unused by `cancel_order`
    /// (which selects a single note by nonce via `set_limit(1)`); reserved for the
    /// clearing circuit (Week 6+) which will sweep many resting notes at once.
    pub global MAX_INPUT_NOTES: u32 = 8;

    /// Maximum orders submitted per epoch (also the cap on fills in one clearing).
    pub global MAX_ORDERS_PER_EPOCH: u32 = 32;

    /// Epoch state machine value indicating the epoch is OPEN and accepting new orders.
    global EPOCH_STATE_OPEN: u8 = 0;

    /// Private note representing a single resting order on the orderbook.
    ///
    /// Fields:
    /// - `submitted_at_block`: L2 block number at which the order was submitted (used for time priority).
    /// - `side`: false = bid (buy base / pay quote), true = ask (sell base / receive quote).
    /// - `amount_in`: input amount the maker is offering (in the appropriate token's smallest unit).
    /// - `limit_price`: quote-per-base price scaled to 18 decimals (Q-format).
    /// - `nonce`: per-order random salt to make every note unique and unlinkable.
    /// - `owner`: address of the order's maker (also nullifier subject).
    /// - `path_len`: Sub-4 routing path length; must be 2 or 3.
    ///   path[0] = input token; path[path_len-1] = output token.
    /// - `path`: Sub-4 routing path as token addresses encoded as Fields (3 slots).
    ///   For path_len == 2, path[2] = 0 (sentinel for unused 3rd hop).
    #[derive(Deserialize, Eq, Serialize)]
    #[note]
    pub struct OrderNote {
        pub submitted_at_block: u32,
        pub side: bool,
        pub amount_in: u128,
        pub limit_price: u128,
        pub nonce: Field,
        pub owner: AztecAddress,
        // Sub-4: routing path. path_len in {2, 3}.
        // path[0] = input token; path[path_len-1] = output token.
        // For path_len == 2, path[2] = 0 (sentinel).
        pub path_len: u8,
        pub path: [Field; 3],
    }

    /// Manual `Packable` impl for OrderNote (replaces `#[derive(Packable)]`).
    ///
    /// Aztec v4.2.0 caps per-note packed length at MAX_NOTE_PACKED_LEN = 8 fields.
    /// The derived layout would consume 10 fields (1 each for submitted_at_block,
    /// side, amount_in, limit_price, nonce, owner, path_len + 3 for path), which
    /// exceeds the cap. We pack `(submitted_at_block, side, path_len)` into a
    /// single Field (each component is much smaller than 2^32, so they fit
    /// without overlap in low 64 bits) to bring the total down to 8 fields:
    ///
    ///   slot 0: amount_in
    ///   slot 1: limit_price
    ///   slot 2: nonce
    ///   slot 3: owner
    ///   slot 4: path[0]
    ///   slot 5: path[1]
    ///   slot 6: path[2]
    ///   slot 7: packed = submitted_at_block | (side << 32) | (path_len << 33)
    impl Packable for OrderNote {
        let N: u32 = 8;

        fn pack(self) -> [Field; 8] {
            let packed_meta: Field =
                (self.submitted_at_block as Field)
                + ((self.side as Field) * 0x100000000)            // bit 32
                + ((self.path_len as Field) * 0x200000000);       // bits 33..40
            [
                self.amount_in as Field,
                self.limit_price as Field,
                self.nonce,
                self.owner.to_field(),
                self.path[0],
                self.path[1],
                self.path[2],
                packed_meta,
            ]
        }

        fn unpack(packed: [Field; 8]) -> Self {
            let amount_in: u128 = packed[0] as u128;
            let limit_price: u128 = packed[1] as u128;
            let nonce: Field = packed[2];
            let owner: AztecAddress = AztecAddress::from_field(packed[3]);
            let path: [Field; 3] = [packed[4], packed[5], packed[6]];
            // Unpack the meta Field via little-endian bit decomposition.
            // bits[0..32] = submitted_at_block; bits[32] = side; bits[33..41] = path_len.
            let meta_bits: [bool; 41] = packed[7].to_le_bits();
            // u64 (not u32): the trailing `pow * 2` at i=31 reaches 2^32, which
            // overflows u32. Do not narrow back -- block_acc fits u32 (32 bits) and
            // is cast at the end.
            let mut block_acc: u64 = 0;
            let mut pow: u64 = 1;
            for i in 0..32 {
                block_acc = block_acc + ((meta_bits[i] as u64) * pow);
                pow = pow * 2;
            }
            let submitted_at_block: u32 = block_acc as u32;
            let side: bool = meta_bits[32];
            // u16 (not u8): the trailing `p8 * 2` at i=7 reaches 256, which overflows
            // u8. Do not narrow back -- plen_acc fits u8 (8 bits) and is cast at the end.
            let mut plen_acc: u16 = 0;
            let mut p8: u16 = 1;
            for i in 0..8 {
                plen_acc = plen_acc + ((meta_bits[33 + i] as u16) * p8);
                p8 = p8 * 2;
            }
            let path_len: u8 = plen_acc as u8;
            Self { submitted_at_block, side, amount_in, limit_price, nonce, owner, path_len, path }
        }
    }

    /// Public state of the current epoch.
    ///
    /// Fields:
    /// - `epoch_id`: monotonically increasing epoch counter (starts at 0).
    /// - `state`: epoch state machine value (0 = OPEN; 1 = CLOSING, 2 = SETTLED reserved for the clearing circuit, Week 6+).
    /// - `opened_at_block`: L2 block number at which this epoch was opened.
    /// - `closes_at_block`: L2 block number at/after which this epoch may transition out of OPEN.
    /// - `order_acc`: running-hash chain of submitted-order commitments (Poseidon2). Starts at 0; folded
    ///   per submit by `_append_order` (Week 5d-1). Bound by the Week 5d-2 clearing circuit.
    /// - `cancel_acc`: running-hash chain of cancelled-order commitments (Poseidon2). Starts at 0; folded
    ///   per cancel by `_append_cancel` (Week 5d-1).
    /// - `order_count`: count of `submit_order` successes this epoch (monotonic; capped at MAX_ORDERS_PER_EPOCH).
    /// - `cancel_count`: count of `cancel_order` successes this epoch (monotonic; <= order_count).
    #[derive(Deserialize, Eq, Packable, Serialize)]
    pub struct EpochState {
        pub epoch_id: u32,
        pub state: u8,
        pub opened_at_block: u32,
        pub closes_at_block: u32,
        pub order_acc: Field,
        pub cancel_acc: Field,
        pub order_count: u32,
        pub cancel_count: u32,
    }

    /// One filled order in a clearing - the aggregator's per-order payout.
    #[derive(Deserialize, Eq, Packable, Serialize)]
    pub struct FillEntry {
        pub order_nonce: Field,
        pub amount_out: u128,
    }

    /// Sub-6a A2: maximum orders per bulk-submit call (1 real + up to 4 decoys).
    /// Sized to fit within Aztec's PXE tagging window (~20 unfinalised submits)
    /// when a maker has 2+ trades in flight. **A5 measurement 2026-05-23:** K=9
    /// measured at 581K gates (above 350K threshold) -- downsized to 5 per A5
    /// decision matrix. K=5 measured at ~365K gates (within UX-acceptable band).
    pub global MAX_ORDERS_PER_BULK: u32 = 5;

    /// Sub-4: cap on pools touched per clearing.
    pub global MAX_ACTIVE_POOLS_PER_EPOCH: u32 = 3;
    /// Sub-5a D1: total pool-registry capacity (!= MAX_ACTIVE_POOLS_PER_EPOCH=3
    /// which caps per-epoch active pools). add_pool refuses to extend past this.
    pub global MAX_NUM_POOLS: u32 = 8;
    /// Sub-4: padding sentinel for unused pool slots in ClearingPublic.
    pub global INVALID_POOL_ID: u32 = 0xFFFFFFFF;

    /// Sub-5a B1: domain separation tag for per-hop claim nullifiers.
    /// Combined with (note_hash, secret, hop_index) in derive_per_hop_nullifier
    /// so per-hop nullifiers cannot collide with default note nullifiers or
    /// with the cancel nullifier.
    /// Value: poseidon2_hash(["ZSWAP_HOP_CLAIM" as Field]) = 0x29190425...
    /// Computed off-chain via @aztec/foundation poseidon2Hash.
    global Z_HOP_CLAIM_TAG: Field = 0x29190425a33e9929a8db7d2c2f8e05ee6118afa95b7acfc338d7a96a8a36e01e as Field;

    /// Sub-5a B1: domain separation tag for cancel-order nullifiers.
    /// Combined with (note_hash, secret) so cancel nullifiers can never collide
    /// with any per-hop claim nullifier.
    /// Value: poseidon2_hash(["ZSWAP_CANCEL" as Field]) = 0x1611cd82...
    /// Computed off-chain via @aztec/foundation poseidon2Hash.
    global Z_CANCEL_TAG: Field = 0x1611cd824d83775a3d18f375bdc4b992562994c11e4298e82e47e4a284760401 as Field;

    /// Sub-4: per-pool clearing payload. 39 fields total = (pool_id + clearing_price
    /// + token_lo + token_hi) prefix + LiquidityPool::ClearingSwap (35 fields: 4
    /// aggregate flows + current_sqrt_price_after + pool_state_commitment +
    /// active_bucket_count + 4 BucketDelta x 7 = 28).
    #[derive(Deserialize, Eq, Packable, Serialize)]
    pub struct PoolClearing {
        pub pool_id: u32,
        pub clearing_price: u128,
        pub token_lo: Field,
        pub token_hi: Field,
        pub swap: LiquidityPool::ClearingSwap,
    }

    /// Sub-4: top-level clearing public input. 6 scalars + 3 PoolClearing x 39 = 123 fields.
    #[derive(Deserialize, Eq, Packable, Serialize)]
    pub struct ClearingPublic {
        pub order_acc:         Field,
        pub cancel_acc:        Field,
        pub order_count:       u32,
        pub cancel_count:      u32,
        pub fills_root:        Field,
        pub active_pool_count: u32,
        pub active_pools:      [PoolClearing; MAX_ACTIVE_POOLS_PER_EPOCH],
    }

    #[storage]
    struct Storage<Context> {
        orders: Owned<PrivateSet<OrderNote, Context>, Context>,
        current_epoch: PublicMutable<EpochState, Context>,
        epoch_length: PublicImmutable<u32, Context>,
        /// M16: blocks after closes_at_block during which a NON-EMPTY epoch may only
        /// be closed by a verified clearing or a bonded aggregator's bare close.
        clear_grace_blocks: PublicImmutable<u32, Context>,
        // Sub-4 NEW: multi-pool registry.
        // Sub-5a D1: PublicMutable so add_pool can append at runtime.
        // Existing slots are never overwritten -- only appended at index pool_count.
        // pool_id -> Pool contract address
        pools: Map<u32, PublicMutable<AztecAddress, Context>, Context>,
        // pool_id -> canonical (token_a, token_b) where token_a < token_b as Field
        pool_token_a: Map<u32, PublicMutable<AztecAddress, Context>, Context>,
        pool_token_b: Map<u32, PublicMutable<AztecAddress, Context>, Context>,
        // How many pools are registered (grows at runtime via add_pool).
        pool_count: PublicMutable<u32, Context>,
        /// Hash of the clearing-circuit VK. Initialised at deploy and immutable.
        /// The full VK is provided as calldata to close_epoch_and_clear_verified.
        clearing_vk_hash: PublicImmutable<Field, Context>,
        /// Week 5d-4: per-epoch Merkle settlement root over the 32-leaf fills array.
        /// `_apply_verified_clearing` writes one slot per clearing; claim_fill reads
        /// it back to verify a maker-supplied inclusion proof.
        fills_root: Map<u32, PublicMutable<Field, Context>, Context>,
        /// Sub-3: AggregatorRegistry contract. The close_epoch_and_clear_verified
        /// gate cross-contract-reads bonded_amount to ensure the caller is bonded.
        aggregator_registry: PublicImmutable<AztecAddress, Context>,
        /// Sub-3: Treasury contract that holds the per-clearing fee pool. Called
        /// via Treasury.pay_aggregator(winner, aggregator_fee) at the end of
        /// _apply_verified_clearing.
        /// Sub-5a A2: PublicMutable so set_treasury can wire the deployed Treasury
        /// address one-shot after Orderbook deploy (resolves Sub-3 4-deploy wart).
        treasury: PublicMutable<AztecAddress, Context>,
        /// Sub-3: flat fee (in bond_token's smallest unit) paid per successful
        /// clearing. Treasury silently partial-pays if its tracked_balance is short.
        aggregator_fee: PublicImmutable<u128, Context>,
        /// Sub-5a A2 / D1: deploy-time admin that controls pool registration and
        /// one-shot treasury wiring. Forward-added here (D1 needed for set_treasury
        /// gate; D1 will add add_pool logic on top).
        pool_registry_admin: PublicImmutable<AztecAddress, Context>,
    }

    /// Deploy-time initializer (Sub-4 form).
    ///
    /// - Sub-4: accepts a deploy-time pool registry of up to 4 pools.
    ///   Each pool entry: (pool contract address, token_a canonical, token_b canonical).
    ///   Caller MUST pre-canonicalize token_a < token_b as Field for each pair.
    /// - Records `clearing_vk_hash` (the VK hash that binds this orderbook to one specific
    ///   clearing circuit; the full VK is provided as calldata at clearing time).
    /// - Sub-3 additions: `aggregator_registry` gates close_epoch_and_clear_verified;
    ///   `treasury` pays the winner; `aggregator_fee` is the per-clearing payout.
    /// - Stores `epoch_length`; opens epoch 0.
    #[external("public")]
    #[initializer]
    fn constructor(
        epoch_length: u32,
        clear_grace_blocks: u32,
        clearing_vk_hash: Field,
        aggregator_registry: AztecAddress,
        aggregator_fee: u128,
        // Sub-4: deploy-time pool registry; up to 4 pools.
        // Each slot: (addr, token_a_canonical, token_b_canonical).
        // Caller MUST pre-canonicalize token_a < token_b as Field.
        pool_count: u32,
        pool_addrs: [AztecAddress; 4],
        pool_token_a_addrs: [AztecAddress; 4],
        pool_token_b_addrs: [AztecAddress; 4],
        // Sub-5a A2: pool_registry_admin gates set_treasury (one-shot after deploy)
        // and will gate add_pool in Task D1. Treasury arg removed from constructor;
        // Orderbook starts with treasury = ZERO; set_treasury() wires it post-deploy.
        pool_registry_admin: AztecAddress,
    ) {
        self.storage.epoch_length.initialize(epoch_length);
        self.storage.clear_grace_blocks.initialize(clear_grace_blocks);
        self.storage.clearing_vk_hash.initialize(clearing_vk_hash);
        self.storage.aggregator_registry.initialize(aggregator_registry);
        // Sub-5a A2: treasury starts as ZERO; set_treasury() wires it once after
        // Treasury is deployed with the real Orderbook address (3-deploy ceremony).
        self.storage.treasury.write(AztecAddress::from_field(0));
        self.storage.aggregator_fee.initialize(aggregator_fee);
        self.storage.pool_registry_admin.initialize(pool_registry_admin);
        // Sub-4 NEW; Sub-5a D1: .initialize() -> .write() (PublicMutable)
        // Audit #12: the constructor seeds the registry from fixed [AztecAddress; 4]
        // arrays via the `0..4` loop below, so it can only seed up to 4 pools. The
        // previous bound of MAX_NUM_POOLS (=8) silently dropped any pool_count in
        // 5..=8 (slots 4..7 left zero). Cap the *constructor* seed at the array
        // length; the registry still grows to MAX_NUM_POOLS post-deploy via add_pool.
        assert((pool_count > 0 as u32) & (pool_count <= 4 as u32), "pool_count in [1, 4] (constructor seeds <=4 pools; use add_pool for more)");
        self.storage.pool_count.write(pool_count);
        for i in 0..4 {
            if (i as u32) < pool_count {
                self.storage.pools.at(i as u32).write(pool_addrs[i]);
                // Caller responsibility: token_a < token_b as Field
                self.storage.pool_token_a.at(i as u32).write(pool_token_a_addrs[i]);
                self.storage.pool_token_b.at(i as u32).write(pool_token_b_addrs[i]);
            }
        }

        let block: u32 = self.context.block_number();
        self.storage.current_epoch.write(EpochState {
            epoch_id: 0,
            state: EPOCH_STATE_OPEN,
            opened_at_block: block,
            closes_at_block: block + epoch_length,
            order_acc: 0,
            cancel_acc: 0,
            order_count: 0,
            cancel_count: 0,
        });
    }

    /// Sub-5a A2: one-shot setter for the Treasury address. Caller must be the
    /// deploy-time pool_registry_admin (typically admin). Reverts after the first
    /// non-ZERO write -- preserving Sub-3's pay_aggregator gating integrity once set.
    #[external("public")]
    fn set_treasury(treasury_addr: AztecAddress) {
        let caller = self.msg_sender();
        let admin = self.storage.pool_registry_admin.read();
        assert(caller == admin, "only pool_registry_admin");
        let stored = self.storage.treasury.read();
        assert(stored == AztecAddress::from_field(0), "treasury already set");
        self.storage.treasury.write(treasury_addr);
    }

    /// Sub-5a D1: append a new pool to the registry. Caller must be pool_registry_admin.
    /// Existing pool slots are untouched; only the next free slot is written.
    /// Refuses duplicate pair registration (canonical lookup) + refuses extension
    /// past MAX_NUM_POOLS.
    #[external("public")]
    fn add_pool(pool_addr: AztecAddress, token_a: AztecAddress, token_b: AztecAddress) {
        let caller = self.msg_sender();
        let admin = self.storage.pool_registry_admin.read();
        assert(caller == admin, "only pool_registry_admin");

        let count = self.storage.pool_count.read();
        assert(count < MAX_NUM_POOLS as u32, "pool registry full");

        // Canonicalize: smaller-as-Field first (matches resolve_pool_id_by_pair's convention).
        let (lo, hi) = if (token_a.to_field() as u128) < (token_b.to_field() as u128) {
            (token_a, token_b)
        } else {
            (token_b, token_a)
        };

        // Refuse duplicate registration of an existing pair.
        let mut existing: u32 = 0xFFFFFFFF as u32;
        for i in 0..MAX_NUM_POOLS {
            if (i as u32) < count {
                let pa = self.storage.pool_token_a.at(i as u32).read();
                let pb = self.storage.pool_token_b.at(i as u32).read();
                if (pa == lo) & (pb == hi) { existing = i as u32; }
            }
        }
        assert(existing == 0xFFFFFFFF as u32, "pair already registered");

        self.storage.pools.at(count).write(pool_addr);
        self.storage.pool_token_a.at(count).write(lo);
        self.storage.pool_token_b.at(count).write(hi);
        self.storage.pool_count.write(count + 1);
    }

    /// Sub-4: resolve which pool_id matches an unordered (token_a, token_b) pair.
    /// Canonicalises internally (smaller Field first) so the caller can pass either order.
    /// Returns 0xFFFFFFFF if no registered pool matches the pair.
    #[external("public")]
    #[view]
    fn resolve_pool_id_by_pair(token_a: AztecAddress, token_b: AztecAddress) -> u32 {
        let count = self.storage.pool_count.read();
        // Canonical: smaller-as-Field first
        let (lo, hi) = if (token_a.to_field() as u128) < (token_b.to_field() as u128) {
            (token_a, token_b)
        } else {
            (token_b, token_a)
        };
        let mut found: u32 = 0xFFFFFFFF;
        for i in 0..MAX_NUM_POOLS {
            if (i as u32) < count {
                let pa = self.storage.pool_token_a.at(i as u32).read();
                let pb = self.storage.pool_token_b.at(i as u32).read();
                if (pa == lo) & (pb == hi) {
                    found = i as u32;
                }
            }
        }
        found
    }

    // ============================ ORDER SUBMISSION ============================

    /// Sub-6a A1: extracted body of submit_order for reuse by submit_order_bulk.
    /// Performs validation, pool lookup, escrow, OrderNote build + insert.
    /// Called from both the per-tx submit_order and the K-batch submit_order_bulk.
    ///
    /// NOTE for K-batch callers: each call enqueues two public callbacks
    /// (`_assert_epoch_open` + `_append_order`). In a K-order bulk call this means
    /// 2K public enqueues within the same private circuit. If Aztec enforces a
    /// per-tx enqueue cap, the real K is bounded by it. Sub-6a A2 sizes
    /// MAX_ORDERS_PER_BULK = 9 (i.e., 18 public enqueues) which fits comfortably,
    /// but if A5's gate-count measurement forces a downsize, the enqueue cost
    /// also scales down.
    #[internal("private")]
    fn _submit_one_order_internal(
        side: bool,
        amount_in: u128,
        limit_price: u128,
        nonce: Field,
        order_nonce: Field,
        path_len: u8,
        path: [Field; 3],
    ) {
        assert(amount_in > 0 as u128, "amount_in must be positive");
        assert(limit_price > 0 as u128, "limit_price must be positive");
        // Sub-4: path validation
        assert((path_len == 2) | (path_len == 3), "path_len must be 2 or 3");
        assert(path[0] != path[1], "path[0] == path[1]");
        if path_len == 3 {
            assert(path[1] != path[2], "path[1] == path[2]");
            assert(path[0] != path[2], "path[0] == path[2]");
        } else {
            assert(path[2] == 0 as Field, "path[2] must be 0 sentinel for 1-hop");
        }

        // Sub-6c A1: canonical path enforcement.
        // Endpoints lex-sorted: path[0] < path[path_len-1]. Direction is
        // encoded only in the private `side` bool; on-chain path no longer
        // leaks direction. Middle hop (3-hop case) unconstrained -- it's the
        // intermediate pool, irrelevant to direction.
        // Uses (as u128) comparison per codebase convention (main.nr:352,
        // 383, 597, 611); top 2 bits of Field truncated, order-preserving
        // for the practical AztecAddress range.
        let last_hop_field: Field = if path_len == 2 { path[1] } else { path[2] };
        assert(
            (path[0] as u128) < (last_hop_field as u128),
            "path must be canonical (lex-sorted endpoints)",
        );

        let maker = self.msg_sender();

        // Sub-4 (B2): validate each hop's pool exists in the registry.
        // Sub-5a D1: pool registry is PublicMutable; in aztec-nr v4.2.0 PublicMutable
        // cannot be read from a private context. Defer the validation to a public
        // callback (atomic with the rest of this private body via enqueue_self).
        self.enqueue_self._assert_path_pools_registered(path_len, path);

        // Determine which token the maker is escrowing.
        // side == false (bid): input = path[0]
        // side == true  (ask): input = path[path_len-1]
        let input_token: Field = if !side {
            path[0]
        } else {
            if path_len == 2 { path[1] } else { path[2] }
        };
        let token_in_addr = AztecAddress::from_field(input_token);

        // Escrow: drain the maker's private balance, credit the orderbook's PUBLIC balance.
        // This is a private->private call (transfer_private_to_public is itself a private
        // function on Token that internally enqueues a public balance increase).
        self.call(Token::at(token_in_addr).transfer_private_to_public(
            maker,
            self.address,
            amount_in,
            nonce,
        ));

        // Build the OrderNote and insert it into the maker's private set, with on-chain
        // constrained encrypted delivery so the maker is guaranteed to discover and decrypt it.
        let submitted_at_block: u32 = self.context.get_anchor_block_header().block_number();
        let order = OrderNote {
            submitted_at_block,
            side,
            amount_in,
            limit_price,
            nonce: order_nonce,
            owner: maker,
            path_len,
            path,
        };
        self.storage.orders.at(maker).insert(order).deliver(MessageDelivery::onchain_constrained());

        // Audit #2: per-order hiding commitment over 10 fields. `order_nonce` is a
        // random Field, so c_i is hiding (maker/side/amount/limit cannot be recovered
        // from c_i). The routing path (path_len + path[0..2]) is now BOUND into c_i so
        // an aggregator cannot substitute an order across different hop sequences
        // (Sub-4 substitution guard). This formula is byte-identical to:
        //   - circuit  circuits/clearing/src/binding.nr::c_i_path
        //   - aggregator aggregator/src/validate.ts::computeCi
        // Field order MUST match exactly:
        //   [ owner, side(0/1), amount_in, limit_price, order_nonce,
        //     submitted_at_block, path_len, path[0], path[1], path[2] ]
        // Computed in PRIVATE here; only the resulting c_i is enqueued to the PUBLIC
        // _append_order fold, so side/amount/limit/path stay private (dark-pool intact).
        let c_i: Field = poseidon2_hash(
            [
                maker.to_field(),
                if side { 1 } else { 0 },
                amount_in as Field,
                limit_price as Field,
                order_nonce,
                submitted_at_block as Field,
                path_len as Field,
                path[0],
                path[1],
                path[2],
            ],
        );

        // Defer to public execution: epoch-open check first (clean revert message if the
        // epoch has advanced), then the accumulator append (also revertible on capacity).
        // Both callbacks run atomically with this private body; any failure reverts escrow
        // and the OrderNote together.
        self.enqueue_self._assert_epoch_open();
        self.enqueue_self._append_order(c_i);
    }

    /// Submit a new private order to the orderbook.
    ///
    /// Flow:
    /// 1. Validate inputs (`amount_in > 0`, `limit_price > 0`).
    /// 2. Validate Sub-4 path: `path_len` in {2, 3}; all hops in the path must be distinct.
    /// 3. Read the input token address from public-immutable storage (decided by `side`).
    /// 4. Escrow the maker's tokens by calling `Token.transfer_private_to_public`, moving
    ///    `amount_in` of the input token from the maker's private balance into the orderbook
    ///    contract's PUBLIC balance. This contract becomes the custodian until the order is
    ///    cancelled (Week 3) or cleared (Week 6+).
    /// 5. Commit an encrypted `OrderNote` to the maker's private set so they can prove ownership
    ///    later (for cancellation / clearing).
    /// 6. Enqueue a public callback to assert the epoch is still OPEN at the time the tx is mined.
    ///    Epoch state lives in a `PublicMutable`, which is not directly readable from private
    ///    context in Aztec v4.2.0, so the check is deferred to public execution.
    ///
    /// # Arguments
    /// - `side`: `false` = bid (deposit token A), `true` = ask (deposit token B).
    /// - `amount_in`: amount of the input token to escrow (must be > 0).
    /// - `limit_price`: quote-per-base price scaled to 18 decimals (must be > 0).
    /// - `nonce`: authwit nonce for the inner `Token.transfer_private_to_public` call.
    /// - `order_nonce`: per-order random salt embedded into the `OrderNote` for uniqueness.
    /// - `path_len`: Sub-4 routing path length; must be 2 (1-hop) or 3 (2-hop).
    /// - `path`: Sub-4 routing path as token addresses encoded as Fields (3 slots).
    ///   path[0] = input token, path[path_len-1] = output token.
    ///   For path_len == 2, path[2] MUST be 0 (sentinel).
    ///
    /// The `nonce` and `order_nonce` are intentionally distinct so the authwit nonce cannot
    /// collide with the note-identity nonce.
    #[external("private")]
    fn submit_order(
        side: bool,
        amount_in: u128,
        limit_price: u128,
        nonce: Field,
        order_nonce: Field,
        // Sub-4 NEW:
        path_len: u8,
        path: [Field; 3],
    ) {
        self.internal._submit_one_order_internal(side, amount_in, limit_price, nonce, order_nonce, path_len, path);
    }

    /// Sub-6a A2: K-batch order submission. Maker submits 1 real + up to 8 decoys
    /// in a single private tx to fit within Aztec's PXE tagging window.
    ///
    /// Slots with amount_in[i] = 0 are skipped -- allows maker to send fewer than
    /// MAX_ORDERS_PER_BULK without padding all 9 slots with real amounts.
    ///
    /// Each used slot is processed identically to a standalone submit_order call.
    /// Real vs decoy distinction is the maker's PXE-local state (see CLI's
    /// decoy-registry.ts); the contract treats all slots uniformly.
    #[external("private")]
    fn submit_order_bulk(
        side: [bool; MAX_ORDERS_PER_BULK],
        amount_in: [u128; MAX_ORDERS_PER_BULK],
        limit_price: [u128; MAX_ORDERS_PER_BULK],
        nonce: [Field; MAX_ORDERS_PER_BULK],
        order_nonce: [Field; MAX_ORDERS_PER_BULK],
        path_len: [u8; MAX_ORDERS_PER_BULK],
        path: [[Field; 3]; MAX_ORDERS_PER_BULK],
    ) {
        for i in 0..MAX_ORDERS_PER_BULK {
            if amount_in[i] > 0 as u128 {
                self.internal._submit_one_order_internal(
                    side[i], amount_in[i], limit_price[i],
                    nonce[i], order_nonce[i], path_len[i], path[i],
                );
            }
        }
    }

    /// Public callback used by `submit_order` / `cancel_order` to enforce that the
    /// current epoch is OPEN *and* its time window has not elapsed. `only_self`
    /// ensures the callback can only be invoked by this contract via `enqueue_self`.
    #[external("public")]
    #[only_self]
    fn _assert_epoch_open() {
        let epoch = self.storage.current_epoch.read();
        assert(epoch.state == EPOCH_STATE_OPEN, "epoch is not OPEN");
        let block: u32 = self.context.block_number();
        assert(block < epoch.closes_at_block, "epoch has expired; awaiting close_epoch");
    }

    /// Public callback used by `_submit_one_order_internal` to validate that each
    /// hop in the routing path corresponds to a registered pool in the registry.
    /// Reverts otherwise; atomic with the rest of the private body via `enqueue_self`.
    /// `only_self` ensures the callback can only be invoked by this contract.
    #[external("public")]
    #[only_self]
    fn _assert_path_pools_registered(path_len: u8, path: [Field; 3]) {
        let pool_count = self.storage.pool_count.read();
        // Hop 0: path[0] -> path[1]
        let (lo0, hi0) = if (path[0] as u128) < (path[1] as u128) { (path[0], path[1]) } else { (path[1], path[0]) };
        let mut found0: u32 = 0xFFFFFFFF as u32;
        for i in 0..MAX_NUM_POOLS {
            if (i as u32) < pool_count {
                let pa = self.storage.pool_token_a.at(i as u32).read().to_field();
                let pb = self.storage.pool_token_b.at(i as u32).read().to_field();
                if (pa == lo0) & (pb == hi0) {
                    found0 = i as u32;
                }
            }
        }
        assert(found0 != 0xFFFFFFFF as u32, "pool not found for path[0..2]");
        // Hop 1 (only for 2-hop paths): path[1] -> path[2]
        if path_len == 3 {
            let (lo1, hi1) = if (path[1] as u128) < (path[2] as u128) { (path[1], path[2]) } else { (path[2], path[1]) };
            let mut found1: u32 = 0xFFFFFFFF as u32;
            for i in 0..MAX_NUM_POOLS {
                if (i as u32) < pool_count {
                    let pa = self.storage.pool_token_a.at(i as u32).read().to_field();
                    let pb = self.storage.pool_token_b.at(i as u32).read().to_field();
                    if (pa == lo1) & (pb == hi1) {
                        found1 = i as u32;
                    }
                }
            }
            assert(found1 != 0xFFFFFFFF as u32, "pool not found for path[1..3]");
        }
    }

    /// Public callback used by `submit_order` to fold an order commitment into the
    /// epoch's `order_acc` running-hash chain and to enforce the per-epoch cap.
    /// `only_self` keeps this callable only via this contract's `enqueue_self`.
    ///
    /// Capacity revert message is the user-visible signal that 32 orders have been
    /// submitted in the current epoch. The whole tx (including the escrow and the
    /// `OrderNote` insertion) reverts because all callbacks share atomicity with
    /// the private body that enqueued them.
    #[external("public")]
    #[only_self]
    fn _append_order(c_i: Field) {
        let mut epoch = self.storage.current_epoch.read();
        assert(
            epoch.order_count < MAX_ORDERS_PER_EPOCH,
            "epoch order capacity reached",
        );
        epoch.order_acc = poseidon2_hash([epoch.order_acc, c_i]);
        epoch.order_count = epoch.order_count + 1;
        self.storage.current_epoch.write(epoch);
    }

    /// Public callback used by `cancel_order` to fold a cancelled-order commitment
    /// into the epoch's `cancel_acc` running-hash chain. `only_self`.
    ///
    /// H13: fold into cancel_acc/cancel_count ONLY when the order was submitted in the
    /// CURRENT epoch (crate::should_fold_cancel). OrderNotes survive epoch rollovers, so a
    /// prior-epoch cancel would otherwise fold a stale c_i that this epoch's orders[] can
    /// never reproduce -- making the clearing circuit's cancel_acc replay unsatisfiable and
    /// permanently bricking the epoch's clearing. Gating here also makes
    /// `cancel_count <= order_count <= MAX_ORDERS_PER_EPOCH` actually hold. A prior-epoch
    /// cancel still refunds + pushes its double-cancel nullifier (in `cancel_order`); only
    /// the accumulator fold is skipped.
    #[external("public")]
    #[only_self]
    fn _append_cancel(c_i: Field, submitted_at_block: u32) {
        let mut epoch = self.storage.current_epoch.read();
        if crate::should_fold_cancel(submitted_at_block, epoch.opened_at_block) {
            epoch.cancel_acc = poseidon2_hash([epoch.cancel_acc, c_i]);
            epoch.cancel_count = epoch.cancel_count + 1;
            self.storage.current_epoch.write(epoch);
        }
    }

    // ============================ EPOCH TRANSITIONS ============================

    /// Advance the orderbook to a fresh epoch once the current epoch's time window
    /// has elapsed. Performs NO clearing: order_acc/cancel_acc are ZEROED, so any
    /// resting order of the closed epoch is orphaned from verified clearing (its
    /// maker must cancel_order + resubmit; escrow is never lost).
    ///
    /// M16 three-tier gate (a bare close wipes the accumulators a verified clearing
    /// is freshness-bound to, so an unrestricted close could front-run and brick an
    /// in-flight close_epoch_and_clear_verified):
    ///   1. Empty epoch (order_count == 0): anyone, immediately -- nothing to grief.
    ///   2. Non-empty, block < closes_at_block + clear_grace_blocks: only a
    ///      registry-bonded caller (the aggregator's no-cross fallback); the intended
    ///      path for these epochs is close_epoch_and_clear_verified.
    ///   3. Non-empty, at/after closes_at_block + clear_grace_blocks: anyone
    ///      (liveness backstop if every bonded aggregator is dead).
    #[external("public")]
    fn close_epoch() {
        let current = self.storage.current_epoch.read();
        let block: u32 = self.context.block_number();
        assert(block >= current.closes_at_block, "epoch has not expired yet");

        let grace = self.storage.clear_grace_blocks.read();
        if crate::bare_close_needs_bond(current.order_count, block, current.closes_at_block, grace) {
            let registry = self.storage.aggregator_registry.read();
            let bonded: u128 =
                self.view(AggregatorRegistry::at(registry).view_bonded_amount(self.msg_sender()));
            assert(bonded > 0 as u128, "grace: only bonded aggregator may close non-empty epoch");
        }

        let epoch_length = self.storage.epoch_length.read();
        self.storage.current_epoch.write(EpochState {
            epoch_id: current.epoch_id + 1,
            state: EPOCH_STATE_OPEN,
            opened_at_block: block,
            closes_at_block: block + epoch_length,
            order_acc: 0,
            cancel_acc: 0,
            order_count: 0,
            cancel_count: 0,
        });
    }

    /// Sub-4: flatten ClearingPublic to [Field; 123] for the recursive verifier.
    /// Layout MUST match circuits/clearing/src/main.nr's fn main pub arg order.
    ///
    /// Slot layout (Task 7 / clearing-soundness audit):
    ///   [0-3]   order_acc, cancel_acc, order_count, cancel_count
    ///   [4]     fills_root
    ///   [5]     active_pool_count
    ///   [6..]   active_pools[0..3], each PoolClearing = 39 fields:
    ///             [0]    pool_id
    ///             [1]    clearing_price
    ///             [2]    token_lo  (+Task 1)
    ///             [3]    token_hi  (+Task 1)
    ///             [4-7]  a_to_pool / b_to_pool / a_from_pool / b_from_pool
    ///             [8]    current_sqrt_price_after
    ///             [9]    pool_state_commitment  (+Task 1)
    ///             [10]   active_bucket_count
    ///             [11-38] active_bucket_deltas[4] x 7 fields each

    /// Sub-5a B1: derive a per-hop claim nullifier from note_hash + secret + hop_index.
    /// The hop_index makes hop=0 and hop=1 produce DIFFERENT nullifiers from the
    /// same note, so 2-hop orders can claim_fill each leg independently.
    #[contract_library_method]
    fn derive_per_hop_nullifier(note_hash: Field, secret: Field, hop_index: u8) -> Field {
        poseidon2_hash([note_hash, secret, hop_index as Field, Z_HOP_CLAIM_TAG])
    }

    /// Sub-5a B1: derive the cancel-order nullifier (distinct from any per-hop nullifier).
    #[contract_library_method]
    fn derive_cancel_nullifier(note_hash: Field, secret: Field) -> Field {
        poseidon2_hash([note_hash, secret, Z_CANCEL_TAG])
    }

    #[contract_library_method]
    fn flatten_clearing_public(p: ClearingPublic) -> [Field; 123] {
        let mut out: [Field; 123] = [0 as Field; 123];
        out[0] = p.order_acc;
        out[1] = p.cancel_acc;
        out[2] = p.order_count as Field;
        out[3] = p.cancel_count as Field;
        out[4] = p.fills_root;
        out[5] = p.active_pool_count as Field;
        for k in 0..MAX_ACTIVE_POOLS_PER_EPOCH {
            let pc = p.active_pools[k];
            let base = 6 + k * 39;
            out[base + 0] = pc.pool_id as Field;
            out[base + 1] = pc.clearing_price as Field;
            out[base + 2] = pc.token_lo;                          // Field, no `as Field`
            out[base + 3] = pc.token_hi;                          // Field, no `as Field`
            out[base + 4] = pc.swap.a_to_pool as Field;
            out[base + 5] = pc.swap.b_to_pool as Field;
            out[base + 6] = pc.swap.a_from_pool as Field;
            out[base + 7] = pc.swap.b_from_pool as Field;
            out[base + 8] = pc.swap.current_sqrt_price_after as Field;
            out[base + 9] = pc.swap.pool_state_commitment;        // Field, no `as Field`
            out[base + 10] = pc.swap.active_bucket_count as Field;
            for i in 0..4 {
                let d = pc.swap.active_bucket_deltas[i];
                let bd_base = base + 11 + i * 7;
                out[bd_base + 0] = d.bucket_id as Field;
                out[bd_base + 1] = d.reserve_a_add as Field;
                out[bd_base + 2] = d.reserve_a_sub as Field;
                out[bd_base + 3] = d.reserve_b_add as Field;
                out[bd_base + 4] = d.reserve_b_sub as Field;
                out[bd_base + 5] = d.cum_fee_a_per_share_increment as Field;
                out[bd_base + 6] = d.cum_fee_b_per_share_increment as Field;
            }
        }
        out
    }

    // ============================ CLEARING ============================

    /// Apply one epoch's clearing on-chain, gated by a recursive verify of the
    /// Week 5d-2 clearing circuit's proof. The replacement for the W5c
    /// `close_epoch_and_clear`: no authority gate, no trust -- anyone holding
    /// `(public_inputs, proof, vk)` for the current epoch may advance it.
    ///
    /// The full verification key is passed as a calldata arg because Aztec's
    /// MAX_PUBLIC_DATA_UPDATE_REQUESTS_PER_TX (~63) makes storing 127 Field
    /// slots in a single constructor tx infeasible. The contract anchors trust
    /// via `clearing_vk_hash` (stored at deploy): `std::verify_proof_with_type`
    /// takes both `vk` and `vk_hash`, and Honk's internal vk-vs-hash binding
    /// enforces that the supplied `vk` matches `vk_hash`. A mismatched vk
    /// produces a hash that fails this internal check (revert).
    ///
    /// Flow:
    /// 1. Flatten public_inputs to the [Field; 123] vector matching the circuit's pub args.
    /// 2. `std::verify_proof_with_type(vk, proof, flat, vk_hash, 6)` -- recursive ZK-Honk verify.
    /// 3. Enqueue `_apply_verified_clearing` which under public-state guards verifies
    ///    freshness (binding inputs match the current epoch's accumulators), runs the
    ///    net AMM swap + stores fills_root + advances the epoch.
    ///
    /// Replay protection is automatic: an old proof's order_acc cannot match the
    /// post-clearing epoch's reset acc (=0).
    #[external("private")]
    fn close_epoch_and_clear_verified(
        public_inputs: ClearingPublic,
        proof: [Field; 458],
        vk: [Field; 115],
    ) {
        let caller = self.msg_sender();
        // Sub-3: gate on caller being a bonded aggregator. Public callback because
        // private context cannot read PublicMutable on the registry contract.
        self.enqueue_self._assert_aggregator_registered(caller);

        let vk_hash = self.storage.clearing_vk_hash.read();
        // Audit #1 (CRITICAL): bind the proof to the FULL public inputs. The clearing
        // circuit exposes all 123 ClearingPublic fields as pub inputs (order_acc,
        // cancel_acc, counts, fills_root, and every per-pool swap delta). Passing []
        // here previously left the swap deltas + fills_root UNBOUND, letting a bonded
        // aggregator replay a valid proof against fabricated calldata and drain a pool.
        // We now pass the real flattened public inputs, so bb's recursive verify forces
        // calldata == proven values; a single tampered field fails verification (proven
        // empirically: positive verifies, one-field tamper -> "verification failed").
        // proof_type 6 = PROOF_TYPE_HONK_ZK (bb -t noir-recursive, ZK UltraHonk):
        // vk = [Field; 115], proof = [Field; 458] (v5 bb proof size; was 500 on
        // 4.3), public_inputs passed separately.
        let flat = flatten_clearing_public(public_inputs);
        std::verify_proof_with_type(vk, proof, flat, vk_hash, 6);
        self.enqueue_self._apply_verified_clearing(public_inputs, caller);
    }

    /// Public callback: cross-contract read of AggregatorRegistry to gate the
    /// caller. only_self.
    #[external("public")]
    #[only_self]
    fn _assert_aggregator_registered(addr: AztecAddress) {
        let registry = self.storage.aggregator_registry.read();
        let bonded: u128 =
            self.view(AggregatorRegistry::at(registry).view_bonded_amount(addr));
        assert(bonded > 0 as u128, "caller is not a bonded aggregator");
    }

    /// Public callback: run the net AMM swap, store the per-epoch fills root,
    /// and advance the epoch. only_self ensures only the matching
    /// close_epoch_and_clear_verified private call can invoke it.
    ///
    /// `winner` is the AggregatorRegistry-bonded address that submitted the
    /// clearing -- Treasury.pay_aggregator credits this address at the end.
    #[external("public")]
    #[only_self]
    fn _apply_verified_clearing(public_inputs: ClearingPublic, winner: AztecAddress) {
        let current = self.storage.current_epoch.read();
        let block: u32 = self.context.block_number();
        assert(block >= current.closes_at_block, "epoch has not expired yet");

        // Freshness: bind to current epoch's accumulators.
        assert(public_inputs.order_acc == current.order_acc, "order_acc mismatch");
        assert(public_inputs.cancel_acc == current.cancel_acc, "cancel_acc mismatch");
        assert(public_inputs.order_count == current.order_count, "order_count mismatch");
        assert(public_inputs.cancel_count == current.cancel_count, "cancel_count mismatch");

        // Sub-4: apply each active pool's clearing.
        assert(public_inputs.active_pool_count <= MAX_ACTIVE_POOLS_PER_EPOCH,
               "active_pool_count > cap");
        for k in 0..MAX_ACTIVE_POOLS_PER_EPOCH {
            let pc = public_inputs.active_pools[k];
            if pc.pool_id != INVALID_POOL_ID {
                assert((k as u32) < public_inputs.active_pool_count,
                       "non-sentinel pool past active_pool_count");
                let pool_addr = self.storage.pools.at(pc.pool_id).read();
                let token_a = self.storage.pool_token_a.at(pc.pool_id).read();
                let token_b = self.storage.pool_token_b.at(pc.pool_id).read();
                // #3: bind the registry pool selected by pc.pool_id to the pair the
                // circuit actually priced (pc.token_lo/token_hi). Canonicalise by
                // u128 truncation to match the circuit's convention (circuits/clearing
                // /src/main.nr:97, "(token as u128) <"). pc.token_lo/token_hi were made
                // proof-bound in Task 4 (circuit block D'').
                let (lo, hi) = if (token_a.to_field() as u128) < (token_b.to_field() as u128) {
                    (token_a.to_field(), token_b.to_field())
                } else {
                    (token_b.to_field(), token_a.to_field())
                };
                assert((lo == pc.token_lo) & (hi == pc.token_hi), "pool_id pair mismatch");
                // #2 conservation: push the trader inputs INTO the pool BEFORE
                // apply_clearing moves *_from_pool OUT, so the pool always has
                // balance for any same-token outbound and the reserve += a_to_pool
                // credit inside apply_clearing is backed by real tokens. The
                // orderbook is the `from` (msg_sender) -- no auth witness needed.
                if pc.swap.a_to_pool > 0 as u128 {
                    self.call(Token::at(token_a).transfer_public_to_public(
                        self.address, pool_addr, pc.swap.a_to_pool, 0));
                }
                if pc.swap.b_to_pool > 0 as u128 {
                    self.call(Token::at(token_b).transfer_public_to_public(
                        self.address, pool_addr, pc.swap.b_to_pool, 0));
                }
                self.call(LiquidityPool::at(pool_addr).apply_clearing(pc.swap));
            } else {
                assert((k as u32) >= public_inputs.active_pool_count,
                       "sentinel pool inside active range");
            }
        }

        // Store fills_root for the just-cleared epoch.
        self.storage.fills_root.at(current.epoch_id).write(public_inputs.fills_root);

        // Sub-3: pay winning aggregator (silent no-op if treasury under-funded).
        let treasury = self.storage.treasury.read();
        let fee = self.storage.aggregator_fee.read();
        self.call(Treasury::at(treasury).pay_aggregator(winner, fee));

        // Advance epoch.
        let next_epoch_id = current.epoch_id + 1;
        self.storage.current_epoch.write(EpochState {
            epoch_id: next_epoch_id,
            state: EPOCH_STATE_OPEN,
            opened_at_block: block,
            closes_at_block: block + self.storage.epoch_length.read(),
            order_acc: 0,
            cancel_acc: 0,
            order_count: 0,
            cancel_count: 0,
        });
    }

    // ============================ CLAIM FILL ============================

    /// Sub-5a B2: maker claims their per-hop fill from a verified clearing.
    ///
    /// The 64-leaf hop-fills Merkle tree stores leaves of the form:
    ///   poseidon2([order_nonce, hop_index, amount_out, pool_id])
    /// where `hop_index` distinguishes the two legs of a 2-hop order.
    ///
    /// # Arguments
    /// - `epoch_id`: the epoch in which the clearing was settled.
    /// - `order_nonce`: per-order identity nonce (matches the maker's `OrderNote`).
    /// - `hop_index`: 0 for the first hop, 1 for the second (must be < 2).
    /// - `amount_out`: the payout amount the maker is claiming for this hop.
    /// - `pool_id`: the pool that executed this hop's swap.
    /// - `leaf_index`: position of this leaf in the 64-leaf tree (0..63).
    /// - `sibling_path`: depth-6 sibling-hash sequence (log2(64) = 6 levels).
    ///
    /// R1 ownership binding: the hop-fill leaf is
    /// poseidon2([owner, order_nonce, hop_index, amount_out, pool_id]) with owner =
    /// msg_sender. The clearing circuit hashes the FILLED order's owner into the leaf,
    /// so only that maker reconstructs a leaf matching fills_root -- an attacker who
    /// reads a victim's public (order_nonce, amount_out) from /proof cannot claim it.
    ///
    /// R1 double-claim protection: a SETTLEMENT-bound nullifier
    /// poseidon2([Z_HOP_CLAIM_TAG, epoch_id, leaf_index]) marks the (epoch, leaf) slot
    /// consumed -- redeemable EXACTLY ONCE regardless of how many OrderNotes share the
    /// nonce or whether the maker re-submits nonce N later (closes self/cross-epoch
    /// replay). hop=0 and hop=1 occupy distinct leaf_index, so each still redeems once.
    /// (Replaces the old per-NOTE nullifier, which a fresh same-nonce note could bypass.)
    ///
    /// Flow:
    ///   1. Reconstruct the owner-bound leaf with owner = msg_sender.
    ///   2. Verify the Merkle inclusion proof against the stored fills_root.
    ///   3. Push the settlement nullifier; a second claim of this (epoch, leaf) reverts.
    ///   4. Read (NOT pop) the maker's OrderNote via `get_notes` -- only for the path.
    ///   5. Derive the output token from the note's path + hop_index + side.
    ///   6. Transfer the payout from orderbook public balance -> maker private balance.
    #[external("private")]
    fn claim_fill(
        epoch_id: u32,
        order_nonce: Field,
        hop_index: u8,
        amount_out: u128,
        pool_id: u32,
        leaf_index: u32,           // 0..63
        sibling_path: [Field; 6],  // log2(64) = 6 sibling hashes
    ) {
        assert(hop_index < 2 as u8, "hop_index must be 0 or 1");
        assert(leaf_index < 64 as u32, "leaf_index >= 64");

        // The claimant. R1: bound into the leaf so only the filled maker (whose
        // address the clearing circuit hashed into the leaf) can redeem this fill.
        let maker = self.msg_sender();

        // 1. Reconstruct the hop-fill leaf.
        //    R1: poseidon2([owner, order_nonce, hop_index, amount_out, pool_id]) with
        //    owner = msg_sender. Byte-identical to circuits/clearing/src/merkle.nr's
        //    hop_fill_leaf + aggregator/src/merkle.ts. An attacker who is not the filled
        //    owner hashes a different leaf -> Merkle root mismatch -> no payout (closes
        //    cross-maker theft, since order_nonce/amount_out are public via /proof).
        let leaf = poseidon2_hash([
            maker.to_field(),
            order_nonce,
            hop_index as Field,
            amount_out as Field,
            pool_id as Field,
        ]);

        // 2. Walk the depth-6 Merkle path and verify against the stored fills_root.
        let computed_root = verify_merkle_proof_64(leaf, leaf_index, sibling_path);
        self.enqueue_self._assert_fill_root(epoch_id, computed_root);

        // 2b. R1: SETTLEMENT-BOUND nullifier. Mark this (epoch_id, leaf_index) settlement
        //     slot consumed so the fill is redeemable EXACTLY ONCE -- regardless of how
        //     many OrderNotes share order_nonce, or whether the maker re-submits nonce N
        //     in a later epoch. The OLD per-NOTE nullifier (note_hash, secret, hop_index)
        //     let a fresh note re-claim the still-stored fills_root[epoch] (self/cross-epoch
        //     replay). leaf_index uniquely identifies one fill within the epoch's tree, so
        //     hop=0 and hop=1 (distinct leaf_index) still each redeem once.
        let settlement_nullifier =
            poseidon2_hash([Z_HOP_CLAIM_TAG, epoch_id as Field, leaf_index as Field]);
        self.context.push_nullifier_unsafe(settlement_nullifier);

        // 3. READ (not pop) the maker's OrderNote -- needed only to resolve the routing
        //    path (output token) below; the per-(epoch,leaf) nullifier above is what
        //    prevents double-claim, so the note is NOT nullified here.
        let options = NoteGetterOptions::new().select(
            // `nonce` lives at PACK SLOT 2 (manual Packable, see the struct/pack note
            // above). The #[note] macro derives OrderNote::properties().nonce from the
            // STRUCT position (index 4 = path[0]) and never consults the manual pack,
            // so properties().nonce silently mis-selects path[0] and never matches a
            // real note ("order not found"). Select the true pack slot directly.
            PropertySelector { index: 2, offset: 0, length: 32 },
            Comparator.EQ,
            order_nonce,
        ).set_limit(1);
        let confirmed_notes: BoundedVec<ConfirmedNote<OrderNote>, _> =
            self.storage.orders.at(maker).get_notes(options);
        assert(confirmed_notes.len() == 1, "order not found");
        let confirmed = confirmed_notes.get(0);
        let order = confirmed.note;
        // Defense in depth: the owner-bound leaf (step 1) already proves msg_sender is
        // the filled maker via the Merkle root; this keeps the explicit note-owner check.
        assert(order.owner == maker, "not order owner");

        // (Double-claim prevention is the per-(epoch,leaf) settlement nullifier in step 2b.
        //  The note is intentionally NOT nullified, so a 2-hop order's hop=1 can still read
        //  it after hop=0 -- each hop has a distinct leaf_index, hence a distinct nullifier.)

        // 5. Determine the OUTPUT token for this hop from the stored routing path.
        //
        //    Path encoding (OrderNote):
        //      path[0]             = input token  (what the maker escrowed)
        //      path[path_len - 1]  = final output token
        //    For path_len == 2 (1-hop):  path = [token_in, token_out, 0_sentinel]
        //    For path_len == 3 (2-hop):  path = [token_in, token_mid, token_out]
        //
        //    Bid (side=false): maker sends path[0], receives along the path left->right.
        //      hop=0 output = path[1]  (always the next token in the forward direction)
        //      hop=1 output = path[2]  (only valid for path_len == 3)
        //
        //    Ask (side=true): maker sends path[path_len-1], receives along the path right->left.
        //      hop=0 output = path[path_len - 2]
        //        1-hop (path_len=2): path[0]
        //        2-hop (path_len=3): path[1]  (intermediate)
        //      hop=1 output = path[0]          (only valid for path_len == 3)
        let output_token: Field = if !order.side {
            // bid: traverse path left->right; hop N outputs path[N+1]
            if hop_index == 0 as u8 {
                order.path[1]
            } else {
                order.path[2]  // path_len must be 3 for hop=1
            }
        } else {
            // ask: traverse path right->left; hop N outputs path[path_len-2-N]
            if hop_index == 0 as u8 {
                if order.path_len == 2 as u8 {
                    order.path[0]  // 1-hop ask: receive path[0]
                } else {
                    order.path[1]  // 2-hop ask hop=0: intermediate = path[1]
                }
            } else {
                order.path[0]  // 2-hop ask hop=1: final = path[0]
            }
        };
        let token_out_addr = AztecAddress::from_field(output_token);

        // 6. Transfer the payout from the Orderbook's public balance to the maker (private).
        self.call(Token::at(token_out_addr).transfer_public_to_private(
            self.address,
            maker,
            amount_out,
            0,
        ));
    }

    /// Public callback for claim_fill -- assert the locally-recomputed root matches
    /// the per-epoch root recorded in storage by _apply_verified_clearing. only_self.
    #[external("public")]
    #[only_self]
    fn _assert_fill_root(epoch_id: u32, computed_root: Field) {
        let stored = self.storage.fills_root.at(epoch_id).read();
        assert(stored != 0, "no clearing recorded for epoch");
        assert(computed_root == stored, "fill merkle root mismatch");
    }

    // ============================ HOP-FILL MERKLE HELPER ============================

    /// Recompute the root of a depth-6 (64-leaf) Merkle tree from a single leaf and
    /// its sibling path. The LSB of `leaf_index` at each level selects whether the
    /// current node is a left (0) or right (1) child.
    ///
    /// Matches the JS `buildHopFillsTree` / aggregator witness builder convention:
    ///   parent = poseidon2([left, right])
    ///
    /// Called by `claim_fill`; also usable in tests.
    #[contract_library_method]
    fn verify_merkle_proof_64(leaf: Field, leaf_index: u32, sibling_path: [Field; 6]) -> Field {
        let mut current = leaf;
        let mut idx = leaf_index;
        for _i in 0..6 {
            let sibling = sibling_path[_i];
            let is_right = (idx & 1) == 1;
            idx = idx >> 1;
            current = if is_right {
                poseidon2_hash([sibling, current])
            } else {
                poseidon2_hash([current, sibling])
            };
        }
        current
    }

    // ============================ ORDER CANCELLATION ============================

    /// Cancel a resting order and return its escrow to the maker's PRIVATE balance.
    ///
    /// Cancellation is rejected once an order has been filled by a clearing - a
    /// filled order must be redeemed via `claim_fill` instead.
    ///
    /// Flow:
    /// 1. Retrieve (and nullify) the caller's `OrderNote` whose identity nonce equals
    ///    `order_nonce`. Exactly one note must match.
    /// 2. Read the escrowed token address from public-immutable storage, decided by the
    ///    note's `side` (false -> token A, true -> token B) - mirrors the same
    ///    side->token mapping as `submit_order` (symmetric, using `order.side`).
    /// 3. Call `Token.transfer_public_to_private` to move `amount_in` of that token from
    ///    the orderbook's PUBLIC balance back into the maker's PRIVATE balance. Because
    ///    `from` is this contract and this contract is the caller, the Token's
    ///    `authorize_once("from", _nonce)` guard passes without an authwit.
    /// 4. Enqueue the `_assert_epoch_open` callback so the whole tx reverts if the epoch
    ///    is no longer OPEN at mine time.
    ///
    /// # Arguments
    /// - `order_nonce`: the per-order identity nonce embedded in the target `OrderNote`
    ///   (the same value passed as `order_nonce` to `submit_order`).
    /// - `nonce`: authwit nonce for the inner `Token.transfer_public_to_private` call.
    #[external("private")]
    fn cancel_order(order_nonce: Field, nonce: Field) {
        let maker = self.msg_sender();

        // 1. READ (not pop) the maker's OrderNote matching `order_nonce`.
        //    We use get_notes (like claim_fill) rather than pop_notes, because
        //    double-cancellation is blocked by the domain-separated cancel nullifier
        //    we push below -- not by removing the note from the PrivateSet.
        //    Using get_notes also keeps the API surface consistent with B2 (claim_fill).
        let options = NoteGetterOptions::new().select(
            // `nonce` lives at PACK SLOT 2 (manual Packable, see the struct/pack note
            // above). The #[note] macro derives OrderNote::properties().nonce from the
            // STRUCT position (index 4 = path[0]) and never consults the manual pack,
            // so properties().nonce silently mis-selects path[0] and never matches a
            // real note ("order not found"). Select the true pack slot directly.
            PropertySelector { index: 2, offset: 0, length: 32 },
            Comparator.EQ,
            order_nonce,
        ).set_limit(1);
        let confirmed_notes: BoundedVec<ConfirmedNote<OrderNote>, _> =
            self.storage.orders.at(maker).get_notes(options);
        assert(confirmed_notes.len() == 1, "order not found");
        let confirmed = confirmed_notes.get(0);
        let order = confirmed.note;

        // Defence-in-depth: the per-owner PrivateSet already scopes retrieval to `maker`.
        assert(order.owner == maker, "not order owner");

        // 2. Derive + emit the CANCEL nullifier (Sub-5a B3).
        //    nullifier = poseidon2([note_hash, nhk_app, Z_CANCEL_TAG])
        //
        //    This is domain-separated from claim_fill's per-hop nullifiers (which use
        //    Z_HOP_CLAIM_TAG and include hop_index). A second cancel attempt on the same
        //    OrderNote will push the same nullifier and revert at the kernel level.
        //
        //    The OrderNote itself remains in the PrivateSet -- claim_fill's get_notes call
        //    would still find it -- but once cancelled the escrow (public balance) has been
        //    refunded, so any subsequent fill-claim will underflow the token transfer and
        //    atomically revert.
        let note_hash = order.compute_note_hash(
            confirmed.owner,
            confirmed.storage_slot,
            confirmed.randomness,
        );
        let owner_npk_m_hash = get_public_keys(maker).npk_m_hash;
        let secret = self.context.request_nhk_app(owner_npk_m_hash);
        let cancel_nullifier = derive_cancel_nullifier(note_hash, secret);
        self.context.push_nullifier_unsafe(cancel_nullifier);

        // 3. Derive the escrowed token from the order's stored path (Sub-4 B2).
        //    side == false (bid): maker escrowed path[0]  (input paid left->right)
        //    side == true  (ask): maker escrowed path[path_len-1] (input paid right->left)
        //    This must match submit_order's escrow direction exactly.
        let cancel_input_token: Field = if !order.side {
            order.path[0]
        } else {
            if order.path_len == 2 { order.path[1] } else { order.path[2] }
        };
        let token_addr: AztecAddress = AztecAddress::from_field(cancel_input_token);

        // 4. Recompute the same per-order commitment submit_order folded into order_acc.
        //    The ConfirmedNote carries every preimage field, so this matches the original
        //    c_i exactly. Equality with the submit-side c_i is what makes the submit-cancel
        //    invariant (IT4) hold.
        //    Audit #2: this MUST be the SAME 10-field formula as _submit_one_order_internal's
        //    c_i (and binding.nr::c_i_path), now including path_len + path[0..2]. The cancel
        //    chain folds this full c_i (see _append_cancel) -- the circuit's
        //    replay_cancel_chain_with_path folds c_i_path(order) identically.
        let c_i: Field = poseidon2_hash(
            [
                maker.to_field(),
                if order.side { 1 } else { 0 },
                order.amount_in as Field,
                order.limit_price as Field,
                order.nonce,
                order.submitted_at_block as Field,
                order.path_len as Field,
                order.path[0],
                order.path[1],
                order.path[2],
            ],
        );

        // 5. Gate cancellation to OPEN, fold into cancel_acc, BEFORE the escrow return.
        //    The 5c _assert_not_filled guard is dropped in 5d-4: cancel-after-fill is
        //    blocked at the token-contract level -- _apply_verified_clearing physically
        //    transfers filled amount_in (a_to_pool / b_to_pool) from the orderbook's
        //    public balance into the pool (audit #2 conservation fix), leaving the
        //    orderbook public balance short, so transfer_public_to_private underflows
        //    and the whole tx atomically reverts.
        self.enqueue_self._assert_epoch_open();
        // H13: pass the note's anchor block so the fold is gated to same-epoch orders.
        self.enqueue_self._append_cancel(c_i, order.submitted_at_block);

        // 6. Return the escrow: orderbook PUBLIC balance -> maker PRIVATE balance.
        self.call(Token::at(token_addr).transfer_public_to_private(
            self.address,
            maker,
            order.amount_in,
            nonce,
        ));
    }

    // ============================ UNCONSTRAINED GETTERS ============================
    // These utility functions exist so TXE tests (and off-chain callers) can read state
    // without requiring an on-chain transaction.

    #[external("utility")]
    unconstrained fn get_epoch() -> EpochState {
        self.storage.current_epoch.read()
    }

    /// Sub-4: returns the canonical token_a (lower Field) for a given pool_id.
    #[external("utility")]
    unconstrained fn get_pool_token_a(pool_id: u32) -> AztecAddress {
        self.storage.pool_token_a.at(pool_id).read()
    }

    /// Sub-4: returns the canonical token_b (higher Field) for a given pool_id.
    #[external("utility")]
    unconstrained fn get_pool_token_b(pool_id: u32) -> AztecAddress {
        self.storage.pool_token_b.at(pool_id).read()
    }

    #[external("utility")]
    unconstrained fn get_epoch_length() -> u32 {
        self.storage.epoch_length.read()
    }

    /// Sub-4: takes pool_id; returns the Pool contract address for that pool.
    #[external("utility")]
    unconstrained fn get_pool_addr(pool_id: u32) -> AztecAddress {
        self.storage.pools.at(pool_id).read()
    }

    /// Sub-4: returns the number of registered pools.
    #[external("utility")]
    unconstrained fn get_pool_count() -> u32 {
        self.storage.pool_count.read()
    }

    /// Exposes the embedded clearing-circuit VK hash.
    #[external("utility")]
    unconstrained fn get_clearing_vk_hash() -> Field {
        self.storage.clearing_vk_hash.read()
    }

    /// The per-epoch Merkle settlement root (0 == no clearing recorded for that epoch).
    /// A maker reads this to confirm an epoch has been cleared before constructing
    /// an inclusion proof for claim_fill.
    #[external("utility")]
    unconstrained fn get_fills_root(epoch_id: u32) -> Field {
        self.storage.fills_root.at(epoch_id).read()
    }

    /// Sub-3 utility getters.
    #[external("utility")]
    unconstrained fn get_aggregator_registry() -> AztecAddress {
        self.storage.aggregator_registry.read()
    }

    #[external("utility")]
    unconstrained fn get_treasury() -> AztecAddress {
        self.storage.treasury.read()
    }

    #[external("utility")]
    unconstrained fn get_aggregator_fee() -> u128 {
        self.storage.aggregator_fee.read()
    }

    /// Return the resting orders owned by `owner` (up to MAX_NOTES_PER_PAGE). `owner` is
    /// passed explicitly rather than read from `msg_sender` because utility functions are
    /// simulated, and only the owner's PXE holds the encrypted notes to resolve.
    ///
    /// Note: in aztec-nr v4.2.0 a `PrivateSet` in a `UtilityContext` exposes only
    /// `view_notes(NoteViewerOptions)` (there is no `get_notes` on the utility context),
    /// and `view_notes` is bounded by `MAX_NOTES_PER_PAGE` (= 10), not `MAX_INPUT_NOTES`.
    ///
    /// The returned orders are UNORDERED: they are NOT sorted by `submitted_at_block`
    /// (or any other field). Callers must not assume any particular ordering and should
    /// sort themselves if order matters.
    #[external("utility")]
    unconstrained fn get_orders(owner: AztecAddress) -> BoundedVec<OrderNote, MAX_NOTES_PER_PAGE> {
        self.storage.orders.at(owner).view_notes(NoteViewerOptions::new())
    }

    pub mod test;
}
