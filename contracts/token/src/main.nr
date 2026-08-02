// Token -- generic reusable token contract.
// Brand (name, symbol, decimals) is passed as deploy-time constructor arguments.
// Compiled artifact: target/token-Token.json

pub mod test;

use aztec::macros::aztec;

// M19: sha256_to_field is not traversable from the crate root via aztec::protocol::hash
// (pub use protocol_types as protocol in aztec does not create a downstream-accessible path).
// We pull sha256 directly and inline field_from_bytes_32_trunc (protocol_types/src/utils/field.nr).
// The computation is byte-identical to aztec::protocol::hash::sha256_to_field.
use sha256::digest as sha256_digest;

// Sub-5b C1: domain-separation tags for bridge flow content hashes. These
// MUST be kept in sync byte-for-byte with contracts-l1/src/lib/DataStructures.sol's
// DEPOSIT_PUBLIC_TAG / DEPOSIT_PRIVATE_TAG / WITHDRAW_PUBLIC_TAG / WITHDRAW_PRIVATE_TAG.
// ASCII-padded labels with a 1-byte discriminant; leading bytes zeroed so all
// values fit in BN254 field. The L1 portal commits each tag in the content
// hash; the L2 Token side reconstructs via sha256_to_field over identical
// byte serialization. Hoisted to crate root so golden tests in test.nr can
// reference these globals directly (production pinning - M19 coverage).
pub global DEPOSIT_PUBLIC_TAG:   Field = 0x000000000000000000000000000000000000000000005a535741505f44505f01;
pub global DEPOSIT_PRIVATE_TAG:  Field = 0x000000000000000000000000000000000000000000005a535741505f44505f02;
pub global WITHDRAW_PUBLIC_TAG:  Field = 0x000000000000000000000000000000000000000000005a535741505f57445f03;
pub global WITHDRAW_PRIVATE_TAG: Field = 0x000000000000000000000000000000000000000000005a535741505f57445f04;

// Inline of protocol_types::utils::field::field_from_bytes_32_trunc.
// Converts the first 31 bytes of a 32-byte array to a BN254 Field (drops byte 31, big-endian).
fn field_trunc_31(h: [u8; 32]) -> Field {
    let mut v: Field = 1;
    let mut high: Field = 0;
    let mut low: Field = 0;
    for i in 0..15 {
        low = low + (h[30 - i] as Field) * v;
        v = v * 256;
        high = high + (h[14 - i] as Field) * v;
    }
    low = low + (h[15] as Field) * v;
    low + high * v
}

/// M19: the L1->L2 deposit content hash. Byte-identical to L1's
/// _depositContent(abi.encode(bytes32, uint256, bytes32, bytes32)) -- 4 x 32 = 128 bytes,
/// big-endian, then sha256_to_field (sha256 truncated to 31 bytes, zero-prefixed).
/// Crate-root pure fn (the #[aztec] macro rejects non-method fns inside the contract);
/// referenced as crate::deposit_content by claim_public / claim_private and the tests.
pub fn deposit_content(to: Field, amount: u128, secret_hash: Field, tag: Field) -> Field {
    let mut bytes: [u8; 128] = [0; 128];
    let to_b: [u8; 32] = to.to_be_bytes();
    let amt_b: [u8; 32] = (amount as Field).to_be_bytes();
    let sh_b: [u8; 32] = secret_hash.to_be_bytes();
    let tag_b: [u8; 32] = tag.to_be_bytes();
    for i in 0..32 {
        bytes[i] = to_b[i];
        bytes[32 + i] = amt_b[i];
        bytes[64 + i] = sh_b[i];
        bytes[96 + i] = tag_b[i];
    }
    field_trunc_31(sha256_digest(bytes))
}

/// M19: the L2->L1 withdraw content hash. Byte-identical to L1's
/// _withdrawContent(abi.encode(bytes32(uint160(recipient)), uint256, bytes32)) -- 3 x 32
/// = 96 bytes. Referenced as crate::withdraw_content by exit_to_l1_public / _private.
pub fn withdraw_content(recipient: Field, amount: u128, tag: Field) -> Field {
    let mut bytes: [u8; 96] = [0; 96];
    let r_b: [u8; 32] = recipient.to_be_bytes();
    let amt_b: [u8; 32] = (amount as Field).to_be_bytes();
    let tag_b: [u8; 32] = tag.to_be_bytes();
    for i in 0..32 {
        bytes[i] = r_b[i];
        bytes[32 + i] = amt_b[i];
        bytes[64 + i] = tag_b[i];
    }
    field_trunc_31(sha256_digest(bytes))
}

#[aztec]
pub contract Token {
    // aztec library
    use aztec::{
        hash::compute_secret_hash,
        macros::{
            events::event,
            functions::{authorize_once, external, initializer, internal, only_self, view},
            storage::storage,
        },
        messages::delivery::MessageDelivery,
        protocol::{
            address::{AztecAddress, EthAddress},
            traits::{FromField, ToField},
        },
        state_vars::{Map, Owned, PublicImmutable, PublicMutable, StateVariable},
    };
    // note library
    use uint_note::{PartialUintNote, UintNote};
    // compression library
    use compressed_string::FieldCompressedString;
    // private balance library
    use balance_set::BalanceSet;

    global INITIAL_TRANSFER_CALL_MAX_NOTES: u32 = 2;
    global RECURSIVE_TRANSFER_CALL_MAX_NOTES: u32 = 8;

    // Sentinel address used in Transfer events to represent the private side of a balance change.
    global PRIVATE_ADDRESS_MAGIC_VALUE: AztecAddress =
        AztecAddress::from_field(0x1ea7e01501975545617c2e694d931cb576b691a4a867fed81ebd3264);

    #[event]
    struct Transfer {
        from: AztecAddress,
        to: AztecAddress,
        amount: u128,
    }

    #[storage]
    struct Storage<Context> {
        name: PublicImmutable<FieldCompressedString, Context>,
        symbol: PublicImmutable<FieldCompressedString, Context>,
        decimals: PublicImmutable<u8, Context>,
        private_balances: Owned<BalanceSet<Context>, Context>,
        total_supply: PublicMutable<u128, Context>,
        public_balances: Map<AztecAddress, PublicMutable<u128, Context>, Context>,
        minter: PublicImmutable<AztecAddress, Context>,
        // Sub-5b: bridge configuration. Set once at deploy; immutable.
        is_bridged: PublicImmutable<bool, Context>,
        portal_addr: PublicImmutable<EthAddress, Context>,
    }

    #[external("public")]
    #[initializer]
    fn constructor_with_initial_supply(
        name: str<31>,
        symbol: str<31>,
        decimals: u8,
        initial_supply: u128,
        to: AztecAddress,
    ) {
        self.storage.name.initialize(FieldCompressedString::from_string(name));
        self.storage.symbol.initialize(FieldCompressedString::from_string(symbol));
        self.storage.decimals.initialize(decimals);
        self.storage.is_bridged.initialize(false);
        self.storage.portal_addr.initialize(EthAddress::zero());

        self.internal._mint_to_public(to, initial_supply);
    }

    #[external("public")]
    #[initializer]
    fn constructor_with_minter(name: str<31>, symbol: str<31>, decimals: u8, minter: AztecAddress) {
        self.storage.name.initialize(FieldCompressedString::from_string(name));
        self.storage.symbol.initialize(FieldCompressedString::from_string(symbol));
        self.storage.decimals.initialize(decimals);
        self.storage.minter.initialize(minter);
        self.storage.is_bridged.initialize(false);
        self.storage.portal_addr.initialize(EthAddress::zero());
    }

    /// Sub-5b: bridge-mode constructor. Sets is_bridged=true + portal_addr.
    /// Mint paths are minter-gated only (the !is_bridged guard was removed for the
    /// hybrid model); functionally equivalent to constructor_with_minter_and_portal.
    #[external("public")]
    #[initializer]
    fn constructor_with_minter_bridged(
        name: str<31>,
        symbol: str<31>,
        decimals: u8,
        minter: AztecAddress,
        portal_addr: EthAddress,
    ) {
        assert(portal_addr != EthAddress::zero(), "bridged token requires non-zero portal_addr");
        self.storage.name.initialize(FieldCompressedString::from_string(name));
        self.storage.symbol.initialize(FieldCompressedString::from_string(symbol));
        self.storage.decimals.initialize(decimals);
        self.storage.minter.initialize(minter);
        self.storage.is_bridged.initialize(true);
        self.storage.portal_addr.initialize(portal_addr);
    }

    /// Hybrid (testnet): mintable AND bridge-claimable. Sets minter + portal,
    /// is_bridged=true. mint_* is gated by minter; claim_* is gated by portal.
    ///
    /// After the !is_bridged guard removal, this constructor produces the same on-chain
    /// state as constructor_with_minter_bridged. A NON-mintable bridged token (mainnet)
    /// is achieved by deploying with a minter address that no caller can match (e.g. an
    /// unspendable address), NOT by constructor choice -- both constructors are equivalent.
    ///
    /// WARNING: a live minter on a bridge-claimable token = two independent supply-inflation
    /// paths (mint + claim). Mainnet must deploy with an unspendable minter.
    #[external("public")]
    #[initializer]
    fn constructor_with_minter_and_portal(
        name: str<31>,
        symbol: str<31>,
        decimals: u8,
        minter: AztecAddress,
        portal_addr: EthAddress,
    ) {
        assert(portal_addr != EthAddress::zero(), "hybrid token requires non-zero portal_addr");
        self.storage.name.initialize(FieldCompressedString::from_string(name));
        self.storage.symbol.initialize(FieldCompressedString::from_string(symbol));
        self.storage.decimals.initialize(decimals);
        self.storage.minter.initialize(minter);
        self.storage.is_bridged.initialize(true);
        self.storage.portal_addr.initialize(portal_addr);
    }

    // ============================== PRIVATE ==============================

    #[authorize_once("from", "_nonce")]
    #[external("private")]
    fn transfer_private_to_public(
        from: AztecAddress,
        to: AztecAddress,
        amount: u128,
        _nonce: Field,
    ) {
        self.internal._decrease_private_balance(from, amount, INITIAL_TRANSFER_CALL_MAX_NOTES);
        self.enqueue_self.increase_public_balance_internal(to, amount);
    }

    #[authorize_once("from", "_nonce")]
    #[external("private")]
    fn transfer_private_to_public_with_commitment(
        from: AztecAddress,
        to: AztecAddress,
        amount: u128,
        _nonce: Field,
    ) -> Field {
        self.internal._decrease_private_balance(from, amount, INITIAL_TRANSFER_CALL_MAX_NOTES);
        self.enqueue_self.increase_public_balance_internal(to, amount);

        let completer = self.msg_sender();
        let commitment = self.internal._initialize_transfer_commitment(to, completer);
        commitment.to_field()
    }

    #[authorize_once("from", "_nonce")]
    #[external("private")]
    fn transfer_private_to_private(
        from: AztecAddress,
        to: AztecAddress,
        amount: u128,
        _nonce: Field,
    ) {
        self.internal._decrease_private_balance(from, amount, INITIAL_TRANSFER_CALL_MAX_NOTES);
        self.internal._increase_private_balance(to, amount);
    }

    #[authorize_once("from", "_nonce")]
    #[external("private")]
    fn transfer_private_to_commitment(
        from: AztecAddress,
        commitment: Field,
        amount: u128,
        _nonce: Field,
    ) {
        self.internal._decrease_private_balance(from, amount, INITIAL_TRANSFER_CALL_MAX_NOTES);

        let completer = self.msg_sender();
        PartialUintNote::from_field(commitment).complete_from_private(
            self.context,
            completer,
            self.storage.private_balances.get_storage_slot(),
            amount,
        );
    }

    #[authorize_once("from", "_nonce")]
    #[external("private")]
    fn transfer_public_to_private(
        from: AztecAddress,
        to: AztecAddress,
        amount: u128,
        _nonce: Field,
    ) {
        self.enqueue_self.decrease_public_balance_internal(from, amount);
        self.internal._increase_private_balance(to, amount);
    }

    #[external("private")]
    fn initialize_transfer_commitment(to: AztecAddress, completer: AztecAddress) -> Field {
        let commitment = self.internal._initialize_transfer_commitment(to, completer);
        commitment.to_field()
    }

    #[external("private")]
    #[only_self]
    fn recurse_subtract_balance_internal(account: AztecAddress, amount: u128) -> u128 {
        self.internal._subtract_balance(account, amount, RECURSIVE_TRANSFER_CALL_MAX_NOTES)
    }

    // ============================== PUBLIC ===============================

    #[authorize_once("from", "_nonce")]
    #[external("public")]
    fn transfer_public_to_public(
        from: AztecAddress,
        to: AztecAddress,
        amount: u128,
        _nonce: Field,
    ) {
        self.internal._decrease_public_balance(from, amount);
        self.internal._increase_public_balance(to, amount);

        self.emit(Transfer { from, to, amount });
    }

    #[authorize_once("from", "_nonce")]
    #[external("public")]
    fn transfer_public_to_commitment(
        from: AztecAddress,
        commitment: Field,
        amount: u128,
        _nonce: Field,
    ) {
        self.internal._decrease_public_balance(from, amount);

        let completer = self.msg_sender();
        self.internal._increase_commitment_balance(
            PartialUintNote::from_field(commitment),
            completer,
            amount,
        );

        self.emit(Transfer { from, to: PRIVATE_ADDRESS_MAGIC_VALUE, amount });
    }

    #[external("public")]
    #[only_self]
    fn increase_public_balance_internal(to: AztecAddress, amount: u128) {
        self.internal._increase_public_balance(to, amount);
        self.emit(Transfer { from: PRIVATE_ADDRESS_MAGIC_VALUE, to, amount });
    }

    #[external("public")]
    #[only_self]
    fn decrease_public_balance_internal(from: AztecAddress, amount: u128) {
        self.internal._decrease_public_balance(from, amount);
        self.emit(Transfer { from, to: PRIVATE_ADDRESS_MAGIC_VALUE, amount });
    }

    // ============================ VIEW FUNCTIONS =========================

    #[external("public")]
    #[view]
    fn balance_of_public(owner: AztecAddress) -> u128 {
        self.storage.public_balances.at(owner).read()
    }

    #[external("public")]
    #[view]
    fn total_supply() -> u128 {
        self.storage.total_supply.read()
    }

    #[external("public")]
    #[view]
    fn name() -> FieldCompressedString {
        self.storage.name.read()
    }

    #[external("public")]
    #[view]
    fn symbol() -> FieldCompressedString {
        self.storage.symbol.read()
    }

    #[external("public")]
    #[view]
    fn decimals() -> u8 {
        self.storage.decimals.read()
    }

    #[external("public")]
    #[view]
    fn is_bridged() -> bool {
        self.storage.is_bridged.read()
    }

    #[external("public")]
    #[view]
    fn portal_addr() -> EthAddress {
        self.storage.portal_addr.read()
    }

    // ============================ UNCONSTRAINED ==========================

    #[external("utility")]
    unconstrained fn balance_of_private(owner: AztecAddress) -> u128 {
        self.storage.private_balances.at(owner).balance_of()
    }

    // =============================== MINTABLE ============================

    #[external("private")]
    fn mint_to_private(to: AztecAddress, amount: u128) {
        _validate_minter(self.msg_sender(), self.storage.minter.read());
        self.internal._mint_to_private(to, amount);
    }

    #[external("public")]
    fn mint_to_public(to: AztecAddress, amount: u128) {
        _validate_minter(self.msg_sender(), self.storage.minter.read());
        self.internal._mint_to_public(to, amount);
    }

    #[external("public")]
    fn mint_to_commitment(commitment: Field, amount: u128) {
        let completer = self.msg_sender();
        _validate_minter(completer, self.storage.minter.read());
        self.internal._increase_total_supply(amount);
        self.internal._increase_commitment_balance(
            PartialUintNote::from_field(commitment),
            completer,
            amount,
        );

        self.emit(Transfer { from: AztecAddress::zero(), to: PRIVATE_ADDRESS_MAGIC_VALUE, amount });
    }

    #[external("public")]
    #[only_self]
    fn increase_total_supply_internal(amount: u128) {
        self.internal._increase_total_supply(amount);
        self.emit(Transfer { from: AztecAddress::zero(), to: PRIVATE_ADDRESS_MAGIC_VALUE, amount });
    }

    // -- Sub-5b: BRIDGE FLOW -------------------------------------------------------
    // L1<->L2 deposit + withdraw functions for bridged tokens (is_bridged=true).
    // Each function consumes / emits an Aztec L1<->L2 message via the portal at
    // portal_addr (set at deploy via constructor_with_minter_bridged or constructor_with_minter_and_portal).
    //
    // Content-hash format: sha256_to_field over abi.encode-style 32-byte field
    // serialization. Both deposit + withdraw flows use the canonical Aztec
    // L1<->L2 message format (matching contracts-l1/src/TokenBridge.sol's
    // _sha256ToField helper).
    //
    // Domain-separator tags (DEPOSIT_PUBLIC/PRIVATE_TAG, WITHDRAW_PUBLIC/PRIVATE_TAG)
    // in the globals block above prevent cross-flow content-hash collisions.
    //
    // PRIVATE FLOWS:
    //   - claim_private: recipient is NOT bound in content hash (mirrors L1's
    //     bytes32(0) recipient -- privacy by design). The `to` param drives the
    //     L2 mint only.
    //   - exit_to_l1_private: emits WITHDRAW_PRIVATE_TAG content; NO L1 CONSUMER
    //     EXISTS yet -- keep the warning on the function until Sub-5c adds the
    //     L1 withdrawPrivate path.

    /// Sub-5b: Consume an L1-to-L2 deposit message from the portal and mint
    /// `amount` to `to` in PUBLIC balance.
    ///
    /// Content hash mirrors L1's _depositContent(l2Recipient, amount, secretHash, tag)
    /// via sha256_to_field over abi.encode layout (4 x 32 bytes = 128 bytes).
    #[external("public")]
    fn claim_public(to: AztecAddress, amount: u128, secret: Field, message_leaf_index: Field) {
        let bridged = self.storage.is_bridged.read();
        assert(bridged, "non-bridged token: use mint_to_public");
        assert(amount > 0 as u128, "amount must be positive");
        let portal = self.storage.portal_addr.read();

        // DO NOT change compute_secret_hash() -- that derivation is protocol-defined
        // and matches what the user submits to depositToL2Public on L1 as secretHash.
        let secret_hash = compute_secret_hash([secret]);

        let content = crate::deposit_content(to.to_field(), amount, secret_hash, crate::DEPOSIT_PUBLIC_TAG);

        // Consume the L1-to-L2 message. Reverts if message absent, already consumed,
        // or secret doesn't match the committed secret_hash.
        self.context.consume_l1_to_l2_message(content, [secret], portal, message_leaf_index);

        // Mint via the same internal helpers used by mint_to_public.
        self.internal._increase_public_balance(to, amount);
        self.internal._increase_total_supply(amount);
        self.emit(Transfer { from: AztecAddress::zero(), to, amount });
    }

    /// Sub-5b: Same as claim_public but mints to PRIVATE balance.
    ///
    /// Content hash mirrors L1's _depositContent(bytes32(0), amount, secretHash, tag)
    /// via sha256_to_field over abi.encode layout (4 x 32 bytes = 128 bytes).
    ///
    /// Sub-5b C1: claim_private's content hash mirrors L1's bytes32(0) recipient
    /// placeholder (privacy by design). The `to` param directs the L2 mint only;
    /// anyone with `secret` can call claim_private + route the mint to any L2
    /// address. Routing is the maker's responsibility via the secret preimage.
    #[external("private")]
    fn claim_private(to: AztecAddress, amount: u128, secret: Field, message_leaf_index: Field) {
        let bridged = self.storage.is_bridged.read();
        assert(bridged, "non-bridged token: use mint_to_private");
        assert(amount > 0 as u128, "amount must be positive");
        let portal = self.storage.portal_addr.read();

        // DO NOT change compute_secret_hash() -- that derivation is protocol-defined
        // and matches what the user submits to depositToL2Private on L1 as secretHash.
        let secret_hash = compute_secret_hash([secret]);

        // Sub-5b C1: claim_private's content hash does NOT bind `to` -- it mirrors L1's
        // depositToL2Private which commits bytes32(0) as the recipient placeholder
        // (privacy by design -- L1 doesn't know who claims on L2). The `to` parameter
        // directs the mint at L2; anyone with the secret can call claim_private and
        // route the mint to any L2 address.
        let content = crate::deposit_content(0, amount, secret_hash, crate::DEPOSIT_PRIVATE_TAG);

        self.context.consume_l1_to_l2_message(content, [secret], portal, message_leaf_index);

        // Mint via the same internal helpers used by mint_to_private.
        self.internal._increase_private_balance(to, amount);
        self.enqueue_self.increase_total_supply_internal(amount);
    }

    /// Sub-5b: Burn `amount` of caller's PUBLIC balance and emit an L2-to-L1
    /// withdrawal message via the Aztec Outbox.
    ///
    /// Content hash mirrors L1's _withdrawContent(recipient, amount, tag)
    /// via sha256_to_field over abi.encode layout (3 x 32 bytes = 96 bytes).
    #[external("public")]
    fn exit_to_l1_public(amount: u128, l1_recipient: EthAddress) {
        let bridged = self.storage.is_bridged.read();
        assert(bridged, "non-bridged token: cannot exit_to_l1");
        assert(amount > 0 as u128, "amount must be positive");
        assert(l1_recipient != EthAddress::zero(), "l1_recipient must be non-zero");

        let portal = self.storage.portal_addr.read();
        let caller = self.msg_sender();

        // Burn caller's public balance via the same internal helper used by burn_public.
        // CEI: state-change (burn) happens BEFORE the L2-to-L1 message emission.
        self.internal._burn_public(caller, amount);

        let content = crate::withdraw_content(l1_recipient.to_field(), amount, crate::WITHDRAW_PUBLIC_TAG);
        self.context.message_portal(portal, content);
    }

    /// Sub-5b: Nullify private notes worth `amount` from caller's balance and
    /// emit an L2-to-L1 withdrawal message via the Aztec Outbox.
    ///
    /// Content hash mirrors L1's _withdrawContent layout (3 x 32 bytes = 96 bytes)
    /// via sha256_to_field with WITHDRAW_PRIVATE_TAG.
    #[external("private")]
    fn exit_to_l1_private(amount: u128, l1_recipient: EthAddress) {
        // Sub-5c B3: WITHDRAW_PRIVATE_TAG content is consumed by L1's withdrawPrivate
        // function (separate from withdraw, which consumes WITHDRAW_PUBLIC_TAG). The
        // L1 portal validates the proof + releases the canonical token to recipient,
        // just like the public path. The privacy benefit is that the L2 emit doesn't
        // reveal the public-tag content shape (off-chain analysis cannot batch-link
        // public + private exits via tag).
        let bridged = self.storage.is_bridged.read();
        assert(bridged, "non-bridged token: cannot exit_to_l1");
        assert(amount > 0 as u128, "amount must be positive");
        assert(l1_recipient != EthAddress::zero(), "l1_recipient must be non-zero");

        let portal = self.storage.portal_addr.read();
        let caller = self.msg_sender();

        // Burn caller's private notes via the same internal helper used by burn_private.
        // CEI: state-change (burn) happens BEFORE the L2-to-L1 message emission.
        self.internal._burn_private(caller, amount);

        let content = crate::withdraw_content(l1_recipient.to_field(), amount, crate::WITHDRAW_PRIVATE_TAG);
        self.context.message_portal(portal, content);
    }

    // =============================== BURNABLE ============================

    #[authorize_once("from", "_nonce")]
    #[external("private")]
    fn burn_private(from: AztecAddress, amount: u128, _nonce: Field) {
        self.internal._burn_private(from, amount);
    }

    #[authorize_once("from", "_nonce")]
    #[external("public")]
    fn burn_public(from: AztecAddress, amount: u128, _nonce: Field) {
        self.internal._burn_public(from, amount);
    }

    #[external("public")]
    #[only_self]
    fn decrease_total_supply_internal(amount: u128) {
        self.internal._decrease_total_supply(amount);
        self.emit(Transfer { from: PRIVATE_ADDRESS_MAGIC_VALUE, to: AztecAddress::zero(), amount });
    }

    // ============================ INTERNAL HELPERS ========================

    #[contract_library_method]
    fn _validate_minter(sender: AztecAddress, minter: AztecAddress) {
        assert(minter.eq(sender), "caller is not minter");
    }

    #[internal("private")]
    fn _decrease_private_balance(account: AztecAddress, amount: u128, max_notes: u32) {
        let change = self.internal._subtract_balance(account, amount, max_notes);
        self.storage.private_balances.at(account).add(change).deliver(
            MessageDelivery::onchain_constrained(),
        );
    }

    #[internal("private")]
    fn _increase_private_balance(to: AztecAddress, amount: u128) {
        self.storage.private_balances.at(to).add(amount).deliver(MessageDelivery::onchain_constrained());
    }

    #[internal("public")]
    fn _increase_public_balance(to: AztecAddress, amount: u128) {
        let new_balance = self.storage.public_balances.at(to).read() + amount;
        self.storage.public_balances.at(to).write(new_balance);
    }

    #[internal("public")]
    fn _decrease_public_balance(from: AztecAddress, amount: u128) {
        let new_balance = self.storage.public_balances.at(from).read() - amount;
        self.storage.public_balances.at(from).write(new_balance);
    }

    #[internal("public")]
    fn _increase_commitment_balance(
        commitment: PartialUintNote,
        completer: AztecAddress,
        amount: u128,
    ) {
        commitment.complete(
            self.context,
            completer,
            self.storage.private_balances.get_storage_slot(),
            amount,
        );
    }

    #[internal("private")]
    fn _subtract_balance(account: AztecAddress, amount: u128, max_notes: u32) -> u128 {
        let subtracted = self.storage.private_balances.at(account).try_sub(amount, max_notes);
        if subtracted >= amount {
            subtracted - amount
        } else {
            assert(subtracted > 0, "Balance too low");
            let remaining = amount - subtracted;
            self.call_self.recurse_subtract_balance_internal(account, remaining)
        }
    }

    #[internal("public")]
    fn _increase_total_supply(amount: u128) {
        let new_supply = self.storage.total_supply.read() + amount;
        self.storage.total_supply.write(new_supply);
    }

    #[internal("public")]
    fn _decrease_total_supply(amount: u128) {
        let new_supply = self.storage.total_supply.read() - amount;
        self.storage.total_supply.write(new_supply);
    }

    #[internal("private")]
    fn _initialize_transfer_commitment(
        to: AztecAddress,
        completer: AztecAddress,
    ) -> PartialUintNote {
        let commitment = UintNote::partial(to, self.context, to, completer);
        commitment
    }

    #[internal("public")]
    fn _mint_to_public(to: AztecAddress, amount: u128) {
        self.internal._increase_public_balance(to, amount);
        self.internal._increase_total_supply(amount);
        self.emit(Transfer { from: AztecAddress::zero(), to, amount });
    }

    #[internal("private")]
    fn _mint_to_private(to: AztecAddress, amount: u128) {
        self.internal._increase_private_balance(to, amount);
        self.enqueue_self.increase_total_supply_internal(amount);
    }

    #[internal("public")]
    fn _burn_public(from: AztecAddress, amount: u128) {
        self.internal._decrease_public_balance(from, amount);
        self.internal._decrease_total_supply(amount);
        self.emit(Transfer { from, to: AztecAddress::zero(), amount });
    }

    #[internal("private")]
    fn _burn_private(from: AztecAddress, amount: u128) {
        self.internal._decrease_private_balance(from, amount, INITIAL_TRANSFER_CALL_MAX_NOTES);
        self.enqueue_self.decrease_total_supply_internal(amount);
    }
}
