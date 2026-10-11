import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const source = await readFile(new URL("../src/lib/prices.ts", import.meta.url), "utf8");
const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } });
const { paidPerUnit, priceGap, compareWithOtherShops, basketElsewhere, daysUntil, addDaysIso, priceSpread, defaultDecision, initialAnswers, receiptVsUsual, worthATrip } =
  await import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`);

const row = (shop_id, price, extra = {}) => ({
  shop_id, shop_name: shop_id.toUpperCase(), price, regular_price: price, regular_on: null,
  sale_price: null, sale_on: null, sale_until: null, on_sale: false,
  last_paid: null, last_paid_on: null, last_paid_on_sale: false, ...extra,
});

test("Per-unit price comes from the line total, like the server", () => {
  assert.equal(paidPerUnit(43332, "0.482"), 89900);
  assert.equal(paidPerUnit(30000, 3), 10000);
  assert.equal(paidPerUnit(9990, undefined), 9990);
  assert.equal(paidPerUnit(9990, "0"), 9990);
  assert.equal(paidPerUnit(9990, "abc"), 9990);
});

test("A gap is signed from the price's point of view", () => {
  assert.deepEqual(priceGap(11000, 10000), { diff: 1000, percent: 10 });
  assert.deepEqual(priceGap(9000, 10000), { diff: -1000, percent: -10 });
  assert.deepEqual(priceGap(100, 0), { diff: 100, percent: null });
});

test("A line compares with the cheapest other shop, never with its own", () => {
  const product = { prices: [row("here", 9000), row("lenta", 8500), row("metro", 9900), row("gone", null)] };
  const dearer = compareWithOtherShops(9000, product, "here");
  assert.equal(dearer.kind, "dearer");
  assert.equal(dearer.shop.shop_id, "lenta");
  assert.equal(dearer.diff, 500);

  const cheapest = compareWithOtherShops(8000, product, "here");
  assert.equal(cheapest.kind, "cheapest");
  assert.equal(cheapest.diff, 500);
  assert.equal(cheapest.next.shop_id, "lenta");

  assert.equal(compareWithOtherShops(8500, product, "here").kind, "same");
  assert.equal(compareWithOtherShops(9000, { prices: [row("here", 9000)] }, "here").kind, "unknown");
});

test("A basket is compared per shop only on the lines that shop prices", () => {
  const products = new Map([
    ["milk", { prices: [row("here", 9000), row("lenta", 8000), row("metro", 9500)] }],
    ["bread", { prices: [row("here", 5000), row("metro", 4000)] }],
    ["cheese", { prices: [row("here", 60000)] }],
  ]);
  const lines = [
    { productId: "milk", quantity: "2", total: 18000 },
    { productId: "bread", total: 5000 },
    { productId: "cheese", quantity: "0.5", total: 30000 },
    { productId: null, total: 1000 },
  ];
  const result = basketElsewhere(lines, products, "here");
  assert.deepEqual(result.map((s) => [s.shopId, s.covered, s.here, s.there, s.diff]), [
    ["lenta", 1, 18000, 16000, -2000],
    ["metro", 2, 23000, 23000, 0],
  ]);
});

test("Sale countdown and default end dates use calendar days", () => {
  assert.equal(daysUntil("2026-10-18", "2026-10-11"), 7);
  assert.equal(daysUntil("2026-10-10", "2026-10-11"), -1);
  assert.equal(addDaysIso("2026-12-28", 7), "2027-01-04");
  assert.equal(addDaysIso("2024-02-28", 1), "2024-02-29");
});

test("A spread needs two priced shops", () => {
  assert.equal(priceSpread({ prices: [row("a", 100), row("b", null)] }), null);
  assert.deepEqual(priceSpread({ prices: [row("a", 300), row("b", 100), row("c", 200)] }), { min: 100, max: 300 });
});

test("A changed price defaults to sale when discounted, keep when implausible, else new", () => {
  const change = (price, saved, on_sale = false) => ({
    product_id: "p", product_name: "Milk", shop_id: "s", shop_name: "S", observed_on: "2026-10-11",
    price, on_sale, regular_price: null, saved_price: saved, saved_on_sale: false,
  });
  assert.equal(defaultDecision(change(9900, 8900)), "regular");
  assert.equal(defaultDecision(change(7900, 8900, true)), "sale");
  assert.equal(defaultDecision(change(89000, 8900)), "keep");
  assert.equal(defaultDecision(change(3000, 8900)), "keep");
  assert.equal(defaultDecision(change(9900, null)), "regular");
  assert.equal(initialAnswers([change(7900, 8900, true)])[0].saleUntil, "2026-10-18");
});

test("A receipt is measured against the average regular price over shops", () => {
  const products = new Map([
    ["milk", { prices: [row("here", 8000), row("lenta", 10000)] }],
    ["coffee", { prices: [row("here", 120000, { regular_price: 160000 })] }],
    ["new", { prices: [row("here", null, { regular_price: null })] }],
  ]);
  const result = receiptVsUsual([
    { productId: "milk", quantity: "2", total: 16000 },
    { productId: "coffee", total: 120000 },
    { productId: "new", total: 500 },
    { productId: null, total: 100 },
  ], products);
  assert.deepEqual(result, { saved: 2000 + 40000, compared: 2 });
});

test("Another shop is only worth a trip for a real saving on several items", () => {
  const shop = (covered, here, there) => ({ shopId: "x", shopName: "X", covered, here, there, diff: there - here });
  assert.equal(worthATrip(shop(5, 10000, 8500)), true);
  assert.equal(worthATrip(shop(1, 10000, 5000)), false); // one toothpick
  assert.equal(worthATrip(shop(5, 10000, 9500)), false); // 5% is not worth the walk
  assert.equal(worthATrip(shop(5, 10000, 11000)), false);
});
