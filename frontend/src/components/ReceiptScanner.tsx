import { useMutation } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState, type DragEvent } from "react";
import { Button, Card, FormError, Skeleton, cx } from "./ui";
import { useServerConfig } from "../hooks/queries";
import { ApiError, api } from "../lib/api";
import { useI18n } from "../lib/i18n";
import type { ReceiptScan } from "../lib/types";

/** What the scanner says, for a scan that is not a receipt. */
export interface ScannerCopy {
  title: string;
  intro: string;
  read: string;
  reading: string;
}

interface Props<T> {
  teamId: string;
  appendToExisting?: boolean;
  /** Where the photos go; the receipt reader unless told otherwise. */
  path?: string;
  /** Sent along with the images. */
  body?: Record<string, unknown>;
  copy?: ScannerCopy;
  onParsed: (result: T) => void;
  onCancel: () => void;
}

interface Shot {
  file: File;
  url: string;
}

const TILE = cx(
  "flex flex-col items-center justify-center gap-2 rounded-control px-4 py-6 text-center",
  "transition duration-150 ease-out active:scale-[0.98] active:duration-0",
);

/**
 * Photos are collected first and read on request. A phone camera returns one
 * shot per trip, so a long receipt needs several trips before anything is sent,
 * and a look at the thumbnails catches a blurred photo before the slow part.
 */
export function ReceiptScanner<T = ReceiptScan>({
  teamId, appendToExisting = false, path, body, copy, onParsed, onCancel,
}: Props<T>) {
  const { t } = useI18n();
  const config = useServerConfig();
  const cameraRef = useRef<HTMLInputElement>(null);
  const pickerRef = useRef<HTMLInputElement>(null);
  const pasteRef = useRef<HTMLTextAreaElement>(null);
  const [shots, setShots] = useState<Shot[]>([]);
  const shotList = useRef<Shot[]>([]);
  const urls = useRef(new Set<string>());
  const mounted = useRef(true);
  const scanLocked = useRef(false);
  const clipboardBusy = useRef(false);
  const dragDepth = useRef(0);
  const [dragging, setDragging] = useState(false);
  const [pasting, setPasting] = useState(false);
  const [pasteFallback, setPasteFallback] = useState(false);
  const [inputError, setInputError] = useState<string | null>(null);
  const max = config.data?.max_receipt_images ?? 8;
  const maxUploadMb = config.data?.max_upload_mb ?? 12;
  const available = config.data?.receipt_scanning !== false;

  const upload = useMutation({
    onMutate: () => { scanLocked.current = true; },
    mutationFn: async (files: File[]) => {
      // Data URLs keep the transfer in memory; multipart UploadFile can spill
      // to a temporary file for large phone photos.
      const images = await Promise.all(files.map((file) => new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => typeof reader.result === "string"
          ? resolve(reader.result)
          : reject(new Error("Could not read this photo."));
        reader.onerror = () => reject(new Error("Could not read this photo."));
        reader.readAsDataURL(file);
      })));
      return api<T>(path ?? `/teams/${teamId}/receipts`, { body: { ...body, images } });
    },
    onSuccess: (result) => onParsed(result),
    onSettled: () => { scanLocked.current = false; },
  });

  // Object URLs pin the image in memory until revoked.
  useEffect(() => {
    mounted.current = true;
    const live = urls.current;
    return () => {
      mounted.current = false;
      live.forEach((url) => URL.revokeObjectURL(url));
    };
  }, []);

  const add = useCallback((files: FileList | readonly File[] | null) => {
    if (!files?.length || !available || scanLocked.current || !mounted.current) return;
    const images = [...files].filter((file) => file.type.startsWith("image/"));
    const valid = images.filter((file) => file.size <= maxUploadMb * 1024 * 1024);
    const remaining = Math.max(0, max - shotList.current.length);
    setInputError(images.length !== files.length
      ? t("Only image files can be added.")
      : valid.length !== images.length
        ? t("Each photo must be {size} MB or smaller.", { size: maxUploadMb })
        : valid.length > remaining
          ? t("You can add up to {count} photos.", { count: max })
          : null);
    const next = valid.slice(0, remaining).map((file) => {
      const url = URL.createObjectURL(file);
      urls.current.add(url);
      return { file, url };
    });
    shotList.current = [...shotList.current, ...next];
    setShots(shotList.current);
  }, [available, max, maxUploadMb, t]);

  // Native paste works without clipboard-read permission. Leave ordinary text
  // pastes alone so the rest of the expense form keeps behaving normally.
  useEffect(() => {
    if (!available) return;
    function onPaste(event: ClipboardEvent) {
      if (event.defaultPrevented || !event.clipboardData) return;
      let files = [...event.clipboardData.files];
      if (!files.length) {
        files = [...event.clipboardData.items]
          .map((item) => item.kind === "file" ? item.getAsFile() : null)
          .filter((file): file is File => file !== null);
      }
      if (!files.some((file) => file.type.startsWith("image/"))) return;
      event.preventDefault();
      if (!clipboardBusy.current) add(files);
    }
    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
  }, [add, available]);

  useEffect(() => {
    if (pasteFallback) pasteRef.current?.focus();
  }, [pasteFallback]);

  async function pastePhoto() {
    if (scanLocked.current || clipboardBusy.current) return;
    setInputError(null);
    if (!navigator.clipboard?.read) {
      setPasteFallback(true);
      pasteRef.current?.focus();
      return;
    }
    clipboardBusy.current = true;
    setPasting(true);
    try {
      const items = await navigator.clipboard.read();
      const files: File[] = [];
      for (const item of items) {
        // A clipboard item can offer several encodings of the same photo.
        const type = item.types.find((type) => type.startsWith("image/"));
        if (!type) continue;
        const blob = await item.getType(type);
        files.push(new File([blob], "pasted-photo", { type }));
      }
      if (!mounted.current) return;
      if (files.length) add(files);
      else setInputError(t("Copy a photo first, then paste it here."));
    } catch {
      if (!mounted.current) return;
      setPasteFallback(true);
      pasteRef.current?.focus();
    } finally {
      clipboardBusy.current = false;
      if (mounted.current) setPasting(false);
    }
  }

  function drag(event: DragEvent<HTMLDivElement>) {
    if (!event.dataTransfer.types.includes("Files")) return false;
    event.preventDefault();
    event.dataTransfer.dropEffect = available && !scanLocked.current && !clipboardBusy.current
      && shotList.current.length < max ? "copy" : "none";
    return true;
  }

  function remove(url: string) {
    URL.revokeObjectURL(url);
    urls.current.delete(url);
    shotList.current = shotList.current.filter((s) => s.url !== url);
    setShots(shotList.current);
    setInputError(null);
  }

  /** "Add another": the camera on a phone, the file picker with a mouse. */
  function addAnother() {
    const coarse = window.matchMedia("(pointer: coarse)").matches;
    (coarse ? cameraRef : pickerRef).current?.click();
  }

  const working = upload.isPending;
  const failed = upload.isError;

  return (
    <div
      onDragEnter={(event) => {
        if (!drag(event)) return;
        dragDepth.current += 1;
        if (event.dataTransfer.dropEffect === "copy") setDragging(true);
      }}
      onDragOver={drag}
      onDragLeave={(event) => {
        event.preventDefault();
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (!dragDepth.current) setDragging(false);
      }}
      onDrop={(event) => {
        event.preventDefault();
        dragDepth.current = 0;
        setDragging(false);
        if (!clipboardBusy.current) add(event.dataTransfer.files);
      }}
    >
    <Card className={cx("p-4 sm:p-5 transition-shadow", dragging && "ring-2 ring-ink bg-surface-2")}>
      <div className="mb-1 flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-body">{copy?.title ?? t("Scan a receipt")}</h2>
        <Button size="sm" variant="ghost" className="-mr-2" onClick={onCancel}>
          {t("Cancel")}
        </Button>
      </div>
      <p className="mb-4 text-[13px] text-muted">
        {copy?.intro ?? t("Photograph the whole receipt. A long one can take several photos — add them in order. Every line comes back editable, so you can fix anything the model misread.")}
        {appendToExisting && <> {t("Scanned lines will be added to the ones already here.")}</>}
      </p>

      {config.data?.receipt_scanning === false && (
        <p role="status" className="rounded-control bg-surface-2 px-3 py-4 text-sm text-body">
          {t("Receipt scanning is not configured on this server.")}
        </p>
      )}

      <FormError
        message={
          upload.error instanceof ApiError
            ? t(upload.error.message)
            : upload.error instanceof Error
              ? t(upload.error.message)
              : null
        }
      />

      <FormError message={inputError} />

      {config.data?.receipt_scanning !== false && <>
      {/* `capture` opens the camera directly but hides the library, so each gets its own input. */}
      <input
        ref={cameraRef}
        type="file"
        accept="image/*"
        capture="environment"
        disabled={working || pasting}
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
        onChange={(e) => {
          add(e.target.files);
          e.target.value = "";
        }}
      />
      <input
        ref={pickerRef}
        type="file"
        accept="image/*"
        multiple
        disabled={working || pasting}
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
        onChange={(e) => {
          add(e.target.files);
          e.target.value = "";
        }}
      />

      {shots.length > 0 && (
        <ul className="no-scrollbar -mx-1 mb-4 mt-3 flex snap-x gap-2 overflow-x-auto px-1 py-1">
          {shots.map((shot, i) => (
            <li key={shot.url} className="relative shrink-0 snap-start">
              <img
                src={shot.url}
                alt={t("Photo {count}", { count: i + 1 })}
                className="h-28 w-20 rounded-control border border-line object-cover"
              />
              {!working && (
                <button
                  type="button"
                  aria-label={t("Remove photo {count}", { count: i + 1 })}
                  onClick={() => remove(shot.url)}
                  className={cx(
                    "absolute right-1 top-1 grid size-7 place-items-center rounded-full",
                    "bg-black/60 text-white backdrop-blur-sm transition active:scale-90 active:duration-0",
                  )}
                >
                  <svg viewBox="0 0 16 16" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                    <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" />
                  </svg>
                </button>
              )}
            </li>
          ))}
          {!working && shots.length < max && (
            <li className="shrink-0">
              <button
                type="button"
                onClick={addAnother}
                disabled={pasting}
                className={cx(
                  "flex h-28 w-20 flex-col items-center justify-center gap-1 rounded-control",
                  "border border-dashed border-line-strong text-muted transition-colors",
                  "hover:bg-surface-2 hover:text-body active:bg-surface-2 active:duration-0",
                )}
              >
                <svg viewBox="0 0 16 16" className="size-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                  <path d="M8 3v10M3 8h10" />
                </svg>
                <span className="text-[12px]">{t("Add")}</span>
              </button>
            </li>
          )}
        </ul>
      )}
      {!working && (
        <div className="mb-3 mt-3 flex flex-col items-center gap-2">
          <p className="text-center text-[13px] text-muted" role="status">
            {dragging
              ? t("Drop receipt photos here")
              : <><span className="pointer-coarse:hidden">{t("Drop photos here, or paste with Ctrl+V / ⌘V.")}</span>
                <span className="hidden pointer-coarse:inline">{t("Copy a receipt photo, then tap Paste photo.")}</span></>}
          </p>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            loading={pasting}
            disabled={shots.length >= max}
            onClick={pastePhoto}
          >
            {t("Paste photo")}
          </Button>
          {pasteFallback && (
            <>
              <p className="text-center text-[13px] text-muted">
                {t("Tap and hold in the field below and choose Paste, or press Ctrl+V / ⌘V. You can also choose a photo from your device.")}
              </p>
              <textarea
                ref={pasteRef}
                aria-label={t("Paste a receipt photo")}
                rows={2}
                value=""
                onChange={() => {}}
                onPaste={(event) => {
                  if (![...event.clipboardData.items].some((item) => item.type.startsWith("image/"))
                    && ![...event.clipboardData.files].some((file) => file.type.startsWith("image/"))) {
                    event.preventDefault();
                    setInputError(t("Copy a photo first, then paste it here."));
                  }
                }}
                className="w-full resize-none rounded-control border border-line-strong bg-surface px-3 py-2 text-base"
              />
            </>
          )}
        </div>
      )}
      {working ? (
        <div className="flex flex-col gap-3" aria-live="polite">
          <p className="text-sm text-muted">
            {copy?.reading ?? t("Reading the receipt…")}
          </p>
          {/* The skeleton is shaped like the line list it will become. */}
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="flex items-center justify-between gap-4">
              <Skeleton className="h-4 flex-1" />
              <Skeleton className="h-4 w-16" />
            </div>
          ))}
        </div>
      ) : shots.length > 0 ? (
        <Button type="button" full disabled={pasting} onClick={() => upload.mutate(shots.map((s) => s.file))}>
          {failed ? t("Try again") : copy?.read ?? t("Read the receipt")}
        </Button>
      ) : (
        <>
          <div className="grid gap-2 pointer-coarse:grid-cols-2">
            <button
              type="button"
              onClick={() => cameraRef.current?.click()}
              className={cx(TILE, "hidden bg-ink text-ink-text pointer-coarse:flex")}
            >
              <svg viewBox="0 0 20 20" className="size-6" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" aria-hidden="true">
                <path d="M2.5 7.5A1.5 1.5 0 0 1 4 6h1.8l1.2-2h6l1.2 2H16a1.5 1.5 0 0 1 1.5 1.5v7A1.5 1.5 0 0 1 16 16H4a1.5 1.5 0 0 1-1.5-1.5v-7Z" />
                <circle cx="10" cy="10.75" r="2.75" />
              </svg>
              <span className="text-sm font-medium">{t("Take a photo")}</span>
            </button>
            <button
              type="button"
              onClick={() => pickerRef.current?.click()}
              className={cx(
                TILE,
                "border border-dashed border-line-strong text-body hover:bg-surface-2 active:bg-surface-2",
              )}
            >
              <svg viewBox="0 0 24 24" className="size-6 text-muted" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <rect x="3.5" y="4.5" width="17" height="15" rx="2" />
                <circle cx="9" cy="10" r="1.75" />
                <path d="m20.5 16-4.5-4.5-8 8" />
              </svg>
              <span className="text-sm font-medium">
                <span className="pointer-coarse:hidden">{t("Upload photos")}</span>
                <span className="hidden pointer-coarse:inline">{t("Choose from gallery")}</span>
              </span>
            </button>
          </div>
          <p className="mt-2 text-center text-[12px] text-muted">
            {t("Up to {count} images, {size} MB each", { count: max, size: config.data?.max_upload_mb ?? 12 })}
          </p>
        </>
      )}
      </>}
    </Card>
    </div>
  );
}
