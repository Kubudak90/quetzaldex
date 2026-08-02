use aztec::macros::aztec;

/// L18: bound how many pending relayer claims a single submitter may hold in the shared
/// MAX_PENDING_RELAYER_CLAIMS (=32) queue, so no single actor can spam-fill it and revert
/// honest makers with "queue full". Crate-root pure fn (the #[aztec] macro rejects free
/// fns inside the contract); the cap is passed in (a crate-root helper cannot read the
/// contract-module global -- M19 lesson). Referenced as crate::under_sender_cap.
pub fn under_sender_cap(count: u32, cap: u32) -> bool {
    count < cap
}

#[aztec]
pub contract Treasury {
    use aztec::{
        macros::{
            functions::{external, initializer, only_self},
            storage::storage,
        },
        protocol::{
            address::{AztecAddress, EthAddress},
            traits::{Deserialize, Packable, Serialize},
        },
        state_vars::{Map, PublicImmutable, PublicMutable},
    };

    use token::Token;
    use aggregator_registry::AggregatorRegistry;

    /// Sub-5c D1: max pending relayer claims at any time. If the queue fills,
    /// new opt-in claims revert; makers either wait or self-claim on L1.
    global MAX_PENDING_RELAYER_CLAIMS: u32 = 32;

    // L18: per-submitter cap on the shared 32-slot relayer queue. 4 of 32 -> one actor
    // holds <= 12.5%; filling the queue needs 8 distinct funded accounts, each paying
    // Aztec tx fees per enqueue.
    global MAX_PENDING_PER_SENDER: u32 = 4;

    /// Sub-5c D1: an opt-in relayer claim queued by a maker alongside their L2 exit.
    /// The relayer submits the L1 withdraw in exchange for `fee`, paid out of
    /// tracked_balance at consume time.
    #[derive(Deserialize, Eq, Packable, Serialize)]
    pub struct RelayerClaim {
        pub id: u64,
        pub l2_tx_hash: Field,
        pub expected_content: Field,
        pub l1_recipient: EthAddress,
        pub amount: u128,
        pub fee: u128,
        pub requested_at_block: u32,
        // L18: address that queued this claim; used to decrement pending_by_sender on consume.
        pub submitter: AztecAddress,
    }

    #[storage]
    struct Storage<Context> {
        bond_token: PublicImmutable<AztecAddress, Context>,
        orderbook_addr: PublicImmutable<AztecAddress, Context>,
        /// R3: AggregatorRegistry. consume_relayer_claim gates the caller to a
        /// bonded aggregator (mirrors Orderbook::_assert_aggregator_registered),
        /// so the protocol-fee pool can no longer be drained by an anonymous call.
        aggregator_registry: PublicImmutable<AztecAddress, Context>,
        deployer: PublicImmutable<AztecAddress, Context>,
        /// Internal balance accounting. Increments on deposit and seed_public;
        /// decrements on pay_aggregator. Avoids the need to cross-contract read
        /// Token.balance_of_public (which returns a PublicStaticCall<...> shape
        /// that is awkward to plumb through env.execute_utility in TXE tests).
        tracked_balance: PublicMutable<u128, Context>,
        // Sub-5c D1: opt-in relayer queue. Maker calls queue_relayer_claim at L2
        // exit time; bonded aggregator (Sub-3) polls + claims on L1; consume
        // pays fee out of tracked_balance.
        pending_relayer_claims_count: PublicMutable<u32, Context>,
        pending_relayer_claims_next_id: PublicMutable<u64, Context>,
        pending_relayer_claims: Map<u32, PublicMutable<RelayerClaim, Context>, Context>,
        // L18: pending-claim count per submitter (bounded by MAX_PENDING_PER_SENDER).
        pending_by_sender: Map<AztecAddress, PublicMutable<u32, Context>, Context>,
    }

    #[external("public")]
    #[initializer]
    fn constructor(
        bond_token: AztecAddress,
        orderbook_addr: AztecAddress,
        aggregator_registry: AztecAddress,
        deployer: AztecAddress,
    ) {
        self.storage.bond_token.initialize(bond_token);
        self.storage.orderbook_addr.initialize(orderbook_addr);
        self.storage.aggregator_registry.initialize(aggregator_registry);
        self.storage.deployer.initialize(deployer);
        self.storage.tracked_balance.write(0 as u128);
        // Sub-5c D1: initialise relayer claim queue counters.
        self.storage.pending_relayer_claims_count.write(0 as u32);
        self.storage.pending_relayer_claims_next_id.write(0 as u64);
    }

    /// Pay the clearing winner a flat fee. ONLY callable by the orderbook
    /// contract. Silently transfers min(amount, tracked_balance) -- never reverts
    /// on under-funded treasury, so a dry treasury does NOT block clearing.
    #[external("public")]
    fn pay_aggregator(winner: AztecAddress, amount: u128) {
        let caller = self.msg_sender();
        let orderbook = self.storage.orderbook_addr.read();
        assert(caller == orderbook, "only orderbook");

        let balance = self.storage.tracked_balance.read();
        let pay = if balance < amount { balance } else { amount };
        if pay > 0 as u128 {
            let bond_token = self.storage.bond_token.read();
            self.call(Token::at(bond_token).transfer_public_to_public(
                self.address,
                winner,
                pay,
                0,
            ));
            self.storage.tracked_balance.write(balance - pay);
        }
    }

    /// Top up the treasury by escrowing `amount` of bond_token from the caller's
    /// private balance to the treasury's public balance. Increments tracked_balance
    /// via the public callback.
    #[external("private")]
    fn deposit(amount: u128, nonce: Field) {
        let caller = self.msg_sender();
        let bond_token = self.storage.bond_token.read();
        self.call(Token::at(bond_token).transfer_private_to_public(
            caller,
            self.address,
            amount,
            nonce,
        ));
        self.enqueue_self._increment_tracked(amount);
    }

    /// Deploy-time helper to seed the treasury from the public balance of the
    /// deployer (e.g., scripts/deploy-tokens.ts mints to the treasury, then
    /// calls this to record the credit). Only the deployer can call. Tests use
    /// this in lieu of Token-authwit machinery.
    #[external("public")]
    fn seed_public(amount: u128) {
        let caller = self.msg_sender();
        let deployer = self.storage.deployer.read();
        assert(caller == deployer, "only deployer");
        // Caller has already minted `amount` of bond_token to this contract's
        // public balance via Token.mint_to_public (or equivalent); we just
        // update our tracked accounting.
        let prev = self.storage.tracked_balance.read();
        self.storage.tracked_balance.write(prev + amount);
    }

    /// Public callback for deposit. only_self.
    #[external("public")]
    #[only_self]
    fn _increment_tracked(amount: u128) {
        let prev = self.storage.tracked_balance.read();
        self.storage.tracked_balance.write(prev + amount);
    }

    #[external("utility")]
    unconstrained fn get_bond_token() -> AztecAddress {
        self.storage.bond_token.read()
    }

    #[external("utility")]
    unconstrained fn get_orderbook_addr() -> AztecAddress {
        self.storage.orderbook_addr.read()
    }

    #[external("utility")]
    unconstrained fn get_aggregator_registry() -> AztecAddress {
        self.storage.aggregator_registry.read()
    }

    #[external("utility")]
    unconstrained fn get_tracked_balance() -> u128 {
        self.storage.tracked_balance.read()
    }

    // --------------------------------------------------------------------------
    // Sub-5c D1: opt-in relayer claim queue
    // --------------------------------------------------------------------------

    /// Sub-5c D1: maker queues an opt-in relayer claim alongside their L2 exit.
    /// The relayer will submit the L1 withdraw in exchange for `fee` (paid out
    /// of treasury's tracked_balance at consume time).
    ///
    /// Returns the assigned claim id.
    #[external("public")]
    fn queue_relayer_claim(
        l2_tx_hash: Field,
        expected_content: Field,
        l1_recipient: EthAddress,
        amount: u128,
        fee: u128,
    ) -> u64 {
        assert(amount > 0 as u128, "amount must be positive");
        assert(fee > 0 as u128, "fee must be positive");
        // R3: a claim can never authorize paying out more than its own stated
        // exit amount. Bounds the per-claim payout (defense in depth on top of
        // the consume bonded-gate); blocks the `amount=1, fee=whole-pool` drain.
        assert(fee <= amount, "fee exceeds claim amount");

        let count = self.storage.pending_relayer_claims_count.read();
        assert(count < MAX_PENDING_RELAYER_CLAIMS, "queue full");

        let sender = self.msg_sender();
        let sender_count = self.storage.pending_by_sender.at(sender).read();
        assert(crate::under_sender_cap(sender_count, MAX_PENDING_PER_SENDER),
               "per-sender claim cap");

        let id = self.storage.pending_relayer_claims_next_id.read();
        self.storage.pending_relayer_claims_next_id.write(id + 1);

        let claim = RelayerClaim {
            id,
            l2_tx_hash,
            expected_content,
            l1_recipient,
            amount,
            fee,
            requested_at_block: self.context.block_number(),
            submitter: sender,
        };
        self.storage.pending_relayer_claims.at(count).write(claim);
        self.storage.pending_relayer_claims_count.write(count + 1);
        self.storage.pending_by_sender.at(sender).write(sender_count + 1);

        id
    }

    /// Sub-5c D1: relayer marks a queued claim as consumed (after submitting the
    /// L1 withdraw). Treasury pays out `fee` to the relayer (caller). Compacts
    /// the queue by moving the last entry into the consumed slot.
    ///
    /// R3 (CRITICAL fix): the caller MUST be a bonded aggregator. Previously this
    /// was permissionless, so anyone could `queue_relayer_claim(amount=1,
    /// fee=tracked_balance)` then `consume_relayer_claim` and transfer the entire
    /// protocol-fee pool to themselves with zero L1 interaction. Gating to a
    /// bonded aggregator (mirrors Orderbook::_assert_aggregator_registered) plus
    /// the queue-time `fee <= amount` cap and the `min(fee, amount, balance)`
    /// payout below removes the unauthenticated drain. NOTE (residual, tracked
    /// follow-up): a *bonded* aggregator is still trusted not to fabricate claims;
    /// fully closing that needs binding consumption to a verified L1 outbox
    /// withdraw. consume is public, so we read the registry view inline.
    #[external("public")]
    fn consume_relayer_claim(claim_id: u64) {
        let relayer = self.msg_sender();

        let registry = self.storage.aggregator_registry.read();
        let bonded: u128 = self.view(AggregatorRegistry::at(registry).view_bonded_amount(relayer));
        assert(bonded > 0 as u128, "caller is not a bonded aggregator");

        let count = self.storage.pending_relayer_claims_count.read();

        // Linear scan to find the slot containing the claim with this id.
        let mut found_slot: u32 = MAX_PENDING_RELAYER_CLAIMS;
        for i in 0..MAX_PENDING_RELAYER_CLAIMS {
            if i < count {
                let entry = self.storage.pending_relayer_claims.at(i).read();
                if entry.id == claim_id {
                    found_slot = i;
                }
            }
        }
        assert(found_slot < MAX_PENDING_RELAYER_CLAIMS, "claim not found");

        let entry = self.storage.pending_relayer_claims.at(found_slot).read();

        // L18: free the submitter's slot allocation.
        let submitter = entry.submitter;
        let submitter_count = self.storage.pending_by_sender.at(submitter).read();
        if submitter_count > 0 {
            self.storage.pending_by_sender.at(submitter).write(submitter_count - 1);
        }

        // Compact: move last entry into the freed slot (skip if found_slot is last).
        let last_slot = count - 1;
        if found_slot != last_slot {
            let last_entry = self.storage.pending_relayer_claims.at(last_slot).read();
            self.storage.pending_relayer_claims.at(found_slot).write(last_entry);
        }
        self.storage.pending_relayer_claims_count.write(last_slot);

        // Pay relayer fee from tracked_balance. R3: cap to min(fee, amount, balance)
        // -- never pay more than the claim's stated exit amount, and never revert if
        // the treasury is dry.
        let balance = self.storage.tracked_balance.read();
        let fee_capped = if entry.fee < entry.amount { entry.fee } else { entry.amount };
        let to_pay = if fee_capped < balance { fee_capped } else { balance };
        if to_pay > 0 as u128 {
            self.storage.tracked_balance.write(balance - to_pay);
            let bond_token = self.storage.bond_token.read();
            self.call(Token::at(bond_token).transfer_public_to_public(
                self.address,
                relayer,
                to_pay,
                0,
            ));
        }
    }

    /// Sub-5c D1: utility getter for the current pending claim count.
    #[external("utility")]
    unconstrained fn get_pending_relayer_claims_count() -> u32 {
        self.storage.pending_relayer_claims_count.read()
    }

    /// Sub-5c D2 follow-up: read a single relayer claim by slot index.
    /// The D2 relayer daemon walks slots [0, count) to enumerate the queue.
    #[external("utility")]
    unconstrained fn get_pending_relayer_claim_at(index: u32) -> pub RelayerClaim {
        self.storage.pending_relayer_claims.at(index).read()
    }

    pub mod test;
}
