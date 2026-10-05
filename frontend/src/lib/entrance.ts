/**
 * Hand-over between a full-screen entrance -- the opening intro, the sign-in
 * welcome -- and the app underneath it.
 *
 * While an entrance plays, the app renders as usual but is held invisible
 * (`entrance-hold` on <html>, see index.css). `revealApp` lets the page settle
 * in and tells anything that wants an entrance of its own, such as a balance
 * counting up, that the moment has come. `landApp` ends the hand-over once the
 * flying mark has landed on the real one.
 */

import { useEffect, useState } from "react";

const html = document.documentElement.classList;
const revealListeners = new Set<() => void>();

export function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

export function holdApp(): void {
  html.add("entrance-hold");
}

export function isAppHeld(): boolean {
  return html.contains("entrance-hold");
}

/**
 * `docking` keeps the page's own mark hidden until `landApp`, so the flying
 * one can land on it. `style` picks how the page arrives (see index.css).
 */
export function revealApp({ docking, style = "rise" }: { docking: boolean; style?: "rise" | "deal" }): void {
  html.remove("entrance-hold");
  html.add("entrance-reveal", `entrance-${style}`);
  if (docking) html.add("entrance-docking");
  window.setTimeout(() => html.remove("entrance-reveal", "entrance-rise", "entrance-deal"), 1800);
  revealListeners.forEach((listener) => listener());
}

export function landApp(): void {
  html.remove("entrance-hold", "entrance-docking");
}

/** Clears any hand-over a hot reload interrupted. */
export function resetEntrance(): void {
  html.remove("entrance-hold", "entrance-reveal", "entrance-rise", "entrance-deal", "entrance-docking");
}

/** Where the page's own brand mark is on screen, if one is visible. */
export function findBrandMark(): DOMRect | null {
  for (const el of document.querySelectorAll("[data-brand-mark]")) {
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.bottom > 0 && r.top < window.innerHeight) return r;
  }
  return null;
}

/**
 * A number that counts up from zero as the page is revealed, if it was first
 * rendered behind an entrance. Anywhere else it is simply `value`.
 */
export function useEntranceCount(value: number, delay = 0, duration = 900): number {
  const [progress, setProgress] = useState(() => (isAppHeld() ? 0 : 1));

  useEffect(() => {
    if (progress === 1) return;
    let timer = 0;
    let frame = 0;
    const run = () => {
      revealListeners.delete(run);
      timer = window.setTimeout(() => {
        const start = performance.now();
        const tick = (now: number) => {
          const p = Math.min(1, (now - start) / duration);
          setProgress(1 - (1 - p) ** 4);
          if (p < 1) frame = requestAnimationFrame(tick);
        };
        frame = requestAnimationFrame(tick);
      }, delay);
    };
    revealListeners.add(run);
    // Revealed between the first render and this effect.
    if (!isAppHeld()) run();
    return () => {
      revealListeners.delete(run);
      clearTimeout(timer);
      cancelAnimationFrame(frame);
    };
    // Runs once: later changes of `value` just scale with the progress.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return progress === 1 ? value : Math.round(value * progress);
}

/* ---------------------------------------------------------------- welcome */

export interface WelcomeRequest {
  name: string;
  returning: boolean;
  /** Called once the old screen is out of sight and the app may switch under it. */
  covered: () => void;
}

let welcomeListener: ((request: WelcomeRequest) => void) | null = null;

export function onWelcome(listener: (request: WelcomeRequest) => void): () => void {
  welcomeListener = listener;
  return () => {
    if (welcomeListener === listener) welcomeListener = null;
  };
}

/**
 * Plays the sign-in welcome. Resolves once the sign-in screen has gone, so the
 * caller can switch to the app behind it -- or at once, if nothing is playing.
 */
export function playWelcome(name: string, returning: boolean): Promise<void> {
  const listener = welcomeListener;
  if (!listener || prefersReducedMotion() || document.visibilityState === "hidden") return Promise.resolve();
  return new Promise((resolve) => {
    // Never let an animation stand between someone and their account.
    const timer = window.setTimeout(resolve, 1500);
    listener({
      name,
      returning,
      covered: () => {
        clearTimeout(timer);
        resolve();
      },
    });
  });
}
