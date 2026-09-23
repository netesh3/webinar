/* What a browser will actually give us, asked of the browser rather than guessed.
 *
 *   node e2e/probe-browser-media.mjs
 *   → open http://localhost:8971 in the browser being investigated
 *
 * Written because "the host cannot start a webinar in Safari" had four plausible causes and
 * no way to tell them apart from the outside. The pre-join screen swallowed the reason (fixed
 * in #159), and every candidate explanation — WebKit needing a user gesture, WebKit bug
 * 179363 where a second getUserMedia stops the first stream, a constraint Safari refuses, a
 * permission that is set to Ask and never asked — predicts exactly the same symptom: a button
 * that does nothing.
 *
 * So this asks. It runs the same calls lib/media.ts and components/room/prejoin.tsx make, in
 * the same order, and reports what each one did. http://localhost is a secure context in
 * every browser, so getUserMedia is available here exactly as it is on the real site.
 *
 * The one test that cannot be automated is the interesting one: the app acquires devices from
 * a React effect, which is NOT inside the click that asked for it. WebKit cares about that and
 * Chromium does not. So this runs the no-gesture attempt on load, then waits for a click and
 * runs the same attempt again. Two results, one difference, and the answer is whichever way
 * they disagree.
 *
 * Reports land in /tmp/browser-media-report-<browser>.json and are printed here. The server
 * stays up so several browsers can be compared in one sitting.
 */
import { createServer } from "node:http";
import { writeFileSync } from "node:fs";

const PORT = Number(process.env.PORT ?? 8971);

/* The capture constraints the app really uses.
 *
 * cameraCapturePreset() resolves to 1080p on a machine with 8+ cores, which every Mac that
 * runs Safari has, and createLocalVideoTrack turns a VideoPreset into ideal width/height/
 * frameRate. deviceId is undefined when the picker says "System default", and that is worth
 * sending as-is rather than tidied away: passing an explicitly-undefined member is exactly
 * the kind of thing one engine ignores and another rejects, and if that is what is happening
 * here then tidying it in the probe would hide the bug being looked for. */
const APP_VIDEO = {
  deviceId: undefined,
  width: { ideal: 1920 },
  height: { ideal: 1080 },
  frameRate: { ideal: 30 },
};
const APP_AUDIO = {
  deviceId: undefined,
  echoCancellation: true,
  noiseSuppression: false,
};

const PAGE = `<!doctype html>
<meta charset="utf-8">
<title>Media capability probe</title>
<style>
  body { font: 14px/1.5 -apple-system, system-ui, sans-serif; max-width: 46rem; margin: 3rem auto; padding: 0 1rem; }
  button { font: inherit; padding: .6rem 1.1rem; border-radius: .5rem; border: 1px solid #888; cursor: pointer; }
  pre { background: #f4f4f5; padding: 1rem; border-radius: .5rem; overflow-x: auto; white-space: pre-wrap; }
  .ok { color: #15803d; } .bad { color: #b91c1c; }
</style>
<h1>Media capability probe</h1>
<p>Step 1 has already run on page load, with no click in front of it. That is how the app
asks today.</p>
<p><button id="go">Step 2 — run the same tests from a click</button></p>
<pre id="out">running step 1…</pre>
<script type="module">
const out = document.getElementById("out");
const report = { browser: navigator.userAgent, secureContext: isSecureContext, steps: [] };

function show() { out.textContent = report.steps.map(s =>
  (s.ok ? "PASS  " : "FAIL  ") + s.name + (s.detail ? "\\n      " + s.detail : "")).join("\\n"); }

async function step(name, fn) {
  try {
    const detail = await fn();
    report.steps.push({ name, ok: true, detail: detail ?? "" });
  } catch (err) {
    report.steps.push({
      name, ok: false,
      detail: (err && err.name ? err.name + ": " : "") + (err && err.message ? err.message : String(err)),
    });
  }
  show();
}

const APP_VIDEO = ${JSON.stringify(APP_VIDEO)};
const APP_AUDIO = ${JSON.stringify(APP_AUDIO)};
// JSON.stringify drops an undefined member, so it is put back explicitly: sending the
// key with an undefined value is part of what is being tested. See the note in the probe.
APP_VIDEO.deviceId = undefined;
APP_AUDIO.deviceId = undefined;

const live = [];
function keep(stream) { live.push(stream); return stream; }
function stopAll() { for (const s of live) for (const t of s.getTracks()) t.stop(); live.length = 0; }

function describe(stream) {
  return stream.getTracks().map(t => t.kind + ":" + t.readyState + (t.label ? " (" + t.label + ")" : "")).join(", ");
}

/* Can this browser host a webinar at all, and which parts of one?
 *
 * Split into what hosting REQUIRES and what merely degrades, because the two failures look
 * nothing alike from a support request: a missing requirement means the room cannot work and
 * has to say so on the way in, while a missing extra means one control should not have been
 * offered. Every "extra" below is already feature-gated in the app; this is the list that
 * says which gates a given browser closes, so "does it work in Brave / Opera / Dia / Comet"
 * has an answer that is not somebody's recollection.
 */
function capabilities() {
  const w = window;
  const canvas = document.createElement("canvas");
  const webgl2 = !!canvas.getContext("webgl2");
  const canvasCapture =
    typeof HTMLCanvasElement !== "undefined" && "captureStream" in HTMLCanvasElement.prototype;
  const videoFrame = typeof w.VideoFrame !== "undefined";
  const trackProcessor =
    typeof w.MediaStreamTrackProcessor !== "undefined" &&
    typeof w.MediaStreamTrackGenerator !== "undefined";

  return {
    required: {
      // Without these the room cannot be entered, let alone published to.
      RTCPeerConnection: typeof w.RTCPeerConnection !== "undefined",
      getUserMedia: !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia),
      WebSocket: typeof w.WebSocket !== "undefined",
      secureContext: w.isSecureContext,
    },
    extras: {
      // lib/backgrounds.ts — virtual backgrounds and the low-light lift.
      "backgrounds+lowLight": webgl2 && videoFrame && (trackProcessor || canvasCapture),
      // lib/file-share.ts — playing a video file into the session.
      screenShare: !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia),
      // lib/recorder.ts — local recording.
      mediaRecorder: typeof w.MediaRecorder !== "undefined" && canvasCapture,
      // lib/noise-suppression.ts
      noiseSuppression: typeof w.AudioWorkletNode !== "undefined",
      // lib/pip.ts — pop-out picture-in-picture.
      documentPiP: typeof w.documentPictureInPicture !== "undefined",
    },
    detail: { webgl2, videoFrame, trackProcessor, canvasCapture },
  };
}

async function suite(phase) {
  await step(phase + " · can this browser host?", async () => {
    const caps = capabilities();
    report.capabilities = caps;
    const missing = Object.entries(caps.required)
      .filter(([, v]) => !v)
      .map(([k]) => k);
    if (missing.length) throw new Error("cannot host — missing " + missing.join(", "));
    const off = Object.entries(caps.extras)
      .filter(([, v]) => !v)
      .map(([k]) => k);
    return (
      "all requirements met" +
      (off.length ? "; features unavailable here: " + off.join(", ") : "; every feature available")
    );
  });

  await step(phase + " · enumerateDevices before any permission", async () => {
    const all = await navigator.mediaDevices.enumerateDevices();
    const withId = all.filter(d => d.deviceId);
    return all.length + " entries, " + withId.length + " with a deviceId, " +
      all.filter(d => d.label).length + " with a label" +
      "  [app would show " + all.filter(d => d.kind === "videoinput" && d.deviceId).length + " cameras]";
  });

  // The microphone alone, with the app's own constraints. What prejoin's startAudio does.
  await step(phase + " · getUserMedia(audio) — the app's constraints", async () =>
    describe(keep(await navigator.mediaDevices.getUserMedia({ audio: APP_AUDIO }))));

  // The camera alone, WHILE the microphone is live. This is WebKit bug 179363: on the
  // affected versions the second call stops the first stream instead of adding to it.
  await step(phase + " · getUserMedia(video) while the mic is already live", async () =>
    describe(keep(await navigator.mediaDevices.getUserMedia({ video: APP_VIDEO }))));

  await step(phase + " · is the microphone still live after that?", async () => {
    const audio = live.flatMap(s => s.getAudioTracks());
    const dead = audio.filter(t => t.readyState !== "live");
    if (dead.length) throw new Error("the second getUserMedia stopped the first stream — WebKit bug 179363");
    return audio.length + " audio track(s) still live";
  });

  stopAll();

  // Both at once, which is what a single permission prompt looks like.
  await step(phase + " · getUserMedia(audio + video) in one call", async () =>
    describe(keep(await navigator.mediaDevices.getUserMedia({ audio: APP_AUDIO, video: APP_VIDEO }))));

  await step(phase + " · enumerateDevices after permission", async () => {
    const all = await navigator.mediaDevices.enumerateDevices();
    return all.filter(d => d.deviceId).length + " with a deviceId, " +
      all.filter(d => d.label).length + " with a label";
  });

  stopAll();
}

async function send() {
  try {
    await fetch("/report", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(report),
    });
  } catch {}
}

/* How many WebGL2 contexts this browser will hold, and whether releasing them helps.
 *
 * This is the one that explains "Couldn't start the background: Cannot read properties of
 * null (reading 'alpha')". MediaPipe's emscripten glue reads getContextAttributes().alpha,
 * and getContextAttributes() returns null on a lost context — so that TypeError is a
 * context-loss report wearing a disguise. lib/segmenter.ts builds a context per processor
 * and, until this was found, never handed one back, so a presenter toggling the low-light
 * lift walked towards the browser's ceiling one click at a time.
 *
 * Both halves are measured, because the first without the second is only half an argument:
 * how many leak before one is lost, and then whether loseContext() keeps it from happening.
 */
await step("webgl2 context budget — leaked (how it was)", async () => {
  const held = [];
  let lostAt = 0;
  for (let i = 1; i <= 24; i++) {
    const gl = document.createElement("canvas").getContext("webgl2");
    if (!gl) { lostAt = i; break; }
    held.push(gl);
    // A lost context still returns an object. These two are how you find out, and the
    // second is the exact call MediaPipe makes.
    if (gl.isContextLost() || gl.getContextAttributes() === null) { lostAt = i; break; }
    // And the ones already held can be taken instead of the new one being refused.
    const casualty = held.findIndex(c => c.isContextLost() || c.getContextAttributes() === null);
    if (casualty !== -1) { lostAt = i; break; }
  }
  for (const gl of held) gl.getExtension("WEBGL_lose_context")?.loseContext();
  if (lostAt) throw new Error("a context was lost at #" + lostAt + " of 24 — this is the ceiling the bug walks into");
  return "held 24 contexts without a loss (this machine's ceiling is higher than 24)";
});

await step("webgl2 context budget — released each time (the fix)", async () => {
  for (let i = 1; i <= 60; i++) {
    const gl = document.createElement("canvas").getContext("webgl2");
    if (!gl) throw new Error("getContext returned null at #" + i + " even when releasing");
    if (gl.isContextLost() || gl.getContextAttributes() === null) {
      throw new Error("lost at #" + i + " despite releasing — releasing is not sufficient");
    }
    gl.getExtension("WEBGL_lose_context")?.loseContext();
  }
  return "60 contexts created and released, none lost";
});

// Step 1: on load, with no user gesture in front of it — the app's current behaviour.
await suite("no-gesture");
await send();

document.getElementById("go").addEventListener("click", async () => {
  report.steps.push({ name: "— clicked —", ok: true, detail: "" });
  await suite("from-a-click");
  await send();
  out.textContent += "\\n\\nSent. You can close this tab.";
});
</script>`;

const server = createServer((req, res) => {
  if (req.method === "POST" && req.url === "/report") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.writeHead(204).end();
      let report;
      try {
        report = JSON.parse(body);
      } catch {
        console.log("(unreadable report)");
        return;
      }
      const ua = report.browser ?? "";
      // Order matters: every one of these claims to be Safari, and Safari is the only one
      // that claims to be none of the others.
      const name = /Firefox/.test(ua)
        ? "firefox"
        : /OPR\//.test(ua)
          ? "opera"
          : /Edg\//.test(ua)
            ? "edge"
            : /Chrome/.test(ua)
              ? "chromium"
              : /Safari/.test(ua)
                ? "safari"
                : "unknown";
      const path = `/tmp/browser-media-report-${name}.json`;
      writeFileSync(path, JSON.stringify(report, null, 2));
      console.log(`\n===== ${name} =====`);
      console.log(ua);
      console.log(`secure context: ${report.secureContext}`);
      for (const s of report.steps ?? []) {
        console.log(`${s.ok ? "PASS" : "FAIL"}  ${s.name}${s.detail ? `\n      ${s.detail}` : ""}`);
      }
      console.log(`\nwritten to ${path}`);
    });
    return;
  }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(PAGE);
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`probe listening on http://localhost:${PORT}`);
  console.log("open that in the browser being investigated, then click the button.");
});
