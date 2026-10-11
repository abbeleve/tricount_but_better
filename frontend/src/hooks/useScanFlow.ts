import { useEffect, useRef, useState } from "react";

/**
 * Opening the photo scanner and bringing what it read into view. Receipts and
 * price screenshots share it, so both scans open, cancel and land the same way.
 *
 * Put `scannerRef` on the open scanner and `resultsRef` on what a scan fills in.
 */
export function useScanFlow(initiallyOpen = false) {
  const [scanning, setScanning] = useState(initiallyOpen);
  const [reveal, setReveal] = useState(0);
  const scannerRef = useRef<HTMLDivElement>(null);
  const resultsRef = useRef<HTMLDivElement>(null);

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
