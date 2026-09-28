"use client";

import { useRef, useState } from "react";
import { Spinner } from "./controls";
import { ImageIcon, TrashIcon } from "./icons";
import { Badge, Button } from "./ui";
import {
  prepareWebinarImage,
  WebinarImageError,
  type PreparedWebinarImage,
} from "@/lib/webinar-image";

/* The cover image picker on the schedule form.
 *
 * Compression happens here, entirely client-side (see lib/webinar-image.ts), so
 * what the box shows is the ACTUAL optimized image — not a promise about what
 * will happen on save. The parent only ever receives an already-cropped,
 * already-under-1MB blob; it does not know or care how large the original file
 * was.
 *
 * One 16:9 box. Empty, it is the drop zone; once a file is chosen, that same
 * box shows the preview. A second empty frame under the drop zone read as two
 * covers. The box stays the drop target and the click target either way.
 */

export function WebinarImagePicker({
  previewUrl,
  onChange,
  onRemove,
}: {
  /** What to show right now: the persisted image, a local preview of a pending
   *  selection, or null when there is nothing to show yet. */
  previewUrl: string | null;
  /** Fired once a picked file has been cropped and compressed and is ready to
   *  send — not on pick itself, so the parent never holds a file that still
   *  needs work done to it. */
  onChange: (prepared: PreparedWebinarImage, previewUrl: string) => void;
  onRemove: () => void;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);

  async function handleFile(file: File | undefined | null) {
    if (!file) return;
    setError(null);
    setBusy(true);
    try {
      const prepared = await prepareWebinarImage(file);
      onChange(prepared, URL.createObjectURL(prepared.blob));
    } catch (err) {
      setError(
        err instanceof WebinarImageError
          ? err.message
          : "Couldn't process that image.",
      );
    } finally {
      setBusy(false);
    }
  }

  function openPicker() {
    inputRef.current?.click();
  }

  return (
    <div>
      <div className="flex items-center gap-2">
        <span className="label !mb-0">Webinar Image</span>
        <Badge tone="brand">Optional</Badge>
      </div>
      <p className="mt-1 mb-2.5 text-[12px] text-ink-3">
        Upload a cover image for your webinar.
      </p>

      <button
        type="button"
        onClick={openPicker}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          void handleFile(e.dataTransfer.files[0]);
        }}
        aria-label={
          previewUrl ? "Replace webinar cover image" : "Upload a webinar cover image"
        }
        className={`relative flex aspect-video w-full flex-col items-center justify-center gap-2 overflow-hidden rounded-lg border-2 px-4 text-center transition-colors outline-none focus-visible:ring-2 focus-visible:ring-brand/40 ${
          previewUrl ? "border-solid p-0" : "border-dashed"
        } ${
          dragOver
            ? "border-brand bg-brand/5"
            : previewUrl
              ? "border-line bg-surface-2"
              : "border-line-2 hover:border-ink-3 hover:bg-surface-2"
        }`}
      >
        {previewUrl ? (
          // eslint-disable-next-line @next/next/no-img-element -- object URL or API URL; next/image cannot optimize either
          <img
            src={previewUrl}
            alt="Webinar cover preview"
            className="absolute inset-0 size-full object-cover"
          />
        ) : busy ? null : (
          <ImageIcon className="size-6 text-ink-3" />
        )}
        {busy && (
          <span className="absolute inset-0 grid place-items-center bg-surface/70">
            <Spinner className="size-5 text-ink-3" />
          </span>
        )}
        {!previewUrl && (
          <>
            <span className="text-[13px] font-medium text-ink-2">
              {busy ? "Processing…" : "Drag & drop an image here"}
            </span>
            {!busy && (
              <span className="text-[12px] text-ink-3">or click to upload</span>
            )}
          </>
        )}
      </button>
      <input
        ref={inputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        className="hidden"
        onChange={(e) => {
          void handleFile(e.target.files?.[0]);
          // Cleared so picking the SAME file twice in a row (e.g. after
          // Remove) still fires a change event.
          e.target.value = "";
        }}
      />

      <p className="mt-2 text-[11.5px] leading-relaxed text-ink-3">
        Recommended: 1280 × 720 (16:9) · Supported formats: JPG, PNG, WEBP
        <br />
        Images are automatically compressed to 1 MB or less.
      </p>
      {error && (
        <p className="mt-1.5 text-[11.5px] font-medium text-live">{error}</p>
      )}

      {previewUrl && (
        <div className="mt-2 flex gap-2">
          <Button type="button" variant="secondary" size="sm" onClick={openPicker}>
            Replace
          </Button>
          <Button type="button" variant="danger" size="sm" onClick={onRemove}>
            <TrashIcon className="size-3.5" />
            Remove
          </Button>
        </div>
      )}
    </div>
  );
}
