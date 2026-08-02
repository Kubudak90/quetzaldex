#!/usr/bin/env bash
# v5 reset-recovery: upgrade the 3 EXISTING TokenBridge proxies in place and
# rebind them to the new Aztec rollup (inbox/outbox/version), then repoint
# each at its new L2 token. Bridge L1 addresses stay unchanged, which is the
# whole point — the redeployed L2 tokens bake these addresses as their
# immutable portal_addr.
#
# Flow per bridge (governance timelock, delay=0 on testnet → schedule+execute):
#   1. upgradeToAndCall(newImpl, setAztecTarget(L2_VERSION, INBOX, OUTBOX))
#   2. setL2TokenAddress(<new L2 token>)
#
# Requires: L1_RPC_URL + DEPLOYER_PK in env (set -a && . ./.env.testnet && set +a)
# and a funded deployer (holds PROPOSER_ROLE + EXECUTOR_ROLE on the governance
# timelock). Run from the repo root.
set -euo pipefail

L2_VERSION=2787991301
INBOX=0x917bb0538c680b71dacc90f0c9cee37ed3b18541
OUTBOX=0xbd9513e770b7b0b98b65ecdd79db093dab1f9b66

cfg() { python3 -c "import json;print(json.load(open('quetzal.config.json'))$1)"; }
GOV=$(cfg "['l1']['governanceTimelock']")
ZERO=0x0000000000000000000000000000000000000000000000000000000000000000

echo ">>> deploying new TokenBridge implementation (v5 outbox ABI + setAztecTarget) ..."
IMPL=$(forge create src/TokenBridge.sol:TokenBridge \
  --root contracts-l1 --broadcast \
  --rpc-url "$L1_RPC_URL" --private-key "$DEPLOYER_PK" --json | python3 -c "import json,sys;print(json.load(sys.stdin)['deployedTo'])")
echo "    impl = $IMPL"

govcall() {  # $1=target  $2=calldata  $3=label
  echo "    schedule $3 ..."
  cast send "$GOV" "schedule(address,uint256,bytes,bytes32,bytes32,uint256)" \
    "$1" 0 "$2" "$ZERO" "$ZERO" 0 \
    --rpc-url "$L1_RPC_URL" --private-key "$DEPLOYER_PK" | grep -iE "status" || true
  echo "    execute $3 ..."
  cast send "$GOV" "execute(address,uint256,bytes,bytes32,bytes32)" \
    "$1" 0 "$2" "$ZERO" "$ZERO" \
    --rpc-url "$L1_RPC_URL" --private-key "$DEPLOYER_PK" | grep -iE "status" || true
}

rebind() {  # $1=label  $2=bridge  $3=newL2Token
  echo ">>> $1  bridge=$2"
  local inner upg
  inner=$(cast calldata "setAztecTarget(uint256,address,address)" "$L2_VERSION" "$INBOX" "$OUTBOX")
  upg=$(cast calldata "upgradeToAndCall(address,bytes)" "$IMPL" "$inner")
  govcall "$2" "$upg" "upgradeToAndCall+setAztecTarget"
  local repoint
  repoint=$(cast calldata "setL2TokenAddress(bytes32)" "$3")
  govcall "$2" "$repoint" "setL2TokenAddress"
  echo "    verify: l2Version=$(cast call "$2" 'l2Version()(uint256)' --rpc-url "$L1_RPC_URL")"
  echo "            inbox=$(cast call "$2" 'inbox()(address)' --rpc-url "$L1_RPC_URL")"
  echo "            outbox=$(cast call "$2" 'outbox()(address)' --rpc-url "$L1_RPC_URL")"
  echo "            l2Token=$(cast call "$2" 'l2TokenAddress()(bytes32)' --rpc-url "$L1_RPC_URL")  (want $3)"
}

rebind USDC "$(cfg "['l1']['usdcBridge']")" "$(cfg "['tUSDC']")"
rebind WETH "$(cfg "['l1']['wethBridge']")" "$(cfg "['tETH']")"
rebind wBTC "$(cfg "['l1']['wbtcBridge']")" "$(cfg "['tBTC']")"
echo "ALL BRIDGES REBOUND TO v5 (rollup $L2_VERSION)."
