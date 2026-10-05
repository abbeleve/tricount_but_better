import { useEffect, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { useAppearance } from "../hooks/useAppearance";
import { useAuth } from "../hooks/useAuth";
import { swatch } from "../lib/glass";
import { useI18n } from "../lib/i18n";
import { syncThemeColor } from "../lib/themeColor";
import { Avatar, Button, cx } from "./ui";

function useTheme() {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains("dark"));
  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
    syncThemeColor();
    try {
      localStorage.setItem("theme", dark ? "dark" : "light");
    } catch {
      /* ignore */
    }
  }, [dark]);
  return [dark, () => setDark((d) => !d)] as const;
}

type Theme = ReturnType<typeof useTheme>;

function ThemeIcon({ dark }: { dark: boolean }) {
  return dark ? (
    <svg viewBox="0 0 20 20" className="size-4.5" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
      <circle cx="10" cy="10" r="3.5" />
      <path d="M10 2v2m0 12v2M2 10h2m12 0h2M4.5 4.5l1.4 1.4m8.2 8.2 1.4 1.4m0-11-1.4 1.4m-8.2 8.2-1.4 1.4" strokeLinecap="round" />
    </svg>
  ) : (
    <svg viewBox="0 0 20 20" className="size-4.5" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
      <path d="M16.5 11.8A7 7 0 0 1 8.2 3.5a7 7 0 1 0 8.3 8.3Z" strokeLinejoin="round" />
    </svg>
  );
}

function ThemeToggle({ theme: [dark, toggle], className }: { theme: Theme; className?: string }) {
  const { t } = useI18n();
  return (
    <button
      onClick={toggle}
      aria-label={t(dark ? "Switch to light theme" : "Switch to dark theme")}
      className={cx(
        "size-9 place-items-center rounded-button text-muted",
        "transition-colors hover:bg-surface-2 hover:text-body active:bg-surface-2",
        className,
      )}
    >
      <ThemeIcon dark={dark} />
    </button>
  );
}

const MENU_ITEM = cx(
  "flex w-full items-center gap-2.5 px-3 py-2.5 text-left text-sm text-body",
  "transition-colors hover:bg-surface-2 active:bg-surface-2 active:duration-0 pointer-coarse:py-3.5",
);

function AccountMenu({ theme }: { theme: Theme }) {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [open, setOpen] = useState(false);
  const [dark, toggleTheme] = theme;
  const { language, setLanguage, t } = useI18n();
  const look = useAppearance();

  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    // Any click elsewhere, or Escape, dismisses the menu.
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("click", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!user) return null;

  return (
    <div className="relative" onClick={(e) => e.stopPropagation()}>
      <button
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t("Account")}
        className="-mr-1 flex items-center gap-2 rounded-control p-1 transition-colors hover:bg-surface-2 active:bg-surface-2 active:duration-0 pointer-coarse:p-2"
      >
        <Avatar name={user.display_name} size={28} />
        <span className="hidden max-w-32 truncate text-sm text-body sm:block">
          {user.display_name}
        </span>
      </button>

      {open && (
        <div
          role="menu"
          className={cx(
            "absolute right-0 z-50 mt-2 w-60 overflow-hidden rounded-card border border-line bg-overlay shadow-lg",
            // Grows out of the avatar that opened it, not from its own centre.
            "origin-top-right transition duration-150 ease-out starting:scale-95 starting:opacity-0",
          )}
        >
          <div className="border-b border-line px-3 py-2.5">
            <p className="truncate text-sm font-medium text-body">{user.display_name}</p>
            <p className="truncate text-[12px] text-muted">{user.email}</p>
          </div>
          {/* On a phone the header has no room for a toggle; it lives here instead. */}
          <button
            role="menuitem"
            onClick={() => {
              toggleTheme();
              setOpen(false);
            }}
            className={cx(MENU_ITEM, "sm:hidden")}
          >
            <span className="text-muted">
              <ThemeIcon dark={dark} />
            </span>
            {t(dark ? "Light theme" : "Dark theme")}
          </button>
          <button
            role="menuitem"
            onClick={() => {
              setOpen(false);
              // Remembered, so the page's back button returns here rather than to the team list.
              navigate("/appearance", { state: { from: location.pathname + location.search } });
            }}
            className={MENU_ITEM}
          >
            <span
              aria-hidden="true"
              className="size-4.5 shrink-0 rounded-full shadow-[inset_0_0_0_1px_rgb(0_0_0/0.12)]"
              style={{ background: swatch(look.palette) }}
            />
            {t("Appearance")}
            <span className="ml-auto text-[12px] text-muted">
              {t(look.appearance.glass ? "Glass" : "Standard")}
            </span>
          </button>
          <div className="border-t border-line px-3 py-2.5">
            <p className="mb-2 text-[12px] text-muted">{t("Language")}</p>
            <div className="flex gap-2" role="group" aria-label={t("Language")}>
              {(["en", "ru"] as const).map((code) => (
                <button
                  key={code}
                  type="button"
                  aria-pressed={language === code}
                  onClick={() => setLanguage(code)}
                  className={cx("rounded-control border px-2.5 py-1.5 text-[13px]", language === code ? "border-ink bg-ink text-ink-text" : "border-line text-body hover:bg-surface-2")}
                >
                  {code === "en" ? "English" : "Русский"}
                </button>
              ))}
            </div>
          </div>
          <button
            role="menuitem"
            onClick={() => {
              logout();
              navigate("/login");
            }}
            className={MENU_ITEM}
          >
            {t("Sign out")}
          </button>
        </div>
      )}
    </div>
  );
}

export interface Back {
  to: string;
  label: string;
}

function Brand({ className }: { className?: string }) {
  return (
    <Link to="/" className={cx("items-center gap-2.5 rounded-control", className)}>
      <span className="grid size-7 place-items-center rounded-lg bg-brand text-brand-ink">
        <svg viewBox="0 0 20 20" className="size-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <path d="M4 6h12M4 10h12M4 14h7" />
        </svg>
      </span>
      <span className="text-[15px] font-semibold tracking-tight text-body">Split</span>
    </Link>
  );
}

/** Phone navigation: the way out sits where the thumb and the eye expect it. */
function BackButton({ back, className }: { back: Back; className?: string }) {
  return (
    <Link
      to={back.to}
      className={cx(
        "-ml-2 h-11 min-w-0 items-center gap-0.5 rounded-control pl-1 pr-3",
        "text-[15px] font-medium text-body transition-opacity duration-150 active:opacity-50 active:duration-0",
        className,
      )}
    >
      <svg viewBox="0 0 20 20" className="size-5 shrink-0" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M12.5 4.5 7 10l5.5 5.5" />
      </svg>
      <span className="truncate">{back.label}</span>
    </Link>
  );
}

export function Header({ back }: { back?: Back }) {
  const theme = useTheme();
  return (
    <header className="material sticky top-0 z-40 border-b border-line pt-[env(safe-area-inset-top)]">
      <div className="gutter mx-auto flex h-(--header-h) max-w-5xl items-center justify-between gap-3">
        {back ? (
          <>
            <BackButton back={back} className="flex sm:hidden" />
            <Brand className="hidden sm:flex" />
          </>
        ) : (
          <Brand className="flex" />
        )}
        <div className="flex shrink-0 items-center gap-1">
          <ThemeToggle theme={theme} className="hidden sm:grid" />
          <AccountMenu theme={theme} />
        </div>
      </div>
    </header>
  );
}

/**
 * `back` puts a back button in the phone header (and a back link above the
 * content on wider screens). `bar` is pinned to the bottom edge above the home
 * indicator -- the place a thumb already is -- for a page's primary action.
 * `narrow` centres a reading-width column, for settings rather than data.
 */
export function AppShell({
  children,
  back,
  bar,
  narrow = false,
}: {
  children: React.ReactNode;
  back?: Back;
  bar?: React.ReactNode;
  narrow?: boolean;
}) {
  return (
    <div className="min-h-dvh">
      <Header back={back} />
      <main
        className={cx(
          "app-main gutter mx-auto pt-5 sm:pt-6",
          narrow ? "max-w-2xl" : "max-w-5xl",
          // Clearance for the floating add button and the home indicator.
          bar ? "pb-6" : "pb-[calc(6rem+env(safe-area-inset-bottom))] sm:pb-16",
        )}
      >
        {back && <BackLink to={back.to}>{back.label}</BackLink>}
        {children}
      </main>
      {bar && (
        <div className="material sticky bottom-0 z-30 border-t border-line pb-[env(safe-area-inset-bottom)]">
          <div className="gutter mx-auto max-w-5xl py-3">{bar}</div>
        </div>
      )}
    </div>
  );
}

/** Centred column for signed-out screens. */
export function AuthShell({ children }: { children: React.ReactNode }) {
  const { language, setLanguage, t } = useI18n();
  return (
    <div className="gutter grid min-h-dvh place-items-center pb-[max(2.5rem,env(safe-area-inset-bottom))] pt-[max(2.5rem,env(safe-area-inset-top))]">
      <div className="w-full max-w-sm">
        {children}
        <div className="mt-5 flex justify-center gap-3 text-[13px] text-muted" role="group" aria-label={t("Language")}>
          {(["en", "ru"] as const).map((code) => (
            <button key={code} type="button" aria-pressed={language === code} onClick={() => setLanguage(code)} className={cx("rounded-control px-1 py-1 hover:text-body", language === code && "font-medium text-body")}>
              {code === "en" ? "English" : "Русский"}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

export function PageTitle({
  title,
  subtitle,
  action,
}: {
  title: string;
  subtitle?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3 sm:mb-6">
      <div className="min-w-0">
        <h1 className="truncate text-[1.75rem] font-semibold leading-tight tracking-tight text-body sm:text-3xl">
          {title}
        </h1>
        {subtitle && <p className="mt-1 text-sm text-muted">{subtitle}</p>}
      </div>
      {action}
    </div>
  );
}

/** Wide screens only: on a phone the header's back button does this job. */
export function BackLink({ to, children }: { to: string; children: React.ReactNode }) {
  return (
    <Link
      to={to}
      className="mb-4 hidden items-center gap-1.5 text-[13px] text-muted transition-colors hover:text-body sm:inline-flex"
    >
      <svg viewBox="0 0 16 16" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M10 3 5 8l5 5" />
      </svg>
      {children}
    </Link>
  );
}

export { Button };
