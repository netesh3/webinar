/* The background's first-time download, and what the camera shows while it runs.
 *
 * Picking a background the first time costs about 18 MB: ONNX Runtime's WebAssembly (14 MB)
 * and the segmentation model (3.8 MB), both cached for thirty days after that (public/_headers).
 * Until they are here there is no person to cut out. What used to be shown meanwhile was a
 * heavy blur over the whole picture — face included — with "Applying…" and nothing to say how
 * long. To everybody it looked broken; and with no time limit on the download, a request that
 * stalled left it like that for good, with a Retry that waited on the same stalled request.
 *
 * Now:
 *   - the files are fetched here, with progress the screens can show ("Downloading
 *     background… 7 of 18 MB") and a stall timeout, so a download that stops moving fails
 *     and a Retry really fetches again;
 *   - while they arrive the camera is not blurred. What it shows depends on who can see it
 *     (LoadingView): on the pre-join screen, where only the presenter sees it, the camera as it
 *     is; in the room, where the audience does, a plain dark frame until the background is
 *     ready — the way Zoom keeps video off until its background has loaded — unless the
 *     presenter chooses to start without waiting.
 *
 * No imports, so lib/background-loading.test.mts can load it with plain Node. React's side is
 * useBackgroundDownload / useBackgroundLoadingView in lib/backgrounds.ts.
 */

// ------------------------------------------------------------------ the files

/** Uncompressed sizes of the two files, for the progress total when the response does not say
 *  (Cloudflare compresses them, and a compressed response carries no usable Content-Length —
 *  the stream reader counts decompressed bytes). lib/background-loading.test.mts checks these
 *  against public/, so an updated file cannot leave a wrong total behind. */
export const BACKGROUND_FILES = {
  runtime: { url: "/onnxruntime/ort-wasm-simd-threaded.wasm", bytes: 14_264_838 },
  model: { url: "/models/humanseg.onnx", bytes: 3_814_964 },
} as const;

/** No bytes for this long and the download is given up on. A slow connection that is still
 *  moving is never cut off; only one that has stopped. */
export const STALL_MS = 15_000;

// ------------------------------------------------------------------ progress store

export type DownloadPhase =
  | "idle" // nothing asked for yet
  | "downloading" // bytes arriving
  | "starting" // all here; the runtime and model are being set up (a second or two)
  | "ready"
  | "failed";

export type DownloadProgress = { phase: DownloadPhase; loaded: number; total: number };

const IDLE: DownloadProgress = { phase: "idle", loaded: 0, total: 0 };
let progress: DownloadProgress = IDLE;
const progressListeners = new Set<() => void>();

export function downloadProgress(): DownloadProgress {
  return progress;
}

export function setDownloadProgress(next: DownloadProgress): void {
  if (next.phase === progress.phase && next.loaded === progress.loaded && next.total === progress.total) return;
  progress = next;
  for (const l of progressListeners) l();
}

export function subscribeDownload(cb: () => void): () => void {
  progressListeners.add(cb);
  return () => progressListeners.delete(cb);
}

export const SERVER_PROGRESS = IDLE;

/** "7.2 of 18 MB", in decompressed bytes — not what crosses the network, since Cloudflare
 *  compresses the runtime about 5× (application/wasm is on its default list). The screens show
 *  a percentage, which is right either way; this is for logs and diagnostics. */
export function progressLabel(p: Pick<DownloadProgress, "loaded" | "total">): string {
  const mb = (b: number) => b / 1_000_000;
  const fmt = (v: number) => (v < 10 ? v.toFixed(1) : Math.round(v).toString());
  return `${fmt(mb(p.loaded))} of ${fmt(mb(p.total))} MB`;
}

/** 0..1, for the bar's width. */
export function progressFraction(p: Pick<DownloadProgress, "loaded" | "total">): number {
  if (!(p.total > 0)) return 0;
  return Math.min(1, Math.max(0, p.loaded / p.total));
}

// ------------------------------------------------------------------ what the camera shows

/** While the background is downloading: the camera as it is ("camera"), or a plain dark frame
 *  ("cover"). "cover" by default, so a screen that says nothing errs toward the audience not
 *  seeing the room the presenter asked to hide. */
export type LoadingView = "camera" | "cover";

let loadingView: LoadingView = "cover";
const viewListeners = new Set<() => void>();

export function backgroundLoadingView(): LoadingView {
  return loadingView;
}

export function setBackgroundLoadingView(next: LoadingView): void {
  if (next === loadingView) return;
  loadingView = next;
  for (const l of viewListeners) l();
}

export function subscribeLoadingView(cb: () => void): () => void {
  viewListeners.add(cb);
  return () => viewListeners.delete(cb);
}

// ------------------------------------------------------------------ fetching

export class DownloadStalledError extends Error {
  constructor(url: string) {
    super(`the background download stopped (${url})`);
    this.name = "DownloadStalledError";
  }
}

/**
 * A file's bytes, reporting each chunk, and failing if nothing arrives for `stallMs`.
 *
 * Through the HTTP cache like any fetch, so the second session reads it from disk. `fetchImpl`
 * and `now`-free timing (setTimeout) keep it testable under Node.
 */
export async function fetchWithProgress(
  url: string,
  opts: {
    onBytes: (loaded: number) => void;
    stallMs?: number;
    fetchImpl?: typeof fetch;
    /** Ends this download from outside — the other file of the pair failed (humanseg.ts). */
    signal?: AbortSignal;
    /** The expected size, to write the bytes straight into one buffer rather than collecting
     *  chunks and copying them (which held the file twice). Grown if the file is larger. */
    expectedBytes?: number;
  },
): Promise<Uint8Array> {
  const stallMs = opts.stallMs ?? STALL_MS;
  const doFetch = opts.fetchImpl ?? fetch;
  const controller = new AbortController();
  let stalled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  /* On a stall: abort the request, and cancel the reader as well. Aborting alone ends a real
   * fetch's body stream in today's browsers, but a pending read() that is not tied to the
   * signal would wait for ever — the very hang this exists to end — so it is not relied on. */
  const end = () => {
    controller.abort();
    void reader?.cancel().catch(() => {});
  };
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      stalled = true;
      end();
    }, stallMs);
  };
  const onOuterAbort = () => end();
  if (opts.signal?.aborted) throw new DOMException("the background download was cancelled", "AbortError");
  opts.signal?.addEventListener("abort", onOuterAbort);
  arm();
  try {
    const res = await doFetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`background download failed: HTTP ${res.status} for ${url}`);
    if (!res.body) {
      const buf = new Uint8Array(await res.arrayBuffer());
      opts.onBytes(buf.byteLength);
      return buf;
    }
    reader = res.body.getReader();
    let buf = new Uint8Array(Math.max(0, opts.expectedBytes ?? 0));
    let loaded = 0;
    for (;;) {
      arm();
      const { done, value } = await reader.read();
      // A cancelled read reports done: a stall or an outside cancel must not pass for a
      // finished file.
      if (stalled) throw new DownloadStalledError(url);
      if (opts.signal?.aborted) throw new DOMException("the background download was cancelled", "AbortError");
      if (done) break;
      if (loaded + value.byteLength > buf.byteLength) {
        const grown = new Uint8Array(Math.max(buf.byteLength * 2, loaded + value.byteLength));
        grown.set(buf.subarray(0, loaded));
        buf = grown;
      }
      buf.set(value, loaded);
      loaded += value.byteLength;
      opts.onBytes(loaded);
    }
    return loaded === buf.byteLength ? buf : buf.slice(0, loaded);
  } catch (err) {
    if (stalled) throw new DownloadStalledError(url);
    throw err;
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onOuterAbort);
  }
}
