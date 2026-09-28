"use client";

import { useRef, useState } from "react";
import { Spinner } from "./controls";
import { TrashIcon } from "./icons";
import { Button } from "./ui";
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
 * One 16:9 box. Empty, it is the cover made from the title; once a file is
 * chosen, that same box shows the preview. The box stays the drop target and
 * the click target either way.
 */

export function WebinarImagePicker({
  topic = "",
  previewUrl,
  onChange,
  onRemove,
}: {
  /** Title painted on the generated cover until a file is chosen. */
  topic?: string;
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

  const coverTitle = topic.trim() || "Your webinar";

  return (
    <div>
      <span className="label">
        Cover image <span className="font-normal text-ink-3">(optional)</span>
      </span>

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
        className={`relative mt-1 flex aspect-video w-full items-center justify-center overflow-hidden rounded-[10px] text-center outline-none focus-visible:ring-2 focus-visible:ring-brand/40 ${
          previewUrl
            ? "border border-line bg-surface-2"
            : "bg-gradient-to-br from-[#2a3b8f] to-[#6a5cff] text-white"
        } ${dragOver ? "ring-2 ring-brand" : ""}`}
      >
        {previewUrl ? (
          // eslint-disable-next-line @next/next/no-img-element -- object URL or API URL; next/image cannot optimize either
          <img
            src={previewUrl}
            alt="Webinar cover preview"
            className="absolute inset-0 size-full object-cover"
          />
        ) : (
          <span className="px-2.5">
            <span className="block text-[13px] font-semibold">{coverTitle}</span>
            <span className="mt-0.5 block text-[11px] opacity-85">
              Shown on your page and in WhatsApp
            </span>
          </span>
        )}
        {busy && (
          <span className="absolute inset-0 grid place-items-center bg-surface/70">
            <Spinner className="size-5 text-ink-3" />
          </span>
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

      {!previewUrl && (
        <p className="mt-2 text-[11.5px] text-ink-3">
          Click the cover or drag an image here · 16:9
        </p>
      )}
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
