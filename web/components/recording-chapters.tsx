"use client";

import { formatChapterTime, type PlayerChapter } from "@/lib/recap";

/* The AI recap's chapters under a recording: each one jumps the player to where that part
 * of the session starts. The times are the recording's own (lib/recap.ts chapterSeekTimes),
 * so they match the player's clock rather than the session's. */
export function RecordingChapters({
  chapters,
  onSeek,
}: {
  chapters: PlayerChapter[];
  onSeek: (sec: number) => void;
}) {
  if (chapters.length === 0) return null;
  return (
    <div className="border-t border-line px-4 py-3">
      <p className="mb-1.5 text-[12px] font-semibold tracking-wide text-ink-3 uppercase">
        Chapters <span className="font-normal normal-case">· by AI</span>
      </p>
      <ol className="grid gap-0.5 sm:grid-cols-2">
        {chapters.map((c) => (
          <li key={`${c.startSec}-${c.title}`}>
            <button
              type="button"
              onClick={() => onSeek(c.startSec)}
              className="flex w-full items-baseline gap-3 rounded-md px-2 py-1 text-left text-[13px] text-ink-2 hover:bg-surface-2 hover:text-ink"
            >
              <span className="w-14 shrink-0 font-mono text-[12px] text-brand">{formatChapterTime(c.startSec)}</span>
              <span className="min-w-0 truncate">{c.title}</span>
            </button>
          </li>
        ))}
      </ol>
    </div>
  );
}
