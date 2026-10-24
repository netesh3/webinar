/* A cloud recording during a load test (run.mjs --record), and the proof that it is a file
 * someone could play (docs/LOAD-TESTING.md):
 *
 *   grant          admin PATCH /admin/users/{id}/features {feature:"cloud_recording", enabled:true}
 *   start          host  POST /host/webinars/{slug}/recordings {}          -> Recording (201)
 *   stop           host  POST /host/webinars/{slug}/recordings/{id}/complete?durationMs=N
 *   ready          host  GET  /host/webinars/{slug}/recordings  until status "ready" (or failed)
 *   playable       host  GET  /host/webinars/{slug}/recordings/{id}/file  with Range: bytes=0-4095
 *                  (a redirect to the CDN / a presigned URL is followed) -> MP4 or WebM bytes
 *
 * The recording goes when the webinar is deleted at cleanup. */
import { sleep, stamp } from "./args.mjs";
import { timed } from "./client.mjs";

export async function grantCloudRecording(admin, userId) {
  await admin.call("PATCH", `/admin/users/${userId}/features`, { feature: "cloud_recording", enabled: true });
}

/** Starts a cloud recording. Resolves { id, startedAt, rec }. */
export async function startRecording(host, slug) {
  const rec = await host.call("POST", `/host/webinars/${slug}/recordings`, {});
  return { id: rec.id, startedAt: Date.now(), rec };
}

export async function stopRecording(host, slug, id, durationMs) {
  return host.call("POST", `/host/webinars/${slug}/recordings/${id}/complete?durationMs=${Math.max(0, Math.round(durationMs))}`, undefined, {
    okStatuses: [404],
  });
}

/** Polls the host's list until the recording is ready or failed (or timeoutMs). Resolves the row (or null). */
export async function waitReady(host, slug, id, { timeoutMs = 600_000, everyMs = 5000, log = console.log } = {}) {
  const t0 = Date.now();
  let row = null;
  let said = "";
  while (Date.now() - t0 < timeoutMs) {
    const list = (await host.call("GET", `/host/webinars/${slug}/recordings`).catch(() => null)) ?? [];
    row = (Array.isArray(list) ? list : []).find((r) => r.id === id) ?? row;
    if (row && (row.status === "ready" || row.status === "failed")) return row;
    const now = `${row?.status ?? "missing"}${row?.uploadPercent ? ` ${row.uploadPercent}%` : ""}`;
    if (now !== said) log(`${stamp()} recording ${id}: ${now}`);
    said = now;
    await sleep(everyMs);
  }
  return row;
}

/** What the first bytes are: "mp4" (an ftyp/moov/moof box), "webm" (EBML), or "". */
export function sniffMedia(buf) {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf ?? []);
  if (b.length >= 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return "webm";
  if (b.length >= 8) {
    const box = String.fromCharCode(b[4], b[5], b[6], b[7]);
    if (["ftyp", "moov", "moof", "styp", "free", "mdat"].includes(box)) return "mp4";
  }
  return "";
}

/** Range GET of the file: { status, bytes, kind, redirected, url } (no body kept). */
export async function probePlayable(host, slug, id) {
  const r = await timed(`${host.api}/host/webinars/${slug}/recordings/${id}/file`, {
    headers: { cookie: host.cookieHeader(), range: "bytes=0-4095" },
    timeoutMs: 30_000,
  });
  return {
    status: r.status,
    bytes: r.bytes ?? 0,
    kind: r.ok ? sniffMedia(r.buf) : "",
    contentType: r.headers?.get?.("content-type") ?? "",
    redirected: !!r.res?.redirected,
    url: r.res?.redirected ? String(r.res.url).split("?")[0] : "",
  };
}

/* checkRecording(row, probe, { recordedMs, tolerance }) -> { pass, checks: [{ name, pass, detail }] }.
 * Duration is "about the recorded time": within max(15 s, tolerance × recorded) either way; the
 * recorder starts a few seconds after the request and stops a few after, so exact is wrong. */
export function checkRecording(row, probe, { recordedMs, tolerance = 0.2 } = {}) {
  const checks = [];
  const add = (name, pass, detail) => checks.push({ name, pass: !!pass, detail });
  add("ready", row?.status === "ready", `status ${row?.status ?? "missing"}`);
  add("size", (row?.sizeBytes ?? 0) > 0, `${row?.sizeBytes ?? 0} bytes`);
  if (recordedMs > 0) {
    const d = row?.durationMs ?? 0;
    const slack = Math.max(15_000, recordedMs * tolerance);
    add("duration", Math.abs(d - recordedMs) <= slack, `${Math.round(d / 1000)} s recorded, expected about ${Math.round(recordedMs / 1000)} s (±${Math.round(slack / 1000)} s)`);
  }
  if (probe) {
    add("playable", (probe.status === 200 || probe.status === 206) && probe.bytes > 0 && !!probe.kind,
      `GET file -> ${probe.status}, ${probe.bytes} bytes, ${probe.kind || "unrecognised"} ${probe.contentType}${probe.redirected ? ` via ${probe.url}` : ""}`);
  }
  return { pass: checks.every((c) => c.pass), checks };
}
