import { readFileSync } from "node:fs";
import { EmbeddedWallet } from "@aztec/wallets/embedded";
import { Fr, Fq } from "@aztec/aztec.js/fields";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { createAztecNodeClient } from "@aztec/aztec.js/node";
import { LiquidityPoolContract } from "../tests/integration/generated/LiquidityPool.js";

async function main() {
  const cfg = JSON.parse(readFileSync("quetzal.config.json", "utf8"));
  const m1 = JSON.parse(readFileSync("testnet-m1-state.json", "utf8"));
  const node = createAztecNodeClient(cfg.nodeUrl);
  const wallet = await EmbeddedWallet.create(cfg.nodeUrl, { ephemeral: true, pxe: { proverEnabled: false } });
  const accountManager = await wallet.createSchnorrAccount(
    Fr.fromString(m1.secret),
    Fr.ZERO,
    Fq.fromString(m1.signingKey),
  );
  const account = await accountManager.getAccount();
  const admin = account.getAddress();
  for (const p of cfg.pools) {
    const addr = AztecAddress.fromStringUnsafe(p.address);
    const nodeAny = node as unknown as { getContract: (a: AztecAddress) => Promise<unknown> };
    const inst = await nodeAny.getContract(addr);
    const walletAny = wallet as unknown as { registerContract: (i: unknown, art: unknown) => Promise<void> };
    await walletAny.registerContract(inst, LiquidityPoolContract.artifact);
    const pool = await LiquidityPoolContract.at(addr, wallet);
    const stateSim = await (pool.methods as any).get_pool_state().simulate({ from: admin });
    const bucketSim = await (pool.methods as any).get_bucket(8).simulate({ from: admin });
    const s = (stateSim as any).result;
    const b = (bucketSim as any).result;
    console.log(`pool ${p.pool_id} ${p.address.slice(0,10)}:`,
      `reserve_a=${s.reserve_a} reserve_b=${s.reserve_b} sqrt_p=${s.current_sqrt_price}`,
      `bucket[8].liquidity=${b.liquidity}`);
  }
}
main().catch(e => { console.error(e); process.exit(1); });
