import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

async function load(path) {
  const source = await readFile(new URL(path, import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } });
  return import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`);
}

const { relativeTime } = await load("../src/lib/dates.ts");
const { base64UrlToBytes, bytesToBase64Url, isAppleMobile } = await load("../src/lib/webpush.ts");

// Local-time constructors, so the calendar-day rules hold in any test timezone.
const at = (h, m = 0, day = 8) => new Date(2026, 9, day, h, m);
const ago = (now, then, locale = "en-US") => relativeTime(then.toISOString(), now, locale);

test("Recent notifications read in minutes and hours", () => {
  const now = at(14, 30);
  assert.equal(relativeTime(new Date(2026, 9, 8, 14, 29, 20).toISOString(), now, "en-US"), "now");
  assert.equal(ago(now, at(14, 25)), "5 minutes ago");
  assert.equal(ago(now, at(11, 30)), "3 hours ago");
  assert.equal(ago(now, at(14, 25), "ru-RU"), "5 минут назад");
});

test("Older ones count calendar days, then show a date", () => {
  assert.equal(ago(at(0, 10), at(23, 50, 7)), "20 minutes ago");
  assert.equal(ago(at(2, 0), at(22, 0, 7)), "4 hours ago");
  assert.equal(ago(at(14, 30), at(9, 0, 7)), "yesterday");
  assert.equal(ago(at(14, 30), at(9, 0, 7), "ru-RU"), "вчера");
  assert.equal(ago(at(14, 30), at(9, 0, 5)), "3 days ago");
  assert.equal(ago(at(14, 30), at(9, 0, 1)), "Oct 1");
  assert.equal(relativeTime(new Date(2025, 11, 30).toISOString(), at(12), "en-US"), "Dec 30, 2025");
});

test("The server's VAPID key decodes to an uncompressed P-256 point and back", () => {
  const key = "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8";
  const bytes = base64UrlToBytes(key);
  assert.equal(bytes.length, 65);
  assert.equal(bytes[0], 4);
  assert.equal(bytesToBase64Url(bytes.buffer), key);
  assert.equal(bytesToBase64Url(bytes.subarray(1, 4)), bytesToBase64Url(bytes.slice(1, 4).buffer));
  for (const size of [0, 1, 2, 3, 16, 31]) {
    const data = Uint8Array.from({ length: size }, (_, i) => (i * 97 + 251) % 256);
    assert.deepEqual([...base64UrlToBytes(bytesToBase64Url(data.buffer))], [...data]);
  }
});

test("iPhones and iPads that call themselves Macs are told to install first", () => {
  assert.equal(isAppleMobile("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)", "iPhone", 5), true);
  assert.equal(isAppleMobile("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", "MacIntel", 5), true);
  assert.equal(isAppleMobile("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", "MacIntel", 0), false);
  assert.equal(isAppleMobile("Mozilla/5.0 (Linux; Android 15; Pixel 9)", "Linux armv8l", 5), false);
});
