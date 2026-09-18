/**
 * API client.
 *
 * Holds the token pair, attaches the access token, and transparently refreshes
 * once on a 401. Concurrent 401s share a single refresh so a screen with five
 * queries does not fire five refreshes and invalidate its own session.
 */

import type { Tokens } from "./types";

const ACCESS_KEY = "tbb.access";
const REFRESH_KEY = "tbb.refresh";

export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* private browsing: the session simply will not survive a reload */
  }
}

export const tokenStore = {
  get access() {
    return read(ACCESS_KEY);
  },
  get refresh() {
    return read(REFRESH_KEY);
  },
  save(tokens: Tokens) {
    write(ACCESS_KEY, tokens.access_token);
    write(REFRESH_KEY, tokens.refresh_token);
  },
  clear() {
    write(ACCESS_KEY, null);
    write(REFRESH_KEY, null);
  },
};

type Listener = () => void;
const logoutListeners = new Set<Listener>();

/** Notified when the session is definitively gone, so the app can route to /login. */
export function onLogout(listener: Listener): () => void {
  logoutListeners.add(listener);
  return () => logoutListeners.delete(listener);
}

function signOut(): void {
  tokenStore.clear();
  logoutListeners.forEach((l) => l());
}

let refreshInFlight: Promise<boolean> | null = null;

async function refreshTokens(): Promise<boolean> {
  const token = tokenStore.refresh;
  if (!token) return false;

  refreshInFlight ??= (async () => {
    try {
      const response = await fetch("/api/auth/refresh", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refresh_token: token }),
      });
      if (!response.ok) return false;
      tokenStore.save((await response.json()) as Tokens);
      return true;
    } catch {
      return false;
    } finally {
      // Cleared on the next microtask so simultaneous callers all see this run.
      queueMicrotask(() => {
        refreshInFlight = null;
      });
    }
  })();

  return refreshInFlight;
}

async function errorMessage(response: Response): Promise<string> {
  try {
    const body = await response.json();
    const detail = body?.detail;
    if (typeof detail === "string") return detail;
    // FastAPI validation errors arrive as a list of {loc, msg}.
    if (Array.isArray(detail) && detail.length > 0) {
      return detail
        .map((d: { msg?: string }) => d.msg?.replace(/^Value error, /, ""))
        .filter(Boolean)
        .join("; ");
    }
  } catch {
    /* fall through to the status text */
  }
  return response.statusText || "Something went wrong";
}

interface RequestOptions {
  method?: string;
  body?: unknown;
  form?: FormData;
  signal?: AbortSignal;
}

export async function api<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const send = async (): Promise<Response> => {
    const headers: Record<string, string> = {};
    const access = tokenStore.access;
    if (access) headers.Authorization = `Bearer ${access}`;
    if (options.body !== undefined) headers["Content-Type"] = "application/json";

    return fetch(`/api${path}`, {
      method: options.method ?? (options.body || options.form ? "POST" : "GET"),
      headers,
      body: options.form ?? (options.body !== undefined ? JSON.stringify(options.body) : undefined),
      signal: options.signal,
    });
  };

  let response = await send();

  if (response.status === 401 && tokenStore.refresh) {
    if (await refreshTokens()) {
      response = await send();
    } else {
      signOut();
      throw new ApiError(401, "Your session expired. Please sign in again.");
    }
  }

  if (response.status === 401) {
    signOut();
    throw new ApiError(401, "Please sign in.");
  }

  if (!response.ok) throw new ApiError(response.status, await errorMessage(response));
  if (response.status === 204) return undefined as T;

  return (await response.json()) as T;
}

export { signOut };
