/* Uploading a video for Simulive, from the browser straight to the bucket.
 *
 * The server (api/internal/api/video_upload.go) starts an S3 multipart upload and says how to
 * cut the file: PartCount parts of PartSize bytes, the last one shorter. Each part is PUT to a
 * presigned URL, a few at a time, retried on its own when it fails; the server reads back what
 * arrived (ListParts), so nothing here needs the bucket's ETags. The upload's id is remembered
 * per file in localStorage, so reopening the page and choosing the same file again carries on
 * from the parts already sent. Complete stitches the parts, and the server probes the result
 * (MP4/MOV, H.264 video, AAC or no audio) before it becomes a recording.
 *
 * The orchestration is pure over the deps it is given, so it is tested on its own
 * (video-uploader.test.mts); the component passes the real API and an XHR PUT. */

import type {
  Recording,
  StartVideoUploadRequest,
  VideoUpload,
  VideoUploadPartURL,
} from "./api-types.ts";

/** What the file picker offers. The server's probe is what decides. */
export const VIDEO_ACCEPT = ".mp4,.m4v,.mov,video/mp4,video/quicktime";

/** The largest upload (types.MaxVideoUploadBytes). */
export const MAX_VIDEO_BYTES = 4 * 1024 ** 3;

export type FileLike = {
  name: string;
  size: number;
  type: string;
  lastModified: number;
  slice(start: number, end: number): Blob;
};

/** A reason not to start the upload at all, or null. */
export function videoFileProblem(
  file: Pick<FileLike, "name" | "size" | "type">,
  maxBytes = MAX_VIDEO_BYTES,
): string | null {
  const ext = file.name.toLowerCase().match(/\.[a-z0-9]+$/)?.[0] ?? "";
  if (ext === ".webm" || ext === ".mkv" || file.type === "video/webm") {
    return "WebM and MKV files don't play in every browser. Export it as an MP4 with H.264 video and AAC audio and upload that.";
  }
  if (![".mp4", ".m4v", ".mov"].includes(ext)) {
    return "Upload an MP4 or MOV file (H.264 video, AAC audio).";
  }
  if (file.size <= 0) return "That file is empty.";
  if (file.size > maxBytes) {
    return `Videos can be up to ${formatBytes(maxBytes)}. This one is ${formatBytes(file.size)}: export a smaller file and try again.`;
  }
  return null;
}

/** "1.4 GB", "820 MB", "12 KB". */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0 MB";
  if (n >= 1024 ** 3) {
    const gb = n / 1024 ** 3;
    return `${gb >= 10 ? Math.round(gb) : Math.round(gb * 10) / 10} GB`;
  }
  if (n >= 1024 ** 2) return `${Math.round(n / 1024 ** 2)} MB`;
  return `${Math.max(1, Math.round(n / 1024))} KB`;
}

/** The title an upload starts with: the file's name without its extension. */
export function titleFromFilename(name: string): string {
  return name.replace(/\.[^.]+$/, "").trim() || "Uploaded video";
}

/** Bytes [start, end) of part (1-based). */
export function partRange(part: number, partSize: number, size: number): [number, number] {
  const start = (part - 1) * partSize;
  return [start, Math.min(start + partSize, size)];
}

/** The parts still to send, in order. */
export function missingParts(partCount: number, uploaded: readonly number[] | null | undefined): number[] {
  const have = new Set(uploaded ?? []);
  const out: number[] = [];
  for (let n = 1; n <= partCount; n++) if (!have.has(n)) out.push(n);
  return out;
}

/** Whole percent sent: finished bytes plus what the parts in flight have sent so far. Never
 *  100 until the server has the file (the caller shows "Checking the video…" then). */
export function progressPercent(totalBytes: number, doneBytes: number, inFlight: Iterable<number> = []): number {
  if (totalBytes <= 0) return 0;
  let sent = doneBytes;
  for (const b of inFlight) sent += b;
  return Math.max(0, Math.min(99, Math.floor((sent / totalBytes) * 100)));
}

/** The localStorage key remembering a file's upload: the same file, chosen again, resumes. */
export function resumeKey(file: Pick<FileLike, "name" | "size" | "lastModified">): string {
  return `video-upload:${file.name}:${file.size}:${file.lastModified}`;
}

export type KeyStore = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export type UploadDeps = {
  start(body: StartVideoUploadRequest): Promise<VideoUpload>;
  status(id: string): Promise<VideoUpload>;
  partURLs(id: string, parts: number[]): Promise<VideoUploadPartURL[]>;
  complete(id: string, title?: string): Promise<Recording>;
  /** PUT one part, reporting bytes sent so far. Rejects on a non-2xx answer. */
  put(url: string, body: Blob, onProgress: (loaded: number) => void, signal: AbortSignal): Promise<void>;
  store?: KeyStore | null;
  sleep?: (ms: number) => Promise<void>;
};

export type UploadProgress = { percent: number; sentBytes: number; totalBytes: number };

export type UploadOptions = {
  title?: string | (() => string);
  signal: AbortSignal;
  onProgress?: (p: UploadProgress) => void;
  /** The upload's id, once known: what Cancel deletes. */
  onStarted?: (id: string) => void;
  concurrency?: number;
  /** Tries per part before the upload gives up. */
  partTries?: number;
};

const URL_BATCH = 20;
const COMPLETE_ROUNDS = 3;

function codeOf(e: unknown): string | undefined {
  return typeof e === "object" && e !== null && "code" in e ? String((e as { code: unknown }).code) : undefined;
}

function abortError(): Error {
  const e = new Error("Upload cancelled");
  e.name = "AbortError";
  return e;
}

function safe(store: KeyStore | null | undefined, fn: (s: KeyStore) => void) {
  if (!store) return;
  try {
    fn(store);
  } catch {
    // Private mode: no resume, the upload itself is unaffected.
  }
}

/** Resumes the file's earlier upload when the server still has it, else starts a new one. */
async function begin(file: FileLike, deps: UploadDeps, title: string | undefined): Promise<VideoUpload> {
  const key = resumeKey(file);
  let saved: string | null = null;
  safe(deps.store, (s) => (saved = s.getItem(key)));
  if (saved) {
    try {
      const up = await deps.status(saved);
      if (up.sizeBytes === file.size) return up;
    } catch {
      // Finished, cancelled or expired: start again.
    }
    safe(deps.store, (s) => s.removeItem(key));
  }
  const up = await deps.start({ filename: file.name, sizeBytes: file.size, mime: file.type, title });
  safe(deps.store, (s) => s.setItem(key, up.id));
  return up;
}

/** Uploads file and returns the recording it became. Rejects with name "AbortError" when
 *  signal fires; the caller then cancels the upload (cancelVideoUpload) if it means to. */
export async function uploadVideo(file: FileLike, deps: UploadDeps, opts: UploadOptions): Promise<Recording> {
  const { signal } = opts;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const titleNow = () => (typeof opts.title === "function" ? opts.title() : opts.title)?.trim() || undefined;
  const concurrency = Math.max(1, opts.concurrency ?? 4);
  const tries = Math.max(1, opts.partTries ?? 4);

  let up = await begin(file, deps, titleNow());
  if (signal.aborted) throw abortError();
  opts.onStarted?.(up.id);

  const partBytes = (n: number) => {
    const [a, b] = partRange(n, up.partSize, up.sizeBytes);
    return b - a;
  };
  let done = new Set(up.uploadedParts ?? []);
  const inFlight = new Map<number, number>();
  const report = () => {
    let doneBytes = 0;
    for (const n of done) doneBytes += partBytes(n);
    const flying = [...inFlight.values()];
    opts.onProgress?.({
      percent: progressPercent(up.sizeBytes, doneBytes, flying),
      sentBytes: doneBytes + flying.reduce((a, b) => a + b, 0),
      totalBytes: up.sizeBytes,
    });
  };
  report();

  for (let round = 0; ; round++) {
    const todo = missingParts(up.partCount, [...done]);
    const urls = new Map<number, string>();
    let next = 0;

    // One request for addresses at a time: the workers wait for a batch already on its way.
    let asking: Promise<void> | null = null;
    const urlFor = async (n: number): Promise<string> => {
      for (let i = 0; i < 3 && !urls.has(n); i++) {
        if (asking) {
          await asking;
          continue;
        }
        // The next batch of parts still to send, starting with this one.
        const batch = [n, ...todo.slice(next).filter((p) => p !== n && !urls.has(p))].slice(0, URL_BATCH);
        asking = deps.partURLs(up.id, batch).then((list) => {
          for (const u of list) urls.set(u.part, u.url);
        });
        try {
          await asking;
        } finally {
          asking = null;
        }
      }
      const got = urls.get(n);
      if (!got) throw new Error(`No upload address for part ${n}.`);
      return got;
    };

    const sendPart = async (n: number) => {
      const [a, b] = partRange(n, up.partSize, up.sizeBytes);
      for (let attempt = 1; ; attempt++) {
        if (signal.aborted) throw abortError();
        try {
          const url = await urlFor(n);
          inFlight.set(n, 0);
          await deps.put(url, file.slice(a, b), (loaded) => {
            inFlight.set(n, Math.min(loaded, b - a));
            report();
          }, signal);
          inFlight.delete(n);
          done.add(n);
          report();
          return;
        } catch (e) {
          inFlight.delete(n);
          if (signal.aborted) throw abortError();
          if (attempt >= tries) throw e;
          // A fresh address too, in case this one expired.
          urls.delete(n);
          await sleep(1000 * 2 ** (attempt - 1));
        }
      }
    };

    const worker = async () => {
      while (next < todo.length) {
        const n = todo[next++];
        await sendPart(n);
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, todo.length) }, worker));
    if (signal.aborted) throw abortError();

    try {
      const rec = await deps.complete(up.id, titleNow());
      safe(deps.store, (s) => s.removeItem(resumeKey(file)));
      return rec;
    } catch (e) {
      // Some part didn't land after all: ask what the bucket has and send the rest.
      if (codeOf(e) === "incomplete" && round + 1 < COMPLETE_ROUNDS) {
        up = await deps.status(up.id);
        done = new Set(up.uploadedParts ?? []);
        continue;
      }
      // The server refused the file (or it is gone): this upload can't be resumed.
      if (codeOf(e) !== "network") safe(deps.store, (s) => s.removeItem(resumeKey(file)));
      throw e;
    }
  }
}

/** Forgets the file's upload in this browser (after Cancel). */
export function forgetUpload(store: KeyStore | null | undefined, file: Pick<FileLike, "name" | "size" | "lastModified">) {
  safe(store, (s) => s.removeItem(resumeKey(file)));
}

/** PUT with upload progress, which fetch can't report. */
export function xhrPut(url: string, body: Blob, onProgress: (loaded: number) => void, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    xhr.upload.onprogress = (ev) => onProgress(ev.loaded);
    xhr.onload = () =>
      xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(`Upload failed (${xhr.status}).`));
    xhr.onerror = () => reject(new Error("The connection dropped while uploading."));
    xhr.onabort = () => reject(abortError());
    const stop = () => xhr.abort();
    signal.addEventListener("abort", stop, { once: true });
    xhr.onloadend = () => signal.removeEventListener("abort", stop);
    xhr.send(body);
  });
}
