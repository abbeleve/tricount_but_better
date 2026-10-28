/**
 * Scans read in the background: which page each goes back to, and which ones
 * an open scanner is already showing, so the header leaves those out.
 */

import type { ScanJob } from "./types";

const ORIGINS = "tbb.scan-origins";
const KEEP = 20;

function readOrigins(): Record<string, string> {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(ORIGINS) ?? "{}");
    return saved && typeof saved === "object" ? (saved as Record<string, string>) : {};
  } catch {
    return {};
  }
}

function writeOrigins(origins: Record<string, string>): void {
  try {
    localStorage.setItem(ORIGINS, JSON.stringify(origins));
  } catch {
    /* private browsing: a scan then reopens on a fresh form */
  }
}

/** The page a scan was started on, to bring its result back to. */
export function rememberOrigin(id: string, path: string): void {
  // Only the newest few: a finished scan's id is clutter.
  writeOrigins(Object.fromEntries(Object.entries({ ...readOrigins(), [id]: path }).slice(-KEEP)));
}

export function forgetOrigin(id: string): void {
  const origins = readOrigins();
  if (!(id in origins)) return;
  delete origins[id];
  writeOrigins(origins);
}

export function originOf(id: string): string | null {
  return readOrigins()[id] ?? null;
}

/**
 * Where to open a scan: the page it was started on, told which scan to pick
 * up, or a fresh form of its kind when that page is not known.
 */
export function resumePath(job: Pick<ScanJob, "id" | "kind" | "team_id">, origin: string | null): string {
  const fallback = job.kind === "prices"
    ? `/teams/${job.team_id}/prices/import`
    : `/teams/${job.team_id}/expenses/new`;
  // Only a path inside the app; "//host" would leave it.
  const from = origin && origin.startsWith("/") && !origin.startsWith("//") ? origin : fallback;
  const [path, query = ""] = from.split("#")[0].split("?");
  const params = new URLSearchParams(query);
  params.set("scan", job.id);
  return `${path}?${params}`;
}

/* Claims: a scanner on screen is following these scans itself. */

const claimed = new Set<string>();
const listeners = new Set<() => void>();
let snapshot: ReadonlySet<string> = new Set();

function changed(): void {
  snapshot = new Set(claimed);
  listeners.forEach((listener) => listener());
}

/** Marks a scan as shown on this page; call the result to let it go. */
export function claimScan(id: string): () => void {
  claimed.add(id);
  changed();
  return () => {
    claimed.delete(id);
    changed();
  };
}

export function subscribeClaims(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function claimedScans(): ReadonlySet<string> {
  return snapshot;
}
