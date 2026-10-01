import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

// Exercise the pure calendar helpers without adding a second TS runtime.
const source = await readFile(new URL("../src/lib/spending.ts", import.meta.url), "utf8");
const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } });
const { addDays, periodStart, shiftPeriod, sumSpending, periodBuckets, historyBuckets, spendingChange, chartDomain } =
  await import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`);
const day = (date, total, expense_count = 1) => ({ date, total, expense_count });

test("Monday weeks cross months and years without moving a purchase date", () => {
  assert.equal(periodStart("2026-01-01", "week"), "2025-12-29");
  assert.equal(periodStart("2026-10-04", "week"), "2026-09-28");
  assert.equal(periodStart("2026-10-05", "week"), "2026-10-05");
  assert.equal(shiftPeriod("2026-01-01", "week", -1), "2025-12-22");
});
test("Month and year shifts normalize before arithmetic, including leap years", () => {
  assert.equal(shiftPeriod("2024-03-31", "month", -1), "2024-02-01");
  assert.equal(shiftPeriod("2026-01-31", "month", -1), "2025-12-01");
  assert.equal(shiftPeriod("2024-02-29", "year", -1), "2023-01-01");
  assert.equal(addDays("2024-02-28", 1), "2024-02-29");
  assert.equal(addDays("2024-02-29", 1), "2024-03-01");
  assert.equal(addDays("2026-03-08", 1), "2026-03-09");
});
test("Current totals stop today and previous totals cover the full previous period", () => {
  const days = [day("2026-09-01", 101), day("2026-09-30", 202), day("2026-10-01", 505, 2), day("2026-10-02", 10000)];
  assert.deepEqual(sumSpending(days, "2026-10-01", "2026-11-01", "2026-10-01"), { total: 505, expenseCount: 2 });
  assert.deepEqual(sumSpending(days, "2026-09-01", "2026-10-01", "2026-10-01"), { total: 303, expenseCount: 2 });
});
test("Months have their real length, with zero past days and unknown future days", () => {
  const buckets = periodBuckets([day("2024-02-01", 100)], "month", "2024-02-15", "2024-02-15");
  assert.equal(buckets.length, 29);
  assert.equal(buckets[0].total, 100);
  assert.equal(buckets[14].total, 0);
  assert.equal(buckets[15].total, null);
  assert.equal(periodBuckets([], "month", "2023-02-01", "2026-10-01").length, 28);
  assert.equal(periodBuckets([], "month", "2024-03-01", "2026-10-01").length, 31);
});
test("Year chart aggregates by month and preserves integer amounts and refunds", () => {
  const buckets = periodBuckets([day("2026-01-01", 101), day("2026-01-31", 202, 2), day("2026-02-01", -50), day("2026-12-01", 999)], "year", "2026-10-01", "2026-10-01");
  assert.equal(buckets.length, 12);
  assert.equal(buckets[0].total, 303);
  assert.equal(buckets[0].expenseCount, 3);
  assert.equal(buckets[1].total, -50);
  assert.equal(buckets[9].total, 0);
  assert.equal(buckets[10].total, null);
});
test("History includes empty periods and respects Monday weeks across years", () => {
  const history = historyBuckets([day("2025-12-31", 123), day("2026-01-05", 456)], "week", "2026-01-05", "2026-01-05", 3);
  assert.deepEqual(history.map((b) => b.start), ["2025-12-22", "2025-12-29", "2026-01-05"]);
  assert.deepEqual(history.map((b) => b.total), [0, 123, 456]);
  const years = historyBuckets([day("2024-02-29", 7), day("2026-10-02", 999)], "year", "2026-10-01", "2026-10-01", 3);
  assert.deepEqual(years.map((b) => b.total), [7, 0, 0]);
});
test("Percentages handle zero baselines, drops, and negative net spending", () => {
  assert.equal(spendingChange(100, 0), null);
  assert.equal(spendingChange(0, 0), 0);
  assert.equal(spendingChange(0, 100), -100);
  assert.equal(spendingChange(150, 100), 50);
  assert.equal(spendingChange(-150, -100), -50);
});
test("Chart scale includes refunds and has a usable empty-data range", () => {
  assert.deepEqual(chartDomain([0, null]), { min: 0, max: 1 });
  const domain = chartDomain([-100, 200, null]);
  assert.ok(domain.min < -100 && domain.max > 200);
  assert.equal(chartDomain([-100]).max, 0);
});
