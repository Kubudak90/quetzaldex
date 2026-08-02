import { describe, test, expect } from "vitest";
import { Mutex } from "@/lib/mutex";

describe("Mutex", () => {
  test("serializes overlapping critical sections (no interleaving)", async () => {
    const m = new Mutex();
    const events: string[] = [];
    const section = (id: string, delay: number) =>
      m.runExclusive(async () => {
        events.push(`enter-${id}`);
        await new Promise((r) => setTimeout(r, delay));
        events.push(`exit-${id}`);
      });

    // Fire three overlapping sections at once (like the wizard's N=3 drips).
    await Promise.all([section("a", 30), section("b", 5), section("c", 5)]);

    // Each section's enter must be immediately followed by its own exit —
    // never another section's enter — proving no interleaving.
    expect(events).toEqual([
      "enter-a", "exit-a",
      "enter-b", "exit-b",
      "enter-c", "exit-c",
    ]);
  });

  test("runs in FIFO arrival order regardless of work duration", async () => {
    const m = new Mutex();
    const order: number[] = [];
    // Enqueue synchronously in order; the first is slowest. FIFO means the
    // result order is 1,2,3 even though later ones are faster.
    await Promise.all([
      m.runExclusive(async () => { await new Promise((r) => setTimeout(r, 20)); order.push(1); }),
      m.runExclusive(async () => { order.push(2); }),
      m.runExclusive(async () => { order.push(3); }),
    ]);
    expect(order).toEqual([1, 2, 3]);
  });

  test("releases the lock when a section throws, and surfaces the error", async () => {
    const m = new Mutex();
    await expect(
      m.runExclusive(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    // A subsequent section must still acquire the lock (not deadlocked).
    const got = await m.runExclusive(async () => "ok");
    expect(got).toBe("ok");
  });

  test("returns the section's resolved value", async () => {
    const m = new Mutex();
    await expect(m.runExclusive(async () => 42)).resolves.toBe(42);
  });
});
