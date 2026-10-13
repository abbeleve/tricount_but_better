import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const source = await readFile(new URL("../src/lib/photoCut.ts", import.meta.url), "utf8");
const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } });
const {
  MAX_ZOOM, MIN_PART, WHOLE, addCut, canAddCut, clampZoom, isWhole, moveCut, moveEdge, photoPoint, photoView, pieces,
  removeCut, scrollFor,
} = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`);

test("a new cut goes halfway down the last part", () => {
  const one = addCut(WHOLE);
  assert.deepEqual(one.cuts, [0.5]);
  const two = addCut(one);
  assert.deepEqual(two.cuts, [0.5, 0.75]);
});

test("a cut cannot pass its neighbours or the photo's ends", () => {
  const plan = { ...WHOLE, cuts: [0.3, 0.6] };
  assert.equal(moveCut(plan, 0, 0.9).cuts[0], 0.6 - MIN_PART);
  assert.equal(moveCut(plan, 1, 0.1).cuts[1], 0.3 + MIN_PART);
  assert.equal(moveCut(plan, 0, -1).cuts[0], MIN_PART);
  assert.equal(moveCut(plan, 1, 2).cuts[1], 1 - MIN_PART);
  assert.deepEqual(moveCut(plan, 0, 0.4).cuts, [0.4, 0.6]);
});

test("the side lines cannot cross", () => {
  const plan = moveEdge(moveEdge(WHOLE, "left", 0.2), "right", 0.8);
  assert.deepEqual([plan.left, plan.right], [0.2, 0.8]);
  assert.equal(moveEdge(plan, "left", 0.95).left, 0.8 - MIN_PART);
  assert.equal(moveEdge(plan, "right", 0.05).right, 0.2 + MIN_PART);
  assert.equal(moveEdge(plan, "left", -3).left, 0);
});

test("no cut is added once the last part is too short to halve", () => {
  const plan = { ...WHOLE, cuts: [1 - MIN_PART] };
  assert.equal(canAddCut(plan), false);
  assert.equal(addCut(plan), plan);
});

test("parts share edges, never overlap, and keep only the box", () => {
  const plan = { left: 0.1, right: 0.9, top: 0.05, bottom: 0.95, cuts: [0.25, 0.5] };
  const parts = pieces(plan, 1000, 4000);
  assert.deepEqual(parts, [
    { x: 100, y: 200, width: 800, height: 800 },
    { x: 100, y: 1000, width: 800, height: 1000 },
    { x: 100, y: 2000, width: 800, height: 1800 },
  ]);
  for (let i = 1; i < parts.length; i++) assert.equal(parts[i].y, parts[i - 1].y + parts[i - 1].height);
});

test("removing a cut joins its parts, and an untouched plan is the whole photo", () => {
  const plan = removeCut({ ...WHOLE, cuts: [0.3, 0.6] }, 0);
  assert.deepEqual(plan.cuts, [0.6]);
  assert.equal(isWhole(WHOLE), true);
  assert.equal(isWhole(removeCut(plan, 0)), true);
  assert.deepEqual(pieces(WHOLE, 600, 900), [{ x: 0, y: 0, width: 600, height: 900 }]);
});

test("at zoom 1 the photo fits the stage, centred", () => {
  const view = photoView({ width: 1000, height: 4000 }, { width: 600, height: 832 }, 1);
  assert.deepEqual(view, { left: 200, top: 16, width: 200, height: 800, areaWidth: 600, areaHeight: 832 });
});

test("zoomed in, the area grows with a margin and the photo no longer centres", () => {
  const view = photoView({ width: 1000, height: 4000 }, { width: 600, height: 832 }, 4);
  assert.deepEqual(view, { left: 16, top: 16, width: 800, height: 3200, areaWidth: 832, areaHeight: 3232 });
});

test("the point under the pointer stays under it across a zoom", () => {
  const stage = { width: 600, height: 832 };
  const photo = { width: 1000, height: 4000 };
  const under = { x: 300, y: 400 };
  const before = photoView(photo, stage, 2);
  const at = photoPoint(before, { x: 0, y: 500 }, under);
  const after = photoView(photo, stage, 3);
  const scroll = scrollFor(after, stage, at, under);
  const again = photoPoint(after, scroll, under);
  assert.ok(Math.abs(again.x - at.x) < 1e-9 && Math.abs(again.y - at.y) < 1e-9);
});

test("a zoom scroll never runs past the area's edges", () => {
  const stage = { width: 600, height: 832 };
  const view = photoView({ width: 1000, height: 4000 }, stage, 4);
  assert.deepEqual(scrollFor(view, stage, { x: 0, y: 0 }, { x: 300, y: 400 }), { x: 0, y: 0 });
  assert.deepEqual(scrollFor(view, stage, { x: 1, y: 1 }, { x: 0, y: 0 }), { x: 232, y: 2400 });
});

test("zoom stays between fitting and the largest", () => {
  assert.equal(clampZoom(0.2), 1);
  assert.equal(clampZoom(100), MAX_ZOOM);
  assert.equal(clampZoom(Number.NaN), 1);
  assert.equal(clampZoom(2.5), 2.5);
});

test("the top and bottom cannot cross each other or a cut, and cuts stay inside them", () => {
  const plan = { ...WHOLE, top: 0.1, bottom: 0.9, cuts: [0.4, 0.6] };
  assert.equal(moveEdge(plan, "top", 0.5).top, 0.4 - MIN_PART);
  assert.equal(moveEdge(plan, "bottom", 0.5).bottom, 0.6 + MIN_PART);
  assert.equal(moveCut(plan, 0, 0).cuts[0], 0.1 + MIN_PART);
  assert.equal(moveCut(plan, 1, 1).cuts[1], 0.9 - MIN_PART);
  const box = { ...WHOLE, top: 0.3, bottom: 0.7 };
  assert.equal(moveEdge(box, "top", 0.9).top, 0.7 - MIN_PART);
  assert.equal(moveEdge(box, "bottom", 0).bottom, 0.3 + MIN_PART);
});

test("a new cut halves the last part of the box, not of the photo", () => {
  const box = { ...WHOLE, top: 0.2, bottom: 0.6 };
  assert.deepEqual(addCut(box).cuts, [0.4]);
  assert.equal(isWhole(box), false);
});
