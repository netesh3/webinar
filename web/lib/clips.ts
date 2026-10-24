/* Clips and reels made from a recording, the pure half: what the formats, framings and
 * platforms are called, what a clip's status says, whether a reel's moments make a reel, and
 * a post as it is copied. The making is the video server's (api/internal/api/clip_jobs.go).
 *
 *   node --experimental-strip-types --no-warnings lib/clips.test.mts */
import {
  ClipFormatSquare,
  ClipFormatVertical,
  ClipFormatWide,
  ClipFramingCenter,
  ClipFramingFit,
  ClipFramingLeft,
  ClipFramingRight,
  ClipPlatformLinkedIn,
  ClipPlatformReels,
  ClipPlatformShorts,
  ClipPlatformTikTok,
  ClipPlatformYouTube,
  ReelMaxMoments,
  ReelMinMoments,
} from "./api-types.ts";
import type { Clip, ClipPost, ClipRange, ClipServer } from "./api-types.ts";

export const CLIP_FORMATS: { id: string; label: string; where: string }[] = [
  { id: ClipFormatVertical, label: "9:16 vertical", where: "Reels, Shorts, TikTok" },
  { id: ClipFormatSquare, label: "1:1 square", where: "LinkedIn, Instagram feed" },
  { id: ClipFormatWide, label: "16:9 wide", where: "YouTube, LinkedIn" },
];

export function formatLabel(id: string): string {
  return CLIP_FORMATS.find((f) => f.id === id)?.label ?? id;
}

/** How the recording fills a vertical or square frame. The recording is one picture of the
 *  session as the audience saw it, so the host picks where the speaker is. */
export const CLIP_FRAMINGS: { id: string; label: string; hint: string }[] = [
  {
    id: ClipFramingFit,
    label: "Whole picture",
    hint: "Everything on screen, over a blurred copy of itself. Safe for slides and screen shares.",
  },
  {
    id: ClipFramingCenter,
    label: "Fill: middle",
    hint: "Crops to the middle of the picture. Best when one camera fills the screen.",
  },
  {
    id: ClipFramingLeft,
    label: "Fill: left side",
    hint: "Crops to the left of the picture.",
  },
  {
    id: ClipFramingRight,
    label: "Fill: right side",
    hint: "Crops to the right, where the speaker sits beside a screen share in the side-by-side layout.",
  },
];

export const PLATFORM_LABELS: Record<string, string> = {
  [ClipPlatformReels]: "Instagram Reels",
  [ClipPlatformShorts]: "YouTube Shorts",
  [ClipPlatformTikTok]: "TikTok",
  [ClipPlatformLinkedIn]: "LinkedIn",
  [ClipPlatformYouTube]: "YouTube",
};

/** A post as it is pasted: the title (where there is one), the text, then the hashtags. */
export function postText(p: ClipPost): string {
  const parts: string[] = [];
  if (p.title) parts.push(p.title);
  parts.push(p.text);
  if (p.hashtags.length) parts.push(p.hashtags.map((t) => `#${t}`).join(" "));
  return parts.join("\n\n");
}

/** What a clip's status reads as, with a badge tone. */
export function clipBadge(c: Clip): { text: string; tone: "neutral" | "brand" | "ok" | "warn" | "live" } {
  switch (c.status) {
    case "ready":
      return { text: "Ready", tone: "ok" };
    case "processing":
      return { text: c.progress > 0 ? `Making… ${c.progress}%` : "Making…", tone: "brand" };
    case "failed":
      return { text: "Couldn't be made", tone: "live" };
    default:
      return { text: "Waiting", tone: "neutral" };
  }
}

/** Whether the list should be looked at again soon: something waiting or being made. */
export function clipsPending(clips: Clip[]): boolean {
  return clips.some((c) => c.status === "queued" || c.status === "processing");
}

/** The line over the list while clips wait, or null when none do. */
export function waitingText(clips: Clip[], server: ClipServer): string | null {
  return clips.some((c) => c.status === "queued") ? server.text : null;
}

/** Why a reel's moments do not make a reel, or null when they do (the server's rules). */
export function reelProblem(ranges: ClipRange[]): string | null {
  if (ranges.length < ReelMinMoments || ranges.length > ReelMaxMoments) {
    return `A reel stitches ${ReelMinMoments} to ${ReelMaxMoments} moments.`;
  }
  let total = 0;
  for (const r of ranges) {
    const d = r.endSec - r.startSec;
    if (d < 2 || d > 30) return "Each moment of a reel has to be 2 to 30 seconds long.";
    total += d;
  }
  if (total < 10 || total > 90) return "A reel has to be 10 to 90 seconds long in all (30 to 60 works best).";
  return null;
}

/** A reel's or clip's length from its ranges. */
export function rangesLength(ranges: ClipRange[]): number {
  return ranges.reduce((acc, r) => acc + Math.max(0, r.endSec - r.startSec), 0);
}

/** Bytes as "12.3 MB". */
export function sizeText(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
