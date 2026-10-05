/**
 * The living backdrop: each glow meanders on its own.
 *
 * Every glow is three nested boxes with one motion each -- sideways, up/down,
 * and shape. Each box picks its own random target and duration, so the three
 * motions turn at different moments: a glow never stops and never retraces a
 * path. Only `transform` is animated, through the Web Animations API, so it
 * runs on the compositor and a busy page cannot make it stutter.
 *
 * No imports and no DOM access at module level, so the maths runs under node --test.
 */

export type FlowMotion = "x" | "y" | "shape";

/** `a` is the offset for x/y; for shape, `a` and `b` are the x and y scale offsets. */
export interface FlowPoint {
  a: number;
  b: number;
}

export interface FlowLeg {
  to: FlowPoint;
  duration: number;
}

export interface FlowWalk {
  /** Speeds up or slows down where it is, mid-leg, instead of jumping. */
  setSpeed(rate: number): void;
  /** How far it may wander; applies from the next leg. */
  setRange(range: number): void;
  /** Drifts home and stays there. */
  stop(): void;
}

export const FLOW_REST: FlowPoint = { a: 0, b: 0 };

export const FLOW_MOTIONS: Record<FlowMotion, { reach: number; minStep: number; minMs: number; maxMs: number }> = {
  x: { reach: 18, minStep: 7, minMs: 9000, maxMs: 17000 }, // vw
  y: { reach: 16, minStep: 6, minMs: 10000, maxMs: 19000 }, // vh
  shape: { reach: 0.22, minStep: 0.08, minMs: 11000, maxMs: 21000 }, // scale offset
};

const HOME_MS = 1400;

export function flowTransform(motion: FlowMotion, p: FlowPoint): string {
  if (motion === "x") return `translateX(${p.a}vw)`;
  if (motion === "y") return `translateY(${p.a}vh)`;
  return `scale(${1 + p.a}, ${1 + p.b})`;
}

/**
 * A point in [-reach, reach] at least `step` away from `from`, uniform over
 * everything that qualifies. `from` may lie outside the range (the range was
 * just narrowed); the result never does.
 */
export function pickTarget(from: number, reach: number, step: number, random: () => number): number {
  const leftEnd = Math.min(from - step, reach);
  const rightStart = Math.max(from + step, -reach);
  const left = Math.max(0, leftEnd + reach);
  const right = Math.max(0, reach - rightStart);
  if (left + right === 0) return from > 0 ? -reach : reach;
  const u = random() * (left + right);
  return u < left ? -reach + u : rightStart + (u - left);
}

export function nextFlowLeg(
  motion: FlowMotion,
  at: FlowPoint,
  range = 1,
  random: () => number = Math.random,
): FlowLeg {
  const { reach, minStep, minMs, maxMs } = FLOW_MOTIONS[motion];
  const span = reach * range;
  const step = Math.min(minStep * range, span);
  const round = (v: number) => Math.round(v * 1000) / 1000;
  return {
    to: {
      a: round(pickTarget(at.a, span, step, random)),
      b: motion === "shape" ? round(pickTarget(at.b, span, step, random)) : 0,
    },
    duration: Math.round(minMs + random() * (maxMs - minMs)),
  };
}

/** Starts one box walking. The caller owns the walk and must stop it. */
export function wander(
  el: HTMLElement,
  motion: FlowMotion,
  options: { speed: number; range: number },
): FlowWalk {
  let at = FLOW_REST;
  let current: Animation | null = null;
  let stopped = false;
  let rate = options.speed;
  let range = options.range;

  const step = () => {
    if (stopped) return;
    const leg = nextFlowLeg(motion, at, range);
    const next = el.animate(
      [{ transform: flowTransform(motion, at) }, { transform: flowTransform(motion, leg.to) }],
      { duration: leg.duration, easing: "ease-in-out", fill: "forwards" },
    );
    next.playbackRate = rate;
    // The old leg held its end point, which is exactly where this one starts.
    current?.cancel();
    current = next;
    at = leg.to;
    next.onfinish = step;
  };
  step();

  return {
    setSpeed(next) {
      rate = next;
      current?.updatePlaybackRate(next);
    },
    setRange(next) {
      range = next;
    },
    stop() {
      stopped = true;
      if (!current) return;
      const here = getComputedStyle(el).transform;
      current.onfinish = null;
      current.cancel();
      current = null;
      el.animate(
        [{ transform: here === "none" ? flowTransform(motion, FLOW_REST) : here }, { transform: flowTransform(motion, FLOW_REST) }],
        { duration: HOME_MS, easing: "ease-in-out" },
      );
    },
  };
}
