/**
 * Validate `bridge exit` split options (M8/M9).
 *
 * M8: --split-into / --interval-days arrive as raw Number(); a typo (NaN, 0,
 * fractional, out of range) previously slipped through and silently exited the FULL
 * amount at once (splitInto coerced to 1), degrading the privacy the flag was for.
 * M9: the scheduler executes each leg directly (no relayer), so a --relayer-fee with
 * --split-into would be silently dropped — fail loudly instead.
 *
 * Throws with a clear message on invalid input; ranges mirror buildSplitSchedule.
 */
export function validateSplitOptions(o: {
  splitInto: number;
  intervalDays: number;
  relayerFee: bigint;
}): void {
  if (!Number.isInteger(o.splitInto) || o.splitInto < 1 || o.splitInto > 20) {
    throw new Error(`--split-into must be an integer in [1, 20], got: ${o.splitInto}`);
  }
  if (!Number.isInteger(o.intervalDays) || o.intervalDays < 1 || o.intervalDays > 90) {
    throw new Error(`--interval-days must be an integer in [1, 90], got: ${o.intervalDays}`);
  }
  if (o.splitInto > 1 && o.relayerFee > 0n) {
    throw new Error(
      "--relayer-fee is not supported with --split-into (staggered exits execute directly, without a relayer)",
    );
  }
}
