import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const source = await readFile(new URL("../src/lib/chart-path.ts", import.meta.url), "utf8");
const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } });
const { smoothChartPath } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`);

function segments(points) {
  const path = smoothChartPath(points);
  assert.ok(!path.includes("NaN") && !path.includes("Infinity"));
  assert.ok(!path.includes("L"), "measured points must use cubic curves");
  const parts = path.split(" C");
  assert.equal(parts[0], `M${points[0].x},${points[0].y}`);
  return parts.slice(1).map((part, i) => {
    const numbers = part.trim().split(/[ ,]+/).map(Number);
    assert.equal(numbers.length, 6);
    const [x1, y1, x2, y2, x3, y3] = numbers;
    assert.equal(x3, points[i + 1].x);
    assert.equal(y3, points[i + 1].y);
    return [points[i], { x: x1, y: y1 }, { x: x2, y: y2 }, { x: x3, y: y3 }];
  });
}
function bezier(points, t, axis) {
  const u = 1 - t;
  return u ** 3 * points[0][axis] + 3 * u ** 2 * t * points[1][axis]
    + 3 * u * t ** 2 * points[2][axis] + t ** 3 * points[3][axis];
}

test("Empty and single-point data produce finite paths without invented points", () => {
  assert.equal(smoothChartPath([]), "");
  assert.equal(smoothChartPath([{ x: 3, y: 7 }]), "M3,7");
});
test("The curve passes through every measured point with continuous tangents", () => {
  const curves = segments([{ x: 0, y: 3 }, { x: 1, y: 12 }, { x: 2, y: 7 }, { x: 4, y: -5 }, { x: 5, y: 0 }]);
  for (let i = 1; i < curves.length; i++) {
    const before = curves[i - 1], after = curves[i];
    const left = (before[3].y - before[2].y) / (before[3].x - before[2].x);
    const right = (after[1].y - after[0].y) / (after[1].x - after[0].x);
    assert.ok(Math.abs(left - right) < 1e-9, "joins should be smooth");
  }
});
test("Peaks, flat zero days, refunds, and unequal intervals never overshoot", () => {
  let seed = 42;
  const random = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
  const series = [
    [0, 0, 1000, 0, 0], [1000, 1, 0, 0, 1000], [0, -500, 0, 500, 0], [0, 0, 0],
  ].map(values => values.map((y, x) => ({ x, y })));
  for (let i = 0; i < 100; i++) {
    let x = 0;
    series.push(Array.from({ length: 12 }, () => ({ x: x += 0.01 + random() * 50, y: Math.round(random() * 2000 - 1000) })));
  }
  for (const points of series) {
    for (const curve of segments(points)) {
      const min = Math.min(curve[0].y, curve[3].y), max = Math.max(curve[0].y, curve[3].y);
      let previousX = curve[0].x;
      for (let i = 0; i <= 100; i++) {
        const y = bezier(curve, i / 100, "y"), x = bezier(curve, i / 100, "x");
        assert.ok(y >= min - 1e-8 && y <= max + 1e-8, "a smooth curve must not invent spending outside endpoint values");
        assert.ok(x >= previousX - 1e-8, "time must always move forward");
        previousX = x;
      }
    }
  }
});
