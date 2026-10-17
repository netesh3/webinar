"use client";

import { useCallback, useId, useState } from "react";
import { engageApi } from "../api";
import { MaterialIcon } from "@/components/icons";
import { useToast } from "@/components/providers";
import { Button } from "@/components/ui";
import { ApiError } from "@/lib/api";
import type { CRMMediaFile, CRMTemplate, CRMTemplateHeaderInput } from "@/lib/api-types";
import {
  MEDIA_RULES,
  MAX_HEADER_TEXT,
  headerSummary,
  headerTextProblem,
  isMediaFormat,
  type HeaderChoice,
  type HeaderFormat,
  type MediaFormat,
} from "../header-media";
import { processedSummary, sizeText } from "../template-options";
import { MediaGallery } from "./media-gallery";

/* A template's header, everywhere it is written or shown: the picker in the editors,
 * the top of a WhatsApp bubble, the file a template sends by default, and a
 * broadcast's own choice. Rules (Meta's limits) are in ../header-media.ts. */

export type HeaderDraft = { format: HeaderFormat; text: string; file: CRMMediaFile | null };

export const NO_HEADER: HeaderDraft = { format: "NONE", text: "", file: null };

/** Why this header cannot be submitted yet, or null. */
export function headerDraftProblem(h: HeaderDraft): string | null {
  if (h.format === "TEXT") return headerTextProblem(h.text);
  if (isMediaFormat(h.format) && !h.file) {
    return `Choose the ${MEDIA_RULES[h.format].label.toLowerCase()} Meta should review it with.`;
  }
  return null;
}

/** The request's header, or undefined for none. */
export function headerInput(h: HeaderDraft): CRMTemplateHeaderInput | undefined {
  if (h.format === "TEXT") return { format: "TEXT", text: h.text.trim() };
  if (isMediaFormat(h.format) && h.file) return { format: h.format, fileId: h.file.id };
  return undefined;
}

/** The media at the top of a WhatsApp bubble. Nothing for a text header or none. */
export function HeaderMediaBlock({
  format,
  file,
  cover,
}: {
  format?: string;
  file?: CRMMediaFile | null;
  /** The webinar's cover, sent when an image header has no file of its own. */
  cover?: string;
}) {
  const f = (format ?? "").toUpperCase();
  if (f === "IMAGE") {
    const src = file?.url ?? cover;
    return (
      <div
        className="relative aspect-[1.91/1] w-full bg-gradient-to-br from-brand to-[#5b8cff]"
        role="img"
        aria-label={file ? "The header image" : "The webinar's cover image"}
      >
        <span className="absolute inset-0 grid place-items-center px-3 text-center text-[12px] font-semibold text-white/90">
          {file ? "Your image" : "Your webinar's cover"}
        </span>
        {src && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={src}
            alt=""
            className="absolute inset-0 size-full object-cover"
            onError={(e) => {
              e.currentTarget.style.display = "none";
            }}
          />
        )}
      </div>
    );
  }
  if (f === "VIDEO") {
    return file ? (
      <video
        src={file.url}
        className="aspect-video w-full bg-black object-cover"
        muted
        playsInline
        preload="metadata"
        aria-label="The header video"
      />
    ) : (
      <div className="grid aspect-video w-full place-items-center bg-[#1f2c34] text-[12px] text-white/80">
        <span className="flex items-center gap-1">
          <MaterialIcon name="play_circle" className="!text-[20px]" />
          Video
        </span>
      </div>
    );
  }
  if (f === "DOCUMENT") {
    return (
      <div className="m-1 flex items-center gap-2 rounded-md bg-[#f0f2f5] px-2.5 py-2 text-[12px] text-[#111]">
        <MaterialIcon name="description" className="!text-[22px] text-[#e5533d]" />
        <span className="min-w-0 flex-1 truncate">{file?.filename || "Document"}</span>
        {file && <span className="shrink-0 text-[10.5px] text-[#667781]">{sizeText(file.bytes)}</span>}
      </div>
    );
  }
  return null;
}

/** Size (and, for a processed image, dimensions and the size before) of an uploaded file. */
export function fileDetail(f: CRMMediaFile): string {
  return f.width ? processedSummary(f) : sizeText(f.bytes);
}

/** A button that opens the media gallery: pick a file uploaded before, or upload a
 *  new one there (checked against Meta's limits). `onUploaded` gets the chosen file. */
export function HeaderFileButton({
  format,
  formats,
  label,
  disabled,
  aspect,
  onUploaded,
}: {
  format: MediaFormat;
  /** More than one kind is fine here (a carousel card: image or video). */
  formats?: MediaFormat[];
  label: string;
  disabled?: boolean;
  /** A carousel card's shape: other images cannot be picked, uploads are cropped to it. */
  aspect?: "square" | "wide";
  onUploaded: (file: CRMMediaFile) => void | Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const accept = formats ?? [format];
  const close = useCallback(() => setOpen(false), []);
  return (
    <>
      <Button
        type="button"
        size="sm"
        variant="secondary"
        className="h-7 px-2.5 text-[12px]"
        disabled={disabled}
        onClick={() => setOpen(true)}
        title={accept.map((f) => MEDIA_RULES[f].hint).join(" · ")}
      >
        <MaterialIcon name="perm_media" className="!text-[15px]" />
        {label}
      </Button>
      <MediaGallery
        open={open}
        onClose={close}
        accept={accept}
        aspect={accept.includes("IMAGE") ? aspect : undefined}
        title={label}
        onSelect={onUploaded}
      />
    </>
  );
}

const FORMATS: { id: HeaderFormat; label: string }[] = [
  { id: "NONE", label: "None" },
  { id: "TEXT", label: "Text" },
  { id: "IMAGE", label: "Image" },
  { id: "VIDEO", label: "Video" },
  { id: "DOCUMENT", label: "Document" },
];

/** The header part of the template editor: kind, then the text or the file. */
export function HeaderPicker({
  value,
  onChange,
  disabled,
}: {
  value: HeaderDraft;
  onChange: (next: HeaderDraft) => void;
  disabled?: boolean;
}) {
  const id = useId();
  const media = isMediaFormat(value.format) ? value.format : null;
  return (
    <div className="grid gap-1.5">
      <label className="flex items-center gap-2 text-[12px] text-ink-2" htmlFor={`${id}-kind`}>
        Header
        <select
          id={`${id}-kind`}
          className="field h-8 w-auto"
          value={value.format}
          disabled={disabled}
          onChange={(e) => {
            const format = e.target.value as HeaderFormat;
            // A file only carries over to the same kind.
            const keep = value.file && isMediaFormat(format) && MEDIA_RULES[format].kind === value.file.kind;
            onChange({ format, text: value.text, file: keep ? value.file : null });
          }}
        >
          {FORMATS.map((f) => (
            <option key={f.id} value={f.id}>
              {f.label}
            </option>
          ))}
        </select>
      </label>
      {value.format === "TEXT" && (
        <input
          className="field h-8"
          value={value.text}
          maxLength={MAX_HEADER_TEXT}
          disabled={disabled}
          onChange={(e) => onChange({ ...value, text: e.target.value })}
          placeholder="Your webinar, today"
          aria-label="Header text"
        />
      )}
      {media && (
        <div className="flex flex-wrap items-center gap-2 text-[11.5px] text-ink-3">
          <HeaderFileButton
            format={media}
            label={value.file ? "Replace" : `Choose ${MEDIA_RULES[media].label.toLowerCase()}`}
            disabled={disabled}
            onUploaded={(file) => onChange({ ...value, file })}
          />
          <span className="min-w-0 flex-1 truncate">
            {value.file ? value.file.filename : MEDIA_RULES[media].hint}
          </span>
          {value.file && <span className="shrink-0">{fileDetail(value.file)}</span>}
        </div>
      )}
      {media && (
        <p className="text-[11px] leading-snug text-ink-3">
          Meta reviews the template with this file, and it is what gets sent unless a broadcast
          picks another.
          {media === "IMAGE" && " Without one, an image header sends the webinar's cover."}
        </p>
      )}
    </div>
  );
}

/** A media-header template's default file, in the template list: show it, set it, clear it. */
export function TemplateHeaderFile({
  template,
  onSaved,
}: {
  template: CRMTemplate;
  onSaved: () => void;
}) {
  const { notify } = useToast();
  const [busy, setBusy] = useState(false);
  const format = (template.headerFormat ?? "").toUpperCase();
  if (!isMediaFormat(format)) return null;
  const file = template.headerFile;

  async function save(fileId: string) {
    setBusy(true);
    try {
      await engageApi.setCrmTemplateMedia(template.name, template.language, fileId);
      onSaved();
    } catch (e) {
      notify(e instanceof ApiError ? e.message : "Could not save that file.", "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-1.5 grid gap-1.5">
      {file && (format === "IMAGE" || format === "VIDEO") && (
        <div className="max-w-[220px] overflow-hidden rounded-md border border-line">
          <HeaderMediaBlock format={format} file={file} />
        </div>
      )}
      <div className="flex flex-wrap items-center gap-1.5 text-[11.5px]">
        <MaterialIcon
          name={format === "IMAGE" ? "image" : format === "VIDEO" ? "movie" : "description"}
          className="!text-[15px] text-ink-3"
        />
        <span className={`mr-auto min-w-0 truncate ${template.needsHeaderFile ? "text-warn" : "text-ink-3"}`}>
          {headerSummary(template)}
        </span>
        <HeaderFileButton
          format={format}
          label={file ? "Replace" : "Choose file"}
          disabled={busy}
          onUploaded={(f) => save(f.id)}
        />
        {file && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-7 px-2 text-[12px]"
            disabled={busy}
            onClick={() => void save("")}
          >
            {format === "IMAGE" ? "Use cover" : "Remove"}
          </Button>
        )}
      </div>
    </div>
  );
}

/** A broadcast's header: the template's file, the webinar's cover, or one just for this send. */
export function BroadcastHeaderPicker({
  template,
  choice,
  ownFile,
  onChange,
}: {
  template: CRMTemplate;
  choice: HeaderChoice;
  ownFile: CRMMediaFile | null;
  onChange: (choice: HeaderChoice, file: CRMMediaFile | null) => void;
}) {
  const name = useId();
  const format = (template.headerFormat ?? "").toUpperCase();
  if (!isMediaFormat(format)) return null;
  const rule = MEDIA_RULES[format];
  const options: { mode: HeaderChoice["mode"]; label: string; hint: string }[] = [];
  if (template.headerFile) {
    options.push({ mode: "default", label: "The template's file", hint: template.headerFile.filename || rule.label });
  }
  if (format === "IMAGE") {
    options.push({ mode: "cover", label: "Webinar cover (auto)", hint: "Each webinar's own cover" });
  }
  options.push({ mode: "file", label: "This file", hint: ownFile?.filename || rule.hint });

  return (
    <fieldset className="grid gap-1.5">
      <legend className="label">{rule.label} at the top</legend>
      <div className="grid gap-1.5 sm:grid-cols-3">
        {options.map((o) => {
          const checked =
            choice.mode === o.mode ||
            // An image template with no file of its own defaults to the cover.
            (choice.mode === "default" && o.mode === "cover" && !template.headerFile);
          return (
            <label
              key={o.mode}
              className={`cursor-pointer rounded-xl border px-3 py-2 transition ${
                checked ? "border-brand ring-1 ring-brand" : "border-line hover:border-line-2"
              }`}
            >
              <input
                type="radio"
                name={name}
                className="sr-only"
                checked={checked}
                onChange={() =>
                  o.mode === "file"
                    ? ownFile && onChange({ mode: "file", fileId: ownFile.id }, ownFile)
                    : onChange({ mode: o.mode } as HeaderChoice, ownFile)
                }
              />
              <span className="block text-[13px] font-medium text-ink">{o.label}</span>
              <span className="block truncate text-[11px] text-ink-3">{o.hint}</span>
            </label>
          );
        })}
      </div>
      <div>
        <HeaderFileButton
          format={format}
          label={ownFile ? "Choose another file" : "Choose a file for this broadcast"}
          onUploaded={(f) => onChange({ mode: "file", fileId: f.id }, f)}
        />
      </div>
    </fieldset>
  );
}
