/* Tests for lib/background-loading.ts. Run with `make test-web`. */

import { statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  BACKGROUND_FILES,
  DownloadStalledError,
  backgroundLoadingView,
  downloadProgress,
  fetchWithProgress,
  progressFraction,
  progressLabel,
  setBackgroundLoadingView,
  setDownloadProgress,
  subscribeDownload,
  subscribeLoadingView,
} from "./background-loading.ts";

let failures = 0;
let checks = 0;
function ok(condition: boolean, what: string, detail = ""): void {
  checks++;
  if (condition) return;
  failures++;
  console.log(`  FAIL  ${what}${detail ? `\n        ${detail}` : ""}`);
}

// ---- the totals match the files actually served
for (const [name, f] of Object.entries(BACKGROUND_FILES)) {
  const path = fileURLToPath(new URL(`../public${f.url}`, import.meta.url));
  const size = statSync(path).size;
  ok(size === f.bytes, `${name}: BACKGROUND_FILES.bytes matches public${f.url}`, `${f.bytes} vs ${size}`);
}

// ---- labels
ok(progressLabel({ loaded: 7_200_000, total: 18_079_802 }) === "7.2 of 18 MB", "label", progressLabel({ loaded: 7_200_000, total: 18_079_802 }));
ok(progressLabel({ loaded: 0, total: 18_079_802 }) === "0.0 of 18 MB", "label at zero");
ok(progressFraction({ loaded: 9, total: 18 }) === 0.5, "fraction");
ok(progressFraction({ loaded: 5, total: 0 }) === 0, "no total: 0, not NaN");
ok(progressFraction({ loaded: 30, total: 18 }) === 1, "never past 1");

// ---- stores
{
  let n = 0;
  const off = subscribeDownload(() => n++);
  setDownloadProgress({ phase: "downloading", loaded: 1, total: 2 });
  setDownloadProgress({ phase: "downloading", loaded: 1, total: 2 });
  ok(n === 1 && downloadProgress().loaded === 1, "progress notifies once per change");
  off();
  ok(backgroundLoadingView() === "cover", "the default loading view hides the room");
  let v = 0;
  const offV = subscribeLoadingView(() => v++);
  setBackgroundLoadingView("camera");
  setBackgroundLoadingView("camera");
  ok(v === 1 && backgroundLoadingView() === "camera", "view notifies once per change");
  setBackgroundLoadingView("cover");
  offV();
}

// ---- fetchWithProgress
function streamOf(chunks: Uint8Array[], stallAfter?: number): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream({
    pull(c) {
      if (stallAfter !== undefined && i >= stallAfter) return new Promise(() => {}); // stops sending
      if (i < chunks.length) c.enqueue(chunks[i++]!);
      else c.close();
    },
  });
}
const fakeFetch =
  (body: ReadableStream<Uint8Array> | null, status = 200): typeof fetch =>
  async (_url, init) =>
    new Promise<Response>((resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      resolve(new Response(body, { status }));
    });

{
  const seen: number[] = [];
  const out = await fetchWithProgress("/x", {
    onBytes: (n) => seen.push(n),
    fetchImpl: fakeFetch(streamOf([new Uint8Array([1, 2]), new Uint8Array([3, 4, 5])])),
  });
  ok(out.byteLength === 5 && out[4] === 5, "bytes reassembled in order");
  ok(seen.join(",") === "2,5", "progress per chunk", seen.join(","));
}
{
  const started = Date.now();
  let err: unknown = null;
  try {
    await fetchWithProgress("/stalls", {
      onBytes: () => {},
      stallMs: 200,
      fetchImpl: fakeFetch(streamOf([new Uint8Array([1]), new Uint8Array([2])], 1)),
    });
  } catch (e) {
    err = e;
  }
  const took = Date.now() - started;
  ok(err instanceof DownloadStalledError, "a download that stops sending fails as stalled", String(err));
  ok(took >= 180 && took < 2000, "after the stall time, not before and not never", `${took} ms`);
}
{
  let err: unknown = null;
  try {
    await fetchWithProgress("/missing", { onBytes: () => {}, fetchImpl: fakeFetch(null, 404) });
  } catch (e) {
    err = e;
  }
  ok(err instanceof Error && /HTTP 404/.test(err.message), "an HTTP error is an error", String(err));
}
{
  // A slow download that keeps moving is never cut off, however long it takes overall.
  let i = 0;
  const slow = new ReadableStream<Uint8Array>({
    async pull(c) {
      await new Promise((r) => setTimeout(r, 120));
      if (i++ < 4) c.enqueue(new Uint8Array([i]));
      else c.close();
    },
  });
  const out = await fetchWithProgress("/slow", { onBytes: () => {}, stallMs: 200, fetchImpl: fakeFetch(slow) });
  ok(out.byteLength === 4, "slow but moving (600 ms overall, stall limit 200 ms) completes");
}

console.log(`\n${failures === 0 ? "PASS" : "FAIL"}  ${checks - failures}/${checks} checks passed`);
process.exit(failures === 0 ? 0 : 1);
