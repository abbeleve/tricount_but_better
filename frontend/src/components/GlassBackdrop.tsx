import { useEffect, useRef } from "react";
import { wander, type FlowMotion, type FlowWalk } from "../lib/backdropFlow";

/** One motion per box: the outer box walks sideways, the middle one up and down, the inner one changes shape. */
const BOXES: { selector: string; motion: FlowMotion }[] = [
  { selector: ".glass-glow", motion: "x" },
  { selector: ".glass-glow-drift", motion: "y" },
  { selector: ".glass-glow-shape", motion: "shape" },
];

/**
 * The glass ground and its four glows: a fixed layer at the bottom of the root
 * stacking context, so it never scrolls and every frosted panel blurs it.
 * Real elements rather than background images, so they can move.
 */
export function GlassBackdrop({
  flowing,
  speed,
  range,
}: {
  flowing: boolean;
  speed: number;
  range: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const walks = useRef<FlowWalk[]>([]);
  const options = useRef({ speed, range });

  useEffect(() => {
    options.current = { speed, range };
    walks.current.forEach((walk) => {
      walk.setSpeed(speed);
      walk.setRange(range);
    });
  }, [speed, range]);

  useEffect(() => {
    const root = ref.current;
    if (!flowing || !root || typeof root.animate !== "function") return;
    // A system-wide "reduce motion" keeps it still, and is followed live.
    const still = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    const stop = () => {
      walks.current.forEach((walk) => walk.stop());
      walks.current = [];
    };
    const sync = () => {
      if (still?.matches) stop();
      else if (walks.current.length === 0) {
        walks.current = BOXES.flatMap(({ selector, motion }) =>
          Array.from(root.querySelectorAll<HTMLElement>(selector), (el) =>
            wander(el, motion, options.current),
          ),
        );
      }
    };
    sync();
    still?.addEventListener?.("change", sync);
    return () => {
      still?.removeEventListener?.("change", sync);
      stop();
    };
  }, [flowing]);

  return (
    <div ref={ref} className="glass-backdrop" aria-hidden="true">
      {[1, 2, 3, 4].map((n) => (
        <div key={n} className={`glass-glow glass-glow--${n}`}>
          <div className="glass-glow-drift">
            <div className="glass-glow-shape" />
          </div>
        </div>
      ))}
    </div>
  );
}
