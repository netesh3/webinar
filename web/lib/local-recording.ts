"use client";

import type { RecordingTransport } from "./recorder";

/* Recording straight to the host's own disk, instead of through the server.
 *
 * Implements the same RecordingTransport shape lib/recorder.ts already uses for
 * the cloud path — SessionRecorder does not know or care which one it was
 * handed, see recording.tsx, which picks one at the moment "Record" is
 * pressed. Every chunk is written to a file the host chose via the browser's
 * own save dialog; nothing here ever reaches the network, which is the whole
 * point of offering it.
 *
 * The File System Access API (showSaveFilePicker) is Chrome/Edge only as of
 * when this was written — no Firefox or Safari implementation — so the types
 * below are declared locally with `unknown` casts at the one point they touch
 * `window`, rather than assuming a global ambient declaration this project's
 * TypeScript lib may or may not already ship.
 */

type SaveFilePickerOptions = {
  suggestedName?: string;
  types?: { description: string; accept: Record<string, string[]> }[];
};

type WritableFileStream = {
  write(data: Blob): Promise<void>;
  close(): Promise<void>;
};

type FileHandle = {
  createWritable(): Promise<WritableFileStream>;
};

type ShowSaveFilePicker = (
  options?: SaveFilePickerOptions,
) => Promise<FileHandle>;

function showSaveFilePicker(): ShowSaveFilePicker | undefined {
  return (window as unknown as { showSaveFilePicker?: ShowSaveFilePicker })
    .showSaveFilePicker;
}

/** Whether this browser can save a recording locally at all. The record
 *  control hides "This device" rather than offering a button that throws. */
export function canRecordLocally(): boolean {
  return typeof window !== "undefined" && typeof showSaveFilePicker() === "function";
}

function extensionFor(mime: string): "mp4" | "webm" {
  return mime.includes("mp4") ? "mp4" : "webm";
}

/**
 * Builds a transport that writes every chunk into a file the host picks.
 *
 * The save dialog is shown by `start`, not by this function — `start` runs
 * from inside SessionRecorder.start(), which is the first `await` reachable
 * from the click on Record with nothing awaited before it. showSaveFilePicker
 * requires that unbroken chain back to a user gesture; calling it any earlier
 * (e.g. here, before the caller has necessarily just been clicked) risks
 * Chrome refusing it as not user-initiated.
 */
export function localRecordingTransport(suggestedName: string): RecordingTransport {
  let writable: WritableFileStream | null = null;

  return {
    start: async (mime) => {
      const picker = showSaveFilePicker();
      if (!picker) {
        throw new Error("This browser can't save a recording to your device.");
      }
      const ext = extensionFor(mime);
      const handle = await picker({
        suggestedName: `${suggestedName}.${ext}`,
        types: [
          {
            description: ext === "mp4" ? "MP4 video" : "WebM video",
            accept: { [mime.split(";")[0]]: [`.${ext}`] },
          },
        ],
      });
      writable = await handle.createWritable();
      // No server row, so no server-issued id — a fixed placeholder is enough:
      // SessionRecorder only ever threads it back into chunk()/complete() below.
      return { id: "local" };
    },
    chunk: async (_id, blob) => {
      if (!writable) throw new Error("The local file isn't open.");
      await writable.write(blob);
    },
    complete: async () => {
      const w = writable;
      writable = null;
      await w?.close();
    },
  };
}
