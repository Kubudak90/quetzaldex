#!/usr/bin/env node
//
// Sub-5a Task A1: Empirically determine whether contractAddressSalt produces
// an address dependent on constructorArgsHash, or independent.
//
// Method: compute would-be addresses with a fixed salt + two DIFFERENT
// constructor arg lists. If addresses match -> args-INDEPENDENT.
//
// Static inspection (see docs/superpowers/specs/sub5a-A1-outcome.md) already
// conclusively shows contractAddressSalt is ARGS-DEPENDENT because
// initializationHash (derived from constructor args) enters
// computeSaltedInitializationHash, which feeds into the address computation.
//
// This dynamic probe serves as a cross-check. Address computation is pure
// crypto — no running Aztec node is required.
//
// Usage: pnpm tsx scripts/sub5a-salt-probe.ts
//
import { Fr } from "@aztec/aztec.js/fields";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { getContractInstanceFromInstantiationParams } from "@aztec/aztec.js/contracts";
import { TokenContractArtifact } from "../tests/integration/generated/Token.js";

async function main() {
  const salt = Fr.random();

  // AztecAddress.ZERO is a valid AztecAddressLike for the encoder
  const deployer = AztecAddress.ZERO;
  const adminAddr = AztecAddress.ZERO;

  // Token constructor: (name: string, symbol: string, decimals: number,
  //                     initial_supply: number, to: AztecAddressLike)
  // Use two distinct arg sets — same salt, different args
  const argsA = ["TokenA", "TA", 6, 0, adminAddr];
  const instanceA = await getContractInstanceFromInstantiationParams(
    TokenContractArtifact,
    { constructorArgs: argsA, deployer, salt },
  );

  const argsB = ["TokenB", "TB", 18, 0, adminAddr];
  const instanceB = await getContractInstanceFromInstantiationParams(
    TokenContractArtifact,
    { constructorArgs: argsB, deployer, salt },
  );

  console.log("Salt:              ", salt.toString());
  console.log("Instance A address:", instanceA.address.toString());
  console.log("Instance B address:", instanceB.address.toString());
  const equal = instanceA.address.toString() === instanceB.address.toString();
  console.log(
    "\nResult: contractAddressSalt is",
    equal ? "ARGS-INDEPENDENT" : "ARGS-DEPENDENT",
  );
  console.log(
    "Phase A branch:",
    equal
      ? "PREFERRED (2-deploy)"
      : "FALLBACK (3-deploy + set_orderbook)",
  );

  return equal;
}

main()
  .then((independent) => process.exit(independent ? 0 : 1))
  .catch((e) => {
    console.error(e);
    process.exit(2);
  });
