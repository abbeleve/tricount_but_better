/* eslint-disable react-refresh/only-export-components */
/**
 * The glass look, per account.
 *
 *  - The account is the source of truth: it arrives with /auth/me, and when a
 *    session starts the server's copy wins, so one account's look never sticks
 *    to the next sign-in on the same device. Signing out goes back to standard.
 *  - A localStorage copy exists only so the first paint after a reload is
 *    already in the right colours (index.html applies it before React loads).
 *  - Changes save the whole look. A slider sends a change per step, so those
 *    saves wait until it settles; saves never overlap, and the last one wins.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { GlassBackdrop } from "../components/GlassBackdrop";
import { api } from "../lib/api";
import {
  BUILTIN_PALETTES,
  DEFAULT_APPEARANCE,
  glassVars,
  parseAppearance,
  resolvePalette,
  themeColors,
  type Appearance,
  type Palette,
} from "../lib/glass";
import { setThemeColors } from "../lib/themeColor";
import { useAuth } from "./useAuth";

const STATE_KEY = "tbb.appearance";
/** Read by the pre-paint script in index.html: `{ vars, theme }`, or absent. */
const PAINT_KEY = "tbb.glass";
const SETTLE_SAVE_MS = 400;

export type SaveStatus = "idle" | "saving" | "saved" | "error";

interface AppearanceValue {
  appearance: Appearance;
  /** What is on screen: the palette being edited while there is one, else the chosen one. */
  palette: Palette;
  /** Built-in palettes, then the user's own. */
  palettes: Palette[];
  /** Whether the glass look is painted right now. */
  active: boolean;
  status: SaveStatus;
  update: (patch: Partial<Appearance>, options?: { settle?: boolean }) => void;
  /** Shows a palette without saving it, for the editor; null drops it. */
  setPreview: (palette: Palette | null) => void;
  retry: () => void;
}

const AppearanceContext = createContext<AppearanceValue | null>(null);

function readCache(): Appearance {
  try {
    return parseAppearance(JSON.parse(localStorage.getItem(STATE_KEY) ?? "null"));
  } catch {
    return DEFAULT_APPEARANCE;
  }
}

function writeCache(look: Appearance | null, paint: unknown): void {
  try {
    if (look) localStorage.setItem(STATE_KEY, JSON.stringify(look));
    else localStorage.removeItem(STATE_KEY);
    if (paint) localStorage.setItem(PAINT_KEY, JSON.stringify(paint));
    else localStorage.removeItem(PAINT_KEY);
  } catch {
    /* private browsing: the look still comes from the account after a reload */
  }
}

/** Puts the look on <html>, replacing whatever was there -- including the pre-paint copy. */
function paint(vars: Record<string, string> | null): void {
  const root = document.documentElement;
  for (const name of Array.from(root.style)) {
    if (name.startsWith("--glass-")) root.style.removeProperty(name);
  }
  root.classList.toggle("glass", vars !== null);
  for (const [name, value] of Object.entries(vars ?? {})) root.style.setProperty(name, value);
}

export function AppearanceProvider({ children }: { children: ReactNode }) {
  const { user, ready } = useAuth();
  const [appearance, setAppearance] = useState<Appearance>(readCache);
  const [preview, setPreview] = useState<Palette | null>(null);
  const [status, setStatus] = useState<SaveStatus>("idle");

  const latest = useRef(appearance);
  const timer = useRef<number | undefined>(undefined);
  const saving = useRef(false);
  const again = useRef(false);

  // A session starting takes the account's look; a session ending drops it.
  useEffect(() => {
    if (!ready) return;
    const next = user ? parseAppearance(user.appearance) : DEFAULT_APPEARANCE;
    window.clearTimeout(timer.current);
    timer.current = undefined;
    latest.current = next;
    setAppearance(next);
    setPreview(null);
    setStatus("idle");
    if (!user) writeCache(null, null);
  }, [ready, user]);

  const chosen = useMemo(
    () => resolvePalette(appearance.palette, appearance.palettes),
    [appearance.palette, appearance.palettes],
  );
  const palette = preview ?? chosen;
  // Before the session is known, the cached look stands in, so a reload does not flash.
  const active = appearance.glass && (user !== null || !ready);

  const vars = useMemo(
    () => (active ? glassVars(appearance, palette) : null),
    [active, appearance, palette],
  );

  useLayoutEffect(() => {
    paint(vars);
    setThemeColors(vars ? themeColors(palette) : null);
  }, [vars, palette]);

  // The pre-paint copy follows what is saved, never an unsaved preview.
  useEffect(() => {
    if (!ready || !user) return;
    writeCache(
      appearance,
      appearance.glass ? { vars: glassVars(appearance, chosen), theme: themeColors(chosen) } : null,
    );
  }, [ready, user, appearance, chosen]);

  const flush = useCallback(async () => {
    if (saving.current) {
      again.current = true;
      return;
    }
    saving.current = true;
    setStatus("saving");
    try {
      do {
        again.current = false;
        await api<Appearance>("/auth/me/appearance", { method: "PUT", body: latest.current });
      } while (again.current);
      setStatus("saved");
    } catch {
      setStatus("error");
    } finally {
      saving.current = false;
    }
  }, []);

  const update = useCallback(
    (patch: Partial<Appearance>, { settle = false }: { settle?: boolean } = {}) => {
      const next = parseAppearance({ ...latest.current, ...patch });
      latest.current = next;
      setAppearance(next);
      window.clearTimeout(timer.current);
      timer.current = undefined;
      if (settle) {
        timer.current = window.setTimeout(() => {
          timer.current = undefined;
          void flush();
        }, SETTLE_SAVE_MS);
      } else {
        void flush();
      }
    },
    [flush],
  );

  // Leaving mid-drag must not lose the last step.
  useEffect(() => {
    const onHide = () => {
      if (timer.current === undefined) return;
      window.clearTimeout(timer.current);
      timer.current = undefined;
      void flush();
    };
    window.addEventListener("pagehide", onHide);
    return () => window.removeEventListener("pagehide", onHide);
  }, [flush]);

  const value = useMemo<AppearanceValue>(
    () => ({
      appearance,
      palette,
      palettes: [...BUILTIN_PALETTES, ...appearance.palettes],
      active,
      status,
      update,
      setPreview,
      retry: () => void flush(),
    }),
    [appearance, palette, active, status, update, flush],
  );

  return (
    <AppearanceContext.Provider value={value}>
      {active && (
        <GlassBackdrop
          flowing={appearance.flow}
          speed={appearance.flow_speed}
          range={appearance.flow_range}
        />
      )}
      {children}
    </AppearanceContext.Provider>
  );
}

export function useAppearance(): AppearanceValue {
  const value = useContext(AppearanceContext);
  if (!value) throw new Error("useAppearance must be used inside AppearanceProvider");
  return value;
}
