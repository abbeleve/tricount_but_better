/**
 * Opening sequence, played on the first load of a browser session.
 *
 * It tells the app's story in four beats: a receipt prints, each line is split
 * between the people who shared it, the balances settle, and the receipt folds
 * into the Split mark -- which is a receipt drawn in three strokes -- and flies
 * to where the mark lives on the page underneath.
 *
 * The app renders the whole time behind the overlay, held invisible until the
 * hand-over (lib/entrance.ts), so landing on the real page costs nothing.
 * Everything runs on the Web Animations API, almost all of it transforms and
 * opacity; only the fold animates layout, on four absolutely placed elements.
 * Click, tap or any key skips it.
 */

import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { findBrandMark, holdApp, landApp, prefersReducedMotion, resetEntrance, revealApp } from "../lib/entrance";
import { getLanguage, useI18n } from "../lib/i18n";
import { previewEqualSplit } from "../lib/money";
import { cx } from "./ui";

const SEEN_KEY = "tbb.intro-seen";

/**
 * Decided once per page load, before the first render, so StrictMode's double
 * mount and hot reloads never replay it. `?intro` in the URL forces a replay.
 */
const PLAY = (() => {
  try {
    const url = new URL(window.location.href);
    const forced = url.searchParams.has("intro");
    if (forced) {
      url.searchParams.delete("intro");
      window.history.replaceState(window.history.state, "", url);
    }
    if (document.visibilityState === "hidden") return false;
    if (!forced && prefersReducedMotion()) return false;
    if (!forced && sessionStorage.getItem(SEEN_KEY)) return false;
    sessionStorage.setItem(SEEN_KEY, "1");
    return true;
  } catch {
    return false;
  }
})();

if (PLAY) holdApp();
else resetEntrance();

/* ------------------------------------------------------------------ scene */

const PEOPLE = ["Andrey", "Masha", "Dima"];
const PAYER = 0;
const ITEMS = [
  { name: "Chicken thighs", price: 34900, sharedBy: [0, 1] },
  { name: "Oat milk", price: 12900, sharedBy: [1, 2] },
  { name: "Napkins", price: 8900, sharedBy: [0, 1, 2] },
];
const TOTAL = ITEMS.reduce((sum, item) => sum + item.price, 0);

/** Every line split the way the server would split it; the payer is owed the rest. */
const BALANCES = PEOPLE.map((_, person) => {
  const share = ITEMS.reduce((sum, item) => {
    const weights = PEOPLE.map((_, p) => (item.sharedBy.includes(p) ? 1 : 0));
    return sum + previewEqualSplit(item.price, weights)[person];
  }, 0);
  return (person === PAYER ? TOTAL : 0) - share;
});

/* --------------------------------------------------------------- timeline */

/** Milliseconds from the start. One place to retime the whole sequence. */
const AT = {
  slot: 0,
  feed: 160,
  slotOut: 1150,
  people: 1200,
  split: 1550,
  count: 2350,
  fold: 3150,
  morph: 3420,
  dock: 4000,
};
const FEED_MS = 950;
const FLIGHT_MS = 600;
const COUNT_MS = 650;
const MORPH_MS = 600;
const DOCK_MS = 720;

/** Side of the mark at the end of the fold, before it shrinks into place. */
const MARK_SIZE = 76;

const EASE_OUT = "cubic-bezier(0.16, 1, 0.3, 1)";
const EASE_IN_OUT = "cubic-bezier(0.65, 0, 0.35, 1)";
const EASE_POP = "cubic-bezier(0.34, 1.56, 0.64, 1)";

const SUPPORTS_LINEAR = typeof CSS !== "undefined" && CSS.supports("transition-timing-function", "linear(0, 1)");

/** A receipt printer feeds in jolts: a quick push, a pause, repeated. */
function feedEasing(steps: number): string {
  if (!SUPPORTS_LINEAR) return EASE_OUT;
  const points = ["0 0%"];
  for (let i = 0; i < steps; i++) {
    const from = i / steps;
    const to = (i + 1) / steps;
    for (let k = 1; k <= 6; k++) {
      const p = k / 6;
      const progress = from + (to - from) * (1 - (1 - p) ** 3);
      const time = (from + (to - from) * 0.6 * p) * 100;
      points.push(`${progress.toFixed(4)} ${time.toFixed(2)}%`);
    }
    points.push(`${to.toFixed(4)} ${(to * 100).toFixed(2)}%`);
  }
  return `linear(${points.join(", ")})`;
}

/* --------------------------------------------------------------- geometry */

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

function boxIn(el: Element, origin: DOMRect): Box {
  const r = el.getBoundingClientRect();
  return { x: r.left - origin.left, y: r.top - origin.top, w: r.width, h: r.height };
}

const centre = (b: Box) => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });
const geometry = (b: Box) => ({ left: `${b.x}px`, top: `${b.y}px`, width: `${b.w}px`, height: `${b.h}px` });

/**
 * The three strokes of BrandMark inside a square of side `size`: a 20-unit
 * icon at 4/7 of the square, strokes 2 units wide with round caps.
 */
function markStrokes(size: number): Box[] {
  const unit = (size * 4) / 7 / 20;
  const inset = (size * 3) / 14;
  return [
    [4, 6, 12],
    [4, 10, 12],
    [4, 14, 7],
  ].map(([x, y, length]) => ({
    x: inset + (x - 1) * unit,
    y: inset + (y - 1) * unit,
    w: (length + 2) * unit,
    h: 2 * unit,
  }));
}

/** A thrown arc from `from` to `to`, sampled so the path can ease as a whole. */
function arc(from: { x: number; y: number }, to: { x: number; y: number }): Keyframe[] {
  const lift = 36;
  const control = { x: from.x + (to.x - from.x) * 0.55, y: Math.min(from.y, to.y) - lift };
  const steps = 20;
  return Array.from({ length: steps + 1 }, (_, i) => {
    const p = i / steps;
    const t = p < 0.5 ? 4 * p ** 3 : 1 - (-2 * p + 2) ** 3 / 2;
    const x = (1 - t) ** 2 * from.x + 2 * (1 - t) * t * control.x + t ** 2 * to.x;
    const y = (1 - t) ** 2 * from.y + 2 * (1 - t) * t * control.y + t ** 2 * to.y;
    const scale = p < 0.15 ? p / 0.15 : p > 0.75 ? 1 - ((p - 0.75) / 0.25) * 0.65 : 1;
    return { offset: p, transform: `translate(${x}px, ${y}px) scale(${scale})`, opacity: p > 0.9 ? (1 - p) * 10 : 1 };
  });
}

/* -------------------------------------------------------------- component */

export default function Intro() {
  const [done, setDone] = useState(!PLAY);
  const finish = useCallback(() => setDone(true), []);
  if (done) return null;
  return createPortal(<IntroScene onDone={finish} />, document.body);
}

function IntroScene({ onDone }: { onDone: () => void }) {
  const { t } = useI18n();
  const root = useRef<HTMLDivElement>(null);

  const locale = getLanguage() === "ru" ? "ru-RU" : "en-US";
  const plain = new Intl.NumberFormat(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  useLayoutEffect(() => {
    const scene = root.current!;
    const one = (name: string) => scene.querySelector<HTMLElement>(`[data-part="${name}"]`)!;
    const all = (name: string) => [...scene.querySelectorAll<HTMLElement>(`[data-part="${name}"]`)];

    const running: Animation[] = [];
    const timers: number[] = [];
    let frame = 0;
    let over = false;

    const play = (el: Element, keyframes: Keyframe[] | PropertyIndexedKeyframes, options: KeyframeAnimationOptions) => {
      const animation = el.animate(keyframes, { fill: "both", easing: EASE_OUT, ...options });
      running.push(animation);
      return animation;
    };
    /** Later beats are created when they start, so their fill never masks an earlier beat. */
    const at = (ms: number, beat: () => void) => timers.push(window.setTimeout(beat, ms));

    const stage = one("stage");
    const feed = one("feed");
    const paperWrap = one("paper-wrap");
    const paper = one("paper");
    const slot = one("slot");
    const avatars = all("avatar");
    const amounts = all("amount");

    const money = new Intl.NumberFormat(locale, {
      style: "currency",
      currency: "RUB",
      currencyDisplay: "narrowSymbol",
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
    const signed = (minor: number) => `${minor > 0 ? "+" : minor < 0 ? "-" : ""}${money.format(Math.abs(minor) / 100)}`;

    /* 1. Print: the slot opens and the receipt feeds up out of it. */
    play(slot, [{ transform: "scaleX(0)", opacity: 0 }, { transform: "scaleX(1)", opacity: 1 }], {
      delay: AT.slot,
      duration: 420,
    });
    play(paperWrap, [{ transform: "translateY(calc(100% + 32px))" }, { transform: "translateY(0)" }], {
      delay: AT.feed,
      duration: FEED_MS,
      easing: feedEasing(5),
    });
    play(scene.querySelector("[data-part=hint]")!, [{ opacity: 0 }, { opacity: 1 }], { delay: 700, duration: 500 });

    /* 2. The slot closes; the people sharing the receipt arrive. */
    at(AT.slotOut, () =>
      play(slot, [{ opacity: 0, transform: "scaleX(0.9)" }], { duration: 280, easing: "ease-in", fill: "forwards" }),
    );
    avatars.forEach((avatar, i) =>
      play(avatar, [{ opacity: 0, transform: "scale(0.4)" }, { opacity: 1, transform: "scale(1)" }], {
        delay: AT.people + i * 80,
        duration: 520,
        easing: EASE_POP,
      }),
    );

    /* 3. Split: from each price, one share flies to everyone on that line. */
    ITEMS.forEach((item, line) => {
      item.sharedBy.forEach((person, k) => {
        const launch = AT.split + line * 140 + k * 55;
        at(launch, () => {
          const origin = stage.getBoundingClientRect();
          const price = centre(boxIn(all("price")[line], origin));
          const target = centre(boxIn(avatars[person], origin));
          const dot = scene.querySelector<HTMLElement>(`[data-part=dot][data-line="${line}"][data-person="${person}"]`)!;
          play(dot, arc(price, target), { duration: FLIGHT_MS, easing: "linear" });
          if (k === 0) play(all("price")[line], [{ opacity: 0.35 }], { duration: 300, fill: "forwards" });
        });
        at(launch + FLIGHT_MS * 0.92, () => {
          play(avatars[person], [{ transform: "scale(1)" }, { transform: "scale(1.14)" }, { transform: "scale(1)" }], {
            duration: 320,
            easing: "ease-out",
            fill: "none",
          });
          play(all("ring")[person], [{ opacity: 0.45, transform: "scale(1)" }, { opacity: 0, transform: "scale(1.7)" }], {
            duration: 520,
            fill: "none",
          });
        });
      });
    });

    /* 4. Settle: the balances count up, owed in teal, owing in orange. */
    at(AT.count, () => {
      amounts.forEach((amount, i) =>
        play(amount, [{ opacity: 0, transform: "translateY(4px)" }, { opacity: 1, transform: "none" }], {
          delay: i * 60,
          duration: 300,
        }),
      );
      const start = performance.now();
      const tick = (now: number) => {
        const p = Math.min(1, (now - start) / COUNT_MS);
        const eased = 1 - (1 - p) ** 4;
        amounts.forEach((amount, i) => (amount.textContent = signed(Math.round(BALANCES[i] * eased))));
        if (p < 1) frame = requestAnimationFrame(tick);
      };
      frame = requestAnimationFrame(tick);
    });

    /* 5. Fold: everything but the item names clears, and the names turn into strokes. */
    at(AT.fold, () => {
      all("person").forEach((person, i) =>
        play(person, [{ opacity: 0, transform: "translateY(10px) scale(0.94)" }], {
          delay: i * 50,
          duration: 300,
          easing: "ease-in",
          fill: "forwards",
        }),
      );
      [...all("chrome"), ...all("price")].forEach((el) => play(el, [{ opacity: 0 }], { duration: 220, fill: "forwards" }));

      const origin = stage.getBoundingClientRect();
      all("name").forEach((name, i) => {
        const box = boxIn(name, origin);
        const bar = all("bar")[i];
        Object.assign(bar.style, geometry({ x: box.x, y: box.y + box.h / 2 - 4, w: box.w, h: 8 }));
        play(bar, [{ opacity: 1, transform: "scaleX(0)" }, { opacity: 1, transform: "scaleX(1)" }], {
          delay: 60 + i * 50,
          duration: 300,
        });
        play(name, [{ opacity: 0 }], { delay: 60 + i * 50, duration: 200, fill: "forwards" });
      });
    });

    /*
      6. Morph: ink floods the paper as it shrinks to the square. The strokes are
      white with a difference blend, so they flip from dark-on-paper to
      light-on-ink exactly where the ink passes under them, in either theme.
    */
    at(AT.morph - 80, () =>
      play(one("ink"), [{ clipPath: "circle(0% at 30% 42%)" }, { clipPath: "circle(100% at 30% 42%)" }], {
        duration: MORPH_MS - 40,
        easing: EASE_IN_OUT,
      }),
    );
    at(AT.morph, () => {
      const origin = stage.getBoundingClientRect();
      const paperBox = boxIn(paperWrap, origin);
      // Take the paper out of the flow without anything around it moving.
      stage.style.height = `${origin.height}px`;
      feed.style.height = `${feed.offsetHeight}px`;
      feed.style.clipPath = "none";
      Object.assign(paperWrap.style, { position: "absolute", ...geometry(paperBox) });

      const square: Box = {
        x: origin.width / 2 - MARK_SIZE / 2,
        y: origin.height / 2 - MARK_SIZE / 2,
        w: MARK_SIZE,
        h: MARK_SIZE,
      };
      const options = { duration: MORPH_MS, easing: EASE_IN_OUT, fill: "forwards" } as const;
      play(paperWrap, [geometry(paperBox), geometry(square)], options);
      play(paperWrap, [{ filter: "drop-shadow(0 0 0 transparent) drop-shadow(0 0 0 transparent)" }], options);
      play(paper, [{ borderRadius: `${(MARK_SIZE * 2) / 7}px`, "--tooth": "0px" }], options);
      markStrokes(MARK_SIZE).forEach((stroke, i) =>
        play(all("bar")[i], [geometry({ ...stroke, x: square.x + stroke.x, y: square.y + stroke.y })], options),
      );
    });

    /* 7. Dock: the mark flies to its place on the page as the page settles in. */
    at(AT.dock, () => {
      const target = findBrandMark();
      const dock = one("dock");
      // The difference blend got the strokes this far; land in the mark's real colour.
      const brandInk = getComputedStyle(scene).getPropertyValue("--brand-ink").trim();
      all("bar").forEach((bar) => Object.assign(bar.style, { mixBlendMode: "normal", backgroundColor: brandInk }));
      scene.style.pointerEvents = "none";
      play(one("backdrop"), [{ opacity: 0 }], { duration: 260, easing: "ease-out", fill: "forwards" });
      play(one("hint"), [{ opacity: 0 }], { duration: 200, fill: "forwards" });
      reveal(Boolean(target));

      if (!target) {
        play(dock, [{ opacity: 0, transform: "scale(0.8)" }], { duration: 420, easing: "ease-in", fill: "forwards" })
          .finished.then(end, () => {});
        return;
      }
      const mark = paperWrap.getBoundingClientRect();
      const from = { x: mark.left + mark.width / 2, y: mark.top + mark.height / 2 };
      const to = { x: target.left + target.width / 2, y: target.top + target.height / 2 };
      dock.style.transformOrigin = `${from.x}px ${from.y}px`;
      // A small swell first, the way a thing gathers itself before it jumps.
      play(
        dock,
        [
          { transform: "none", easing: "cubic-bezier(0.2, 0, 0.3, 1)" },
          { offset: 0.18, transform: "scale(1.08)", easing: "cubic-bezier(0.45, 0, 0.12, 1)" },
          { transform: `translate(${to.x - from.x}px, ${to.y - from.y}px) scale(${target.width / mark.width})` },
        ],
        { duration: DOCK_MS, easing: "linear", fill: "forwards" },
      ).finished.then(end, () => {});
    });

    let revealed = false;
    function reveal(docking: boolean) {
      if (revealed) return;
      revealed = true;
      revealApp({ docking });
    }

    function end() {
      if (over) return;
      over = true;
      reveal(false);
      landApp();
      onDone();
    }

    /** Skipping fades the whole overlay out over the page as it settles in. */
    function skip() {
      if (over || scene.style.pointerEvents === "none") return;
      timers.forEach(clearTimeout);
      cancelAnimationFrame(frame);
      scene.style.pointerEvents = "none";
      reveal(false);
      play(scene, [{ opacity: 0 }], { duration: 240, easing: "ease-out", fill: "forwards" }).finished.then(end, () => {});
    }

    const onHidden = () => document.visibilityState === "hidden" && end();
    scene.addEventListener("pointerdown", skip);
    window.addEventListener("keydown", skip);
    document.addEventListener("visibilitychange", onHidden);

    return () => {
      timers.forEach(clearTimeout);
      cancelAnimationFrame(frame);
      running.forEach((animation) => animation.cancel());
      scene.removeEventListener("pointerdown", skip);
      window.removeEventListener("keydown", skip);
      document.removeEventListener("visibilitychange", onHidden);
    };
  }, [locale, onDone]);

  return (
    <div ref={root} className="intro fixed inset-0 z-[100] touch-none select-none overscroll-contain">
      <div data-part="backdrop" className="absolute inset-0 bg-bg" />

      <div data-part="dock" className="absolute inset-0 grid place-items-center" aria-hidden="true">
        <div data-part="stage" className="relative w-[264px]">
          {/* The clip edge is the printer's slot: paper exists only above it. */}
          <div data-part="feed" className="[clip-path:inset(-64px_-64px_0_-64px)]">
            <div data-part="paper-wrap" className="intro-paper-wrap">
              <div data-part="paper" className="intro-paper relative h-full overflow-hidden bg-surface px-[18px] pt-4">
                <div data-part="ink" className="absolute inset-0 bg-brand [clip-path:circle(0%_at_30%_42%)]" />
                <div data-part="chrome" className="flex items-baseline justify-between">
                  <span className="text-[13px] font-semibold tracking-tight text-body">{t("Groceries")}</span>
                  <span className="tabular text-[11px] text-subtle">18:42</span>
                </div>
                <div data-part="chrome" className="my-3 border-t border-dashed border-line-strong" />
                <div className="flex flex-col gap-2.5">
                  {ITEMS.map((item) => (
                    <div key={item.name} className="flex items-baseline gap-2 text-[14px]">
                      <span data-part="name" className="truncate text-body">
                        {t(item.name)}
                      </span>
                      <span data-part="chrome" className="min-w-3 flex-1 border-b border-dotted border-line-strong" />
                      <span data-part="price" className="tabular text-body">
                        {plain.format(item.price / 100)}
                      </span>
                    </div>
                  ))}
                </div>
                <div data-part="chrome" className="my-3 border-t border-dashed border-line-strong" />
                <div data-part="chrome" className="flex items-baseline justify-between text-[14px] font-semibold text-body">
                  <span>{t("Total")}</span>
                  <span className="tabular">{plain.format(TOTAL / 100)}</span>
                </div>
              </div>
            </div>
          </div>
          <div data-part="slot" className="relative -mx-3 -mt-px h-[3px] rounded-full bg-ink" />

          <div className="mt-11 grid grid-cols-3">
            {PEOPLE.map((name, i) => (
              <div key={name} data-part="person" className="flex flex-col items-center">
                <span data-part="avatar" className="relative grid size-11 place-items-center rounded-full bg-surface-3 text-[16px] font-medium text-muted">
                  {t(name).slice(0, 1)}
                  <span data-part="ring" className="absolute inset-0 rounded-full border-[1.5px] border-ink opacity-0" />
                  {i === PAYER && (
                    // Paid for the receipt: a tiny receipt badge, the mark in miniature.
                    <span className="absolute -bottom-0.5 -right-1 grid size-[18px] place-items-center rounded-full bg-ink text-ink-text ring-2 ring-bg">
                      <svg viewBox="0 0 20 20" className="size-2.5" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round">
                        <path d="M4 6h12M4 10h12M4 14h7" />
                      </svg>
                    </span>
                  )}
                </span>
                <span
                  data-part="amount"
                  className={cx(
                    "tabular mt-2.5 h-5 text-[13px] font-medium opacity-0",
                    BALANCES[i] > 0 ? "text-positive" : BALANCES[i] < 0 ? "text-negative" : "text-body",
                  )}
                />
              </div>
            ))}
          </div>

          {ITEMS.flatMap((item, line) =>
            item.sharedBy.map((person) => (
              <span
                key={`${line}-${person}`}
                data-part="dot"
                data-line={line}
                data-person={person}
                className="absolute -ml-[5px] -mt-[5px] left-0 top-0 size-2.5 rounded-full bg-body opacity-0"
              />
            )),
          )}
          {markStrokes(MARK_SIZE).map((_, i) => (
            <span key={i} data-part="bar" className="absolute left-0 top-0 origin-left rounded-full bg-white opacity-0 mix-blend-difference" />
          ))}
        </div>
      </div>

      <button
        type="button"
        data-part="hint"
        className="absolute inset-x-0 bottom-[max(1.5rem,env(safe-area-inset-bottom))] mx-auto w-fit rounded-control px-3 py-2 text-[13px] text-subtle"
      >
        {t("Skip intro")}
      </button>
    </div>
  );
}
