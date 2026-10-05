import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

// Exercise the pure glass helpers without adding a second TS runtime.
async function load(path) {
  const source = await readFile(new URL(path, import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } });
  return import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`);
}

const glass = await load("../src/lib/glass.ts");
const flow = await load("../src/lib/backdropFlow.ts");

/** A repeatable stand-in for Math.random. */
function seeded(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

test("Anything malformed falls back to the default, field by field", () => {
  assert.deepEqual(glass.parseAppearance(null), glass.DEFAULT_APPEARANCE);
  assert.deepEqual(glass.parseAppearance("nonsense"), glass.DEFAULT_APPEARANCE);

  const look = glass.parseAppearance({
    glass: "yes",
    palette: "Not An Id",
    glow: Number.NaN,
    blur: 400,
    fill: 3,
    backdrop_seed: -5,
    flow: true,
    flow_speed: 9,
    flow_range: "far",
  });
  assert.equal(look.glass, false);
  assert.equal(look.palette, "mint");
  assert.equal(look.glow, 1);
  assert.equal(look.blur, 40, "out of range is clamped, not dropped");
  assert.equal(look.fill, 20);
  assert.equal(look.backdrop_seed, 0);
  assert.equal(look.flow, true, "one bad field never costs the good ones");
  assert.equal(look.flow_speed, 4);
  assert.equal(look.flow_range, 1);
});

test("Own palettes are validated, de-duplicated and capped", () => {
  const good = { id: "custom-a", name: "  Dusk ", base: "#3A5BD9", accent: "f59e0b" };
  const look = glass.parseAppearance({
    palettes: [
      good,
      { ...good, name: "Duplicate id" },
      { id: "custom-b", name: "", base: "#000000", accent: "#000000" },
      { id: "custom-c", name: "Bad colour", base: "blue", accent: "#000000" },
      ...Array.from({ length: 20 }, (_, i) => ({ id: `p${i}`, name: "P", base: "#000000", accent: "#ffffff" })),
    ],
  });
  assert.deepEqual(look.palettes[0], { id: "custom-a", name: "Dusk", base: "#3a5bd9", accent: "#f59e0b" });
  assert.equal(look.palettes.length, glass.MAX_PALETTES);
  assert.ok(!look.palettes.some((p) => p.id === "custom-b" || p.id === "custom-c"));
});

test("A palette id resolves to the user's own, then a built-in, then the default", () => {
  const own = [{ id: "custom-a", name: "A", base: "#111111", accent: "#222222" }];
  assert.equal(glass.resolvePalette("custom-a", own).base, "#111111");
  assert.equal(glass.resolvePalette("ocean", own).id, "ocean");
  assert.equal(glass.resolvePalette("deleted", own).id, "mint");
});

test("Mixing matches color-mix in srgb, and ink is chosen for contrast", () => {
  assert.equal(glass.mixHex("#ff0000", "#0000ff", 0.5), "#800080");
  assert.equal(glass.mixHex("#22a35a", "#ffffff", 1), "#22a35a");
  assert.equal(glass.readableOn("#ffffff"), glass.DARK_INK);
  assert.equal(glass.readableOn("#000000"), glass.LIGHT_INK);
  // Pure blue lightened for a dark ground is still too dark for dark ink.
  assert.equal(glass.readableOn(glass.mixHex("#0000ff", "#ffffff", 0.72)), glass.LIGHT_INK);
  // Every built-in palette keeps its primary buttons readable in both themes.
  for (const palette of glass.BUILTIN_PALETTES) {
    const vars = glass.glassVars(glass.DEFAULT_APPEARANCE, palette);
    const onDark = glass.mixHex(palette.base, "#ffffff", 0.72);
    const onLight = glass.mixHex(palette.base, "#000000", 0.88);
    assert.ok(glass.contrast(onDark, vars["--glass-on-primary-dark"]) >= 4.5, palette.id);
    assert.ok(glass.contrast(onLight, vars["--glass-on-primary-light"]) >= 4.5, palette.id);
  }
});

test("Glow layout is deterministic per seed and left alone at seed 0", () => {
  assert.deepEqual(glass.glowLayout(0), {});
  const a = glass.glowLayout(123456789);
  assert.deepEqual(a, glass.glowLayout(123456789));
  assert.notDeepEqual(a, glass.glowLayout(987654321));
  assert.equal(Object.keys(a).length, 8);
  for (const value of Object.values(a)) {
    const n = Number.parseInt(value, 10);
    assert.ok(n >= 5 && n <= 95, value);
  }
});

test("Variables only ever use the --glass- prefix, and zero frost means no filter", () => {
  const palette = glass.BUILTIN_PALETTES[1];
  const on = glass.glassVars({ ...glass.DEFAULT_APPEARANCE, backdrop_seed: 42, blur: 12, fill: 70 }, palette);
  assert.ok(Object.keys(on).every((name) => name.startsWith("--glass-")));
  assert.equal(on["--glass-base"], palette.base);
  assert.equal(on["--glass-blur-px"], "12px");
  assert.equal(on["--glass-fill"], "70%");
  assert.equal(on["--glass-blur"], undefined);

  const off = glass.glassVars({ ...glass.DEFAULT_APPEARANCE, blur: 0 }, palette);
  assert.equal(off["--glass-blur"], "none");
  assert.equal(off["--glass-blur-px"], undefined);
});

test("New ids and seeds never collide with what exists or mean 'not shuffled'", () => {
  const random = seeded(7);
  const taken = [];
  for (let i = 0; i < 50; i++) {
    const id = glass.newPaletteId(taken, random);
    assert.match(id, /^custom-[a-z0-9]{6}$/);
    assert.ok(!taken.includes(id));
    taken.push(id);
  }
  assert.equal(glass.randomSeed(() => 0), 1);
  assert.ok(glass.randomSeed(() => 0.999999999) <= glass.MAX_SEED);
});

test("Each leg stays in reach and moves at least a minimum step", () => {
  const random = seeded(99);
  for (const motion of ["x", "y", "shape"]) {
    for (const range of [0.5, 1, 2]) {
      const { reach, minStep, minMs, maxMs } = flow.FLOW_MOTIONS[motion];
      const span = reach * range;
      const step = Math.min(minStep * range, span);
      let at = flow.FLOW_REST;
      for (let i = 0; i < 200; i++) {
        const leg = flow.nextFlowLeg(motion, at, range, random);
        assert.ok(Math.abs(leg.to.a) <= span + 1e-9, `${motion} a ${leg.to.a}`);
        assert.ok(Math.abs(leg.to.a - at.a) >= step - 1e-3, `${motion} step ${at.a} -> ${leg.to.a}`);
        if (motion === "shape") assert.ok(Math.abs(leg.to.b - at.b) >= step - 1e-3);
        else assert.equal(leg.to.b, 0);
        assert.ok(leg.duration >= minMs && leg.duration <= maxMs);
        at = leg.to;
      }
    }
  }
});

test("Narrowing the range pulls a glow back inside it", () => {
  // The glow sits at the old edge; the new range is half as wide.
  const target = flow.pickTarget(18, 9, 3.5, seeded(1));
  assert.ok(target >= -9 && target <= 9);
  // Nowhere qualifies on either side: it goes to the far edge.
  assert.equal(flow.pickTarget(0, 5, 5, () => 0.5), 5);
});

test("Transforms name one motion each", () => {
  assert.equal(flow.flowTransform("x", { a: 3, b: 0 }), "translateX(3vw)");
  assert.equal(flow.flowTransform("y", { a: -2, b: 0 }), "translateY(-2vh)");
  assert.equal(flow.flowTransform("shape", { a: 0.1, b: -0.1 }), "scale(1.1, 0.9)");
});
