/**
 * Trimming a photo to a box and cutting it across into parts.
 *
 * A receipt is long and narrow, so a photo of it is mostly table around it,
 * and shrunk to the size a model reads it at, a long one's print gets too
 * small to read. The box's four edges trim what is not the receipt; cut lines
 * across split the box into parts that are read as pages of one receipt, each
 * at full size.
 *
 * Positions are fractions of the photo, so they hold at any display size.
 */

export interface CutPlan {
  /** The kept box, 0 to 1 across and down the photo. */
  left: number;
  right: number;
  top: number;
  bottom: number;
  /** Where the box is cut across, ascending, strictly between top and bottom. */
  cuts: number[];
}

export type Edge = "left" | "right" | "top" | "bottom";

/** The narrowest kept width, and the shortest part, as a fraction of the photo. */
export const MIN_PART = 0.04;

export const WHOLE: CutPlan = { left: 0, right: 1, top: 0, bottom: 1, cuts: [] };

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

export function isWhole(plan: CutPlan): boolean {
  return (
    plan.left === 0 && plan.right === 1 && plan.top === 0 && plan.bottom === 1 && plan.cuts.length === 0
  );
}

/** An edge of the box moved towards `to`. It stops short of the opposite edge,
 * and the top and bottom also of the nearest cut, so no part is left empty. */
export function moveEdge(plan: CutPlan, edge: Edge, to: number): CutPlan {
  switch (edge) {
    case "left":
      return { ...plan, left: clamp(to, 0, plan.right - MIN_PART) };
    case "right":
      return { ...plan, right: clamp(to, plan.left + MIN_PART, 1) };
    case "top":
      return { ...plan, top: clamp(to, 0, (plan.cuts[0] ?? plan.bottom) - MIN_PART) };
    case "bottom":
      return { ...plan, bottom: clamp(to, (plan.cuts.at(-1) ?? plan.top) + MIN_PART, 1) };
  }
}

/** A cut moved towards `to`; it stops short of its neighbours and the box's
 * top and bottom, so cuts never pass each other and no part is left empty. */
export function moveCut(plan: CutPlan, index: number, to: number): CutPlan {
  const low = (plan.cuts[index - 1] ?? plan.top) + MIN_PART;
  const high = (plan.cuts[index + 1] ?? plan.bottom) - MIN_PART;
  return { ...plan, cuts: plan.cuts.map((cut, i) => (i === index ? clamp(to, low, high) : cut)) };
}

/** Whether the last part is tall enough to cut in two. */
export function canAddCut(plan: CutPlan): boolean {
  return plan.bottom - (plan.cuts.at(-1) ?? plan.top) >= 2 * MIN_PART;
}

/** A new cut halfway down the last part, below every other cut. */
export function addCut(plan: CutPlan): CutPlan {
  if (!canAddCut(plan)) return plan;
  const last = plan.cuts.at(-1) ?? plan.top;
  return { ...plan, cuts: [...plan.cuts, (last + plan.bottom) / 2] };
}

export function removeCut(plan: CutPlan, index: number): CutPlan {
  return { ...plan, cuts: plan.cuts.filter((_, i) => i !== index) };
}

export interface Piece {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The parts of a `width` x `height` photo inside the box, in pixels, top to
 * bottom. They share edges and never overlap, so no line is read twice. */
export function pieces(plan: CutPlan, width: number, height: number): Piece[] {
  const x = Math.round(plan.left * width);
  const kept = Math.max(1, Math.round(plan.right * width) - x);
  const ys = [plan.top, ...plan.cuts, plan.bottom].map((at) => Math.round(at * height));
  return ys.slice(1).map((bottom, i) => ({
    x,
    y: ys[i],
    width: kept,
    height: Math.max(1, bottom - ys[i]),
  }));
}

// iOS Safari will not draw a canvas larger than this; a bigger part is scaled
// down to fit. The server shrinks every photo further anyway.
const MAX_CANVAS_PIXELS = 16_777_216;

/** The parts of a loaded photo as JPEG files, top to bottom. */
export async function cutPhoto(image: HTMLImageElement, plan: CutPlan, name: string): Promise<File[]> {
  const base = name.replace(/\.[^.]*$/, "") || "photo";
  const parts = pieces(plan, image.naturalWidth, image.naturalHeight);
  const files: File[] = [];
  for (const [i, part] of parts.entries()) {
    const scale = Math.min(1, Math.sqrt(MAX_CANVAS_PIXELS / (part.width * part.height)));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(part.width * scale));
    canvas.height = Math.max(1, Math.round(part.height * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Could not cut this photo.");
    context.drawImage(image, part.x, part.y, part.width, part.height, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.92));
    if (!blob) throw new Error("Could not cut this photo.");
    const suffix = parts.length > 1 ? `-${i + 1}` : "";
    files.push(new File([blob], `${base}${suffix}.jpg`, { type: "image/jpeg" }));
  }
  return files;
}

// ---------------------------------------------------------------- zoom

/** How far a photo can be enlarged past fitting the editor. */
export const MAX_ZOOM = 8;

export interface Size {
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

/** Where the photo sits in the editor's scrolling area, in CSS pixels. */
export interface View {
  left: number;
  top: number;
  width: number;
  height: number;
  /** The whole scrollable area: the photo with a margin, never smaller than the stage. */
  areaWidth: number;
  areaHeight: number;
}

export function clampZoom(zoom: number): number {
  return Number.isFinite(zoom) ? Math.min(MAX_ZOOM, Math.max(1, zoom)) : 1;
}

/** The photo fitted inside `stage` with a `margin` around it, then enlarged by
 * `zoom`, and centred while it is smaller than the stage. */
export function photoView(photo: Size, stage: Size, zoom: number, margin = 16): View {
  const fit = Math.max(
    0,
    Math.min((stage.width - 2 * margin) / photo.width, (stage.height - 2 * margin) / photo.height),
  );
  const width = photo.width * fit * zoom;
  const height = photo.height * fit * zoom;
  const areaWidth = Math.max(stage.width, width + 2 * margin);
  const areaHeight = Math.max(stage.height, height + 2 * margin);
  return { left: (areaWidth - width) / 2, top: (areaHeight - height) / 2, width, height, areaWidth, areaHeight };
}

/** The point of the photo, as fractions, under a point of the stage. */
export function photoPoint(view: View, scroll: Point, under: Point): Point {
  return {
    x: view.width ? (scroll.x + under.x - view.left) / view.width : 0.5,
    y: view.height ? (scroll.y + under.y - view.top) / view.height : 0.5,
  };
}

/** The scroll that puts point `at` of the photo under point `under` of the
 * stage, as near as the edges of the area allow. */
export function scrollFor(view: View, stage: Size, at: Point, under: Point): Point {
  return {
    x: Math.min(Math.max(0, view.left + at.x * view.width - under.x), view.areaWidth - stage.width),
    y: Math.min(Math.max(0, view.top + at.y * view.height - under.y), view.areaHeight - stage.height),
  };
}
