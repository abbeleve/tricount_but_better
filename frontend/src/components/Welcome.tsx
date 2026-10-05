/**
 * The moment after signing in, staged in 3D.
 *
 * The sign-in screen tips back and falls away. The Split mark flies in from
 * the distance as a solid tile, turning over a receding floor, while the
 * greeting flips up letter by letter. Then the tile squares up, flattens and
 * lands on the mark in the header, as the home page stands up into place and
 * its blocks are dealt in after it.
 *
 * The app switches to the home page behind the scene as soon as the sign-in
 * screen is gone (lib/entrance.ts), so the account never waits on the
 * animation. Every motion is a transform or opacity on the Web Animations API.
 * Click, tap or any key skips ahead.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { findBrandMark, holdApp, landApp, onWelcome, revealApp, type WelcomeRequest } from "../lib/entrance";
import { useI18n } from "../lib/i18n";

/** Side of the tile on stage, its thickness, and the slices that make it. */
const SIZE = 112;
const DEPTH = 24;
const LAYERS = 16;

/** Milliseconds from the start. */
const AT = {
  covered: 640,
  fly: 340,
  greet: 900,
  name: 1100,
  exit: 2300,
};
const FLY_MS = 1150;
const DOCK_MS = 780;

const EASE_OUT = "cubic-bezier(0.16, 1, 0.3, 1)";
const EASE_IN_OUT = "cubic-bezier(0.65, 0, 0.35, 1)";
const CAMERA = "perspective(1000px)";

/** One pose of the tile: where it is and how it is turned. */
function pose(z: number, y: number, rx: number, ry: number, rz: number): string {
  return `${CAMERA} translate3d(0, ${y}px, ${z}px) rotateX(${rx}deg) rotateY(${ry}deg) rotateZ(${rz}deg)`;
}

export default function Welcome() {
  const [current, setCurrent] = useState<{ id: number; request: WelcomeRequest } | null>(null);
  useEffect(() => onWelcome((request) => setCurrent((prev) => ({ id: (prev?.id ?? 0) + 1, request }))), []);
  const finish = useCallback(() => setCurrent(null), []);
  if (!current) return null;
  return createPortal(<WelcomeScene key={current.id} request={current.request} onDone={finish} />, document.body);
}

function WelcomeScene({ request, onDone }: { request: WelcomeRequest; onDone: () => void }) {
  const { t } = useI18n();
  const root = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const scene = root.current!;
    const one = (name: string) => scene.querySelector<HTMLElement>(`[data-part="${name}"]`)!;
    const all = (name: string) => [...scene.querySelectorAll<HTMLElement>(`[data-part="${name}"]`)];
    const app = document.getElementById("root")!;

    const running: Animation[] = [];
    const timers: number[] = [];
    let covered = false;
    let leaving = false;
    let revealed = false;
    let over = false;

    const play = (el: Element, keyframes: Keyframe[], options: KeyframeAnimationOptions) => {
      const animation = el.animate(keyframes, { fill: "both", easing: EASE_OUT, ...options });
      running.push(animation);
      return animation;
    };
    const at = (ms: number, beat: () => void) => timers.push(window.setTimeout(beat, ms));

    const anchor = one("anchor");
    const slab = one("slab");
    const letters = [...all("greet"), ...all("name")];

    /* 1. The sign-in screen tips back onto the floor and is gone. */
    app.style.transformOrigin = "50% 85%";
    const fall = play(
      app,
      [
        { transform: "perspective(1200px) translateY(0) rotateX(0deg) translateZ(0)", opacity: 1 },
        { opacity: 1, offset: 0.5 },
        { transform: "perspective(1200px) translateY(12%) rotateX(64deg) translateZ(-520px)", opacity: 0 },
      ],
      { duration: AT.covered, easing: "cubic-bezier(0.5, 0, 0.75, 0.3)", fill: "forwards" },
    );
    // Only once the page is nearly gone, so the backdrop never dims its fall.
    play(one("backdrop"), [{ opacity: 0 }, { opacity: 1 }], { delay: AT.covered - 120, duration: 120, easing: "linear" });

    // Out of sight now: let the app switch to the home page behind the scene.
    at(AT.covered, cover);
    function cover() {
      if (covered) return;
      covered = true;
      holdApp();
      fall.cancel();
      app.style.transformOrigin = "";
      request.covered();
    }

    /* 2. A floor rolls toward us; the tile flies in over it, turning. */
    play(
      one("floor"),
      [
        { opacity: 0, transform: "perspective(900px) rotateX(58deg) translateY(0)" },
        { opacity: 1, offset: 0.4 },
        { opacity: 1, transform: "perspective(900px) rotateX(58deg) translateY(112px)" },
      ],
      { delay: 120, duration: 1900, easing: "cubic-bezier(0.3, 0, 0.2, 1)" },
    );
    play(anchor, [{ opacity: 0 }, { opacity: 1 }], { delay: AT.fly, duration: 260, easing: "linear" });
    play(slab, [{ transform: pose(-2600, -80, 40, -330, -20) }, { transform: pose(0, 0, 14, -28, 0) }], {
      delay: AT.fly,
      duration: FLY_MS,
      easing: EASE_OUT,
    });
    play(one("shadow"), [{ opacity: 0, transform: "scale(0.2)" }, { opacity: 1, transform: "scale(1)" }], {
      delay: AT.fly + 250,
      duration: FLY_MS - 250,
    });
    play(one("sheen"), [{ backgroundPosition: "100% 0" }, { backgroundPosition: "0% 0" }], {
      delay: AT.fly + 650,
      duration: 900,
      easing: EASE_IN_OUT,
    });
    // Once there, it keeps drifting, so it never looks parked.
    at(AT.fly + FLY_MS, () =>
      play(slab, [{ transform: pose(0, -6, 6, -10, 0) }], { duration: 1100, easing: EASE_IN_OUT, fill: "forwards" }),
    );

    /* 3. The greeting flips up, a letter at a time. */
    const flipIn = (els: HTMLElement[], start: number, gap: number) =>
      els.forEach((el, i) =>
        play(
          el,
          [
            { opacity: 0, transform: "perspective(500px) translateY(6px) rotateX(-100deg)" },
            { opacity: 1, transform: "perspective(500px) translateY(0) rotateX(0deg)" },
          ],
          { delay: start + i * gap, duration: 700 },
        ),
      );
    flipIn(all("greet"), AT.greet, 22);
    flipIn(all("name"), AT.name, 42);

    /* 4. Everything clears; the tile squares up and flattens into the mark. */
    at(AT.exit, leave);
    function leave() {
      if (leaving) return;
      leaving = true;
      timers.forEach(clearTimeout);
      letters.forEach((el, i) =>
        play(el, [{ opacity: 0, transform: "perspective(500px) translateY(-4px) rotateX(90deg)" }], {
          delay: i * 12,
          duration: 280,
          easing: "ease-in",
          fill: "forwards",
        }),
      );
      play(one("floor"), [{ opacity: 0 }], { duration: 380, easing: "ease-in", fill: "forwards" });
      play(one("shadow"), [{ opacity: 0 }], { duration: 300, fill: "forwards" });
      play(slab, [{ transform: pose(0, 0, 0, 0, 0) }], { duration: 420, easing: EASE_IN_OUT, fill: "forwards" });
      play(one("depth"), [{ transform: "scaleZ(1)" }, { transform: "scaleZ(0.001)" }], {
        delay: 160,
        duration: 300,
        easing: "ease-in",
        fill: "forwards",
      });
      at(440, dock);
    }

    /* 5. The mark lands in the header; the home page stands up under it. */
    function dock() {
      const target = findBrandMark();
      scene.style.pointerEvents = "none";
      play(one("backdrop"), [{ opacity: 0 }], { duration: 420, easing: "ease-out", fill: "forwards" });
      reveal(Boolean(target));

      // Not tracked in `running`: it must finish even after the scene is gone.
      app.style.transformOrigin = "50% 0";
      app.animate(
        [{ transform: "perspective(1400px) translateY(28px) rotateX(18deg) scale(0.97)" }, { transform: "none" }],
        { duration: 900, easing: EASE_OUT },
      ).finished.then(() => (app.style.transformOrigin = ""), () => {});

      if (!target) {
        play(anchor, [{ opacity: 0, transform: "scale(0.6)" }], { duration: 360, easing: "ease-in", fill: "forwards" })
          .finished.then(end, () => {});
        return;
      }
      const from = anchor.getBoundingClientRect();
      const dx = target.left + target.width / 2 - (from.left + from.width / 2);
      const dy = target.top + target.height / 2 - (from.top + from.height / 2);
      play(anchor, [{ transform: "none" }, { transform: `translate(${dx}px, ${dy}px) scale(${target.width / from.width})` }], {
        duration: DOCK_MS,
        easing: "cubic-bezier(0.6, 0, 0.15, 1)",
        fill: "forwards",
      }).finished.then(end, () => {});
    }

    function reveal(docking: boolean) {
      if (revealed) return;
      revealed = true;
      revealApp({ docking, style: "deal" });
    }

    function end() {
      if (over) return;
      over = true;
      cover();
      reveal(false);
      landApp();
      onDone();
    }

    /** Skipping jumps to the landing, once the app is ready underneath. */
    function skip() {
      if (leaving) return;
      if (covered) leave();
      else timers.push(window.setTimeout(skip, AT.covered - 40));
    }

    const onHidden = () => document.visibilityState === "hidden" && end();
    scene.addEventListener("pointerdown", skip);
    window.addEventListener("keydown", skip);
    document.addEventListener("visibilitychange", onHidden);

    return () => {
      timers.forEach(clearTimeout);
      running.forEach((animation) => animation.cancel());
      app.style.transformOrigin = "";
      scene.removeEventListener("pointerdown", skip);
      window.removeEventListener("keydown", skip);
      document.removeEventListener("visibilitychange", onHidden);
    };
  }, [request, onDone]);

  const greeting = request.returning ? t("Welcome back") : t("Welcome");

  return (
    <div ref={root} className="fixed inset-0 z-[100] touch-none select-none overflow-hidden overscroll-contain">
      <div data-part="backdrop" className="absolute inset-0 bg-bg" />
      <div data-part="floor" className="welcome-floor" aria-hidden="true" />

      <div className="absolute inset-0 grid place-items-center px-4">
        <div className="flex flex-col items-center">
          <div data-part="anchor" className="relative" style={{ width: SIZE, height: SIZE }} aria-hidden="true">
            <div
              data-part="shadow"
              className="absolute -bottom-9 left-1/2 h-4 w-24 -ml-12 rounded-[50%] bg-black/25 blur-md dark:hidden"
            />
            <div data-part="slab" className="slab">
              <div data-part="depth" className="slab-depth">
                {Array.from({ length: LAYERS }, (_, i) => (
                  <div
                    key={i}
                    className="slab-layer"
                    style={{
                      transform: `translateZ(${(-(i + 1) * DEPTH) / LAYERS}px)`,
                      background: `color-mix(in srgb, var(--slab-edge-deep) ${Math.round((i / (LAYERS - 1)) * 100)}%, var(--slab-edge))`,
                    }}
                  />
                ))}
                <div className="slab-face" style={{ transform: `translateZ(${-DEPTH}px) rotateY(180deg)` }}>
                  <Strokes />
                </div>
              </div>
              <div className="slab-face">
                <Strokes />
                <div data-part="sheen" className="slab-sheen" />
              </div>
            </div>
          </div>

          <p className="mt-20 text-center text-[15px] text-muted" aria-live="polite">
            <Letters text={greeting} part="greet" />
          </p>
          <p className="mt-1 max-w-[18ch] text-center text-[clamp(1.875rem,9vw,2.75rem)] font-semibold leading-tight tracking-tight text-body">
            <Letters text={request.name} part="name" />
          </p>
        </div>
      </div>
    </div>
  );
}

/** The mark's three strokes, at the same 4/7 of the side as BrandMark. */
function Strokes() {
  return (
    <svg viewBox="0 0 20 20" width={(SIZE * 4) / 7} height={(SIZE * 4) / 7} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <path d="M4 6h12M4 10h12M4 14h7" />
    </svg>
  );
}

/** Text split into letters that can each turn; words still wrap as words. */
function Letters({ text, part }: { text: string; part: string }) {
  return text.split(/\s+/).map((word, w) => (
    <span key={w}>
      {w > 0 && " "}
      <span className="inline-block whitespace-nowrap">
        {Array.from(word).map((letter, i) => (
          <span key={i} data-part={part} className="flip-letter">
            {letter}
          </span>
        ))}
      </span>
    </span>
  ));
}
