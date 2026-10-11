import type { ReactNode } from "react";
import type { ScanFlow } from "../hooks/useScanFlow";
import { cx } from "./ui";

export function CameraIcon() {
  return (
    <svg viewBox="0 0 20 20" className="size-4.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" aria-hidden="true">
      <path d="M2.5 7.5A1.5 1.5 0 0 1 4 6h1.8l1.2-2h6l1.2 2H16a1.5 1.5 0 0 1 1.5 1.5v7A1.5 1.5 0 0 1 16 16H4a1.5 1.5 0 0 1-1.5-1.5v-7Z" />
      <circle cx="10" cy="10.75" r="2.75" />
    </svg>
  );
}

/** The card that opens the photo scanner: the camera, what it reads, a chevron. */
export function ScanCard({
  title,
  hint,
  onClick,
  className,
}: {
  title: string;
  hint: string;
  onClick: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cx(
        "card flex w-full items-center gap-3 p-4 text-left hover:border-line-strong",
        "transition duration-150 ease-out active:scale-[0.98] active:duration-0",
        className,
      )}
    >
      <span className="grid size-10 shrink-0 place-items-center rounded-button bg-ink text-ink-text">
        <CameraIcon />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium text-body">{title}</span>
        <span className="block text-[13px] text-muted">{hint}</span>
      </span>
      <svg viewBox="0 0 16 16" className="size-4 shrink-0 text-subtle" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="m6 3 5 5-5 5" />
      </svg>
    </button>
  );
}

/**
 * The scan card, or the scanner in its place while it is open -- kept visible
 * even after lines are filled in, so another photo is always one tap away.
 */
export function ScanPanel({
  flow,
  title,
  hint,
  className,
  children,
}: {
  flow: ScanFlow;
  title: string;
  hint: string;
  className?: string;
  /** The open scanner. */
  children: ReactNode;
}) {
  return flow.scanning ? (
    <div ref={flow.scannerRef} className={cx("scroll-mt-[calc(var(--header-h)+env(safe-area-inset-top)+1rem)]", className)}>
      {children}
    </div>
  ) : (
    <ScanCard title={title} hint={hint} onClick={flow.open} className={className} />
  );
}
