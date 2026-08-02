import { describe, test, expect, beforeEach } from "vitest";
import { recordOrder, loadOrders, removeOrder, type JournalOrder } from "./order-journal";

const OWNER = "0xMaker";
const sample: JournalOrder = {
  nonce: "0x007e9a21",
  epoch: 11,
  side: "sell",
  pair: "USDC/ETH",
  amount: "1",
  amountToken: "ETH",
  limit: "3218.50",
  limitToken: "USDC",
  createdAt: 1779900000000,
};

beforeEach(() => {
  localStorage.clear();
});

describe("order-journal persistence", () => {
  test("recordOrder + loadOrders round-trip", () => {
    recordOrder(OWNER, sample);
    expect(loadOrders(OWNER)).toEqual([sample]);
  });

  test("keyed by owner — another wallet sees nothing", () => {
    recordOrder(OWNER, sample);
    expect(loadOrders("0xOther")).toEqual([]);
  });

  test("recordOrder de-dupes by nonce (re-record updates in place)", () => {
    recordOrder(OWNER, sample);
    recordOrder(OWNER, { ...sample, epoch: 12 });
    const out = loadOrders(OWNER);
    expect(out.length).toBe(1);
    expect(out[0]!.epoch).toBe(12);
  });

  test("multiple distinct nonces preserved in insertion order", () => {
    const second: JournalOrder = { ...sample, nonce: "0x00abc" };
    recordOrder(OWNER, sample);
    recordOrder(OWNER, second);
    expect(loadOrders(OWNER)).toEqual([sample, second]);
  });

  test("removeOrder filters by nonce (case-insensitive)", () => {
    const second: JournalOrder = { ...sample, nonce: "0x00ABC" };
    recordOrder(OWNER, sample);
    recordOrder(OWNER, second);
    removeOrder(OWNER, "0x00abc");
    expect(loadOrders(OWNER)).toEqual([sample]);
  });

  test("loadOrders returns [] on missing / corrupt", () => {
    expect(loadOrders(OWNER)).toEqual([]);
    localStorage.setItem("quetzal:orders:0xmaker", "{not-json");
    expect(loadOrders(OWNER)).toEqual([]);
  });
});
