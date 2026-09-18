/**
 * Interface primitives.
 *
 * Rules held here so screens cannot drift from them:
 *  - a label always sits ABOVE its input; placeholders are examples, never labels
 *  - every control has hover, focus-visible, active and disabled states
 *  - :active nudges the control down 1px so taps feel physical
 *  - loading states are skeletons shaped like the content, not spinners
 */

import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from "react";
import { useId } from "react";
import { formatMoney } from "../lib/money";

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}

/* ------------------------------------------------------------------ button */

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  // Ink on light, light on ink: maximum contrast in both themes.
  primary: "bg-ink text-ink-text hover:bg-ink-hover disabled:bg-subtle",
  secondary: "bg-surface text-body border border-line-strong hover:bg-surface-2",
  ghost: "bg-transparent text-muted hover:bg-surface-2 hover:text-body",
  danger: "bg-transparent text-danger border border-line-strong hover:bg-danger-soft",
};

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: "sm" | "md";
  loading?: boolean;
  full?: boolean;
}

export function Button({
  variant = "primary",
  size = "md",
  loading = false,
  full = false,
  className,
  children,
  disabled,
  ...rest
}: ButtonProps) {
  return (
    <button
      {...rest}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cx(
        "inline-flex items-center justify-center gap-2 rounded-control font-medium",
        "whitespace-nowrap transition-all duration-150",
        "active:translate-y-px disabled:cursor-not-allowed disabled:opacity-60",
        "disabled:active:translate-y-0",
        size === "sm" ? "h-8 px-3 text-[13px]" : "h-10 px-4 text-sm",
        full && "w-full",
        BUTTON_VARIANTS[variant],
        className,
      )}
    >
      {loading && <Spinner />}
      {children}
    </button>
  );
}

function Spinner() {
  return (
    <svg className="size-3.5 animate-spin" viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2" />
      <path d="M14 8a6 6 0 0 0-6-6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

/* ------------------------------------------------------------------- field */

interface FieldProps {
  label: string;
  hint?: string;
  error?: string;
  children: (id: string) => ReactNode;
}

/** Label, control, then hint or error. The order never changes. */
export function Field({ label, hint, error, children }: FieldProps) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-[13px] font-medium text-body">
        {label}
      </label>
      {children(id)}
      {error ? (
        <p className="text-[12px] text-danger" role="alert">
          {error}
        </p>
      ) : hint ? (
        <p className="text-[12px] text-muted">{hint}</p>
      ) : null}
    </div>
  );
}

const CONTROL = cx(
  "h-10 w-full rounded-control border border-line bg-surface px-3 text-sm text-body",
  "placeholder:text-subtle transition-colors",
  "hover:border-line-strong focus:border-line-strong",
  "disabled:cursor-not-allowed disabled:bg-surface-2 disabled:text-muted",
);

export function Input({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...rest} className={cx(CONTROL, className)} />;
}

/** Numeric input: monospaced and right-aligned so amounts line up in a column. */
export function MoneyInput({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...rest}
      inputMode="decimal"
      autoComplete="off"
      className={cx(CONTROL, "tabular text-right", className)}
    />
  );
}

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select {...rest} className={cx(CONTROL, "cursor-pointer appearance-none pr-9", className)}
      style={{
        backgroundImage:
          "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 12 12'%3E%3Cpath d='M3 4.5 6 8l3-3.5' fill='none' stroke='%2371717a' stroke-width='1.5' stroke-linecap='round'/%3E%3C/svg%3E\")",
        backgroundRepeat: "no-repeat",
        backgroundPosition: "right 10px center",
        backgroundSize: "14px",
      }}
    >
      {children}
    </select>
  );
}

export function Textarea({ className, ...rest }: InputHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      {...(rest as object)}
      className={cx(CONTROL, "h-auto min-h-20 resize-y py-2 leading-relaxed", className)}
    />
  );
}

/* -------------------------------------------------------------------- money */

interface MoneyProps {
  minor: number;
  currency: string;
  /** Colour and sign it as a balance. Plain amounts stay neutral. */
  signed?: boolean;
  className?: string;
}

/**
 * Colour here is data, not decoration, so it never travels alone: the sign is
 * always rendered too, and a screen-reader label spells out the direction.
 */
export function Money({ minor, currency, signed = false, className }: MoneyProps) {
  const tone = !signed || minor === 0 ? "text-body" : minor > 0 ? "text-positive" : "text-negative";
  const meaning = !signed || minor === 0 ? undefined : minor > 0 ? "owed to them" : "they owe";

  return (
    <span className={cx("tabular", tone, className)}>
      {formatMoney(minor, currency, { signed })}
      {meaning && <span className="sr-only"> ({meaning})</span>}
    </span>
  );
}

/* ------------------------------------------------------------------- misc */

export function Card({ className, children }: { className?: string; children?: ReactNode }) {
  return <div className={cx("card", className)}>{children}</div>;
}

export function Avatar({ name, size = 32 }: { name: string; size?: number }) {
  const initials = name
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("");
  return (
    <span
      className="inline-flex shrink-0 items-center justify-center rounded-full bg-surface-3 font-medium text-muted"
      style={{ width: size, height: size, fontSize: size * 0.38 }}
      aria-hidden="true"
    >
      {initials}
    </span>
  );
}

export function Chip({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span
      className={cx(
        "inline-flex items-center gap-1 rounded-full bg-surface-2 px-2.5 py-1",
        "text-[12px] font-medium text-muted",
        className,
      )}
    >
      {children}
    </span>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cx("skeleton", className)} aria-hidden="true" />;
}

export function EmptyState({
  title,
  body,
  action,
}: {
  title: string;
  body: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-3 px-6 py-14 text-center">
      <h3 className="text-base font-semibold text-body">{title}</h3>
      <p className="max-w-[46ch] text-sm leading-relaxed text-muted">{body}</p>
      {action && <div className="mt-1">{action}</div>}
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="flex flex-col items-center gap-3 px-6 py-14 text-center" role="alert">
      <h3 className="text-base font-semibold text-body">That did not work</h3>
      <p className="max-w-[46ch] text-sm leading-relaxed text-muted">{message}</p>
      {onRetry && (
        <Button variant="secondary" size="sm" onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  );
}

/** Inline form-level error. Toasts are for transient news, not for failures. */
export function FormError({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p
      role="alert"
      className="rounded-control border border-line bg-danger-soft px-3 py-2 text-[13px] text-danger"
    >
      {message}
    </p>
  );
}
