import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const source = await readFile(new URL("../src/lib/scanJobs.ts", import.meta.url), "utf8");
const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } });
const { resumePath, claimScan, claimedScans, subscribeClaims } =
  await import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`);

const job = (kind, id = "j1") => ({ id, kind, team_id: "t1" });

test("A scan goes back to the page it was started on, keeping that page's own query", () => {
  assert.equal(resumePath(job("receipt"), "/teams/t1/expenses/e9"), "/teams/t1/expenses/e9?scan=j1");
  assert.equal(
    resumePath(job("receipt"), "/teams/t1/expenses/new?planId=p2"),
    "/teams/t1/expenses/new?planId=p2&scan=j1",
  );
  // An old scan id in the remembered address is replaced, not doubled.
  assert.equal(resumePath(job("prices", "j2"), "/teams/t1/prices/import?scan=j1#top"), "/teams/t1/prices/import?scan=j2");
});

test("Without a known page, a fresh form of the scan's kind opens it", () => {
  assert.equal(resumePath(job("receipt"), null), "/teams/t1/expenses/new?scan=j1");
  assert.equal(resumePath(job("prices"), null), "/teams/t1/prices/import?scan=j1");
  // Never somewhere outside the app.
  assert.equal(resumePath(job("receipt"), "//evil.example/x"), "/teams/t1/expenses/new?scan=j1");
  assert.equal(resumePath(job("receipt"), "https://evil.example/x"), "/teams/t1/expenses/new?scan=j1");
});

test("A claim lasts until it is let go, and tells whoever listens", () => {
  let heard = 0;
  const stop = subscribeClaims(() => { heard += 1; });
  const release = claimScan("j1");
  const held = claimedScans();
  assert.ok(held.has("j1"));
  release();
  assert.ok(!claimedScans().has("j1"));
  // Snapshots are fresh objects, so React sees each change.
  assert.notEqual(claimedScans(), held);
  assert.equal(heard, 2);
  stop();
});
