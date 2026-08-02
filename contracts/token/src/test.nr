// TXE tests for the Token contract - two brands (tUSDC 6 dec, tETH 18 dec).
// Run with: pnpm test:noir  (compiles then invokes nargo via Docker)

use crate::Token;
use aztec::{
    protocol::address::{AztecAddress, EthAddress},
    test::helpers::test_environment::TestEnvironment,
};

// tUSDC brand constants
// "tUSDC" + 26 '0' chars = 31 ASCII chars.
global TUSDC_NAME: str<31> = "tUSDC00000000000000000000000000";
global TUSDC_SYMBOL: str<31> = "tUSDC00000000000000000000000000";
global TUSDC_DECIMALS: u8 = 6;

// tETH brand constants
// "tETH" + 27 '0' chars = 31 ASCII chars.
global TETH_NAME: str<31> = "tETH000000000000000000000000000";
global TETH_SYMBOL: str<31> = "tETH000000000000000000000000000";
global TETH_DECIMALS: u8 = 18;

// aUSDC bridged brand constants
// "aUSDC" + 26 '0' chars = 31 ASCII chars.
global AUSDC_NAME: str<31> = "aUSDC00000000000000000000000000";
global AUSDC_SYMBOL: str<31> = "aUSDC00000000000000000000000000";
global AUSDC_DECIMALS: u8 = 6;

// deploy helpers

unconstrained fn deploy_token(
    env: &mut TestEnvironment,
    deployer: AztecAddress,
    minter: AztecAddress,
    name: str<31>,
    symbol: str<31>,
    decimals: u8,
) -> AztecAddress {
    let initializer_call = Token::interface().constructor_with_minter(
        name,
        symbol,
        decimals,
        minter,
    );
    env.deploy("@token/Token").with_public_initializer(deployer, initializer_call)
}

unconstrained fn deploy_bridged_token(
    env: &mut TestEnvironment,
    deployer: AztecAddress,
    minter: AztecAddress,
    name: str<31>,
    symbol: str<31>,
    decimals: u8,
    portal_addr: EthAddress,
) -> AztecAddress {
    let initializer_call = Token::interface().constructor_with_minter_bridged(
        name,
        symbol,
        decimals,
        minter,
        portal_addr,
    );
    env.deploy("@token/Token").with_public_initializer(deployer, initializer_call)
}

unconstrained fn deploy_hybrid_token(
    env: &mut TestEnvironment,
    deployer: AztecAddress,
    minter: AztecAddress,
    name: str<31>,
    symbol: str<31>,
    decimals: u8,
    portal_addr: EthAddress,
) -> AztecAddress {
    let initializer_call = Token::interface().constructor_with_minter_and_portal(
        name,
        symbol,
        decimals,
        minter,
        portal_addr,
    );
    env.deploy("@token/Token").with_public_initializer(deployer, initializer_call)
}

// tUSDC tests

#[test]
unconstrained fn mint_to_private_balance_tusdc() {
    let mut env = TestEnvironment::new();
    let admin = env.create_light_account();
    let _other = env.create_light_account();

    let token_address = deploy_token(&mut env, admin, admin, TUSDC_NAME, TUSDC_SYMBOL, TUSDC_DECIMALS);

    // 1000.000000 tUSDC (6 decimals)
    let mint_amount: u128 = 1_000_000_000;
    env.call_private(admin, Token::at(token_address).mint_to_private(admin, mint_amount));

    let balance = env.execute_utility(Token::at(token_address).balance_of_private(admin));
    assert(balance == mint_amount, "tUSDC: minted balance mismatch");
}

#[test]
unconstrained fn private_transfer_moves_balance_tusdc() {
    let mut env = TestEnvironment::new();
    let alice = env.create_light_account();
    let bob = env.create_light_account();

    let token_address = deploy_token(&mut env, alice, alice, TUSDC_NAME, TUSDC_SYMBOL, TUSDC_DECIMALS);

    let mint_amount: u128 = 100_000_000;
    env.call_private(alice, Token::at(token_address).mint_to_private(alice, mint_amount));

    let transfer_amount: u128 = 30_000_000;
    env.call_private(
        alice,
        Token::at(token_address).transfer_private_to_private(alice, bob, transfer_amount, 0),
    );

    let alice_balance = env.execute_utility(Token::at(token_address).balance_of_private(alice));
    let bob_balance = env.execute_utility(Token::at(token_address).balance_of_private(bob));

    assert(alice_balance == mint_amount - transfer_amount, "alice should have 70 tUSDC");
    assert(bob_balance == transfer_amount, "bob should have 30 tUSDC");
}

// tETH tests

#[test]
unconstrained fn mint_to_private_balance_teth() {
    let mut env = TestEnvironment::new();
    let admin = env.create_light_account();
    let _other = env.create_light_account();

    let token_address = deploy_token(&mut env, admin, admin, TETH_NAME, TETH_SYMBOL, TETH_DECIMALS);

    // 1 tETH (18 decimals)
    let mint_amount: u128 = 1_000_000_000_000_000_000;
    env.call_private(admin, Token::at(token_address).mint_to_private(admin, mint_amount));

    let balance = env.execute_utility(Token::at(token_address).balance_of_private(admin));
    assert(balance == mint_amount, "tETH: minted balance mismatch");
}

#[test]
unconstrained fn private_transfer_moves_balance_teth() {
    let mut env = TestEnvironment::new();
    let alice = env.create_light_account();
    let bob = env.create_light_account();

    let token_address = deploy_token(&mut env, alice, alice, TETH_NAME, TETH_SYMBOL, TETH_DECIMALS);

    // Mint 5 tETH to Alice.
    let mint_amount: u128 = 5_000_000_000_000_000_000;
    env.call_private(alice, Token::at(token_address).mint_to_private(alice, mint_amount));

    // Transfer 2.5 tETH from Alice to Bob (private -> private).
    let transfer_amount: u128 = 2_500_000_000_000_000_000;
    env.call_private(
        alice,
        Token::at(token_address).transfer_private_to_private(alice, bob, transfer_amount, 0),
    );

    let alice_balance = env.execute_utility(Token::at(token_address).balance_of_private(alice));
    let bob_balance = env.execute_utility(Token::at(token_address).balance_of_private(bob));

    assert(alice_balance == mint_amount - transfer_amount, "alice should have 2.5 tETH left");
    assert(bob_balance == transfer_amount, "bob should have 2.5 tETH");
}

// -- Sub-5b: bridge-mode TXE tests --

// mint_to_public now succeeds in bridge mode (minter-gated, not bridged-gated).
#[test]
unconstrained fn sub5b_mint_to_public_succeeds_via_minter_in_bridge_mode() {
    let mut env = TestEnvironment::new();
    let admin = env.create_light_account();
    let portal_l1 = EthAddress::from_field(0xabcdef);

    let token_address = deploy_bridged_token(
        &mut env, admin, admin, AUSDC_NAME, AUSDC_SYMBOL, AUSDC_DECIMALS, portal_l1,
    );

    // Minter can now mint even in bridge mode (hybrid behaviour) -- no revert means success
    env.call_public(admin, Token::at(token_address).mint_to_public(admin, 100 as u128));
}

// mint_to_private now succeeds in bridge mode (minter-gated, not bridged-gated).
#[test]
unconstrained fn sub5b_mint_to_private_succeeds_via_minter_in_bridge_mode() {
    let mut env = TestEnvironment::new();
    let admin = env.create_light_account();
    let portal_l1 = EthAddress::from_field(0xabcdef);

    let token_address = deploy_bridged_token(
        &mut env, admin, admin, AUSDC_NAME, AUSDC_SYMBOL, AUSDC_DECIMALS, portal_l1,
    );

    // No revert means success; balance readable via execute_utility
    env.call_private(admin, Token::at(token_address).mint_to_private(admin, 100 as u128));
    let bal = env.execute_utility(Token::at(token_address).balance_of_private(admin));
    assert(bal == 100 as u128, "bridged-mode: private minted balance mismatch");
}

#[test(should_fail_with = "non-bridged token: use mint_to_public")]
unconstrained fn sub5b_claim_public_reverts_in_non_bridge_mode() {
    let mut env = TestEnvironment::new();
    let admin = env.create_light_account();

    // Default (non-bridged) constructor
    let token_address = deploy_token(&mut env, admin, admin, TUSDC_NAME, TUSDC_SYMBOL, TUSDC_DECIMALS);

    // claim_public should revert because is_bridged=false
    env.call_public(
        admin,
        Token::at(token_address).claim_public(admin, 100 as u128, 0 as Field, 0 as Field),
    );
}

#[test(should_fail_with = "bridged token requires non-zero portal_addr")]
unconstrained fn sub5b_bridged_constructor_rejects_zero_portal() {
    let mut env = TestEnvironment::new();
    let admin = env.create_light_account();
    let zero_portal = EthAddress::zero();

    let _ = deploy_bridged_token(
        &mut env, admin, admin, AUSDC_NAME, AUSDC_SYMBOL, AUSDC_DECIMALS, zero_portal,
    );
}

#[test(should_fail_with = "non-bridged token: cannot exit_to_l1")]
unconstrained fn sub5b_exit_to_l1_reverts_in_non_bridge_mode() {
    let mut env = TestEnvironment::new();
    let admin = env.create_light_account();
    let token_address = deploy_token(&mut env, admin, admin, TUSDC_NAME, TUSDC_SYMBOL, TUSDC_DECIMALS);

    let l1_recipient = EthAddress::from_field(0xdeadbeef);
    env.call_public(admin, Token::at(token_address).exit_to_l1_public(100 as u128, l1_recipient));
}

// -- Hybrid constructor TXE tests --

/// Hybrid token: mint_to_public by the minter SUCCEEDS (key new behaviour).
/// The token is both is_bridged=true AND has a live minter.
#[test]
unconstrained fn hybrid_mint_to_public_by_minter_succeeds() {
    let mut env = TestEnvironment::new();
    let admin = env.create_light_account();
    let portal_l1 = EthAddress::from_field(0x1234abcd);

    let token_address = deploy_hybrid_token(
        &mut env, admin, admin, AUSDC_NAME, AUSDC_SYMBOL, AUSDC_DECIMALS, portal_l1,
    );

    // Minter mints to public balance -- no revert means success (is_bridged guard removed)
    let mint_amount: u128 = 500_000_000;
    env.call_public(admin, Token::at(token_address).mint_to_public(admin, mint_amount));

    let bal = env.view_public(Token::at(token_address).balance_of_public(admin));
    assert(bal == mint_amount, "hybrid: public minted balance mismatch");
}

/// Hybrid token: mint_to_public by a non-minter REVERTS (minter guard still active).
#[test(should_fail_with = "caller is not minter")]
unconstrained fn hybrid_mint_to_public_by_non_minter_reverts() {
    let mut env = TestEnvironment::new();
    let admin = env.create_light_account();
    let other = env.create_light_account();
    let portal_l1 = EthAddress::from_field(0x1234abcd);

    let token_address = deploy_hybrid_token(
        &mut env, admin, admin, AUSDC_NAME, AUSDC_SYMBOL, AUSDC_DECIMALS, portal_l1,
    );

    // Non-minter attempts mint -- must revert
    env.call_public(other, Token::at(token_address).mint_to_public(other, 100 as u128));
}

/// Hybrid constructor rejects zero portal address.
#[test(should_fail_with = "hybrid token requires non-zero portal_addr")]
unconstrained fn hybrid_constructor_rejects_zero_portal() {
    let mut env = TestEnvironment::new();
    let admin = env.create_light_account();
    let zero_portal = EthAddress::zero();

    let _ = deploy_hybrid_token(
        &mut env, admin, admin, AUSDC_NAME, AUSDC_SYMBOL, AUSDC_DECIMALS, zero_portal,
    );
}

/// Hybrid token: claim_public guard still asserts is_bridged=true (rejects non-bridged tokens).
/// We verify this by deploying a plain minter token (is_bridged=false) and checking
/// claim_public reverts, which proves the claim guard is still active.
/// The hybrid token itself (is_bridged=true) allows claim_public when given a valid L1 message
/// (which we cannot fake in TXE, so we only test the negative here).
#[test(should_fail_with = "non-bridged token: use mint_to_public")]
unconstrained fn hybrid_non_bridged_token_claim_public_still_reverts() {
    let mut env = TestEnvironment::new();
    let admin = env.create_light_account();

    // Plain minter token (is_bridged=false) -- claim_public must revert
    let token_address = deploy_token(&mut env, admin, admin, TUSDC_NAME, TUSDC_SYMBOL, TUSDC_DECIMALS);
    env.call_public(
        admin,
        Token::at(token_address).claim_public(admin, 100 as u128, 0 as Field, 0 as Field),
    );
}

// M19: golden-vector parity for the L1<->L2 content hash. Values from an independent
// oracle (sha256(concat)[0:31] zero-prefixed); the SAME literals are asserted on the
// L1 Solidity and SDK sides, so any field-order / tag / truncation regression in any of
// the three impls fails here. Fixed inputs: to/l2r=0x11.., secretHash=0x22..,
// amount=123456789, l1recipient=0x33..33 (20 bytes -> field 0x00..00333..33).
// Tags are referenced via crate::{DEPOSIT,WITHDRAW}_{PUBLIC,PRIVATE}_TAG so that a
// regression in any production tag global causes these tests to fail (M19 coverage).
global M19_AMOUNT: u128 = 123456789;
global M19_TO: Field = 0x1111111111111111111111111111111111111111111111111111111111111111;
global M19_SH: Field = 0x2222222222222222222222222222222222222222222222222222222222222222;
global M19_L1: Field = 0x0000000000000000000000003333333333333333333333333333333333333333;

#[test]
fn m19_deposit_public_golden() {
    let got = crate::deposit_content(M19_TO, M19_AMOUNT, M19_SH, crate::DEPOSIT_PUBLIC_TAG);
    assert(got == 0x0082e259c24bad647156f027ed63128d24811b86968547273efa5738a375fcc7,
           "deposit public content hash regressed");
}

#[test]
fn m19_deposit_private_golden() {
    // L1 private deposit commits bytes32(0) as recipient (privacy placeholder).
    let got = crate::deposit_content(0, M19_AMOUNT, M19_SH, crate::DEPOSIT_PRIVATE_TAG);
    assert(got == 0x006439d00b4364718dd3944832245249bc88cf84840a3ee487064dd0a2671df9,
           "deposit private content hash regressed");
}

#[test]
fn m19_withdraw_public_golden() {
    let got = crate::withdraw_content(M19_L1, M19_AMOUNT, crate::WITHDRAW_PUBLIC_TAG);
    assert(got == 0x00706f0d1c76b1411fa40f1b5243f66db8fe671c26464bf1475dd4c348dcf7f6,
           "withdraw public content hash regressed");
}

#[test]
fn m19_withdraw_private_golden() {
    let got = crate::withdraw_content(M19_L1, M19_AMOUNT, crate::WITHDRAW_PRIVATE_TAG);
    assert(got == 0x006de33747bb380f044f1e16230ba9c2b88643c25aff92264cf61c910aeb1bba,
           "withdraw private content hash regressed");
}
