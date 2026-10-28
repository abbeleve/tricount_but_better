import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";

/**
 * Opening the photo scanner and bringing what it read into view. Receipts and
 * price screenshots share it, so both scans open, cancel and land the same way.
 *
 * A page opened with `?scan=<id>` -- from the header, for a scan read while
 * the user was elsewhere -- opens the scanner on that scan: pass `resumeId`
 * to the scanner as its `jobId`, and as its `key`, so a second one starts afresh.
 *
 * Put `scannerRef` on the open scanner and `resultsRef` on what a scan fills in.
 */
export function useScanFlow(initiallyOpen = false) {
  const [params, setParams] = useSearchParams();
  const asked = params.get("scan");
  const [resumeId, setResumeId] = useState<string | null>(null);
  const [scanning, setScanning] = useState(initiallyOpen || Boolean(asked));
  const [reveal, setReveal] = useState(0);
  const scannerRef = useRef<HTMLDivElement>(null);
  const resultsRef = useRef<HTMLDivElement>(null);

  if (asked && asked !== resumeId) {
    setResumeId(asked);
    setScanning(true);
  }

  // Taken up once: a reload must not ask for a scan already picked up.
  useEffect(() => {
    if (!asked) return;
    setParams((current) => {
      const next = new URLSearchParams(current);
      next.delete("scan");
      return next;
    }, { replace: true });
  }, [asked, setParams]);

  useEffect(() => {
    if (scanning) scannerRef.current?.scrollIntoView({ block: "start" });
  }, [scanning]);

  // After a scan the results are the thing to check, so bring them into view.
  useEffect(() => {
    if (!reveal) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    resultsRef.current?.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
  }, [reveal]);

  return {
    scanning,
    resumeId,
    open: () => setScanning(true),
    close: () => setScanning(false),
    /** The scan came back: close the scanner and show what it read. */
    finish: () => {
      setScanning(false);
      setReveal((n) => n + 1);
    },
    scannerRef,
    resultsRef,
  };
}

export type ScanFlow = ReturnType<typeof useScanFlow>;
