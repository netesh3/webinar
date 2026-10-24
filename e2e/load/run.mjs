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
 * Checks
 *   --engage              during the top step: a chat burst, questions and upvotes, polls and
 *                         quizzes one at a time, then verify what the server stored (engage.mjs);
 *                         sizes with --engage-chat 200 --engage-questions 20 --engage-upvotes 60
 *                         --engage-polls 3 --engage-quizzes 2 --engage-voters 100
 *   --record              cloud-record the session (grants the test host cloud_recording), stop
 *                         at the end and verify: ready (within --record-wait 10m), size,
 *                         duration, the file plays
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
import { startPresenter, testMediaFlags } from "./presenter.mjs";
import { hlsTable, apiTable, writeResults } from "./lib/report.mjs";
import { BOX_WAIT_MS, waitForVideoServer } from "./lib/box.mjs";
import { grantCloudRecording, startRecording, stopRecording, waitReady, probePlayable, checkRecording } from "./lib/recording.mjs";
import { generatorPlan, parseHosts, startGenerators, mergeGeneratorSteps } from "./lib/generators.mjs";
import { promConfig, stepMetrics } from "./lib/metrics.mjs";
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

export function plan(f) {
  const notes = [];
  const steps = parseSteps(f.steps, [50, 200, 500, 1000]);
  const rampMs = parseDuration(f.ramp, 30_000);
  const holdMs = parseDuration(f.hold, 120_000);
  const viewers = steps[steps.length - 1];
  const hosts = parseHosts(f.generators);
  /* More viewers than one generator can pull (its NIC, its cores): seats for other generators,
   * which run hls-viewers.mjs on their own slice, started at the same instant (--start-at). */
  const extraGiven = f.extraSeats !== undefined && f.extraSeats !== true;
  const extra = extraGiven ? intFlag(f.extraSeats, 0, "extra-seats") : hosts.length ? viewers * hosts.length : 0;
  if (hosts.length && !extraGiven) notes.push(`--generators without --extra-seats: ${viewers} viewers on each of ${hosts.length} generator(s), ${extra} in all`);
  if (hosts.length && !extra) throw new Error("--generators with --extra-seats 0: nothing for them to run");
  let maxViewers = Math.min(intFlag(f.maxViewers, 1000, "max-viewers"), ABSOLUTE_MAX_VIEWERS);
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
  const presenters = intFlag(f.presenters, 1, "presenters");
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
  // joins, then the other generators'.
  const webrtc = webrtcSteps.length ? webrtcSteps[webrtcSteps.length - 1] : 0;
  if (viewers + webrtc + extra > ABSOLUTE_MAX_VIEWERS) throw new Error(`${viewers + webrtc + extra} seats is over the hard cap ${ABSOLUTE_MAX_VIEWERS}`);
  const spare = apiLoad ? Math.max(0, Math.min(1000, ABSOLUTE_MAX_VIEWERS - viewers - webrtc - extra, Math.max(50, Math.ceil((rates.vote * durationMs) / 1000)))) : 0;
  const extraSteps = scaleSteps(steps, extra);
  const generators = hosts.length ? generatorPlan(extra, extraSteps, hosts) : [];
  const seats = viewers + webrtc + spare + extra;
  const engage = f.engage
    ? {
        chat: intFlag(f.engageChat, ENGAGE_DEFAULTS.chat, "engage-chat"),
        questions: intFlag(f.engageQuestions, ENGAGE_DEFAULTS.questions, "engage-questions"),
        upvotes: intFlag(f.engageUpvotes, ENGAGE_DEFAULTS.upvotes, "engage-upvotes"),
        polls: intFlag(f.engagePolls, ENGAGE_DEFAULTS.polls, "engage-polls"),
        quizzes: intFlag(f.engageQuizzes, ENGAGE_DEFAULTS.quizzes, "engage-quizzes"),
        voters: intFlag(f.engageVoters, ENGAGE_DEFAULTS.voters, "engage-voters"),
        atMs: topStepAt(steps, rampMs, holdMs),
      }
    : null;
  return {
    steps, rampMs, holdMs, viewers, maxViewers, presenters, webrtcSteps, webrtc, delivery, apiLoad, rates, durationMs,
    seats, spare: seats - viewers - webrtc - extra, extra, extraSteps, generators,
    boxWaitMs: parseDuration(f.boxWait, BOX_WAIT_MS), record: !!f.record, engage, notes,
  };
}

/* checksRows(results) -> the PASS/FAIL lines of a run: engagement and recording. */
function checksRows(results) {
  const rows = [];
  for (const c of results.engage?.checks ?? []) rows.push({ ...c, area: `engage ${c.area}` });
  for (const c of results.recording?.checks ?? []) rows.push({ ...c, area: "recording" });
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
  console.log(`  ${p.delivery} webinar, ${p.presenters} presenter(s)${f.screenShare ? " + screen share" : ""}, HLS viewers ${p.steps.join(" -> ")} ` +
    `(ramp ${p.rampMs / 1000}s, hold ${p.holdMs / 1000}s, about ${Math.round(p.durationMs / 60000)} min)` +
    (f.origin ? `, from the ORIGIN ${f.origin}` : ", via the playback URL join returns"));
  for (const n of p.notes) console.log(`  note: ${n}`);
  if (p.generators.length) {
    for (const g of p.generators) console.log(`  generator ${g.host}: ${g.count} viewers (seats ${g.from}-${g.from + g.count - 1} of the extra), steps ${g.steps.join(" -> ")}`);
  } else if (p.extra) console.log(`  ${p.extra} extra viewers for generators you start by hand, steps ${p.extraSteps.join(" -> ")}`);
  if (p.apiLoad) console.log(`  API load: ${JSON.stringify(p.rates)} per second`);
  if (p.engage) console.log(`  engagement check at the top step (+${Math.round(p.engage.atMs / 1000)}s): ${JSON.stringify({ ...p.engage, atMs: undefined })}`);
  if (p.record) console.log("  cloud recording: on, verified at the end");
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
  try {
    const admin = await adminSession(api);
    state.host = await createTestHost(api, admin, run, { sfuProject: f.sfuProject });
    saveState(statePath, state);
    console.log(`${stamp()} test host ${state.host.email}`);
    if (p.record) {
      await grantCloudRecording(admin, state.host.id);
      console.log(`${stamp()} test host granted cloud_recording`);
    }
    host = await new Session(api, "host").login(state.host.email, state.host.password);
    const wb = await createWebinar(host, `Load test ${run}`, { delivery: p.delivery });
    state.slug = wb.id;
    saveState(statePath, state);
    console.log(`${stamp()} webinar ${wb.id} (delivery ${wb.delivery ?? "?"})`);
    if (p.delivery === "edge" && wb.delivery && wb.delivery !== "edge") throw new Error(`asked for edge, got ${wb.delivery}: does the server have BROADCAST_RTMP_BASE?`);

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
    const spareKeys = keys.slice(p.viewers + p.webrtc, p.seats - p.extra);
    const extraKeys = keys.slice(p.seats - p.extra);
    console.log(`${stamp()} ${keys.length} seat(s) minted`);

    await host.call("POST", `/host/webinars/${wb.id}/start`);
    console.log(`${stamp()} live`);

    // A cold on-demand box boots now (2-4 min): wait for it before the stage tries to join.
    const box = await waitForVideoServer({ api, slug: wb.id, timeoutMs: p.boxWaitMs, signal: ctl.signal });
    if (box && box.state !== "ready") warn(`the video server is still ${box.state} after --box-wait ${Math.round(p.boxWaitMs / 1000)}s; carrying on`);

    const mediaFlags = testMediaFlags();
    if (!mediaFlags.length) console.log(`${stamp()} no ffmpeg: presenters use Chrome's built-in fake camera`);
    const who = p.presenters ? [{ ...state.host, label: "host" }, ...panelists.map((x, i) => ({ ...x, label: `panelist${i + 2}` }))] : [];
    for (const [i, x] of who.entries()) {
      presenters.push(
        await startPresenter({
          web, api, slug: wb.id, email: x.email, password: x.password, label: x.label, port: 9700 + i,
          screenShare: i === 0 && !!f.screenShare, mediaFlags, boxWaitMs: p.boxWaitMs,
        }),
      );
    }

    // The audience stream (the mix) takes a little while to start after the stage publishes.
    if (p.delivery === "edge") {
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
          viewerArgs: viewerFlags,
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
          `  node hls-viewers.mjs --web ${web} ${viewerFlags.join(" ")} --keys keys-extra.json --steps ${p.extraSteps.join(",")} ` +
          `--max-viewers ${p.extra} --start-at ${startAt}\n`);
      }
      await sleep(startAt - Date.now(), ctl.signal);
    }
    const hlsT0 = Date.now();
    const jobs = [
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
    ];
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
    console.log("\n=== HLS viewers (this generator) ===\n" + (results.hls ? hlsTable(results.hls.steps) : "(no results)"));
    if (results.generators?.length) {
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
