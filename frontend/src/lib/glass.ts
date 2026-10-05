/**
 * The glass look's model: palettes, the stored settings, and how they become
 * CSS custom properties. Pure -- no DOM, no imports -- so it runs under node --test.
 *
 * A palette is just two colours. glass.css derives every other colour from them
 * with color-mix(); the only colours worked out here are the ones CSS cannot
 * decide for itself: which ink stays readable on a fill the user picked.
 */

export interface Palette {
  id: string;
  name: string;
  /** '#rrggbb' -- the ground, the glows, the glass tint, primary buttons. */
  base: string;
  /** '#rrggbb' -- small accents: the tab marker, the logo, avatars. */
  accent: string;
}

/** Names are English keys, translated where they are shown. */
export const BUILTIN_PALETTES: readonly Palette[] = [
  { id: "mint", name: "Mint", base: "#22a35a", accent: "#ee5a24" },
  { id: "ocean", name: "Ocean", base: "#2f7fd8", accent: "#f59e0b" },
  { id: "sunset", name: "Sunset", base: "#ea6a2c", accent: "#6d4ae6" },
  { id: "lavender", name: "Lavender", base: "#8b5cf6", accent: "#ec4899" },
  { id: "graphite", name: "Graphite", base: "#64748b", accent: "#f97316" },
];

/** Mirrors schemas.Appearance on the server, field for field. */
export interface Appearance {
  glass: boolean;
  /** A built-in palette id or one of `palettes`. */
  palette: string;
  palettes: Palette[];
  /** Backdrop glow strength; 1 is the designed look. */
  glow: number;
  /** Frost radius in px; 0 means a plain translucent fill. */
  blur: number;
  /** Panel opacity in %. */
  fill: number;
  /** 0 keeps the hand-placed glow layout; anything else shuffles it. */
  backdrop_seed: number;
  /** The glows drift. */
  flow: boolean;
  flow_speed: number;
  flow_range: number;
}

/** The server's bounds; parsing clamps into them, so a save is never refused. */
export const LIMITS = {
  glow: { min: 0, max: 2 },
  blur: { min: 0, max: 40 },
  fill: { min: 20, max: 95 },
  flow_speed: { min: 0.25, max: 4 },
  flow_range: { min: 0.5, max: 2 },
} as const;

export const MAX_PALETTES = 12;
export const MAX_SEED = 0xffffffff;

export const DEFAULT_APPEARANCE: Appearance = {
  glass: false,
  palette: "mint",
  palettes: [],
  glow: 1,
  blur: 18,
  fill: 55,
  backdrop_seed: 0,
  flow: false,
  flow_speed: 1,
  flow_range: 1,
};

/* ------------------------------------------------------------------ parsing */

const HEX = /^#[0-9a-f]{6}$/;
const PALETTE_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** '#RRGGBB', 'rrggbb', ' #rrggbb ' -> '#rrggbb'; anything else -> null. */
export function parseHex(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const hex = value.trim().toLowerCase();
  const full = hex.startsWith("#") ? hex : `#${hex}`;
  return HEX.test(full) ? full : null;
}

export function parseSeed(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= MAX_SEED
    ? value
    : 0;
}

function parseNumber(value: unknown, fallback: number, range: { min: number; max: number }): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(range.max, Math.max(range.min, value));
}

export function parsePalette(value: unknown): Palette | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const name = typeof raw.name === "string" ? raw.name.trim().slice(0, 40) : "";
  const base = parseHex(raw.base);
  const accent = parseHex(raw.accent);
  if (typeof raw.id !== "string" || !PALETTE_ID.test(raw.id) || !name || !base || !accent) return null;
  return { id: raw.id, name, base, accent };
}

/**
 * Whatever came from the server or local storage -> a valid Appearance.
 * Each field falls back to its default on its own, so one bad value never
 * costs the user the rest of their look.
 */
export function parseAppearance(value: unknown): Appearance {
  const raw = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const d = DEFAULT_APPEARANCE;

  const palettes: Palette[] = [];
  if (Array.isArray(raw.palettes)) {
    for (const item of raw.palettes) {
      const palette = parsePalette(item);
      if (palette && palettes.length < MAX_PALETTES && !palettes.some((p) => p.id === palette.id)) {
        palettes.push(palette);
      }
    }
  }

  return {
    glass: typeof raw.glass === "boolean" ? raw.glass : d.glass,
    palette: typeof raw.palette === "string" && PALETTE_ID.test(raw.palette) ? raw.palette : d.palette,
    palettes,
    glow: parseNumber(raw.glow, d.glow, LIMITS.glow),
    blur: Math.round(parseNumber(raw.blur, d.blur, LIMITS.blur)),
    fill: Math.round(parseNumber(raw.fill, d.fill, LIMITS.fill)),
    backdrop_seed: parseSeed(raw.backdrop_seed),
    flow: typeof raw.flow === "boolean" ? raw.flow : d.flow,
    flow_speed: parseNumber(raw.flow_speed, d.flow_speed, LIMITS.flow_speed),
    flow_range: parseNumber(raw.flow_range, d.flow_range, LIMITS.flow_range),
  };
}

/** The user's own palette first, then a built-in, then the default. */
export function resolvePalette(id: string, own: readonly Palette[]): Palette {
  return own.find((p) => p.id === id) ?? BUILTIN_PALETTES.find((p) => p.id === id) ?? BUILTIN_PALETTES[0];
}

export function isBuiltin(id: string): boolean {
  return BUILTIN_PALETTES.some((p) => p.id === id);
}

export function newPaletteId(taken: readonly string[], random: () => number = Math.random): string {
  for (;;) {
    const id = `custom-${Math.floor(random() * 36 ** 6).toString(36).padStart(6, "0")}`;
    if (!taken.includes(id) && !isBuiltin(id)) return id;
  }
}

/** A fresh shuffle; never 0, which means "not shuffled". */
export function randomSeed(random: () => number = Math.random): number {
  return 1 + Math.floor(random() * (MAX_SEED - 1));
}

/* ------------------------------------------------------------------- colour */

type Rgb = [number, number, number];

function toRgb(hex: string): Rgb {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function toHex(rgb: Rgb): string {
  return `#${rgb.map((c) => Math.round(c).toString(16).padStart(2, "0")).join("")}`;
}

/** `color-mix(in srgb, a <weight>, b)` -- the browser's arithmetic for opaque colours. */
export function mixHex(a: string, b: string, weight: number): string {
  const x = toRgb(a);
  const y = toRgb(b);
  return toHex([0, 1, 2].map((i) => x[i] * weight + y[i] * (1 - weight)) as Rgb);
}

function luminance(hex: string): number {
  const [r, g, b] = toRgb(hex).map((c) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio, 1..21. */
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (hi + 0.05) / (lo + 0.05);
}

export const DARK_INK = "#0a0f0c";
export const LIGHT_INK = "#ffffff";

/** Whichever ink reads better on `fill`; a palette can be any colour at all. */
export function readableOn(fill: string): string {
  return contrast(fill, DARK_INK) >= contrast(fill, LIGHT_INK) ? DARK_INK : LIGHT_INK;
}

/* These four mixes must match the ones in glass.css. */
const primaryOnDark = (p: Palette) => mixHex(p.base, "#ffffff", 0.72);
const primaryOnLight = (p: Palette) => mixHex(p.base, "#000000", 0.88);
const accentOnDark = (p: Palette) => mixHex(p.accent, "#ffffff", 0.85);
const accentOnLight = (p: Palette) => p.accent;

/** Status-bar colours that match the glass ground at the top of the screen. */
export function themeColors(palette: Palette): { light: string; dark: string } {
  return {
    light: mixHex(palette.base, "#ffffff", 0.04),
    dark: mixHex(palette.base, "#090c0a", 0.06),
  };
}

/** Both colours of a palette in one circle, split on the diagonal. */
export function swatch(palette: Palette): string {
  return `conic-gradient(from 225deg, ${palette.base} 0 50%, ${palette.accent} 50% 100%)`;
}

/* ---------------------------------------------------------------- variables */

/**
 * Where the four glows sit. Seed 0 sets nothing, so the stylesheet's own
 * hand-placed layout shows; any other seed drives an LCG, so the same seed
 * gives the same layout on every render and every device.
 */
export function glowLayout(seed: number): Record<string, string> {
  let state = parseSeed(seed);
  const vars: Record<string, string> = {};
  if (state === 0) return vars;
  const position = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return `${Math.round(5 + (state / 0x100000000) * 90)}%`;
  };
  for (let i = 1; i <= 4; i++) {
    vars[`--glass-glow-${i}-x`] = position();
    vars[`--glass-glow-${i}-y`] = position();
  }
  return vars;
}

/**
 * The only place a palette crosses into CSS: custom properties for the inline
 * style of <html>. Every name starts with `--glass-`, which is how the
 * pre-paint script in index.html knows what it may apply.
 */
export function glassVars(look: Appearance, palette: Palette): Record<string, string> {
  const vars: Record<string, string> = {
    "--glass-base": palette.base,
    "--glass-accent": palette.accent,
    "--glass-glow": String(look.glow),
    "--glass-fill": `${look.fill}%`,
    "--glass-on-primary-dark": readableOn(primaryOnDark(palette)),
    "--glass-on-primary-light": readableOn(primaryOnLight(palette)),
    "--glass-on-accent-dark": readableOn(accentOnDark(palette)),
    "--glass-on-accent-light": readableOn(accentOnLight(palette)),
    ...glowLayout(look.backdrop_seed),
  };
  // No frost at all, rather than a zero blur that still costs a backdrop pass.
  if (look.blur > 0) vars["--glass-blur-px"] = `${look.blur}px`;
  else vars["--glass-blur"] = "none";
  return vars;
}
