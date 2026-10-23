/* Tests for uploading a video for Simulive: what the picker refuses before uploading, how the
 * file is cut into parts, the progress bar, resuming from the parts already sent, retrying a
 * part, finishing parts the server says are missing, and cancelling.
 * Run with `make test-web`. */

import assert from "node:assert/strict";
import type { Recording, VideoUpload } from "./api-types.ts";
import {
  formatBytes,
  missingParts,
  partRange,
  progressPercent,
  resumeKey,
  titleFromFilename,
  uploadVideo,
  videoFileProblem,
  type KeyStore,
  type UploadDeps,
} from "./video-uploader.ts";

// ---- the picker's own checks
assert.equal(videoFileProblem({ name: "talk.mp4", size: 10, type: "video/mp4" }), null);
assert.equal(videoFileProblem({ name: "Talk.MOV", size: 10, type: "video/quicktime" }), null);
assert.match(videoFileProblem({ name: "talk.webm", size: 10, type: "video/webm" }) ?? "", /MP4 with H\.264/);
assert.match(videoFileProblem({ name: "talk.avi", size: 10, type: "" }) ?? "", /MP4 or MOV/);
assert.match(videoFileProblem({ name: "talk.mp4", size: 0, type: "" }) ?? "", /empty/);
assert.match(videoFileProblem({ name: "talk.mp4", size: 5 * 1024 ** 3, type: "" }) ?? "", /up to 4 GB/);
assert.equal(formatBytes(1.5 * 1024 ** 3), "1.5 GB");
assert.equal(formatBytes(820 * 1024 ** 2), "820 MB");
assert.equal(titleFromFilename("Launch talk.final.mp4"), "Launch talk.final");
assert.equal(titleFromFilename(".mp4"), "Uploaded video");

// ---- cutting and counting
assert.deepEqual(partRange(1, 10, 25), [0, 10]);
assert.deepEqual(partRange(3, 10, 25), [20, 25]);
assert.deepEqual(missingParts(5, [2, 4]), [1, 3, 5]);
assert.deepEqual(missingParts(2, null), [1, 2]);
assert.equal(progressPercent(100, 50, [10, 5]), 65);
// Never 100 before the server has said yes.
assert.equal(progressPercent(100, 100), 99);
assert.equal(progressPercent(0, 0), 0);
assert.equal(resumeKey({ name: "a.mp4", size: 3, lastModified: 7 }), "video-upload:a.mp4:3:7");

// ---- the orchestration, against a fake server and bucket

const SIZE = 25;
const PART = 10;
const file = {
  name: "Launch.mp4",
  size: SIZE,
  type: "video/mp4",
  lastModified: 1,
  slice: (a: number, b: number) => new Blob([new Uint8Array(b - a).fill(a)]),
};

class MemStore implements KeyStore {
  m = new Map<string, string>();
  getItem(k: string) {
    return this.m.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.m.set(k, v);
  }
  removeItem(k: string) {
    this.m.delete(k);
  }
}

function fakeServer(opts: { failPutOnce?: number; dropOnComplete?: number; existing?: number[] } = {}) {
  const bucket = new Map<number, number>(); // part -> bytes
  for (const n of opts.existing ?? []) bucket.set(n, n === 3 ? 5 : PART);
  const calls: string[] = [];
  let failed = false;
  let dropped = false;
  const view = (id: string): VideoUpload => ({
    id,
    filename: file.name,
    title: "Launch",
    sizeBytes: SIZE,
    partSize: PART,
    partCount: 3,
    uploadedParts: [...bucket.keys()].sort(),
    createdAt: "",
  });
  const deps: UploadDeps = {
    start: async () => {
      calls.push("start");
      return view("up-1");
    },
    status: async (id) => {
      calls.push(`status:${id}`);
      if (id !== "up-1") throw Object.assign(new Error("gone"), { code: "not_found" });
      return view(id);
    },
    partURLs: async (_id, parts) => {
      calls.push(`urls:${parts.join(",")}`);
      return parts.map((part) => ({ part, url: `https://bucket/${part}` }));
    },
    put: async (url, body, onProgress) => {
      const n = Number(url.split("/").pop());
      if (opts.failPutOnce === n && !failed) {
        failed = true;
        throw new Error("dropped");
      }
      onProgress(body.size / 2);
      onProgress(body.size);
      bucket.set(n, body.size);
      calls.push(`put:${n}`);
    },
    complete: async (id, title) => {
      calls.push(`complete:${title ?? ""}`);
      if (opts.dropOnComplete && !dropped) {
        dropped = true;
        bucket.delete(opts.dropOnComplete);
        throw Object.assign(new Error("missing"), { code: "incomplete" });
      }
      assert.equal(bucket.size, 3);
      return { id, source: "upload", topic: title ?? "Launch" } as Recording;
    },
    store: new MemStore(),
    sleep: async () => {},
  };
  return { deps, calls, bucket };
}

{
  // A whole upload: every part once, progress climbing to 99, the title read at the end.
  const { deps, calls } = fakeServer();
  const seen: number[] = [];
  let title = "Launch";
  let started = "";
  const rec = await uploadVideo(file, deps, {
    signal: new AbortController().signal,
    title: () => title,
    onStarted: (id) => {
      started = id;
      title = "Launch (final)";
    },
    onProgress: (p) => seen.push(p.percent),
    concurrency: 2,
  });
  assert.equal(started, "up-1");
  assert.equal(rec.topic, "Launch (final)");
  assert.deepEqual(calls.filter((c) => c.startsWith("put")).sort(), ["put:1", "put:2", "put:3"]);
  assert.equal(calls.filter((c) => c.startsWith("urls")).length, 1, "one batch of addresses");
  assert.equal(seen.at(-1), 99);
  assert.ok(seen.every((p, i) => i === 0 || p >= seen[i - 1]), `progress went backwards: ${seen}`);
  // Finished: nothing left to resume.
  assert.equal((deps.store as MemStore).m.size, 0);
}

{
  // Choosing the same file again resumes: only the parts the bucket lacks are sent.
  const { deps, calls } = fakeServer({ existing: [1, 3] });
  (deps.store as MemStore).setItem(resumeKey(file), "up-1");
  await uploadVideo(file, deps, { signal: new AbortController().signal });
  assert.ok(!calls.includes("start"), "resumed, not restarted");
  assert.deepEqual(calls.filter((c) => c.startsWith("put")), ["put:2"]);
}

{
  // A remembered upload the server no longer has: start again.
  const { deps, calls } = fakeServer();
  (deps.store as MemStore).setItem(resumeKey(file), "up-old");
  await uploadVideo(file, deps, { signal: new AbortController().signal });
  assert.deepEqual(calls.slice(0, 2), ["status:up-old", "start"]);
}

{
  // A part that fails is retried on its own, with a fresh address.
  const { deps, calls } = fakeServer({ failPutOnce: 2 });
  await uploadVideo(file, deps, { signal: new AbortController().signal, concurrency: 1 });
  assert.deepEqual(calls.filter((c) => c.startsWith("put")), ["put:1", "put:2", "put:3"]);
  assert.ok(calls.includes("urls:2"), `re-asked for part 2's address: ${calls}`);
}

{
  // Complete says a part is missing: send it and complete again.
  const { deps, calls } = fakeServer({ dropOnComplete: 3 });
  await uploadVideo(file, deps, { signal: new AbortController().signal });
  assert.equal(calls.filter((c) => c === "put:3").length, 2);
  assert.equal(calls.filter((c) => c.startsWith("complete")).length, 2);
}

{
  // A refused file is forgotten here too; cancel stops before anything is sent.
  const { deps } = fakeServer();
  deps.complete = async () => {
    throw Object.assign(new Error("HEVC"), { code: "unsupported_video" });
  };
  await assert.rejects(uploadVideo(file, deps, { signal: new AbortController().signal }), /HEVC/);
  assert.equal((deps.store as MemStore).m.size, 0);

  const ctl = new AbortController();
  const { deps: d2, calls } = fakeServer();
  ctl.abort();
  await assert.rejects(uploadVideo(file, d2, { signal: ctl.signal }), (e: Error) => e.name === "AbortError");
  assert.ok(!calls.some((c) => c.startsWith("put")));
}

console.log("video-uploader: ok");
