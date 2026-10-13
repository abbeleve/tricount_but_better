import {
  useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent,
} from "react";
import { Button, FormError, cx } from "./ui";
import { useI18n } from "../lib/i18n";
import {
  MAX_ZOOM, WHOLE, addCut, canAddCut, clampZoom, cutPhoto, isWhole, moveCut, moveEdge, photoPoint,
  photoView, removeCut, scrollFor, type CutPlan, type Edge, type Point, type Size,
} from "../lib/photoCut";

interface Props {
  file: File;
  url: string;
  /** How many photos this one may become, so the scan stays within its limit. */
  maxParts: number;
  /** The limit itself, for saying why no more cuts fit. */
  maxPhotos: number;
  /** The parts, top to bottom; `null` when the photo stays as it was. */
  onDone: (parts: File[] | null) => void;
  onCancel: () => void;
}

type Handle = { kind: "edge"; edge: Edge } | { kind: "cut"; index: number };

const EDGES: Record<Edge, string> = {
  left: "Left edge",
  right: "Right edge",
  top: "Top edge",
  bottom: "Bottom edge",
};

/** Whether a handle moves up and down rather than left and right. */
function upright(handle: Handle): boolean {
  return handle.kind === "cut" || handle.edge === "top" || handle.edge === "bottom";
}

const STEP = 0.01;
/** One press of a zoom button or key. */
const ZOOM_STEP = 1.5;

// Lines and knobs sit on any photo, so they are white with a dark edge rather
// than theme colours.
const LINE = "bg-white shadow-[0_0_0_1px_rgb(0_0_0/0.45)]";
// A cut is dashed, so it does not read as an edge of the box.
const CUT_LINE = "h-0 border-t-2 border-dashed border-white drop-shadow-[0_0_1px_rgb(0_0_0/0.9)]";
const KNOB = cx(
  "rounded-full bg-white shadow-[0_0_0_1px_rgb(0_0_0/0.35),0_1px_4px_rgb(0_0_0/0.4)]",
  "transition-transform duration-150 group-active:scale-110 group-active:duration-0",
  "group-focus-visible:ring-2 group-focus-visible:ring-ink group-focus-visible:ring-offset-2",
);
// The line is thin; the strip around it is what a finger catches.
const HANDLE = "group absolute touch-none outline-none";
const ZOOM_BUTTON = cx(
  "grid size-10 place-items-center rounded-full transition active:scale-90 active:duration-0",
  "hover:bg-white/15 disabled:opacity-40 disabled:hover:bg-transparent",
  "focus-visible:outline-2 focus-visible:outline-offset-[-4px] focus-visible:outline-white",
);

/**
 * Trim a photo to a box and cut it across into parts, in a dialog over the
 * scanner. The box's edges move in from all four sides; cut lines are added
 * below the last one and move up and down, never past each other or out of
 * the box.
 */
export function PhotoCutter({ file, url, maxParts, maxPhotos, onDone, onCancel }: Props) {
  const { t, language } = useI18n();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const grab = useRef<{ handle: Handle; offset: number } | null>(null);
  const [plan, setPlan] = useState<CutPlan>(WHOLE);
  const [natural, setNatural] = useState<Size | null>(null);
  const [stage, setStage] = useState<Size | null>(null);
  // Zoom is over the photo fitted to the editor. A change keeps one point of
  // the photo where it was on screen: under the pointer, between two fingers,
  // or in the middle.
  const [zoom, setZoom] = useState(1);
  const [zoomed, setZoomed] = useState(0);
  const anchor = useRef<{ at: Point; under: Point } | null>(null);
  const shownZoom = useRef(1);
  const wantedZoom = useRef(1);
  const fingers = useRef(new Map<number, Point>());
  const pinch = useRef<{ distance: number; zoom: number; at: Point } | null>(null);
  const [broken, setBroken] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Unmounting removes the dialog from the page, which ends the modal too.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  // The photo is drawn as large as the stage allows, and the lines are laid
  // over exactly that box.
  useLayoutEffect(() => {
    const element = stageRef.current;
    if (!element) return;
    const measure = () => setStage({ width: element.clientWidth, height: element.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const view = natural && stage ? photoView(natural, stage, zoom) : null;

  const showZoom = useCallback((next: number, at: Point, under: Point) => {
    anchor.current = { at, under };
    wantedZoom.current = clampZoom(next);
    setZoom(wantedZoom.current);
    setZoomed((n) => n + 1);
  }, []);

  // Once the photo is drawn at the new size, scroll it so the anchor is back
  // where it was.
  useLayoutEffect(() => {
    const element = scrollRef.current;
    shownZoom.current = zoom;
    const held = anchor.current;
    if (!element || !natural || !stage || !held) return;
    anchor.current = null;
    const scroll = scrollFor(photoView(natural, stage, zoom), stage, held.at, held.under);
    element.scrollLeft = scroll.x;
    element.scrollTop = scroll.y;
  }, [zoom, zoomed, natural, stage]);

  /** Zoom by `factor` around a point of the stage, its middle by default. */
  const zoomBy = useCallback((factor: number, under?: Point) => {
    const element = scrollRef.current;
    if (!element || !natural || !stage) return;
    const point = under ?? { x: stage.width / 2, y: stage.height / 2 };
    const shown = photoView(natural, stage, shownZoom.current);
    const at = photoPoint(shown, { x: element.scrollLeft, y: element.scrollTop }, point);
    showZoom(wantedZoom.current * factor, at, point);
  }, [natural, stage, showZoom]);

  // Ctrl or ⌘ with the wheel, and a trackpad pinch, which arrives as one.
  // Listened to directly: React's wheel listener cannot stop the page zooming.
  useEffect(() => {
    const area = scrollRef.current;
    if (!area) return;
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const box = area.getBoundingClientRect();
      const delta = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? event.deltaY * 16 : event.deltaY;
      zoomBy(Math.exp(-delta / 250), { x: event.clientX - box.left, y: event.clientY - box.top });
    };
    area.addEventListener("wheel", onWheel, { passive: false });
    return () => area.removeEventListener("wheel", onWheel);
  }, [zoomBy, broken]);

  function stagePoint(event: PointerEvent): Point {
    const box = scrollRef.current?.getBoundingClientRect();
    return { x: event.clientX - (box?.left ?? 0), y: event.clientY - (box?.top ?? 0) };
  }

  function pinchFrom(a: Point, b: Point) {
    const element = scrollRef.current;
    if (!element || !natural || !stage) return null;
    const middle = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const shown = photoView(natural, stage, shownZoom.current);
    return {
      distance: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
      zoom: wantedZoom.current,
      at: photoPoint(shown, { x: element.scrollLeft, y: element.scrollTop }, middle),
    };
  }

  // One finger or the mouse pans the photo; two fingers pinch to zoom. The
  // lines and buttons on it keep their own pointers.
  function startPan(event: PointerEvent<HTMLDivElement>) {
    if ((event.target as Element).closest("[data-handle], button")) return;
    if (event.pointerType === "mouse" && event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    fingers.current.set(event.pointerId, stagePoint(event));
    const [a, b] = [...fingers.current.values()];
    pinch.current = b ? pinchFrom(a, b) : null;
  }

  function pan(event: PointerEvent<HTMLDivElement>) {
    const last = fingers.current.get(event.pointerId);
    const element = scrollRef.current;
    if (!last || !element) return;
    const now = stagePoint(event);
    fingers.current.set(event.pointerId, now);
    const [a, b] = [...fingers.current.values()];
    if (b && pinch.current) {
      const distance = Math.hypot(a.x - b.x, a.y - b.y);
      const middle = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      showZoom(pinch.current.zoom * (distance / pinch.current.distance), pinch.current.at, middle);
    } else if (!b) {
      element.scrollLeft -= now.x - last.x;
      element.scrollTop -= now.y - last.y;
    }
  }

  function endPan(event: PointerEvent<HTMLDivElement>) {
    fingers.current.delete(event.pointerId);
    pinch.current = null;
  }

  function onKeys(event: KeyboardEvent<HTMLDialogElement>) {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key === "+" || event.key === "=") zoomBy(ZOOM_STEP);
    else if (event.key === "-") zoomBy(1 / ZOOM_STEP);
    else if (event.key === "0") zoomBy(1 / wantedZoom.current);
    else return;
    event.preventDefault();
  }

  const zoomLabel = `${new Intl.NumberFormat(language, { maximumFractionDigits: 1 }).format(zoom)}×`;
  const parts = plan.cuts.length + 1;
  const full = parts >= maxParts;

  function at(handle: Handle, from: CutPlan): number {
    return handle.kind === "cut" ? from.cuts[handle.index] : from[handle.edge];
  }

  function moved(handle: Handle, from: CutPlan, to: number): CutPlan {
    return handle.kind === "cut" ? moveCut(from, handle.index, to) : moveEdge(from, handle.edge, to);
  }

  /** Where the pointer is along the line's axis, as a fraction of the photo. */
  function pointerAt(event: PointerEvent, handle: Handle): number | null {
    const box = frameRef.current?.getBoundingClientRect();
    if (!box?.width || !box.height) return null;
    return upright(handle)
      ? (event.clientY - box.top) / box.height
      : (event.clientX - box.left) / box.width;
  }

  function startDrag(event: PointerEvent<HTMLDivElement>, handle: Handle) {
    const pointer = pointerAt(event, handle);
    if (busy || event.button !== 0 || pointer === null) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    event.currentTarget.focus();
    // Held where it was grabbed, so the line does not jump to the finger.
    grab.current = { handle, offset: pointer - at(handle, plan) };
  }

  function drag(event: PointerEvent<HTMLDivElement>) {
    const held = grab.current;
    const pointer = held && pointerAt(event, held.handle);
    if (!held || pointer === null) return;
    setPlan((current) => moved(held.handle, current, pointer - held.offset));
  }

  function drop() {
    grab.current = null;
  }

  function nudge(event: KeyboardEvent<HTMLDivElement>, handle: Handle) {
    const forward = upright(handle) ? ["ArrowDown", "ArrowRight"] : ["ArrowRight", "ArrowDown"];
    const back = upright(handle) ? ["ArrowUp", "ArrowLeft"] : ["ArrowLeft", "ArrowUp"];
    const step = event.shiftKey ? STEP * 5 : STEP;
    if (forward.includes(event.key) || back.includes(event.key)) {
      event.preventDefault();
      const by = forward.includes(event.key) ? step : -step;
      setPlan((current) => moved(handle, current, at(handle, current) + by));
    } else if (handle.kind === "cut" && (event.key === "Delete" || event.key === "Backspace")) {
      event.preventDefault();
      setPlan((current) => removeCut(current, handle.index));
    }
  }

  async function finish() {
    const image = imageRef.current;
    if (isWhole(plan) || !image) {
      onDone(null);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      onDone(await cutPhoto(image, plan, file.name));
    } catch {
      setError(t("Could not cut this photo."));
      setBusy(false);
    }
  }

  const percent = (value: number) => `${(value * 100).toFixed(3)}%`;
  const bounds = [plan.top, ...plan.cuts];
  const across = { left: percent(plan.left), width: percent(plan.right - plan.left) };
  const down = { top: percent(plan.top), height: percent(plan.bottom - plan.top) };

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby="photo-cutter-title"
      // Escape closes the dialog itself; this keeps the scanner in step.
      onClose={onCancel}
      onKeyDown={onKeys}
      className={cx(
        "fixed inset-0 m-0 h-dvh max-h-none w-full max-w-none overflow-hidden bg-overlay p-0 text-body",
        "sm:m-auto sm:h-[min(92dvh,60rem)] sm:w-[min(92vw,44rem)] sm:rounded-card sm:border sm:border-line",
        "backdrop:bg-black/60",
      )}
    >
      <div className="flex h-full flex-col">
        <header className="flex items-start justify-between gap-3 border-b border-line px-4 pb-3 pt-[max(0.75rem,env(safe-area-inset-top))]">
          <div>
            <h2 id="photo-cutter-title" className="text-sm font-semibold">{t("Trim and cut the photo")}</h2>
            <p className="mt-0.5 text-[13px] text-muted">
              {t("Move the edges in to leave out the background. Add cuts to split a long photo into parts; each part is read as its own photo, so small print stays legible.")}
            </p>
          </div>
          {!isWhole(plan) && (
            <Button size="sm" variant="ghost" className="-mr-2 shrink-0" disabled={busy} onClick={() => setPlan(WHOLE)}>
              {t("Reset")}
            </Button>
          )}
        </header>

        <div ref={stageRef} className="relative min-h-0 flex-1 overflow-hidden bg-surface-2">
          {broken ? (
            <p role="alert" className="absolute inset-0 m-auto h-fit max-w-xs px-4 text-center text-sm text-muted">
              {t("This photo cannot be opened for editing in this browser.")}
            </p>
          ) : (
            <>
            <div
              ref={scrollRef}
              onPointerDown={startPan}
              onPointerMove={pan}
              onPointerUp={endPan}
              onPointerCancel={endPan}
              className={cx(
                "no-scrollbar absolute inset-0 touch-none overflow-auto overscroll-contain",
                zoom > 1 && "cursor-grab active:cursor-grabbing",
              )}
            >
            <div className="relative" style={view ? { width: view.areaWidth, height: view.areaHeight } : undefined}>
            <div
              ref={frameRef}
              className="absolute select-none"
              style={view
                ? { left: view.left, top: view.top, width: view.width, height: view.height }
                : { width: 0, height: 0, overflow: "hidden" }}
            >
              <img
                ref={imageRef}
                src={url}
                alt=""
                draggable={false}
                onLoad={(e) => setNatural({ width: e.currentTarget.naturalWidth, height: e.currentTarget.naturalHeight })}
                onError={() => setBroken(true)}
                className="block size-full"
              />

              {/* What is left out of the box. */}
              <div aria-hidden="true" className="absolute inset-x-0 top-0 bg-black/55" style={{ height: percent(plan.top) }} />
              <div aria-hidden="true" className="absolute inset-x-0 bottom-0 bg-black/55" style={{ height: percent(1 - plan.bottom) }} />
              <div aria-hidden="true" className="absolute left-0 bg-black/55" style={{ ...down, width: percent(plan.left) }} />
              <div aria-hidden="true" className="absolute right-0 bg-black/55" style={{ ...down, width: percent(1 - plan.right) }} />

              {/* Part numbers, so it is clear how many photos this becomes. */}
              {parts > 1 && bounds.map((top, i) => (
                <span
                  key={i}
                  aria-hidden="true"
                  className="pointer-events-none absolute m-1.5 rounded-full bg-black/60 px-1.5 text-[11px] font-medium leading-5 text-white tabular-nums"
                  style={{ top: percent(top), left: percent(plan.left) }}
                >
                  {i + 1}
                </span>
              ))}

              {plan.cuts.map((cut, index) => {
                const handle: Handle = { kind: "cut", index };
                return (
                  <div
                    key={index}
                    role="slider"
                    tabIndex={0}
                    aria-label={t("Cut {count}", { count: index + 1 })}
                    aria-orientation="vertical"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={Math.round(cut * 100)}
                    aria-valuetext={`${Math.round(cut * 100)}%`}
                    onPointerDown={(e) => startDrag(e, handle)}
                    onPointerMove={drag}
                    onPointerUp={drop}
                    onPointerCancel={drop}
                    onKeyDown={(e) => nudge(e, handle)}
                    data-handle=""
                    className={cx(HANDLE, "z-10 h-8 -translate-y-1/2 cursor-ns-resize pointer-coarse:h-11")}
                    style={{ ...across, top: percent(cut) }}
                  >
                    <span aria-hidden="true" className={cx(CUT_LINE, "absolute inset-x-0 top-1/2 -translate-y-1/2")} />
                    <button
                      type="button"
                      aria-label={t("Remove cut {count}", { count: index + 1 })}
                      disabled={busy}
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={() => setPlan((current) => removeCut(current, index))}
                      className={cx(
                        "absolute right-10 top-1/2 grid size-7 -translate-y-1/2 place-items-center rounded-full",
                        "bg-black/65 text-white transition active:scale-90 active:duration-0",
                      )}
                    >
                      <svg viewBox="0 0 16 16" className="size-3" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
                        <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" />
                      </svg>
                    </button>
                    <span aria-hidden="true" className={cx(KNOB, "absolute left-1/2 top-1/2 h-3 w-10 -translate-x-1/2 -translate-y-1/2")} />
                  </div>
                );
              })}

              {(["top", "bottom"] as const).map((edge) => {
                const handle: Handle = { kind: "edge", edge };
                const value = plan[edge];
                return (
                  <div
                    key={edge}
                    role="slider"
                    tabIndex={0}
                    aria-label={t(EDGES[edge])}
                    aria-orientation="vertical"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={Math.round(value * 100)}
                    aria-valuetext={`${Math.round(value * 100)}%`}
                    onPointerDown={(e) => startDrag(e, handle)}
                    onPointerMove={drag}
                    onPointerUp={drop}
                    onPointerCancel={drop}
                    onKeyDown={(e) => nudge(e, handle)}
                    data-handle=""
                    className={cx(HANDLE, "z-20 h-8 -translate-y-1/2 cursor-ns-resize pointer-coarse:h-11")}
                    style={{ ...across, top: percent(value) }}
                  >
                    <span aria-hidden="true" className={cx(LINE, "absolute inset-x-0 top-1/2 h-0.5 -translate-y-1/2")} />
                    <span aria-hidden="true" className={cx(KNOB, "absolute left-1/2 top-1/2 h-3 w-10 -translate-x-1/2 -translate-y-1/2")} />
                  </div>
                );
              })}

              {(["left", "right"] as const).map((edge) => {
                const handle: Handle = { kind: "edge", edge };
                const value = plan[edge];
                return (
                  <div
                    key={edge}
                    role="slider"
                    tabIndex={0}
                    aria-label={t(EDGES[edge])}
                    aria-orientation="horizontal"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={Math.round(value * 100)}
                    aria-valuetext={`${Math.round(value * 100)}%`}
                    onPointerDown={(e) => startDrag(e, handle)}
                    onPointerMove={drag}
                    onPointerUp={drop}
                    onPointerCancel={drop}
                    onKeyDown={(e) => nudge(e, handle)}
                    data-handle=""
                    className={cx(HANDLE, "z-20 w-8 -translate-x-1/2 cursor-ew-resize pointer-coarse:w-11")}
                    style={{ ...down, left: percent(value) }}
                  >
                    <span aria-hidden="true" className={cx(LINE, "absolute inset-y-0 left-1/2 w-0.5 -translate-x-1/2")} />
                    <span aria-hidden="true" className={cx(KNOB, "absolute left-1/2 top-1/2 h-10 w-3 -translate-x-1/2 -translate-y-1/2")} />
                  </div>
                );
              })}
            </div>
            </div>
            </div>

            <div className="absolute bottom-3 right-3 z-30 flex items-center rounded-full bg-black/65 text-white shadow-lg backdrop-blur-sm">
              <button
                type="button"
                aria-label={t("Zoom out")}
                title={t("Zoom out")}
                disabled={zoom <= 1 || !view}
                onClick={() => zoomBy(1 / ZOOM_STEP)}
                className={ZOOM_BUTTON}
              >
                <svg viewBox="0 0 16 16" className="size-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                  <path d="M3.5 8h9" />
                </svg>
              </button>
              <button
                type="button"
                aria-label={t("Fit the photo")}
                title={t("Fit the photo")}
                disabled={zoom <= 1 || !view}
                onClick={() => zoomBy(1 / wantedZoom.current)}
                className="h-10 min-w-11 px-1 text-[13px] font-medium tabular-nums disabled:opacity-100"
              >
                {zoomLabel}
              </button>
              <button
                type="button"
                aria-label={t("Zoom in")}
                title={t("Zoom in")}
                disabled={zoom >= MAX_ZOOM || !view}
                onClick={() => zoomBy(ZOOM_STEP)}
                className={ZOOM_BUTTON}
              >
                <svg viewBox="0 0 16 16" className="size-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                  <path d="M3.5 8h9M8 3.5v9" />
                </svg>
              </button>
            </div>
            </>
          )}
        </div>

        <footer className="flex flex-col gap-2 border-t border-line px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3">
          <FormError message={error} />
          <Button
            type="button"
            variant="secondary"
            full
            disabled={busy || broken || !natural || full || !canAddCut(plan)}
            onClick={() => setPlan(addCut)}
          >
            <svg viewBox="0 0 16 16" className="size-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <path d="M2 8h12M8 4.5v-2M8 13.5v-2" />
            </svg>
            {t("Add a cut")}
          </Button>
          {full && maxParts > 1 && (
            <p className="text-center text-[12px] text-muted">
              {t("A scan takes up to {count} photos.", { count: maxPhotos })}
            </p>
          )}
          {maxParts <= 1 && (
            <p className="text-center text-[12px] text-muted">
              {t("A scan takes up to {count} photos, so this one cannot be cut. Remove another photo first.", { count: maxPhotos })}
            </p>
          )}
          <div className="flex gap-2">
            <Button type="button" variant="ghost" className="flex-1" disabled={busy} onClick={onCancel}>
              {t("Cancel")}
            </Button>
            <Button type="button" className="flex-1" loading={busy} disabled={broken} onClick={finish}>
              {parts > 1
                ? t("Cut into {count} photos", { count: parts })
                : isWhole(plan) ? t("Done") : t("Trim photo")}
            </Button>
          </div>
        </footer>
      </div>
    </dialog>
  );
}
