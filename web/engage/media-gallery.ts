/* The media gallery's rules: which tabs a caller gets, which files it can pick and
 * why not, and the words for where a file is still used. Pure (type imports only),
 * so it runs under node's test runner. The modal is components/media-gallery.tsx. */

import type { CRMMediaDeleteResult, CRMMediaFile, CRMMediaUsage } from "@/lib/api-types";
import type { MediaFormat } from "./header-media";

export type GalleryKind = "image" | "video" | "document";
export type GalleryTab = { id: GalleryKind | "all"; label: string };

const KIND_OF: Record<MediaFormat, GalleryKind> = { IMAGE: "image", VIDEO: "video", DOCUMENT: "document" };
const KIND_LABEL: Record<GalleryKind, string> = { image: "Images", video: "Videos", document: "Documents" };
const KIND_NOUN: Record<GalleryKind, string> = { image: "an image", video: "a video", document: "a document" };

/** The kinds a caller takes, in a fixed order, without repeats. */
export function acceptedKinds(accept: readonly MediaFormat[]): GalleryKind[] {
  const want = new Set(accept.map((f) => KIND_OF[f]));
  return (["image", "video", "document"] as const).filter((k) => want.has(k));
}

/** The tabs above the grid: "All" only when more than one kind is accepted. */
export function galleryTabs(accept: readonly MediaFormat[]): GalleryTab[] {
  const kinds = acceptedKinds(accept);
  const tabs: GalleryTab[] = kinds.map((k) => ({ id: k, label: KIND_LABEL[k] }));
  return kinds.length > 1 ? [{ id: "all", label: "All" }, ...tabs] : tabs;
}

/** The `type` to list with: one kind, or none for "All" (filtered here instead). */
export function listType(tab: GalleryTab["id"]): GalleryKind | undefined {
  return tab === "all" ? undefined : tab;
}

/** The header format an uploaded file goes in as, among those accepted, or null. */
export function formatForUpload(accept: readonly MediaFormat[], mime: string): MediaFormat | null {
  const m = mime.toLowerCase();
  const kind: GalleryKind = m.startsWith("image/") ? "image" : m.startsWith("video/") ? "video" : "document";
  return accept.find((f) => KIND_OF[f] === kind) ?? null;
}

export type CardAspect = "square" | "wide";

const RATIO: Record<CardAspect, number> = { square: 1, wide: 1.91 };
// Center-cropped on upload to these exactly; 2% covers rounding to whole pixels.
const RATIO_SLACK = 0.02;

/** Whether an image of this size has this card shape. Unknown sizes pass. */
export function fitsAspect(width: number | undefined, height: number | undefined, aspect: CardAspect): boolean {
  if (!width || !height) return true;
  return Math.abs(width / height / RATIO[aspect] - 1) <= RATIO_SLACK;
}

/** Why this file cannot be picked here, or null when it can. */
export function pickProblem(
  file: Pick<CRMMediaFile, "kind" | "width" | "height">,
  accept: readonly MediaFormat[],
  aspect?: CardAspect,
): string | null {
  const kinds = acceptedKinds(accept);
  if (!kinds.includes(file.kind as GalleryKind)) {
    return `This needs ${kinds.map((k) => KIND_NOUN[k]).join(" or ")}.`;
  }
  if (file.kind === "image" && aspect && !fitsAspect(file.width, file.height, aspect)) {
    const shape = aspect === "square" ? "square (1:1)" : "wide (1.91:1)";
    return `Cards here are ${shape}; this image is ${file.width}×${file.height}. Upload it again to crop it.`;
  }
  return null;
}

/** One place a file is used, in words. */
export function usageText(u: CRMMediaUsage, timeZone?: string): string {
  const lang = u.language ? ` (${u.language})` : "";
  switch (u.kind) {
    case "template":
      return `Header of template ${u.name}${lang}`;
    case "carousel":
      return `Carousel card of template ${u.name}${lang}`;
    case "broadcast":
      return u.scheduledAt
        ? `Broadcast “${u.name}”, sending ${whenText(u.scheduledAt, timeZone)}`
        : `Broadcast “${u.name}”`;
  }
  return u.name;
}

/** A send time: "12 Oct 2026, 18:30". */
export function whenText(iso: string, timeZone?: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone,
  });
}

/** An upload date for the grid: "Today", "Yesterday", or "3 Oct 2026". */
export function uploadedText(iso: string | undefined, now: Date = new Date(), timeZone?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const day = (x: Date) => x.toLocaleDateString("en-CA", { timeZone });
  if (day(d) === day(now)) return "Today";
  if (day(d) === day(new Date(now.getTime() - 86_400_000))) return "Yesterday";
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone });
}

/** A delete's outcome in one line, for the notice under the grid. */
export function deleteSummary(r: CRMMediaDeleteResult): string {
  const n = r.deleted.length;
  const gone = n === 0 ? "" : n === 1 ? "Deleted 1 file." : `Deleted ${n} files.`;
  const inUse = r.skipped.filter((s) => s.reason === "in_use").length;
  const failed = r.skipped.filter((s) => s.reason === "storage").length;
  const parts = [gone];
  if (inUse) {
    parts.push(inUse === 1 ? "1 kept because it is still used (listed below)." : `${inUse} kept because they are still used (listed below).`);
  }
  if (failed) parts.push(failed === 1 ? "1 could not be removed from storage — try again." : `${failed} could not be removed from storage — try again.`);
  return parts.filter(Boolean).join(" ") || "Nothing was deleted.";
}

const MB = 1 << 20;

/** A size in the space bar: "12.4 MB", "1.5 GB". */
export function spaceSize(bytes: number): string {
  if (bytes >= 1024 * MB) return `${(bytes / (1024 * MB)).toFixed(1).replace(/\.0$/, "")} GB`;
  return `${(bytes / MB).toFixed(1).replace(/\.0$/, "")} MB`;
}

export type Space = { usedBytes: number; limitBytes: number };

/** "12.4 MB of 10 MB used", and how full, 0–1, for the bar. */
export function spaceSummary(s: Space): { text: string; fraction: number; full: boolean } {
  const fraction = s.limitBytes > 0 ? Math.min(1, s.usedBytes / s.limitBytes) : 0;
  return {
    text: `${spaceSize(s.usedBytes)} of ${spaceSize(s.limitBytes)} used`,
    fraction,
    full: s.usedBytes >= s.limitBytes,
  };
}

/** Why this file cannot be uploaded into what is left, or null when it might fit.
 *  An image is converted (and usually shrinks) on the server, so its original size
 *  is not held against it; only a library that is already full refuses one here. */
export function spaceProblem(file: { type: string; size: number }, s: Space): string | null {
  if (s.limitBytes <= 0) return null;
  const left = Math.max(0, s.limitBytes - s.usedBytes);
  if (left === 0) {
    return `Your media library is full (${spaceSize(s.usedBytes)} of ${spaceSize(s.limitBytes)}). Your files are kept, but delete some to upload more.`;
  }
  if (file.type.startsWith("image/")) return null;
  if (file.size > left) {
    return `This file is ${spaceSize(file.size)} but only ${spaceSize(left)} of your ${spaceSize(s.limitBytes)} is left. Delete files you no longer use to make room.`;
  }
  return null;
}

/** Merge a page into what is shown: newest first, no file twice. */
export function mergePage(shown: readonly CRMMediaFile[], page: readonly CRMMediaFile[]): CRMMediaFile[] {
  const seen = new Set(shown.map((f) => f.id));
  return [...shown, ...page.filter((f) => !seen.has(f.id))];
}
