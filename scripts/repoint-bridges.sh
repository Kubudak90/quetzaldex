#!/usr/bin/env bash
# Repoint the L1 TokenBridges at the new hybrid L2 tokens via setL2TokenAddress
# (governance timelock; testnet delay=0 → schedule + execute immediately).
#
# Reads the new token + bridge + governance-timelock addresses from
# quetzal.config.json. Requires L1_RPC_URL + DEPLOYER_PK in the environment
# (run `set -a && . ./.env.testnet && set +a` first). DEPLOYER_PK must hold
# PROPOSER_ROLE + EXECUTOR_ROLE on the governance timelock (it deployed/wired
# the bridges originally, so it does).
#
# This is Option A from docs/superpowers/specs/2026-06-02-hybrid-bridged-tokens-design.md:
# keep the existing bridges, just point them at the new L2 tokens. Mirrors
# wirePortalL2Token() in scripts/deploy-bridge.ts.
set -eo pipefail

cfg() { python3 -c "import json;print(json.load(open('quetzal.config.json'))$1)"; }
GOV=$(cfg "['l1']['governanceTimelock']")
ZERO=0x0000000000000000000000000000000000000000000000000000000000000000

repoint() {
  local label="$1" bridge="$2" token="$3"
  echo ">>> $label  bridge=$bridge  ->  token=$token"
  local inner
  inner=$(cast calldata "setL2TokenAddress(bytes32)" "$token")
  echo "    schedule..."
  cast send "$GOV" "schedule(address,uint256,bytes,bytes32,bytes32,uint256)" \
    "$bridge" 0 "$inner" "$ZERO" "$ZERO" 0 \
    --rpc-url "$L1_RPC_URL" --private-key "$DEPLOYER_PK" 2>&1 | grep -iE "transactionHash|status" || true
  echo "    execute..."
  cast send "$GOV" "execute(address,uint256,bytes,bytes32,bytes32)" \
    "$bridge" 0 "$inner" "$ZERO" "$ZERO" \
    --rpc-url "$L1_RPC_URL" --private-key "$DEPLOYER_PK" 2>&1 | grep -iE "transactionHash|status" || true
  local got
  got=$(cast call "$bridge" "l2TokenAddress()(bytes32)" --rpc-url "$L1_RPC_URL")
  echo "    l2TokenAddress() now = $got  (expected $token)"
}

repoint USDC "$(cfg "['l1']['usdcBridge']")" "$(cfg "['tUSDC']")"
repoint WETH "$(cfg "['l1']['wethBridge']")" "$(cfg "['tETH']")"
repoint wBTC "$(cfg "['l1']['wbtcBridge']")" "$(cfg "['tBTC']")"
echo "ALL BRIDGES REPOINTED."
