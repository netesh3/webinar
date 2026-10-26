/* A simulive for the load test (run.mjs --kind simulive): a generated test video uploaded the
 * way the app's uploader does it, a simulive playing it a minute from now, and the wait until
 * the server starts it. Its audience plays the file from R2 through the recordings CDN, not
 * the video box, so this measures that path (docs/LOAD-TESTING.md, scenario c). */
import { execFileSync } from "node:child_process";
import { readFileSync, statSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { webinarInput } from "./fixture.mjs";
import { sleep } from "./args.mjs";

/* ffmpegArgs(out, seconds) -> a 720p 20 fps H.264 + AAC test pattern at about the mix's bitrate
 * (~1.1 Mbit/s), keyframes every 2 s, "faststart" (the index at the front, as uploads are). */
export function ffmpegArgs(out, seconds) {
  return [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=20",
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
    "-t", String(Math.ceil(seconds)),
    "-c:v", "libx264", "-preset", "veryfast", "-b:v", "1000k", "-maxrate", "1200k", "-bufsize", "2000k", "-g", "40", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "64k",
    "-movflags", "+faststart",
    out,
  ];
}

export function makeTestVideo(seconds) {
  const dir = mkdtempSync(join(tmpdir(), "load-simulive-"));
  const out = join(dir, "load-test.mp4");
  execFileSync("ffmpeg", ffmpegArgs(out, seconds), { stdio: ["ignore", "ignore", "inherit"] });
  return out;
}

/** The parts of a file of `size` bytes cut at `partSize`: [{ part (1-based), start, end }]. */
export function partsOf(size, partSize) {
  const out = [];
  for (let start = 0, part = 1; start < size; start += partSize, part++) out.push({ part, start, end: Math.min(size, start + partSize) });
  return out;
}

/* uploadVideo(host, file, title) -> the uploaded recording ({ id, ... }): start, part URLs in
 * batches of 100, PUT each part straight to the bucket, complete. */
export async function uploadVideo(host, file, title) {
  const size = statSync(file).size;
  const up = await host.call("POST", "/host/videos/uploads", { filename: "load-test.mp4", sizeBytes: size, mime: "video/mp4", title });
  const data = readFileSync(file);
  const parts = partsOf(size, up.partSize);
  for (let i = 0; i < parts.length; i += 100) {
    const batch = parts.slice(i, i + 100);
    const { urls } = await host.call("POST", `/host/videos/uploads/${up.id}/parts`, { parts: batch.map((p) => p.part) });
    for (const u of urls) {
      const p = batch.find((x) => x.part === u.part);
      const r = await fetch(u.url, { method: "PUT", body: data.subarray(p.start, p.end) });
      if (!r.ok) throw new Error(`upload part ${u.part}: HTTP ${r.status}`);
    }
  }
  return host.call("POST", `/host/videos/uploads/${up.id}/complete`, { title });
}

/** A simulive playing `recordingId`, starting `leadMs` from now (the server wants >= 1 min). */
export async function createSimulive(host, topic, recordingId, { leadMs = 75_000, attendeeLimit = 200 } = {}) {
  const input = {
    ...webinarInput(topic, { attendeeLimit }),
    kind: "simulive",
    instant: false,
    startsAt: new Date(Date.now() + leadMs).toISOString(),
    simuliveRecordingId: recordingId,
  };
  return host.call("POST", "/host/webinars", input);
}

/** Waits until the simulive is live (the tick starts it when due); resolves its status. */
export async function waitSimuliveLive(host, slug, { timeoutMs = 240_000, signal } = {}) {
  const t0 = Date.now();
  let st = null;
  while (Date.now() - t0 < timeoutMs && !signal?.aborted) {
    const wb = await host.call("GET", `/host/webinars/${slug}`).catch(() => null);
    st = wb?.status ?? st;
    if (st === "live") return st;
    await sleep(5000, signal);
  }
  return st;
}
