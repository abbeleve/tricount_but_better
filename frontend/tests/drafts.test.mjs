import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

// A stand-in for the browser's storage, enough for the module.
const store = new Map();
globalThis.localStorage = {
  get length() { return store.size; },
  key: (i) => [...store.keys()][i] ?? null,
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)); },
  removeItem: (k) => { store.delete(k); },
};

const source = await readFile(new URL("../src/lib/drafts.ts", import.meta.url), "utf8");
const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } });
const { draftKey, draftPath, readDraft, writeDraft, removeDraft, listDrafts, removeUserDrafts } =
  await import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`);

const DAY = 86_400_000;
const NOW = Date.parse("2026-10-29T12:00:00Z");
const summary = (title, total = 100) => ({ title, total, lines: 1, currency: "RUB" });

test("A draft is kept per user, team and form, and read back as written", () => {
  store.clear();
  const key = draftKey("u1", "t1", { kind: "new" });
  writeDraft(key, { title: "Пятёрочка" }, summary("Пятёрочка"), NOW);
  assert.deepEqual(readDraft(key, NOW).data, { title: "Пятёрочка" });
  assert.notEqual(key, draftKey("u2", "t1", { kind: "new" }));
  assert.notEqual(key, draftKey("u1", "t2", { kind: "new" }));
  assert.notEqual(key, draftKey("u1", "t1", { kind: "plan", planId: "p1" }));
  removeDraft(key);
  assert.equal(readDraft(key, NOW), null);
});

test("A team lists only this user's drafts, newest first, each back to its own form", () => {
  store.clear();
  writeDraft(draftKey("u1", "t1", { kind: "new" }), {}, summary("old"), NOW - 2 * DAY);
  writeDraft(draftKey("u1", "t1", { kind: "plan", planId: "p9" }), {}, summary("plan"), NOW - DAY);
  writeDraft(draftKey("u2", "t1", { kind: "new" }), {}, summary("someone else's"), NOW);
  writeDraft(draftKey("u1", "t2", { kind: "new" }), {}, summary("other team"), NOW);
  const drafts = listDrafts("u1", "t1", NOW);
  assert.deepEqual(drafts.map((d) => d.summary.title), ["plan", "old"]);
  assert.deepEqual(drafts.map((d) => draftPath("t1", d.slot)), [
    "/teams/t1/expenses/new?planId=p9",
    "/teams/t1/expenses/new",
  ]);
});

test("A month-old or unreadable draft is dropped", () => {
  store.clear();
  const key = draftKey("u1", "t1", { kind: "new" });
  writeDraft(key, {}, summary("stale"), NOW - 31 * DAY);
  assert.equal(readDraft(key, NOW), null);
  assert.equal(store.has(key), false);
  store.set(draftKey("u1", "t1", { kind: "plan", planId: "x" }), "{not json");
  assert.deepEqual(listDrafts("u1", "t1", NOW), []);
});

test("Signing out removes that user's drafts and no one else's", () => {
  store.clear();
  writeDraft(draftKey("u1", "t1", { kind: "new" }), {}, summary("mine"), NOW);
  writeDraft(draftKey("u1", "t2", { kind: "new" }), {}, summary("mine too"), NOW);
  writeDraft(draftKey("u2", "t1", { kind: "new" }), {}, summary("theirs"), NOW);
  store.set("tbb.language", "ru");
  removeUserDrafts("u1");
  assert.deepEqual([...store.keys()].sort(), [draftKey("u2", "t1", { kind: "new" }), "tbb.language"].sort());
});
