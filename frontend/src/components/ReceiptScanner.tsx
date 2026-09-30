import { useMutation } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Button, Card, FormError, Skeleton, cx } from "./ui";
import { useReceipt, useServerConfig } from "../hooks/queries";
import { ApiError, api } from "../lib/api";
import { useI18n } from "../lib/i18n";
import type { ParsedReceiptItem, Receipt } from "../lib/types";

interface Props {
  teamId: string;
  onParsed: (receipt: Receipt, items: ParsedReceiptItem[]) => void;
  onCancel: () => void;
}

interface Shot {
  file: File;
  url: string;
}

const STATUS_COPY: Record<string, string> = {
  pending: "Queued…",
  processing: "Reading the receipt…",
};

const TILE = cx(
  "flex flex-col items-center justify-center gap-2 rounded-control px-4 py-6 text-center",
  "transition duration-150 ease-out active:scale-[0.98] active:duration-0",
);

/**
 * Photos are collected first and read on request. A phone camera returns one
 * shot per trip, so a long receipt needs several trips before anything is sent,
 * and a look at the thumbnails catches a blurred photo before the slow part.
 */
export function ReceiptScanner({ teamId, onParsed, onCancel }: Props) {
  const { t } = useI18n();
  const config = useServerConfig();
  const cameraRef = useRef<HTMLInputElement>(null);
  const pickerRef = useRef<HTMLInputElement>(null);
  const [shots, setShots] = useState<Shot[]>([]);
  const [receiptId, setReceiptId] = useState<string | null>(null);
  const handled = useRef(false);
  const urls = useRef(new Set<string>());
  const max = config.data?.max_receipt_images ?? 8;

  const upload = useMutation({
    mutationFn: (files: File[]) => {
      const form = new FormData();
      files.forEach((file) => form.append("files", file));
      return api<Receipt>(`/teams/${teamId}/receipts`, { form });
    },
    onSuccess: (receipt) => setReceiptId(receipt.id),
  });

  const receipt = useReceipt(teamId, receiptId);

  // Hand the parsed lines up exactly once, then let the parent take over.
  useEffect(() => {
    if (receipt.data?.status === "parsed" && !handled.current) {
      handled.current = true;
      onParsed(receipt.data, receipt.data.items);
    }
  }, [receipt.data, onParsed]);

  // Object URLs pin the image in memory until revoked.
  useEffect(() => {
    const live = urls.current;
    return () => live.forEach((url) => URL.revokeObjectURL(url));
  }, []);

  function add(files: FileList | null) {
    if (!files?.length) return;
    const next = [...files].slice(0, Math.max(0, max - shots.length)).map((file) => {
      const url = URL.createObjectURL(file);
      urls.current.add(url);
      return { file, url };
    });
    setShots((list) => [...list, ...next]);
  }

  function remove(url: string) {
    URL.revokeObjectURL(url);
    urls.current.delete(url);
    setShots((list) => list.filter((s) => s.url !== url));
  }

  /** "Add another": the camera on a phone, the file picker with a mouse. */
  function addAnother() {
    const coarse = window.matchMedia("(pointer: coarse)").matches;
    (coarse ? cameraRef : pickerRef).current?.click();
  }

  const working =
    upload.isPending ||
    receipt.data?.status === "pending" ||
    receipt.data?.status === "processing";
  const failed = receipt.data?.status === "failed";

  return (
    <Card className="p-4 sm:p-5">
      <div className="mb-1 flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-body">{t("Scan a receipt")}</h2>
        <Button size="sm" variant="ghost" className="-mr-2" onClick={onCancel}>
          {t("Cancel")}
        </Button>
      </div>
      <p className="mb-4 text-[13px] text-muted">
        {t("Photograph the whole receipt. A long one can take several photos — add them in order. Every line comes back editable, so you can fix anything the model misread.")}
      </p>

      <FormError
        message={
          upload.error instanceof ApiError
            ? upload.error.message
            : failed
              ? (receipt.data?.error ?? t("That receipt could not be read."))
              : null
        }
      />

      {/* `capture` opens the camera directly but hides the library, so each gets its own input. */}
      <input
        ref={cameraRef}
        type="file"
        accept="image/*"
        capture="environment"
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

      {working ? (
        <div className="flex flex-col gap-3" aria-live="polite">
          <p className="text-sm text-muted">
            {t(STATUS_COPY[receipt.data?.status ?? "pending"] ?? "Uploading…")}
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
        <Button type="button" full onClick={() => upload.mutate(shots.map((s) => s.file))}>
          {t(failed ? "Try again" : "Read the receipt")}
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
                <span className="pointer-coarse:hidden">{t("Choose images")}</span>
                <span className="hidden pointer-coarse:inline">{t("From photos")}</span>
              </span>
            </button>
          </div>
          <p className="mt-2 text-center text-[12px] text-muted">
            {t("Up to {count} images, {size} MB each", { count: max, size: config.data?.max_upload_mb ?? 12 })}
          </p>
        </>
      )}
    </Card>
  );
}
