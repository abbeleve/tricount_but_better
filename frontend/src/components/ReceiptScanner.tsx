import { useMutation } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { Button, Card, FormError, Skeleton, cx } from "./ui";
import { useReceipt, useServerConfig } from "../hooks/queries";
import { ApiError, api } from "../lib/api";
import type { ParsedReceiptItem, Receipt } from "../lib/types";

interface Props {
  teamId: string;
  onParsed: (receipt: Receipt, items: ParsedReceiptItem[]) => void;
  onCancel: () => void;
}

const STATUS_COPY: Record<string, string> = {
  pending: "Queued…",
  processing: "Reading the receipt…",
};

export function ReceiptScanner({ teamId, onParsed, onCancel }: Props) {
  const config = useServerConfig();
  const inputRef = useRef<HTMLInputElement>(null);
  const [receiptId, setReceiptId] = useState<string | null>(null);
  const [previews, setPreviews] = useState<string[]>([]);
  const [handled, setHandled] = useState(false);

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
  if (receipt.data?.status === "parsed" && !handled) {
    setHandled(true);
    onParsed(receipt.data, receipt.data.items);
  }

  function choose(files: FileList | null) {
    if (!files?.length) return;
    const list = [...files].slice(0, config.data?.max_receipt_images ?? 8);
    setPreviews(list.map((f) => URL.createObjectURL(f)));
    upload.mutate(list);
  }

  const working =
    upload.isPending ||
    receipt.data?.status === "pending" ||
    receipt.data?.status === "processing";
  const failed = receipt.data?.status === "failed";

  return (
    <Card className="p-5">
      <div className="mb-1 flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-semibold text-body">Scan a receipt</h2>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
      <p className="mb-4 text-[13px] text-muted">
        Photograph the whole receipt. Several photos of one long receipt are fine — add them in
        order. Every line comes back editable, so you can fix anything the model misread.
      </p>

      <FormError
        message={
          upload.error instanceof ApiError
            ? upload.error.message
            : failed
              ? (receipt.data?.error ?? "That receipt could not be read.")
              : null
        }
      />

      {previews.length > 0 && (
        <div className="mb-4 flex gap-2 overflow-x-auto py-1">
          {previews.map((src) => (
            <img
              key={src}
              src={src}
              alt=""
              className="h-24 w-auto shrink-0 rounded-control border border-line object-cover"
            />
          ))}
        </div>
      )}

      {working ? (
        <div className="flex flex-col gap-3" aria-live="polite">
          <p className="text-sm text-muted">
            {STATUS_COPY[receipt.data?.status ?? "pending"] ?? "Uploading…"}
          </p>
          {/* The skeleton is shaped like the line list it will become. */}
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="flex items-center justify-between gap-4">
              <Skeleton className="h-4 flex-1" />
              <Skeleton className="h-4 w-16" />
            </div>
          ))}
        </div>
      ) : (
        <>
          <input
            ref={inputRef}
            type="file"
            accept="image/*"
            capture="environment"
            multiple
            className="sr-only"
            onChange={(e) => choose(e.target.files)}
          />
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            className={cx(
              "flex w-full flex-col items-center gap-2 rounded-control border border-dashed border-line-strong",
              "px-4 py-8 text-center transition-colors hover:bg-surface-2 active:translate-y-px",
            )}
          >
            <svg viewBox="0 0 24 24" className="size-6 text-muted" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
              <path d="M4 8V6a2 2 0 0 1 2-2h2M16 4h2a2 2 0 0 1 2 2v2M20 16v2a2 2 0 0 1-2 2h-2M8 20H6a2 2 0 0 1-2-2v-2" />
              <path d="M7 12h10" />
            </svg>
            <span className="text-sm font-medium text-body">
              {failed ? "Try another photo" : "Take a photo or choose files"}
            </span>
            <span className="text-[12px] text-muted">
              Up to {config.data?.max_receipt_images ?? 8} images, {config.data?.max_upload_mb ?? 12} MB each
            </span>
          </button>
        </>
      )}
    </Card>
  );
}
