#!/usr/bin/env node
/* Presenters for a load test: each a headless Chrome signed in as the host (or a panelist),
 * on the stage at /host/<slug>/room, publishing a looping test video and tone as its camera
 * and microphone (docs/LOAD-TESTING.md).
 *
 *   node presenter.mjs --web <web origin> --slug <slug> --email <host> --password <pw>
 *     [--api URL] [--screen-share] [--duration 10m] [--video-size 1280x720] [--fps 30] [--box-wait 6m]
 *
 * run.mjs starts presenters itself (the test host plus --presenters N-1 panelists). The test
 * video is made once with ffmpeg (testsrc2 + a 440 Hz tone, MJPEG + WAV, ~10 s, looped by
 * Chrome's --use-file-for-fake-video-capture); without ffmpeg, Chrome's built-in fake camera is
 * used. --screen-share also presses Share (headless Chrome shares its virtual screen); this
 * path depends on the room's UI and is best effort. */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { launchChrome, attach, clickButton, WATCH_PCS, PUBLISHING, OUTBOUND } from "./lib/chrome.mjs";
import { CAPTION_TAP, DRAIN_CAPTIONS, AUDIO_STATE } from "./lib/captions.mjs";
import { parseArgs, parseDuration, sleep, stamp } from "./lib/args.mjs";
import { apiBase, assertSafeTarget } from "./lib/client.mjs";
import { BOX_WAIT_MS, boxProgress, videoServerStatus } from "./lib/box.mjs";

const SELF = fileURLToPath(import.meta.url);

/** Makes (once) the looping test media; returns Chrome flags, or [] for the built-in fake. */
export function testMediaFlags({ size = "1280x720", fps = 30, seconds = 10 } = {}) {
  const dir = join(tmpdir(), "webinarliv-load-media");
  const video = join(dir, `test-${size}-${fps}.mjpeg`);
  const audio = join(dir, "tone.wav");
  try {
    mkdirSync(dir, { recursive: true });
    if (!existsSync(video)) {
      execFileSync("ffmpeg", ["-loglevel", "error", "-y", "-f", "lavfi", "-i", `testsrc2=size=${size}:rate=${fps}`,
        "-t", String(seconds), "-q:v", "6", "-f", "mjpeg", video], { stdio: "ignore" });
    }
    if (!existsSync(audio)) {
      execFileSync("ffmpeg", ["-loglevel", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
        "-t", String(seconds), "-ac", "1", audio], { stdio: "ignore" });
    }
    return [`--use-file-for-fake-video-capture=${video}`, `--use-file-for-fake-audio-capture=${audio}`];
  } catch {
    return [];
  }
}

/** mediaFlags with the microphone replaced by `wav` (a presenter's voice, lib/voice.mjs). Chrome loops it. */
export function withVoice(mediaFlags, wav) {
  return [...(mediaFlags ?? []).filter((f) => !f.startsWith("--use-file-for-fake-audio-capture=")), `--use-file-for-fake-audio-capture=${wav}`];
}

// Expression: the microphone is being sent and nothing offers to unmute it.
const MIC_LIVE = `(async () => {
  const s = ${AUDIO_STATE};
  const unmute = [...document.querySelectorAll('button')].some((b) => /^unmute( \\(m\\))?$/i.test((b.getAttribute('aria-label') || b.textContent || '').trim()));
  return s.sent.some((x) => x.enabled && x.state === 'live') && !unmute; })()`;

/* startPresenter(o) -> { label, status(): Promise<stats>, drainCaptions(), audioState(), stop() }.
 * o: { web, api, slug, email, password, port, screenShare, mediaFlags, voice (a WAV is in
 * mediaFlags: tap captions, make sure the mic is on), boxWaitMs, log }. Resolves once the
 * presenter is publishing. */
export async function startPresenter(o) {
  const log = o.log ?? console.log;
  const label = o.label ?? o.email;
  const chrome = await launchChrome({
    port: o.port ?? 9700,
    flags: [
      ...(o.mediaFlags ?? []),
      // Screen share without a picker: the virtual screen is chosen automatically.
      "--auto-select-desktop-capture-source=Entire screen",
      "--auto-accept-this-tab-capture",
      // The voice file: macOS Chrome's sandboxed audio service cannot read it and captures
      // silence (on a root Linux droplet --no-sandbox covers it already).
      ...(o.voice ? ["--disable-features=AudioServiceSandbox"] : []),
    ],
  });
  try {
    // With a voice (run.mjs --captions) the page also records the caption packets it receives
    // and when its microphone opened (lib/captions.mjs CAPTION_TAP).
    const page = await attach(chrome.first.webSocketDebuggerUrl, label, { init: o.voice ? WATCH_PCS + CAPTION_TAP : WATCH_PCS });
    await page.navigate(o.web, 20000);
    const login = await page.evaluate(`fetch(${JSON.stringify(o.api + "/auth/login")}, {method:'POST', credentials:'include',
      headers:{'Content-Type':'application/json'}, body: JSON.stringify({email:${JSON.stringify(o.email)}, password:${JSON.stringify(o.password)}})})
      .then(r => r.status)`);
    if (login !== 200) throw new Error(`${label}: login ${login}`);
    await page.navigate(`${o.web}/host/${o.slug}/room`, 20000);
    /* A cold video box takes 2-4 minutes to boot, and the room shows "Starting servers…"
     * until it is up: wait up to --box-wait (default 6 min), saying what we are waiting for. */
    const boxWaitMs = o.boxWaitMs ?? BOX_WAIT_MS;
    const t0 = Date.now();
    let joined = null;
    let reloaded = false;
    while (!joined && Date.now() - t0 < boxWaitMs) {
      joined = await page.waitFor(clickButton("join the webinar|join the meeting"), Math.min(15000, boxWaitMs - (Date.now() - t0)));
      if (joined) break;
      const st = await videoServerStatus(o.api, o.slug).catch(() => null);
      if (st?.state === "failed") throw new Error(`${label}: the video server failed to start: ${st.message ?? ""}`);
      if (st && st.state !== "ready") log(`${stamp()} presenter ${label}: ${boxProgress(st, Date.now() - t0)}`);
      else if (st?.state === "ready" && !reloaded && Date.now() - t0 > 60000) {
        // The box came up but the page did not move on: load the room again, once.
        reloaded = true;
        log(`${stamp()} presenter ${label}: video server ready but no Join button yet; reloading the room`);
        await page.navigate(`${o.web}/host/${o.slug}/room`, 20000);
      }
    }
    if (!joined) {
      // Say what the page shows instead: an error, a sign-in screen, a different button.
      const text = await page.evaluate("(document.body?.innerText || '').replace(/\\s+/g, ' ').slice(0, 400)");
      throw new Error(`${label}: no "Join the webinar" button on /host/${o.slug}/room after ${Math.round(boxWaitMs / 1000)} s (--box-wait); the page says: ${text}`);
    }
    if (!(await page.waitFor(PUBLISHING, 60000, 1000))) throw new Error(`${label}: joined but never published video`);
    log(`${stamp()} presenter ${label} on stage and publishing`);
    if (o.voice) {
      /* The voice is the microphone: make sure it is on (a stage can join muted: the
       * controls' muteOnEntry, or the device preference). Live = an enabled audio track on a
       * sender, and no "Unmute" button showing. */
      let live = false;
      for (let i = 0; i < 6 && !live; i++) {
        live = await page.waitFor(MIC_LIVE, 3000, 500);
        if (!live) await page.evaluate(clickButton("^unmute( \\(m\\))?$"));
      }
      log(`${stamp()} presenter ${label}: microphone ${live ? "on, speaking its script" : "NOT on (no enabled audio sender); its captions will be missing"}`);
    }
    if (o.screenShare) {
      await sleep(2000);
      const clicked = await page.waitFor(clickButton("^share$|share screen"), 10000);
      if (clicked) await page.waitFor(clickButton("screen|entire"), 5000);
      log(`${stamp()} presenter ${label}: screen share ${clicked ? "pressed" : "button not found"}`);
    }
    let prev = null;
    return {
      label,
      async status() {
        const s = await page.evaluate(OUTBOUND);
        if (!s) return null;
        const now = Date.now();
        const out = { ...s, kbps: 0, fpsRate: 0 };
        if (prev) {
          const dt = (now - prev.at) / 1000;
          out.kbps = Math.round(((s.bytes - prev.bytes) * 8) / 1000 / dt);
          out.fpsRate = Math.round(((s.frames - prev.frames) / dt) * 10) / 10;
        }
        prev = { ...s, at: now };
        return out;
      },
      // The caption packets this page received since the last call: [{ at, packet }].
      async drainCaptions() {
        return (o.voice ? await page.evaluate(DRAIN_CAPTIONS) : null) ?? [];
      },
      // The microphone's open times and the track being sent (the audio anchor).
      async audioState() {
        return o.voice ? await page.evaluate(AUDIO_STATE) : null;
      },
      // Closing the browser is the presenter dropping off; ending the session is run.mjs's job.
      async stop() {
        page.close();
        chrome.close();
      },
    };
  } catch (e) {
    chrome.close();
    throw e;
  }
}

async function main() {
  const f = parseArgs(process.argv.slice(2));
  if (f.help || !f.web || !f.slug) {
    console.log(
      "usage: node presenter.mjs --web <origin> --slug <slug> --email <host> --password <pw> [--screen-share] [--duration 10m] [--box-wait 6m]",
    );
    process.exit(f.help ? 0 : 2);
  }
  const api = apiBase(f.web, f);
  assertSafeTarget([f.web, api], f);
  const email = f.email || process.env.LOADTEST_HOST_EMAIL;
  const password = f.password || process.env.LOADTEST_HOST_PASSWORD;
  if (!email || !password) throw new Error("--email and --password (or LOADTEST_HOST_EMAIL/PASSWORD) are required");
  const [w, h] = String(f.videoSize || "1280x720").split("x");
  const p = await startPresenter({
    web: f.web.replace(/\/$/, ""),
    api,
    slug: f.slug,
    email,
    password,
    screenShare: !!f.screenShare,
    boxWaitMs: parseDuration(f.boxWait, BOX_WAIT_MS),
    mediaFlags: testMediaFlags({ size: `${w}x${h}`, fps: Number(f.fps || 30) }),
  });
  const until = Date.now() + parseDuration(f.duration, 600_000);
  process.on("SIGINT", async () => {
    await p.stop();
    process.exit(130);
  });
  while (Date.now() < until) {
    await sleep(10_000);
    const s = await p.status();
    if (s) console.log(`${stamp()} ${p.label}: ${s.w}x${s.h} ${s.fpsRate} fps ${s.kbps} kbps${s.limited ? ` (limited: ${s.limited})` : ""}`);
  }
  await p.stop();
}

if (process.argv[1] === SELF) {
  main().catch((e) => {
    console.error(`${stamp()} ${e.message}`);
    process.exit(1);
  });
}
