import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { api, onLogout, signOut, tokenStore } from "../lib/api";
import { releasePush } from "../lib/push";
import type { Tokens, User } from "../lib/types";

/**
 * Runs once the credentials are accepted and before the app switches to the
 * signed-in screens -- the moment the sign-in welcome plays in.
 */
type BeforeEnter = (user: User) => Promise<void>;

interface AuthValue {
  user: User | null;
  ready: boolean;
  login: (email: string, password: string, beforeEnter?: BeforeEnter) => Promise<void>;
  register: (email: string, displayName: string, password: string, beforeEnter?: BeforeEnter) => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [ready, setReady] = useState(false);

  // Resume an existing session on boot, and clear it if the token is stale.
  useEffect(() => {
    let cancelled = false;
    if (!tokenStore.access) {
      setReady(true);
      return;
    }
    api<User>("/auth/me")
      .then((me) => !cancelled && setUser(me))
      .catch(() => !cancelled && setUser(null))
      .finally(() => !cancelled && setReady(true));
    return () => {
      cancelled = true;
    };
  }, []);

  // A refresh failure anywhere in the app must drop the session everywhere.
  useEffect(() => onLogout(() => setUser(null)), []);

  const finish = useCallback(async (tokens: Tokens, beforeEnter?: BeforeEnter) => {
    tokenStore.save(tokens);
    const me = await api<User>("/auth/me");
    await beforeEnter?.(me);
    setUser(me);
  }, []);

  const value = useMemo<AuthValue>(
    () => ({
      user,
      ready,
      login: async (email, password, beforeEnter) =>
        finish(await api<Tokens>("/auth/login", { body: { email, password } }), beforeEnter),
      register: async (email, display_name, password, beforeEnter) =>
        finish(
          await api<Tokens>("/auth/register", { body: { email, display_name, password } }),
          beforeEnter,
        ),
      logout: () => {
        // First, while the tokens still authorise it: this device stops getting the account's news.
        releasePush();
        signOut();
        setUser(null);
      },
    }),
    [user, ready, finish],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error("useAuth must be used inside AuthProvider");
  return value;
}
