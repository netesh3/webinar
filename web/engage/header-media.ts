/* A WhatsApp template's header: none, fixed text, or an image, video or document.
 *
 * Meta's own limits, mirrored from the API's check (api/internal/engage/wa_template_media.go)
 * so the editor refuses a file before uploading it. The server checks again, by
 * content, and is the one that counts. Pure, so it runs under node's test runner. */

export type HeaderFormat = "NONE" | "TEXT" | "IMAGE" | "VIDEO" | "DOCUMENT";
export type MediaFormat = "IMAGE" | "VIDEO" | "DOCUMENT";

const MB = 1 << 20;

export const MEDIA_RULES: Record<
  MediaFormat,
  { kind: string; label: string; noun: string; types: string[]; limit: number; hint: string }
> = {
  IMAGE: {
    kind: "image",
    label: "Image",
    noun: "an image",
    // Converted on upload (api/internal/engage/wa_image.go): turned upright, resized
    // and saved as the JPEG or PNG under 5 MB that Meta takes.
    types: ["image/jpeg", "image/png", "image/webp", "image/gif"],
    limit: 25 * MB,
    hint: "JPG, PNG, WebP or GIF — resized for WhatsApp",
  },
  VIDEO: {
    kind: "video",
    label: "Video",
    noun: "a video",
    types: ["video/mp4", "video/3gpp"],
    limit: 16 * MB,
    hint: "MP4 (H.264/AAC), up to 16 MB",
  },
  DOCUMENT: {
    kind: "document",
    label: "Document",
    noun: "a document",
    types: [
      "application/pdf",
      "text/plain",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ],
    limit: 100 * MB,
    hint: "PDF, Word, Excel, PowerPoint or text, up to 100 MB",
  },
};

export const MAX_HEADER_TEXT = 60;

/** Meta plays only these; there is no transcoder here, so the coach exports it right. */
export const VIDEO_RULE = "Video must be MP4 (H.264 video, AAC audio) under 16 MB.";

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function isMediaFormat(f: string | undefined): f is MediaFormat {
  return f === "IMAGE" || f === "VIDEO" || f === "DOCUMENT";
}

/** The header format a stored file fits: image, video or document. */
export function formatForKind(kind: string): MediaFormat | null {
  for (const f of ["IMAGE", "VIDEO", "DOCUMENT"] as const) {
    if (MEDIA_RULES[f].kind === kind) return f;
  }
  return null;
}

/** Why this file cannot be this header, or null when it can. */
export function headerFileProblem(
  format: MediaFormat,
  file: { type: string; size: number },
): string | null {
  const rule = MEDIA_RULES[format];
  if (format === "IMAGE" && /^image\/hei[cf]/i.test(file.type)) {
    return "HEIC photos can't be read here. Upload a JPG or PNG (on iPhone: Settings → Camera → Formats → Most Compatible).";
  }
  if (!rule.types.includes(file.type)) {
    if (format === "VIDEO") return VIDEO_RULE;
    if (format === "IMAGE") return "An image header takes JPG, PNG, WebP or GIF.";
    return `${cap(rule.noun)} header takes ${rule.hint.split(",")[0]}.`;
  }
  if (file.size === 0) return "That file is empty.";
  if (file.size > rule.limit) {
    if (format === "VIDEO") return VIDEO_RULE;
    if (format === "IMAGE") return `That image is over ${rule.limit / MB} MB. Use a smaller one.`;
    return `WhatsApp takes ${rule.noun} of up to ${rule.limit / MB} MB.`;
  }
  return null;
}

/** Why the fixed header text cannot be sent, or null. */
export function headerTextProblem(text: string): string | null {
  const t = text.trim();
  if (!t) return "Write the header, or choose no header.";
  if ([...t].length > MAX_HEADER_TEXT) return `A header is at most ${MAX_HEADER_TEXT} characters.`;
  if (/\{\{/.test(t)) return "A header here is fixed text, without blanks.";
  return null;
}

/** One line for a template's header in a list: what it is and what it sends. */
export function headerSummary(t: {
  headerFormat?: string;
  headerFile?: { filename?: string };
  needsHeaderFile?: boolean;
}): string {
  const f = (t.headerFormat ?? "").toUpperCase();
  if (!isMediaFormat(f)) return "";
  const label = MEDIA_RULES[f].label;
  if (t.headerFile) return `${label} header · ${t.headerFile.filename || "your file"}`;
  if (f === "IMAGE") return "Image header · the webinar's cover";
  return `${label} header · needs a file before it can be sent`;
}

/** A broadcast's header choice, as the request's fields. */
export type HeaderChoice =
  | { mode: "default" }
  | { mode: "cover" }
  | { mode: "file"; fileId: string };

export function headerRequest(
  format: string | undefined,
  choice: HeaderChoice,
): { headerFileId?: string; headerUseCover?: boolean } {
  if (!isMediaFormat((format ?? "").toUpperCase())) return {};
  if (choice.mode === "file") return { headerFileId: choice.fileId };
  if (choice.mode === "cover" && (format ?? "").toUpperCase() === "IMAGE") {
    return { headerUseCover: true };
  }
  return {};
}

/** Can the broadcast go with this choice? A video or document needs a file from somewhere. */
export function headerChoiceProblem(
  t: { headerFormat?: string; headerFile?: unknown },
  choice: HeaderChoice,
): string | null {
  const f = (t.headerFormat ?? "").toUpperCase();
  if (f !== "VIDEO" && f !== "DOCUMENT") return null;
  if (choice.mode === "file" || (choice.mode === "default" && t.headerFile)) return null;
  return `This template opens with ${MEDIA_RULES[f].noun}. Choose the file to send.`;
}
