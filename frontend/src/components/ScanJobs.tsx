import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, useSyncExternalStore } from "react";
import { useNavigate } from "react-router-dom";
import { keys, useScanJobs, useTeams } from "../hooks/queries";
import { useAuth } from "../hooks/useAuth";
import { api } from "../lib/api";
import { useI18n } from "../lib/i18n";
import { claimedScans, forgetOrigin, originOf, resumePath, subscribeClaims } from "../lib/scanJobs";
import type { ScanJob } from "../lib/types";
import { CameraIcon } from "./ScanButton";
import { cx } from "./ui";

function Spinner({ className }: { className?: string }) {
  return (
    <svg className={cx("animate-spin", className)} viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2" />
      <path d="M14 8a6 6 0 0 0-6-6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

/**
 * Scans read in the background, on every page: still reading, or read and
 * waiting to be opened. A scan whose scanner is on screen is left to it.
 */
export function ScanJobsMenu() {
  const { user } = useAuth();
  const { t } = useI18n();
  const navigate = useNavigate();
  const client = useQueryClient();
  const scans = useScanJobs(Boolean(user));
  const claimed = useSyncExternalStore(subscribeClaims, claimedScans);
  const jobs = (scans.data ?? []).filter((job) => !claimed.has(job.id));
  const teams = useTeams(jobs.length > 0);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("click", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!user || jobs.length === 0) return null;

  const reading = jobs.filter((job) => job.status === "reading").length;
  const ready = jobs.filter((job) => job.status === "done").length;
  const failed = jobs.length - reading - ready;
  const teamName = (id: string) => teams.data?.find((team) => team.id === id)?.name;

  function openJob(job: ScanJob) {
    setOpen(false);
    navigate(resumePath(job, originOf(job.id)));
  }

  function dismiss(job: ScanJob) {
    forgetOrigin(job.id);
    client.setQueryData<ScanJob[]>(keys.scans, (list) => list?.filter((j) => j.id !== job.id));
    void api(`/scans/${job.id}`, { method: "DELETE" })
      .catch(() => { /* gone already */ })
      .finally(() => client.invalidateQueries({ queryKey: keys.scans }));
  }

  const summary = ready
    ? t(ready === 1 ? "{count} scan ready" : "{count} scans ready", { count: ready })
    : reading
      ? t("Reading…")
      : t("Scan failed");

  return (
    <div className="relative" onClick={(e) => e.stopPropagation()}>
      <button
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t("Scans: {status}", { status: summary })}
        className={cx(
          "relative flex h-9 items-center gap-1.5 rounded-button px-2 text-muted pointer-coarse:h-11",
          "transition-colors hover:bg-surface-2 hover:text-body active:bg-surface-2 active:duration-0",
          "transition duration-200 ease-out starting:scale-75 starting:opacity-0",
          ready > 0 && "text-body",
        )}
      >
        {reading > 0 && ready === 0 ? <Spinner className="size-4.5" /> : <CameraIcon />}
        <span className="hidden text-[13px] sm:inline">{summary}</span>
        {(ready > 0 || failed > 0) && (
          <span
            aria-hidden="true"
            className={cx(
              "absolute left-1/2 top-1.5 ml-1 size-2.5 rounded-full ring-2 ring-bg sm:hidden",
              ready > 0 ? "bg-positive-mark" : "bg-danger",
            )}
          />
        )}
      </button>
      {/* Read out when a scan comes back, wherever the user is. */}
      <span className="sr-only" aria-live="polite">
        {ready ? t(ready === 1 ? "{count} scan ready" : "{count} scans ready", { count: ready }) : ""}
      </span>

      {open && (
        <div
          role="menu"
          className={cx(
            "absolute right-0 z-50 mt-2 w-72 overflow-hidden rounded-card border border-line bg-overlay shadow-lg",
            "origin-top-right transition duration-150 ease-out starting:scale-95 starting:opacity-0",
          )}
        >
          <p className="border-b border-line px-3 py-2.5 text-[12px] text-muted">
            {t(reading ? "Keep using the app; scans read on their own." : "Open a scan to check what it read.")}
          </p>
          <ul>
            {jobs.map((job) => {
              const team = teamName(job.team_id);
              return (
                <li key={job.id} className="flex items-stretch border-b border-line last:border-b-0">
                  <button
                    role="menuitem"
                    onClick={() => openJob(job)}
                    className={cx(
                      "flex min-w-0 flex-1 items-center gap-2.5 px-3 py-2.5 text-left",
                      "transition-colors hover:bg-surface-2 active:bg-surface-2 active:duration-0 pointer-coarse:py-3.5",
                    )}
                  >
                    <span
                      className={cx(
                        "grid size-7 shrink-0 place-items-center rounded-full",
                        job.status === "done" ? "bg-positive-soft text-positive"
                          : job.status === "failed" ? "bg-danger-soft text-danger"
                          : "bg-surface-2 text-muted",
                      )}
                    >
                      {job.status === "reading" ? <Spinner className="size-3.5" />
                        : job.status === "done" ? (
                          <svg viewBox="0 0 16 16" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                            <path d="m3.5 8.5 3 3 6-7" />
                          </svg>
                        ) : (
                          <svg viewBox="0 0 16 16" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                            <path d="M8 4v5M8 11.5v.5" />
                          </svg>
                        )}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm text-body">
                        {t(job.kind === "prices" ? "Prices from a screenshot" : "Receipt")}
                        {team && <span className="text-muted"> · {team}</span>}
                      </span>
                      <span className={cx("block truncate text-[12px]", job.status === "failed" ? "text-danger" : "text-muted")}>
                        {job.status === "reading" ? t("Reading…")
                          : job.status === "done" ? t("Ready to check")
                          : t(job.error ?? "Could not read these images.")}
                      </span>
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={() => dismiss(job)}
                    aria-label={t(job.status === "reading" ? "Stop reading" : "Dismiss")}
                    className="grid w-11 shrink-0 place-items-center text-subtle transition-colors hover:bg-surface-2 hover:text-body active:bg-surface-2"
                  >
                    <svg viewBox="0 0 16 16" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                      <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" />
                    </svg>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
