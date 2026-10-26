#!/usr/bin/env node
/* One command for a load test (docs/LOAD-TESTING.md):
 *
 *   test host + edge webinar -> load-test seats -> go live -> (wait for the video box) ->
 *   presenters on stage -> (cloud recording) -> ramp HLS viewers here and on other generators
 *   (+ API load, + engagement check, + WebRTC tabs) -> summary -> end -> delete everything
 *
 *   PROBE_ADMIN_EMAIL=... PROBE_ADMIN_PASSWORD=... \
 *   node run.mjs --web https://webinarliv.com --steps 50,200,500,1000 --ramp 30s --hold 120s \
 *     --presenters 1 --api-load --i-know-this-is-prod
 *
 * Target
 *   --web URL             the web origin (pages, and <web>/api unless --api)
 *   --api URL             the API base, e.g. https://<service>.run.app/api
 *   --origin URL          viewers fetch HLS from the origin (e.g. https://152.42.156.192.sslip.io/live)
 *                         instead of the CDN playback URL: stresses the video box, not the CDN
 *   --sfu-project ID      pin the test host to a video server (admin PATCH /users/{id}/sfu)
 *   --delivery edge       (default) or standard
 *   --box-wait 6m         how long to wait for a cold video box (it boots in 2-4 min): for the
 *                         presenters' Join button and for the audience stream (default 360s)
 * Load
 *   --steps 50,200        HLS viewers per step (default 50,200,500,1000)
 *   --ramp 30s --hold 120s
 *   --workers N           viewer processes (default: one per 150 viewers, up to the CPU count)
 *   --presenters N        0-3 people on stage publishing a test video (default 1; 0 = you present)
 *   --screen-share        the host presenter also shares its screen (best effort)
 *   --api-load            chat/Q&A/poll/join traffic while the viewers run; rates with
 *                         --chat --question --upvote --vote --join --register --events (per second)
 *   --webrtc-steps 5,10   WebRTC attendee tabs too (standard delivery only; see webrtc-attendees.mjs)
 *   --low-latency / --no-low-latency   force the viewers' player mode (default: what join says,
 *                         EDGE_PLAYBACK_LOW_LATENCY; the browser may also step up to LL by itself)
 * Real-browser viewers (browser-viewers.mjs): what a viewer sees, not what the server serves
 *   --viewers browser     the audience is headless Chrome tabs on the real room page and the
 *                         production player (default: hls, the simulated viewers). Reports
 *                         stalls per viewer-minute, stall waves, first frame and latency, by
 *                         delivery path and generator region, with a PASS/FAIL verdict
 *   --scenario a|b|c|d    a: live, 150 browser viewers, the join's path (India -> the box)
 *                         b: as a, every viewer started on the CDN path
 *                         c: a simulive, 100 browser viewers (the file via the recordings CDN)
 *                         d: as a, 20% of the viewers on a Slow 4G network
 *                         (each sets defaults; flags given still win)
 *   --kind simulive       a simulive of a generated test video instead of a live webinar
 *                         (needs ffmpeg; --viewers browser; no presenters, no video box)
 *   --path cdn|direct     browser viewers start on this path when the join offered both
 *   --throttle-share F    this share of browser viewers on --throttle slow4g|fast4g
 *   --per-chrome N        viewer windows per Chrome (default 10); --max-cpu 70: a generator
 *                         past it opens no more and its results are marked invalid
 *   --phases LIST         the content timeline once everyone has joined, for a live browser
 *                         run (default camera:3m,screen:6m,video:6m,engage:2m): camera only,
 *                         the host shares its screen, then shares a video file (motion + tone),
 *                         then the engagement burst (chat, Q&A, polls, quizzes; engage.mjs) and
 *                         a chat round trip timed in every viewer window. Every number in the
 *                         report is split by phase, including the server's (Grafana)
 *   --no-phases           one plain hold instead
 * More generators
 *   --generators h1,h2    other generator droplets, over SSH (root@ unless given; key SSH_KEY or
 *                         ssh's default). Each gets the kit and its slice of --extra-seats, runs
 *                         hls-viewers.mjs in step with this one, and sends its results back;
 *                         the summary merges every generator per step
 *   --extra-seats N       viewers on the other generators between them (default with
 *                         --generators: as many per generator as this one runs). Without
 *                         --generators the command to run is printed, for you to start by hand
 *   --extra-wait 90s      the shared start is this far away (time to copy and start)
 *   --generator-kit DIR   use the kit already on the generators (e.g. /opt/loadgen/e2e/load)
 *                         instead of copying this one
 *   --generator-regions L each generator's DigitalOcean region, in --generators order (labels
 *                         the results; provision-generators.mjs prints both lists). Before
 *                         starting, the account's droplet limit is checked (doctl): the video
 *                         and captions boxes must still fit when they come up
 * Checks
 *   --engage              during the top step: a chat burst, questions and upvotes, polls and
 *                         quizzes one at a time, then verify what the server stored (engage.mjs);
 *                         sizes with --engage-chat 200 --engage-questions 20 --engage-upvotes 60
 *                         --engage-polls 3 --engage-quizzes 2 --engage-voters 100
 *   --record              cloud-record the session (grants the test host cloud_recording), stop
 *                         at the end and verify: ready (within --record-wait 10m), size,
 *                         duration, the file plays
 *   --captions            the presenters speak known scripts (espeak-ng / macOS say, lib/voice.mjs)
 *                         and the live captions are checked (captions.mjs): the source (server
 *                         agent or on-device), delivery to a WebRTC page, an edge tap and every
 *                         edge viewer, phrase latency, word error rate live and stored. Options:
 *                         --captions-source server|any  --captions-wait 3m (agent live by then)
 *                         --captions-live-wer 0.25 --captions-stored-wer 0.2
 *                         --captions-latency 4s (WebRTC p95) --captions-edge-slack 4s (edge p95
 *                         on screen <= edge live latency + this) --captions-delivery 0.9
 *   GRAFANA_PROM_URL + GRAFANA_PROM_TOKEN (+ GRAFANA_PROM_USER)   box CPU/network per step
 *                         from Grafana Cloud into results.json (lib/metrics.mjs)
 * Safety
 *   --max-viewers N       refuse more than N viewers in all (default 1000, raised to fit
 *                         --extra-seats when you did not set it; hard cap 5000)
 *   --i-know-this-is-prod required for webinarliv.com / *.run.app
 *   --dry-run             print the plan, check the admin login, create nothing
 *   --keep                leave the webinar and accounts (clean later with --cleanup)
 *   --cleanup FILE        clean up an interrupted run from its state.json
 *   --out DIR             results directory (default results/<run id>)
 *
 * It only ever touches what it made: a host at host-<run>@loadtest.invalid and that host's one
 * webinar. The server enforces the same (load-test endpoints refuse a non-.invalid host).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, parseDuration, parseSteps, intFlag, numFlag, sleep, stamp } from "./lib/args.mjs";
import { apiBase, assertSafeTarget, Session, ABSOLUTE_MAX_VIEWERS } from "./lib/client.mjs";
import {
  adminSession,
  createTestHost,
  createWebinar,
  createPanelist,
  seatViewers,
  cleanup,
  saveState,
  loadState,
  runId,
} from "./lib/fixture.mjs";
import { runHlsViewers } from "./hls-viewers.mjs";
import { runApiLoad } from "./api-load.mjs";
import { runWebrtcAttendees } from "./webrtc-attendees.mjs";
import { runEngage, verdictTable, ENGAGE_DEFAULTS } from "./engage.mjs";
import { startPresenter, testMediaFlags, withVoice, makeShareVideo } from "./presenter.mjs";
import { makeVoices } from "./lib/voice.mjs";
import { CAPTION_THRESHOLDS } from "./lib/captions.mjs";
import { enableCaptions, captionSource, EdgeCaptionTap, pageCaptions, edgeDelivery, analyseCaptions } from "./captions.mjs";
import { hlsTable, apiTable, writeResults } from "./lib/report.mjs";
import { BOX_WAIT_MS, waitForVideoServer } from "./lib/box.mjs";
import { grantCloudRecording, startRecording, stopRecording, waitReady, probePlayable, checkRecording } from "./lib/recording.mjs";
import { generatorPlan, parseHosts, startGenerators, mergeGeneratorSteps } from "./lib/generators.mjs";
import { promConfig, stepMetrics, phaseMetrics, captionLatency, stats as seriesStats } from "./lib/metrics.mjs";
import { runBrowserViewers } from "./browser-viewers.mjs";
import { report as browserReport, markdown as browserMarkdown } from "./lib/browser-summary.mjs";
import { parseRegions, checkDropletLimit, accountDroplets } from "./lib/provision.mjs";
import { makeTestVideo, uploadVideo, createSimulive, waitSimuliveLive } from "./lib/simulive.mjs";
import { table } from "./lib/stats.mjs";

const SELF = fileURLToPath(import.meta.url);

/** When the top step's hold begins, from the start of the viewers' ramp (ms). */
export function topStepAt(steps, rampMs, holdMs) {
  return (steps.length - 1) * (rampMs + holdMs) + rampMs;
}

/* The other generators' steps: the same shape as this one's, scaled to `extra`, strictly
 * increasing, ending at exactly `extra`. */
export function scaleSteps(steps, extra) {
  const viewers = steps[steps.length - 1];
  const out = [];
  if (!extra) return out;
  for (const n of steps) {
    const m = Math.max(Math.round((n * extra) / viewers), (out[out.length - 1] ?? 0) + 1);
    if (m <= extra) out.push(m);
  }
  if (out[out.length - 1] !== extra) out.push(extra);
  return out;
}

/* The scenarios (docs/LOAD-TESTING.md, "Browser viewers"): defaults over the flags, which
 * still win. The viewer total is split between this machine and the generators: one share
 * here, the rest as extra seats. */
export const SCENARIOS = {
  // Live: the presenter speaks scripts (captions checked) and the content phases run.
  a: { viewers: "browser", total: 150, captions: true, engage: true },
  b: { viewers: "browser", total: 150, path: "cdn", captions: true, engage: true },
  c: { viewers: "browser", total: 100, kind: "simulive", presenters: "0" },
  d: { viewers: "browser", total: 150, throttleShare: "0.2", throttle: "slow4g", captions: true, engage: true },
};

/* "camera:3m,screen:6m,video:6m,engage:2m" -> [{ name, kind, ms }]. Kinds: camera (nothing
 * shared), screen (the host shares its screen), video (the host shares a video file), engage
 * (the engagement burst; shares stopped). */
export const PHASE_DEFAULT = "camera:3m,screen:6m,video:6m,engage:2m";
const PHASE_NAMES = { camera: "camera only", screen: "screen share", video: "video share", engage: "engagement" };
export function parsePhases(v) {
  const s = v === undefined || v === true ? PHASE_DEFAULT : String(v);
  return s.split(",").map((x) => x.trim()).filter(Boolean).map((x) => {
    const [kind, d] = x.split(":");
    if (!PHASE_NAMES[kind]) throw new Error(`--phases: "${kind}" is not one of ${Object.keys(PHASE_NAMES).join(", ")}`);
    const ms = parseDuration(d, NaN);
    if (!(ms > 0)) throw new Error(`--phases: ${x} needs a length, e.g. ${kind}:5m`);
    return { kind, name: PHASE_NAMES[kind], ms };
  });
}

/** When phase `kind` starts, ms from the start of the viewers' ramp (null if there is none). */
export function phaseStartMs(phases, kind, rampMs) {
  let at = rampMs;
  for (const ph of phases) {
    if (ph.kind === kind) return at;
    at += ph.ms;
  }
  return null;
}

export function applyScenario(f) {
  if (!f.scenario) return f;
  const sc = SCENARIOS[String(f.scenario).toLowerCase()];
  if (!sc) throw new Error(`--scenario is one of ${Object.keys(SCENARIOS).join(", ")}`);
  const out = { ...f };
  for (const [k, v] of Object.entries(sc)) if (k !== "total" && out[k] === undefined) out[k] = v;
  if (out.steps === undefined) {
    /* With generators, this machine (often a laptop on home bandwidth) runs one viewer, and
     * the generators the rest: ~20 real viewers per c-4 under the 70% CPU guard. */
    const gens = parseHosts(f.generators).length;
    const here = gens ? intFlag(f.localViewers, 1, "local-viewers") : sc.total;
    out.steps = String(here);
    if (gens && out.extraSeats === undefined) out.extraSeats = String(sc.total - here);
  }
  if (out.hold === undefined && sc.kind === "simulive") out.hold = "600s";
  if (out.ramp === undefined) out.ramp = "60s";
  return out;
}

export function plan(f) {
  f = applyScenario(f);
  const notes = [];
  const viewersMode = f.viewers === "browser" ? "browser" : "hls";
  const kind = f.kind === "simulive" ? "simulive" : "live";
  if (kind === "simulive" && viewersMode !== "browser") throw new Error("--kind simulive needs --viewers browser: the simulated viewers play HLS, a simulive plays a file");
  const path = f.path === undefined ? null : String(f.path);
  if (path && !["cdn", "direct"].includes(path)) throw new Error("--path is cdn or direct");
  if (path && viewersMode !== "browser") throw new Error("--path is for --viewers browser (the simulated viewers take --origin)");
  const browser = viewersMode === "browser"
    ? {
        path,
        throttle: f.throttle === undefined ? "slow4g" : String(f.throttle),
        throttleShare: numFlag(f.throttleShare, 0, "throttle-share"),
        perChrome: intFlag(f.perChrome, 10, "per-chrome"),
        maxCpu: numFlag(f.maxCpu, 70, "max-cpu"),
      }
    : null;
  const steps = parseSteps(f.steps, [50, 200, 500, 1000]);
  const rampMs = parseDuration(f.ramp, 30_000);
  let holdMs = parseDuration(f.hold, 120_000);
  const viewers = steps[steps.length - 1];
  const hosts = parseHosts(f.generators);
  const generatorRegions = parseRegions(f.generatorRegions);
  if (generatorRegions.length && generatorRegions.length !== hosts.length) {
    throw new Error(`--generator-regions lists ${generatorRegions.length} region(s) for ${hosts.length} generator(s)`);
  }
  /* More viewers than one generator can pull (its NIC, its cores): seats for other generators,
   * which run hls-viewers.mjs on their own slice, started at the same instant (--start-at). */
  const extraGiven = f.extraSeats !== undefined && f.extraSeats !== true;
  const extra = extraGiven ? intFlag(f.extraSeats, 0, "extra-seats") : hosts.length ? viewers * hosts.length : 0;
  if (hosts.length && !extraGiven) notes.push(`--generators without --extra-seats: ${viewers} viewers on each of ${hosts.length} generator(s), ${extra} in all`);
  if (hosts.length && !extra) throw new Error("--generators with --extra-seats 0: nothing for them to run");
  let maxViewers = Math.min(intFlag(f.maxViewers, viewersMode === "browser" ? 300 : 1000, "max-viewers"), ABSOLUTE_MAX_VIEWERS);
  if (viewers > maxViewers) throw new Error(`${viewers} viewers is over --max-viewers ${maxViewers} (hard cap ${ABSOLUTE_MAX_VIEWERS})`);
  if (viewers + extra > maxViewers) {
    // Asking for extra seats is asking for that many more viewers: unless --max-viewers says
    // otherwise, the cap moves to fit (24 Oct: "10 + 1000 over --max-viewers 1000").
    if (f.maxViewers !== undefined || viewers + extra > ABSOLUTE_MAX_VIEWERS) {
      throw new Error(`${viewers} + ${extra} extra viewers is over --max-viewers ${f.maxViewers !== undefined ? maxViewers : ABSOLUTE_MAX_VIEWERS}`);
    }
    notes.push(`--max-viewers raised from ${maxViewers} to ${viewers + extra} to fit ${viewers} here + ${extra} extra (pass --max-viewers to cap it)`);
    maxViewers = viewers + extra;
  }
  const presenters = kind === "simulive" ? 0 : intFlag(f.presenters, 1, "presenters");
  /* The content phases (live browser runs with a presenter): the viewers' hold is their sum, and
   * the engagement check runs in its own phase rather than at the top step. */
  const phases = viewersMode === "browser" && kind === "live" && presenters > 0 && f.phases !== false ? parsePhases(f.phases) : [];
  if (phases.length) {
    if (steps.length > 1) throw new Error("--phases runs one step (everyone joins, then the content); give one --steps value or --no-phases");
    if (f.hold !== undefined && f.scenario === undefined) notes.push(`--hold ignored: the phases (${phases.map((x) => x.name).join(", ")}) set the hold`);
    holdMs = phases.reduce((a, x) => a + x.ms, 0);
  }
  if (presenters > 3) throw new Error("--presenters is 0 to 3 (0: nobody presents from here, e.g. a person or OBS does)");
  const webrtcSteps = f.webrtcSteps ? parseSteps(f.webrtcSteps) : [];
  const delivery = f.delivery === "standard" ? "standard" : "edge";
  if (webrtcSteps.length && delivery === "edge") {
    throw new Error("--webrtc-steps needs --delivery standard: an edge webinar's audience is LL-HLS (use the HLS viewers; or webrtc-attendees.mjs --kind meeting)");
  }
  const apiLoad = !!f.apiLoad;
  const rates = {
    chat: numFlag(f.chat, 1, "chat"),
    question: numFlag(f.question, 0.1, "question"),
    upvote: numFlag(f.upvote, 0.2, "upvote"),
    vote: numFlag(f.vote, 1, "vote"),
    join: numFlag(f.join, 0.5, "join"),
    register: numFlag(f.register, 0, "register"),
    events: numFlag(f.events, 0, "events"),
  };
  const durationMs = steps.length * (rampMs + holdMs);
  // Seats: one per HLS viewer, then the WebRTC tabs, then spare ones for API load's votes and
  // joins, then the captions tap (an edge viewer that keeps every caption), then the other
  // generators'.
  const webrtc = webrtcSteps.length ? webrtcSteps[webrtcSteps.length - 1] : 0;
  const captions = f.captions ? captionsPlan(f, presenters) : null;
  const tap = captions && delivery === "edge" ? 1 : 0;
  if (viewers + webrtc + extra + tap > ABSOLUTE_MAX_VIEWERS) throw new Error(`${viewers + webrtc + extra + tap} seats is over the hard cap ${ABSOLUTE_MAX_VIEWERS}`);
  const spare = apiLoad ? Math.max(0, Math.min(1000, ABSOLUTE_MAX_VIEWERS - viewers - webrtc - extra - tap, Math.max(50, Math.ceil((rates.vote * durationMs) / 1000)))) : 0;
  const extraSteps = scaleSteps(steps, extra);
  const generators = hosts.length ? generatorPlan(extra, extraSteps, hosts) : [];
  const seats = viewers + webrtc + spare + tap + extra;
  const engage = f.engage
    ? {
        chat: intFlag(f.engageChat, ENGAGE_DEFAULTS.chat, "engage-chat"),
        questions: intFlag(f.engageQuestions, ENGAGE_DEFAULTS.questions, "engage-questions"),
        upvotes: intFlag(f.engageUpvotes, ENGAGE_DEFAULTS.upvotes, "engage-upvotes"),
        polls: intFlag(f.engagePolls, ENGAGE_DEFAULTS.polls, "engage-polls"),
        quizzes: intFlag(f.engageQuizzes, ENGAGE_DEFAULTS.quizzes, "engage-quizzes"),
        voters: intFlag(f.engageVoters, ENGAGE_DEFAULTS.voters, "engage-voters"),
        // With phases: the engagement phase's start; else the top step's hold.
        atMs: phases.length ? phaseStartMs(phases, "engage", rampMs) ?? topStepAt(steps, rampMs, holdMs) : topStepAt(steps, rampMs, holdMs),
      }
    : null;
  if (kind === "simulive" && (f.captions || f.record || webrtcSteps.length)) throw new Error("--kind simulive runs without --captions, --record or --webrtc-steps");

  return {
    steps, rampMs, holdMs, viewers, maxViewers, presenters, webrtcSteps, webrtc, delivery, apiLoad, rates, durationMs,
    seats, spare, tap, extra, extraSteps, generators, generatorRegions, viewersMode, kind, browser, phases,
    boxWaitMs: parseDuration(f.boxWait, BOX_WAIT_MS), record: !!f.record, engage, captions, notes,
  };
}

/* --captions: the presenters speak (lib/voice.mjs) and the captions are checked (captions.mjs).
 * The thresholds, from the flags, over CAPTION_THRESHOLDS. */
export function captionsPlan(f, presenters) {
  if (presenters < 1) throw new Error("--captions needs --presenters 1-3: the presenters speak the scripts");
  const ratio = (v, def, name) => {
    if (v === undefined || v === true) return def;
    const s = String(v).trim();
    const x = s.endsWith("%") ? Number(s.slice(0, -1)) / 100 : Number(s);
    if (!Number.isFinite(x) || x < 0 || x > 1) throw new Error(`--${name} is a fraction (0.25) or a percentage (25%)`);
    return x;
  };
  const source = f.captionsSource === undefined ? CAPTION_THRESHOLDS.source : String(f.captionsSource);
  if (!["server", "any"].includes(source)) throw new Error("--captions-source is server or any");
  return {
    waitMs: parseDuration(f.captionsWait, 180_000),
    thresholds: {
      liveWer: ratio(f.captionsLiveWer, CAPTION_THRESHOLDS.liveWer, "captions-live-wer"),
      storedWer: ratio(f.captionsStoredWer, CAPTION_THRESHOLDS.storedWer, "captions-stored-wer"),
      webrtcP95Ms: parseDuration(f.captionsLatency, CAPTION_THRESHOLDS.webrtcP95Ms),
      edgeSlackMs: parseDuration(f.captionsEdgeSlack, CAPTION_THRESHOLDS.edgeSlackMs),
      edgeDelivery: ratio(f.captionsDelivery, CAPTION_THRESHOLDS.edgeDelivery, "captions-delivery"),
      source,
    },
  };
}

/* checksRows(results) -> the PASS/FAIL lines of a run: engagement, recording and captions. */
export function checksRows(results) {
  const rows = [];
  for (const c of results.engage?.checks ?? []) rows.push({ ...c, area: `engage ${c.area}` });
  for (const c of results.recording?.checks ?? []) rows.push({ ...c, area: "recording" });
  for (const c of results.captions?.checks ?? []) rows.push({ ...c, area: `captions ${c.area}` });
  for (const c of results.browserReport?.verdict ?? []) rows.push({ area: "browser viewers", name: c.name, pass: c.pass, detail: c.detail });
  return rows;
}

async function main() {
  const f = parseArgs(process.argv.slice(2));
  if (f.help || (!f.web && !f.cleanup)) {
    console.log(readFileSync(SELF, "utf8").split("*/")[0].replace(/^#!.*\n\/\* ?/, ""));
    process.exit(f.help ? 0 : 2);
  }
  if (f.cleanup) {
    const state = loadState(f.cleanup);
    assertSafeTarget([state.web, state.api], f);
    const errs = await cleanup(state);
    process.exit(errs.length ? 1 : 0);
  }
  const web = String(f.web).replace(/\/$/, "");
  const api = apiBase(web, f);
  const prod = assertSafeTarget([web, api, typeof f.origin === "string" ? f.origin : ""], f);
  const p = plan(f);
  const run = runId();
  const out = f.out || join("results", run);
  const prom = promConfig();
  console.log(`${stamp()} load test ${run} against ${web} (API ${api})${prod ? "  ** PRODUCTION **" : ""}`);
  console.log(`  ${p.kind === "simulive" ? "simulive" : `${p.delivery} webinar`}, ${p.presenters} presenter(s)${f.screenShare ? " + screen share" : ""}, ` +
    `${p.browser ? "BROWSER" : "HLS"} viewers ${p.steps.join(" -> ")} ` +
    `(ramp ${p.rampMs / 1000}s, hold ${p.holdMs / 1000}s, about ${Math.round(p.durationMs / 60000)} min)` +
    (f.origin ? `, from the ORIGIN ${f.origin}` : ", via the playback URL join returns"));
  for (const n of p.notes) console.log(`  note: ${n}`);
  if (p.generators.length) {
    for (const g of p.generators) console.log(`  generator ${g.host}: ${g.count} viewers (seats ${g.from}-${g.from + g.count - 1} of the extra), steps ${g.steps.join(" -> ")}`);
  } else if (p.extra) console.log(`  ${p.extra} extra viewers for generators you start by hand, steps ${p.extraSteps.join(" -> ")}`);
  if (p.apiLoad) console.log(`  API load: ${JSON.stringify(p.rates)} per second`);
  if (p.browser) console.log(`  browser viewers: path ${p.browser.path ?? "the join's"}, ${Math.round(p.browser.throttleShare * 100)}% on ${p.browser.throttle}, ` +
    `${p.browser.perChrome} tabs per Chrome, generator CPU ceiling ${p.browser.maxCpu}%` +
    (p.generatorRegions.length ? `; generators in ${p.generatorRegions.join(", ")}` : ""));
  if (p.engage) console.log(`  engagement check at the top step (+${Math.round(p.engage.atMs / 1000)}s): ${JSON.stringify({ ...p.engage, atMs: undefined })}`);
  if (p.record) console.log("  cloud recording: on, verified at the end");
  let voices = null;
  if (p.captions) {
    // Made before anything is created: no TTS engine is a reason not to start.
    voices = makeVoices(p.presenters);
    console.log(`  captions: on; ${p.presenters} presenter(s) speak scripts (${voices.engine}, ${Math.round(voices.loopMs / 1000)} s loop), ` +
      `checked against ${JSON.stringify(p.captions.thresholds)}`);
  }
  if (p.webrtc) console.log(`  WebRTC tabs ${p.webrtcSteps.join(" -> ")}`);
  console.log(`  server metrics: ${prom ? `${prom.base} (box ${prom.box})` : "off (set GRAFANA_PROM_URL and GRAFANA_PROM_TOKEN)"}`);
  console.log(`  ${p.seats} seat(s), at most ${p.viewers + p.extra} viewers (--max-viewers ${p.maxViewers}); results in ${out}`);

  if (f.dryRun) {
    if (process.env.PROBE_ADMIN_EMAIL) {
      await adminSession(api);
      console.log(`${stamp()} dry run: admin login ok; nothing created`);
    } else console.log(`${stamp()} dry run: PROBE_ADMIN_EMAIL not set; nothing created`);
    return;
  }

  /* Generators are droplets too: with them up, the video and captions boxes must still fit in
   * the account's droplet limit when they come up during the run, or the box never starts. */
  if (p.generators.length) {
    try {
      const acct = accountDroplets();
      const why = checkDropletLimit({ limit: acct.limit, existing: acct.existing, adding: 0, boxesUp: acct.boxesUp });
      if (why) throw new Error(`droplet limit: the video and captions boxes would not fit (${why})`);
      console.log(`${stamp()} droplets: ${acct.existing} of ${acct.limit}, room for the boxes`);
    } catch (e) {
      if (/droplet limit/.test(e.message)) throw e;
      console.log(`${stamp()} WARNING could not check the droplet limit with doctl (${e.message.split("\n")[0]}); make sure the boxes fit`);
    }
  }

  const ctl = new AbortController();
  const statePath = join(out, "state.json");
  const state = { run, web, api, startedAt: new Date().toISOString(), extraUsers: [] };
  writeResults(join(out, "plan.json"), { run, web, api, origin: f.origin || null, ...p });
  saveState(statePath, state);
  const presenters = [];
  let interrupted = false;
  process.on("SIGINT", () => {
    if (interrupted) process.exit(130);
    interrupted = true;
    console.log(`\n${stamp()} interrupted: stopping, then cleaning up (Ctrl-C again to quit now; then run --cleanup ${statePath})`);
    ctl.abort();
  });

  const results = { run, web, api, plan: p, warnings: [], presenters: [], serverViewers: [] };
  const warn = (msg) => {
    results.warnings.push(msg);
    console.log(`${stamp()} WARNING ${msg}`);
  };
  let host = null;
  let rec = null; // the cloud recording while it runs
  let capTap = null; // the captions tap (--captions), stopped in finally if the run fails
  try {
    const admin = await adminSession(api);
    state.host = await createTestHost(api, admin, run, { sfuProject: f.sfuProject, captions: !!p.captions });
    saveState(statePath, state);
    console.log(`${stamp()} test host ${state.host.email}`);
    if (p.record) {
      await grantCloudRecording(admin, state.host.id);
      console.log(`${stamp()} test host granted cloud_recording`);
    }
    host = await new Session(api, "host").login(state.host.email, state.host.password);
    let wb;
    if (p.kind === "simulive") {
      // A test video as long as the run (plus a margin), uploaded, then a simulive playing it.
      await admin.call("PATCH", `/admin/users/${state.host.id}/features`, { feature: "simulive", enabled: true });
      const seconds = Math.ceil(p.durationMs / 1000) + 300;
      console.log(`${stamp()} making a ${Math.round(seconds / 60)} min test video (ffmpeg) and uploading it`);
      const rec = await uploadVideo(host, makeTestVideo(seconds), `Load test ${run}`);
      wb = await createSimulive(host, `Load test ${run}`, rec.id);
    } else {
      wb = await createWebinar(host, `Load test ${run}`, { delivery: p.delivery, captions: !!p.captions });
    }
    state.slug = wb.id;
    saveState(statePath, state);
    console.log(`${stamp()} webinar ${wb.id} (delivery ${wb.delivery ?? "?"})`);
    if (p.kind === "live" && p.delivery === "edge" && wb.delivery && wb.delivery !== "edge") throw new Error(`asked for edge, got ${wb.delivery}: does the server have BROADCAST_RTMP_BASE?`);

    const panelists = [];
    for (let n = 2; n <= p.presenters; n++) {
      const pn = await createPanelist(api, admin, host, wb.id, run, n);
      panelists.push(pn);
      state.extraUsers.push(pn.id);
      saveState(statePath, state);
    }
    const keys = await seatViewers(admin, wb.id, p.seats, p.seats);
    const keysFile = join(out, "keys.json");
    writeFileSync(keysFile, JSON.stringify(keys));
    const viewerKeys = keys.slice(0, p.viewers);
    const webrtcKeys = keys.slice(p.viewers, p.viewers + p.webrtc);
    const spareKeys = keys.slice(p.viewers + p.webrtc, p.viewers + p.webrtc + p.spare);
    const tapKey = p.tap ? keys[p.viewers + p.webrtc + p.spare] : null;
    const extraKeys = keys.slice(p.seats - p.extra);
    console.log(`${stamp()} ${keys.length} seat(s) minted`);
    /* Joins past a webinar's "Max attendees" are refused (default 50, 300 at most): an admin
     * override lets a load test's audience in (up to 1000; the server's own ceiling). */
    if (p.seats > 200) {
      await admin.call("PATCH", `/admin/webinars/${wb.id}/audience-cap`, { audienceCap: Math.min(1000, p.seats) });
      console.log(`${stamp()} audience limit raised to ${Math.min(1000, p.seats)} for this webinar`);
      if (p.seats > 1000) warn(`${p.seats} seats but a webinar admits at most 1000: viewers past that are refused`);
    }

    if (p.kind === "simulive") {
      // No stage and no video box: the simulive starts itself when due (a minute after creation).
      const st = await waitSimuliveLive(host, wb.id, { signal: ctl.signal });
      if (st !== "live") throw new Error(`the simulive did not go live (status ${st ?? "unknown"})`);
      console.log(`${stamp()} simulive live`);
    } else {
      await host.call("POST", `/host/webinars/${wb.id}/start`);
      console.log(`${stamp()} live`);
    }

    // A cold on-demand box boots now (2-4 min): wait for it before the stage tries to join.
    const box = p.kind === "live" ? await waitForVideoServer({ api, slug: wb.id, timeoutMs: p.boxWaitMs, signal: ctl.signal }) : null;
    if (box && box.state !== "ready") warn(`the video server is still ${box.state} after --box-wait ${Math.round(p.boxWaitMs / 1000)}s; carrying on`);

    const mediaFlags = testMediaFlags();
    if (!mediaFlags.length) console.log(`${stamp()} no ffmpeg: presenters use Chrome's built-in fake camera`);
    const who = p.presenters ? [{ ...state.host, label: "host" }, ...panelists.map((x, i) => ({ ...x, label: `panelist${i + 2}` }))] : [];
    for (const [i, x] of who.entries()) {
      presenters.push(
        await startPresenter({
          web, api, slug: wb.id, email: x.email, password: x.password, label: x.label, port: 9700 + i,
          screenShare: i === 0 && !!f.screenShare, boxWaitMs: p.boxWaitMs,
          // --captions: each presenter's microphone is its own script, in its own voice.
          mediaFlags: voices ? withVoice(mediaFlags, voices.presenters[i].wav) : mediaFlags, voice: !!voices,
        }),
      );
    }

    /* --captions: the room's Captions switch on (the webinar was made with "Live captions", so
     * go-live asked for the agent already; this also brings it in if the box was still booting
     * then), then, every 5 s until the end: the caption packets each presenter's page received
     * (WebRTC), and every 10 s which source serves them. */
    const cap = { pages: presenters.map(() => []), source: [], tap: null, collect: null };
    if (p.captions) {
      await enableCaptions(host, wb.id).catch((e) => warn(`turning captions on: ${e.message}`));
      console.log(`${stamp()} captions on; waiting up to ${Math.round(p.captions.waitMs / 1000)} s for the server caption agent (on-device captions meanwhile)`);
      cap.collect = (async () => {
        const t0 = Date.now();
        let said = false;
        for (let n = 0; !ctl.signal.aborted; n++) {
          for (const [i, x] of presenters.entries()) cap.pages[i].push(...pageCaptions(await x.drainCaptions().catch(() => [])));
          if (n % 2 === 0) {
            const s = await captionSource(host, wb.id).catch(() => null);
            if (s) cap.source.push(s);
            if (s?.server && !said) {
              said = true;
              console.log(`${stamp()} captions: the server caption agent is live (${Math.round((Date.now() - t0) / 1000)} s)`);
            } else if (!said && Date.now() - t0 > p.captions.waitMs) {
              said = true;
              warn(`captions: the server caption agent is not live after --captions-wait ${Math.round(p.captions.waitMs / 1000)} s ` +
                `(${s?.pending ? "asked for, not live: no worker took the job, or its CPU guard paused it" : "not asked for: CAPTIONS_SECRET unset, the feature off, or the dispatch failed"}); captions are on-device`);
            }
          }
          await sleep(5000, ctl.signal);
        }
      })();
    }

    // The audience stream (the mix) takes a little while to start after the stage publishes.
    if (p.kind === "live" && p.delivery === "edge") {
      const waitMs = parseDuration(f.waitLive, p.boxWaitMs);
      const t0 = Date.now();
      let st = null;
      let said = 0;
      while (Date.now() - t0 < waitMs && !ctl.signal.aborted) {
        st = await host.call("GET", `/host/webinars/${wb.id}/edge`).catch(() => null);
        if (st?.audienceStream === "live") break;
        if (Date.now() - said >= 15_000) {
          console.log(`${stamp()} waiting for the audience stream (${st?.audienceStream ?? "unknown"}, ${Math.round((Date.now() - t0) / 1000)} s so far)`);
          said = Date.now();
        }
        await sleep(3000, ctl.signal);
      }
      console.log(`${stamp()} audience stream: ${st?.audienceStream ?? "unknown"} ${st?.playbackUrl ?? ""}`);
      results.playbackUrl = st?.playbackUrl ?? null;
      if (st?.audienceStream !== "live") warn("the audience stream is not live yet; viewers will retry the playlist");
      if (!f.origin && looksLikeOrigin(st?.playbackUrl)) {
        const msg = `the playback URL ${st.playbackUrl} is the video box itself, not a CDN pull zone: every viewer loads the ORIGIN. ` +
          "The numbers below are the box's, not the CDN's (set the project's edgePlaybackBase to the pull zone; deploy/digitalocean/README.md)";
        console.log("\n" + "!".repeat(100));
        warn(msg);
        console.log("!".repeat(100) + "\n");
      }
    }

    // The captions tap: one more edge viewer, events stream only, keeping every caption.
    if (tapKey) capTap = cap.tap = new EdgeCaptionTap({ api, slug: wb.id, joinKey: tapKey }).start();

    if (p.record && !ctl.signal.aborted) {
      try {
        rec = await startRecording(host, wb.id);
        state.recording = rec.id;
        saveState(statePath, state);
        console.log(`${stamp()} cloud recording ${rec.id} started`);
      } catch (e) {
        results.recording = { started: false, error: e.message, pass: false, checks: [{ area: "recording", name: "start", pass: false, detail: e.message }] };
        warn(`cloud recording did not start: ${e.message}`);
      }
    }

    // api-load's votes go to whatever poll is open; --engage opens its own and pauses these.
    const votePoll = { id: "", paused: false };
    if (p.apiLoad && p.rates.vote > 0) {
      const poll = await host.call("POST", `/host/webinars/${wb.id}/polls`, { question: "Load test poll", kind: "poll", options: ["One", "Two", "Three"] });
      votePoll.id = poll.id;
      await host.call("POST", `/host/webinars/${wb.id}/polls/${votePoll.id}/open`);
    }

    // While the load runs: what the server thinks (host edge status: viewers) and the presenters.
    const monitor = (async () => {
      while (!ctl.signal.aborted) {
        await sleep(30_000, ctl.signal);
        if (ctl.signal.aborted) break;
        const st = await host.call("GET", `/host/webinars/${wb.id}/edge`).catch(() => null);
        const ps = await Promise.all(presenters.map(async (x) => ({ label: x.label, ...(await x.status().catch(() => ({}))) })));
        results.serverViewers.push({ at: new Date().toISOString(), viewers: st?.viewers ?? null, audienceStream: st?.audienceStream ?? null });
        results.presenters.push({ at: new Date().toISOString(), presenters: ps });
        console.log(`${stamp()} server counts ${st?.viewers ?? "?"} edge viewer(s); ` +
          ps.map((x) => `${x.label} ${x.w ?? 0}x${x.h ?? 0} ${x.fpsRate ?? 0}fps ${x.kbps ?? 0}kbps${x.limited ? ` (${x.limited})` : ""}`).join(", "));
      }
    })();

    const viewerFlags = [
      "--api", api, "--slug", wb.id, "--ramp", `${p.rampMs / 1000}s`, "--hold", `${p.holdMs / 1000}s`,
      ...(f.origin ? ["--origin", f.origin] : []),
      ...(f.lowLatency === undefined ? [] : [f.lowLatency ? "--low-latency" : "--no-low-latency"]),
      ...(prod ? ["--i-know-this-is-prod"] : []),
    ];
    // The browser viewers' flags (browser-viewers.mjs takes the web origin: it opens pages).
    const browserFlags = p.browser
      ? [
          "--web", web, "--slug", wb.id, "--ramp", `${p.rampMs / 1000}s`, "--hold", `${p.holdMs / 1000}s`,
          ...(p.browser.path ? ["--path", p.browser.path] : []),
          "--throttle", p.browser.throttle, "--throttle-share", String(p.browser.throttleShare),
          "--per-chrome", String(p.browser.perChrome), "--max-cpu", String(p.browser.maxCpu),
          ...(prod ? ["--i-know-this-is-prod"] : []),
        ]
      : null;
    // The chat round trip: when the engagement phase starts, from the viewers' own start.
    const chatProbeOffset = p.browser && p.phases.length ? phaseStartMs(p.phases, "engage", p.rampMs) : null;
    let generatorsDone = null;
    if (p.extra) {
      // The other generators: same steps, scaled, starting at the same instant as this one.
      const extraFile = join(out, "keys-extra.json");
      writeFileSync(extraFile, JSON.stringify(extraKeys));
      const startAt = Date.now() + parseDuration(f.extraWait, 90_000);
      if (p.generators.length) {
        console.log(`${stamp()} starting ${p.generators.length} generator(s) over SSH; everyone starts in ${Math.round((startAt - Date.now()) / 1000)}s`);
        const g = startGenerators({
          gens: p.generators,
          kitDir: dirname(SELF),
          remoteKit: typeof f.generatorKit === "string" ? f.generatorKit : null,
          run,
          keysFile: extraFile,
          viewerArgs: browserFlags ?? viewerFlags,
          tool: browserFlags ? "browser-viewers.mjs" : "hls-viewers.mjs",
          genArgs: (g, i) => [
            ...(p.generatorRegions[i] ? ["--region", p.generatorRegions[i]] : []),
            ...(chatProbeOffset !== null ? ["--chat-probe-at", String(startAt + chatProbeOffset)] : []),
          ],
          startAt,
          signal: ctl.signal,
        });
        for (const [i, s] of (await g.ready).entries()) {
          if (s.status === "rejected") warn(`generator ${p.generators[i].host} is not running: ${s.reason?.message ?? s.reason}`);
        }
        if (Date.now() > startAt) warn("the generators took longer to prepare than --extra-wait; they will start late (or refuse, past a minute)");
        generatorsDone = g.done;
      } else {
        console.log(`\n${stamp()} ${p.extra} more viewers for other generators. Copy ${extraFile} to each and run, within ` +
          `${Math.round((startAt - Date.now()) / 1000)}s (split it with --from/--steps for more than one, or use --generators):\n` +
          `  node ${browserFlags ? "browser-viewers.mjs" : `hls-viewers.mjs --web ${web}`} ${(browserFlags ?? viewerFlags).join(" ")} --keys keys-extra.json --steps ${p.extraSteps.join(",")} ` +
          `--max-viewers ${p.extra} --start-at ${startAt}\n`);
      }
      await sleep(startAt - Date.now(), ctl.signal);
    }
    const hlsT0 = Date.now();
    const jobs = [];
    if (p.browser) {
      jobs.push(
        runBrowserViewers({
          web, slug: wb.id, keys: viewerKeys, steps: p.steps, rampMs: p.rampMs, holdMs: p.holdMs,
          path: p.browser.path, throttle: p.browser.throttle, throttleShare: p.browser.throttleShare,
          perChrome: p.browser.perChrome, maxCpu: p.browser.maxCpu, region: typeof f.region === "string" ? f.region : "",
          api, chatProbeAt: chatProbeOffset !== null ? hlsT0 + chatProbeOffset : null,
          signal: ctl.signal,
        }).then((r) => (results.browser = r)),
      );
    }
    /* The content phases: everyone has joined by the end of the ramp; then camera only, the host
     * sharing its screen, then a video file, then the engagement burst (its own job, above, at
     * the same moment). Each phase's start and end go into results.phases, for every number. */
    if (p.phases.length) {
      const shareVideo = p.phases.some((x) => x.kind === "video") ? makeShareVideo(Math.ceil(Math.max(...p.phases.filter((x) => x.kind === "video").map((x) => x.ms)) / 1000) + 60) : null;
      jobs.push(
        (async () => {
          const ph = (results.phases = [{ name: "join ramp", kind: "ramp", start: new Date(hlsT0).toISOString() }]);
          const next = (x, extra = {}) => {
            const now = new Date().toISOString();
            ph.at(-1).end = now;
            ph.push({ name: x.name, kind: x.kind, start: now, ...extra });
            console.log(`${stamp()} phase: ${x.name}`);
          };
          await sleep(hlsT0 + p.rampMs - Date.now(), ctl.signal);
          const lead = presenters[0];
          let sharing = false;
          for (const x of p.phases) {
            if (ctl.signal.aborted) break;
            const extra = {};
            if (sharing && x.kind !== "screen") {
              extra.stoppedShare = await lead?.stopShare().catch(() => false);
              sharing = false;
            }
            if (x.kind === "screen") sharing = extra.shared = !!(await lead?.startScreenShare().catch(() => false));
            if (x.kind === "video") {
              sharing = extra.shared = shareVideo ? !!(await lead?.shareVideoFile(shareVideo).catch(() => false)) : false;
              if (!shareVideo) warn("no ffmpeg: no video to share in the video phase");
            }
            next(x, extra);
            if ((x.kind === "screen" || x.kind === "video") && !extra.shared) warn(`phase ${x.name}: the host's share did not start (the room's buttons changed?); this phase is camera only`);
            await sleep(x.ms, ctl.signal);
          }
          if (sharing) await lead?.stopShare().catch(() => false);
          next({ name: "leave", kind: "leave" });
          ph.at(-1).end = new Date().toISOString();
        })(),
      );
    }
    if (!p.browser) jobs.push(
      runHlsViewers({
        api,
        slug: wb.id,
        keys: viewerKeys,
        steps: p.steps,
        holdMs: p.holdMs,
        rampMs: p.rampMs,
        workers: intFlag(f.workers, 0, "workers"),
        originBase: typeof f.origin === "string" ? f.origin : "",
        lowLatency: f.lowLatency === undefined ? null : !!f.lowLatency,
        signal: ctl.signal,
      }).then((r) => (results.hls = r)),
    );
    if (generatorsDone) jobs.push(generatorsDone.then((r) => (results.generators = r)));
    if (p.apiLoad) {
      jobs.push(
        runApiLoad({
          api, slug: wb.id, keys: spareKeys.length ? spareKeys : viewerKeys, run,
          pollId: () => (votePoll.paused ? "" : votePoll.id),
          rates: p.rates, eventsHoldMs: 60_000, durationMs: p.durationMs, windowMs: 30_000, signal: ctl.signal,
        }).then((r) => (results.apiLoad = r)),
      );
    }
    if (p.engage) {
      jobs.push(
        (async () => {
          await sleep(hlsT0 + p.engage.atMs - Date.now(), ctl.signal);
          if (ctl.signal.aborted) return;
          console.log(`${stamp()} engagement check starting (top step, ${p.viewers} viewers here)`);
          results.engage = await runEngage({
            // The viewers' seats (here and on the other generators): an audience that watches
            // and talks. Not api-load's, so neither eats the other's per-sender allowance.
            api, slug: wb.id, host, keys: [...viewerKeys, ...extraKeys], ...p.engage, signal: ctl.signal,
            beforePolls: () => (votePoll.paused = true),
            afterPolls: async () => {
              // Put api-load's poll back so its votes carry on.
              if (votePoll.id) await host.call("POST", `/host/webinars/${wb.id}/polls/${votePoll.id}/open`).catch(() => {});
              votePoll.paused = false;
            },
          }).catch((e) => ({ pass: false, error: e.message, checks: [{ area: "run", name: "engage", pass: false, detail: e.message }] }));
          console.log(`${stamp()} engagement check: ${results.engage.pass ? "PASS" : "FAIL"}`);
        })(),
      );
    }
    if (p.webrtc) {
      const wk = join(out, "webrtc-keys.json");
      writeFileSync(wk, JSON.stringify(webrtcKeys));
      jobs.push(
        runWebrtcAttendees({ web, api, steps: p.webrtcSteps, holdMs: p.holdMs, slug: wb.id, keysFile: wk, out: join(out, "webrtc.json"), cdpPort: 9600, signal: ctl.signal })
          .then((code) => (results.webrtcExit = code)),
      );
    }
    await Promise.allSettled(jobs);
    ctl.abort();
    await monitor;
    await cap.collect;

    // The recording: stop it, wait for the file, prove it plays.
    if (rec) {
      const recordedMs = Date.now() - rec.startedAt;
      await stopRecording(host, wb.id, rec.id, recordedMs).catch((e) => warn(`stopping the recording: ${e.message}`));
      console.log(`${stamp()} cloud recording ${rec.id} stopped after ${Math.round(recordedMs / 1000)} s; waiting for it to be ready`);
      const row = await waitReady(host, wb.id, rec.id, { timeoutMs: parseDuration(f.recordWait, 600_000) });
      const probe = row?.status === "ready" ? await probePlayable(host, wb.id, rec.id).catch((e) => ({ status: "neterr", bytes: 0, kind: "", error: e.message })) : null;
      results.recording = { id: rec.id, recordedMs, row, probe, ...checkRecording(row, probe, { recordedMs }) };
      rec = null;
    }

    if (prom && results.hls?.steps?.length) {
      results.serverMetrics = await stepMetrics(results.hls.steps, prom);
    }

    // ---- the summary ----
    // A browser run's report checks the captions too, so they are scored first.
    if (p.captions && p.browser) await finishCaptions({ results, p, cap, presenters, host, slug: wb.id, voices, warn });
    if (p.browser) {
      /* Every generator's viewers, summarised together and split by path and region
       * (lib/browser-summary.mjs), into browser.json / browser.md and the checks. */
      const parts = [results.browser, ...(results.generators ?? []).map((g) => g.result)].filter((x) => x?.viewers);
      for (const g of results.generators ?? []) if (!g.result) warn(`generator ${g.host}: ${g.error ?? `exit ${g.exit}`}`);
      for (const x of parts) for (const w of x.warnings ?? []) warn(w);
      const viewersAll = parts.flatMap((x) => x.viewers);
      const phases = results.phases ?? [{ name: "run", start: new Date(hlsT0).toISOString(), end: new Date().toISOString() }];
      const rep = browserReport(viewersAll, { target: p.viewers + p.extra, phases: results.phases });
      // The generators: CPU per phase (over 70% sustained = that generator's numbers are suspect).
      const inPh = (cpu, ph) => (cpu ?? []).filter((c) => c[0] >= Date.parse(ph.start) && c[0] < Date.parse(ph.end ?? new Date().toISOString())).map((c) => c[1]);
      results.browserGenerators = parts.map((x) => ({
        region: x.region, target: x.target, overloaded: x.overloaded, edges: x.edges,
        cpuPct: Object.fromEntries(phases.map((ph) => [ph.name, seriesStats(inPh(x.cpu, ph))])),
        probe: Object.fromEntries(Object.entries(x.probe ?? {}).map(([k, v]) => [k, v.summary])),
        chatSent: x.chatSent,
      }));
      // The server side per phase (Grafana Cloud), and the captions box's own latency lines.
      const server = prom ? await phaseMetrics(phases, prom).catch((e) => (warn(`server metrics: ${e.message}`), null)) : null;
      const captionsLog = p.captions
        ? await captionLatency({ from: Math.floor(Date.parse(phases[0].start) / 1000), to: Math.ceil(Date.now() / 1000), room: `webinar_${wb.id}` }).catch((e) => (warn(`caption latency (Loki): ${e.message}`), null))
        : null;
      results.serverPhases = server;
      results.captionsLog = captionsLog;
      // The extra checks: the box, the captions, the generators.
      const content = (server ?? []).filter((r) => !["join ramp", "leave"].includes(r.phase));
      const boxP95 = content.map((r) => r.boxCpuPct?.p95).filter(Number.isFinite);
      if (boxP95.length) rep.verdict.push({ name: "video box CPU p95 in every content phase", pass: Math.max(...boxP95) <= 80, detail: `worst ${Math.max(...boxP95)}% (needs <= 80%)` });
      const capP90 = captionsLog?.e2eP90Ms?.p95 ?? results.captions?.report?.webrtc?.latency?.p95 ?? null;
      if (p.captions) rep.verdict.push({ name: "caption delay p90", pass: capP90 !== null && capP90 <= 4000, detail: capP90 === null ? "no caption latency read" : `${capP90} ms (needs <= 4000 ms)${captionsLog ? " (captions box log)" : " (p95 at the host page, no Loki)"}` });
      const hot = results.browserGenerators.filter((g) => g.overloaded);
      rep.verdict.push({ name: "generators under 70% CPU (else the run is invalid)", pass: !hot.length, detail: hot.length ? `${hot.map((g) => g.region).join(", ")} ran hot` : "all under" });
      const md = browserMarkdown(rep) + serverMarkdown(server, results.browserGenerators, captionsLog, phases, wb.id);
      results.browserReport = rep;
      writeResults(join(out, "browser.json"), { report: rep, phases, generators: results.browserGenerators, server, captionsLog, viewers: viewersAll });
      writeFileSync(join(out, "browser.md"), md);
      console.log("\n" + md);
      if (results.browserGenerators.some((g) => g.overloaded)) warn("a generator ran out of CPU: its viewers' stalls may be its own; see browserGenerators");
      // The browser viewers' samples were for that report; results.json keeps the summary.
      if (results.browser) delete results.browser.viewers;
      for (const g of results.generators ?? []) if (g.result) delete g.result.viewers;
    }
    if (!p.browser) console.log("\n=== HLS viewers (this generator) ===\n" + (results.hls ? hlsTable(results.hls.steps) : "(no results)"));
    if (results.generators?.length && !p.browser) {
      for (const g of results.generators) {
        if (!g.ok && !g.result) warn(`generator ${g.host}: ${g.error ?? `exit ${g.exit}`}`);
        else if (g.result) console.log(`\n=== HLS viewers (${g.host}${g.ok ? "" : `, exit ${g.exit}`}) ===\n` + hlsTable(g.result.steps));
      }
      results.hlsAll = mergeGeneratorSteps([
        { label: "local", ...results.hls },
        ...results.generators.filter((g) => g.result).map((g) => ({ label: g.host, ...g.result })),
      ]);
      console.log("\n=== HLS viewers, all generators ===\n" + hlsTable(results.hlsAll));
    }
    if (p.captions && !p.browser) await finishCaptions({ results, p, cap, presenters, host, slug: wb.id, voices, warn });
    // The reservoirs were for that merge; results.json keeps the summaries.
    if (results.hls) delete results.hls.dumps;
    for (const g of results.generators ?? []) if (g.result) delete g.result.dumps;
    if (results.apiLoad) console.log("\n=== API load ===\n" + apiTable(results.apiLoad.windows));
    if (results.serverMetrics) {
      const cols = Object.keys(prom.queries);
      console.log("\n=== Server (Grafana) ===\n" + table(results.serverMetrics, [["step", "step"], ...cols.map((c) => [c, c])]));
    }
    if (results.serverViewers.length) {
      const peak = Math.max(...results.serverViewers.map((x) => x.viewers ?? 0));
      console.log(`\nserver-side edge viewer count peaked at ${peak} (target ${p.viewers + p.extra})`);
    }
    const checks = checksRows(results);
    if (checks.length) {
      const ok = checks.every((c) => c.pass);
      console.log(`\n=== Checks: ${ok ? "PASS" : "FAIL"} ===\n` + verdictTable(checks));
      results.checksPass = ok;
      if (!ok) process.exitCode = 1;
    }
    if (results.warnings.length) console.log("\nWarnings:\n" + results.warnings.map((w) => `  - ${w}`).join("\n"));
  } catch (e) {
    console.error(`${stamp()} FAILED: ${e.message}`);
    results.error = e.message;
    process.exitCode = 1;
  } finally {
    ctl.abort();
    if (rec && host) {
      // Failed or interrupted mid-run: stop the recording so the box lets go of it.
      await stopRecording(host, state.slug, rec.id, Date.now() - rec.startedAt).catch(() => {});
    }
    if (capTap) await capTap.stop().catch(() => {});
    await Promise.allSettled(presenters.map((x) => x.stop()));
    writeResults(join(out, "results.json"), results);
    console.log(`${stamp()} results: ${join(out, "results.json")}`);
    if (f.keep) {
      console.log(`${stamp()} --keep: left ${state.slug ?? "(no webinar)"} and the test accounts; clean up with: node run.mjs --cleanup ${statePath}${prod ? " --i-know-this-is-prod" : ""}`);
    } else {
      // Deleting the webinar deletes its recordings too.
      const errs = await cleanup(state);
      if (errs.length) {
        console.log(`${stamp()} cleanup incomplete; retry: node run.mjs --cleanup ${statePath}${prod ? " --i-know-this-is-prod" : ""}`);
        process.exitCode = 1;
      }
    }
  }
}

if (process.argv[1] === SELF) {
  main().catch((e) => {
    console.error(`${stamp()} ${e.message}`);
    process.exit(1);
  });
}

/* The captions check's end (--captions): the last packets and the microphones' open times
 * from the pages, the tap stopped, the session ended so the transcript is the stored one, then
 * everything scored against the scripts (captions.mjs). Into results.captions. */
async function finishCaptions({ results, p, cap, presenters, host, slug, voices, warn }) {
  const audio = [];
  for (const [i, x] of presenters.entries()) {
    cap.pages[i].push(...pageCaptions(await x.drainCaptions().catch(() => [])));
    audio.push(await x.audioState().catch(() => null));
  }
  if (cap.tap) await cap.tap.stop();
  let transcript = null;
  let transcriptError = null;
  try {
    // Ending here rather than at cleanup: the transcript is read back as it is after the session.
    await host.call("POST", `/host/webinars/${slug}/end`, undefined, { okStatuses: [409] });
    await sleep(3000);
    transcript = (await host.call("GET", `/host/webinars/${slug}/transcript.txt`)) ?? "";
    if (typeof transcript !== "string") transcript = String(transcript);
  } catch (e) {
    transcriptError = `transcript.txt: ${e.message}`;
    warn(`captions: ${transcriptError}`);
  }
  const localTop = results.hls?.steps?.[results.hls.steps.length - 1] ?? null;
  const allTop = results.hlsAll?.[results.hlsAll.length - 1] ?? localTop;
  const edgeLatencyMs = allTop?.latencyMs?.liveLatency?.p50 ?? null;
  const r = analyseCaptions({
    voices,
    labels: presenters.map((x) => x.label),
    webrtc: presenters.length ? cap.pages[0] : null,
    edge: cap.tap ? cap.tap.events : null,
    audio,
    edgeLatencyMs,
    delivery: p.delivery === "edge" ? edgeDelivery(localTop, allTop, cap.tap?.events ?? [], p.rampMs) : null,
    transcript,
    transcriptError,
    sourceSamples: cap.source,
    edgeRoom: p.delivery === "edge",
    thresholds: p.captions.thresholds,
  });
  r.report.observers = presenters.map((x, i) => ({ label: x.label, events: cap.pages[i].length, finals: cap.pages[i].filter((e) => !e.partial).length }));
  r.report.tap = cap.tap ? { events: cap.tap.events.length, connects: cap.tap.connects, serverCaptions: cap.tap.meta } : null;
  r.report.sourceSamples = cap.source;
  results.captions = r;
  const line = (name, s) => s && `  ${name}: ${s.finals} final(s), ${s.partials} partial(s); latency p50 ${s.latency.p50 ?? "-"} ms p95 ${s.latency.p95 ?? "-"} ms; ` +
    s.presenters.map((x) => `${x.label} WER ${x.wer.wer === null ? "-" : `${(x.wer.wer * 100).toFixed(1)}%`}`).join(", ");
  console.log(`\n=== Captions (${r.report.source.server ? "server" : "on-device"}) ===\n` +
    [line("WebRTC (host page)", r.report.webrtc), line("edge tap", r.report.edge),
      r.report.stored && `  stored: ${r.report.stored.lines} line(s); ` + r.report.stored.presenters.map((x) => `${x.label} WER ${x.wer.wer === null ? "-" : `${(x.wer.wer * 100).toFixed(1)}%`}`).join(", "),
      `  audio anchors: ${r.report.anchors.map((a) => `${a.label} ${a.anchor ?? "unknown"}${a.agentSkewMs !== null ? ` (agent start ${a.agentSkewMs} ms off)` : ""}`).join("; ")}`,
    ].filter(Boolean).join("\n"));
}

/** The box's own address rather than a CDN: a bare IP, or an sslip.io name (which is one). */
export function looksLikeOrigin(url) {
  let host = "";
  try {
    host = new URL(url).hostname;
  } catch {
    return false;
  }
  return /(^|\.)sslip\.io$/i.test(host) || /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.startsWith("[");
}

/* The server side of a browser run, per phase, for browser.md: the video and captions boxes,
 * Cloud Run, the database, the generators, the side probers, and the Bunny log command. */
export function serverMarkdown(server, gens, captionsLog, phases, slug) {
  const cell = (x) => (x ? `${x.avg}/${x.p95}/${x.max}` : "-");
  const lines = ["", "## Server and network, per phase (avg/p95/max)", ""];
  if (server?.length) {
    const cols = [
      ["box CPU %", "boxCpuPct"], ["box mem %", "boxMemPct"], ["box out Mbit/s", "boxTxMbps"], ["HLS out Mbit/s", "hlsOutMbps"],
      ["LiveKit loss p95 %", "livekitLossP95Pct"], ["captions cores", "captionsCpuCores"], ["captions MB", "captionsMemMB"],
      ["API instances", "apiInstances"], ["API req/s", "apiRps"], ["API p95 s", "apiP95Sec"], ["join p95 s", "apiJoinP95Sec"],
      ["say p95 s", "apiSayP95Sec"], ["vote p95 s", "apiVoteP95Sec"], ["5xx/s", "api5xxPerSec"], ["goroutines", "apiGoroutines"], ["DB MB", "dbSizeMB"],
    ];
    lines.push(`| phase | ${cols.map((c) => c[0]).join(" | ")} |`, `|---|${cols.map(() => "---").join("|")}|`);
    for (const r of server) lines.push(`| ${r.phase} | ${cols.map(([, k]) => cell(r[k] && "avg" in r[k] ? r[k] : null)).join(" | ")} |`);
    const svc = server.map((r) => `${r.phase}: ${Object.entries(r.boxCpuByService ?? {}).map(([k, v]) => `${k} ${v?.avg ?? "-"}`).join(", ")}`);
    lines.push("", `Box CPU by container (cores, avg): ${svc.join("; ")}`);
    lines.push("", "DB connections are not exported (Supabase pooler); the size gauge is.");
  } else lines.push("(no Grafana: set GRAFANA_PROM_URL / GRAFANA_PROM_TOKEN / GRAFANA_PROM_USER)");
  if (captionsLog) lines.push("", `Captions box latency lines: ${captionsLog.minutes} minute(s), ${captionsLog.finals} finals; e2e p50 ${cell(captionsLog.e2eP50Ms)} ms, p90 ${cell(captionsLog.e2eP90Ms)} ms`);
  lines.push("", "### Generators", "", `| region | viewers | CPU % per phase (avg/p95/max) | overloaded | CDN edge | prober playlist TTFB p50/p95 ms | prober segment TTFB p95 ms | prober errors |`, "|---|---|---|---|---|---|---|---|");
  for (const g of gens ?? []) {
    const pr = g.probe?.cdn ?? g.probe?.direct;
    lines.push(`| ${g.region} | ${g.target} | ${Object.entries(g.cpuPct ?? {}).map(([k, v]) => `${k} ${cell(v)}`).join("; ")} | ${g.overloaded ? `YES at ${g.overloaded.at}` : "no"} | ${Object.values(g.edges ?? {}).join(", ") || "-"} | ` +
      `${pr ? `${pr.playlist.ttfbP50Ms}/${pr.playlist.ttfbP95Ms}` : "-"} | ${pr ? pr.segment.ttfbP95Ms : "-"} | ${pr ? pr.playlist.errors + pr.segment.errors : "-"} |`);
  }
  const from = phases?.[0]?.start;
  const to = phases?.at(-1)?.end;
  lines.push("", "### Bunny's log for this window", "",
    "Download the day's log (Monitoring -> Logs -> webinarlivindiav -> Download), then:", "",
    "```", `node e2e/load/bunny-log.mjs --file <zone>.log --from ${from} --to ${to} --slug ${slug}`, "```", "");
  return lines.join("\n");
}
