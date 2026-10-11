import { lazy, type ComponentType } from "react";

const RELOADED = "tbb.chunk-reload";

/**
 * React.lazy that survives a deploy. A deploy deletes the previous build's
 * hashed chunks, so a tab opened before it gets a 404 the first time it needs
 * one; reloading picks up the new shell and its chunks. At most once per
 * session, so a real outage shows an error rather than a reload loop.
 */
// `any` is React.lazy's own constraint; anything narrower rejects real components.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function lazyPage<T extends ComponentType<any>>(load: () => Promise<{ default: T }>) {
  return lazy(async () => {
    try {
      const module = await load();
      try { sessionStorage.removeItem(RELOADED); } catch { /* private browsing */ }
      return module;
    } catch (error) {
      let reloaded = false;
      try {
        reloaded = sessionStorage.getItem(RELOADED) === "1";
        sessionStorage.setItem(RELOADED, "1");
      } catch { /* private browsing: fall through to one reload */ }
      if (reloaded) throw error;
      window.location.reload();
      return new Promise<{ default: T }>(() => {});
    }
  });
}
