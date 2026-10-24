#!/usr/bin/env node
/* One command for a load test (docs/LOAD-TESTING.md):
 *
 *   test host + edge webinar -> load-test seats -> go live -> presenters on stage ->
 *   ramp HLS viewers (+ API load, + WebRTC tabs) -> summary -> end -> delete everything
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
 * Load
 *   --steps 50,200        HLS viewers per step (default 50,200,500,1000)
 *   --ramp 30s --hold 120s
 *   --workers N           viewer processes (default: one per 150 viewers, up to the CPU count)
 *   --presenters N        0-3 people on stage publishing a test video (default 1; 0 = you present)
 *   --screen-share        the host presenter also shares its screen (best effort)
 *   --api-load            chat/Q&A/poll/join traffic while the viewers run; rates with
 *                         --chat --question --upvote --vote --join --register --events (per second)
 *   --extra-seats N       N more viewers on other generator droplets: prints their hls-viewers.mjs
 *                         command and starts everyone together after --extra-wait (90s)
 *   --webrtc-steps 5,10   WebRTC attendee tabs too (standard delivery only; see webrtc-attendees.mjs)
 *   --low-latency / --no-low-latency   force the viewers' player mode (default: what join says,
 *                         EDGE_PLAYBACK_LOW_LATENCY; the browser may also step up to LL by itself)
 * Safety
 *   --max-viewers N       refuse more than N viewers (default 1000; hard cap 5000)
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
import { join } from "node:path";
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
import { startPresenter, testMediaFlags } from "./presenter.mjs";
import { hlsTable, apiTable, writeResults } from "./lib/report.mjs";

const SELF = fileURLToPath(import.meta.url);

export function plan(f) {
  const steps = parseSteps(f.steps, [50, 200, 500, 1000]);
  const rampMs = parseDuration(f.ramp, 30_000);
  const holdMs = parseDuration(f.hold, 120_000);
  const maxViewers = Math.min(intFlag(f.maxViewers, 1000, "max-viewers"), ABSOLUTE_MAX_VIEWERS);
  const viewers = steps[steps.length - 1];
  if (viewers > maxViewers) throw new Error(`${viewers} viewers is over --max-viewers ${maxViewers} (hard cap ${ABSOLUTE_MAX_VIEWERS})`);
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
  // Seats: one per HLS viewer, then the WebRTC tabs, then spare ones for API load's votes and joins.
  const webrtc = webrtcSteps.length ? webrtcSteps[webrtcSteps.length - 1] : 0;
  const spare = apiLoad ? Math.max(0, Math.min(1000, ABSOLUTE_MAX_VIEWERS - viewers - webrtc, Math.max(50, Math.ceil((rates.vote * durationMs) / 1000)))) : 0;
  /* More viewers than one generator can pull (its NIC, its cores): seats for other generators,
   * which run hls-viewers.mjs on their own slice, started at the same instant (--start-at). */
  const extra = intFlag(f.extraSeats, 0, "extra-seats");
  if (viewers + extra > maxViewers) throw new Error(`${viewers} + ${extra} extra viewers is over --max-viewers ${maxViewers}`);
  const extraSteps = [];
  for (const n of steps) {
    const m = Math.max(Math.round((n * extra) / viewers), (extraSteps[extraSteps.length - 1] ?? 0) + 1);
    if (extra && m <= extra) extraSteps.push(m);
  }
  if (extra && extraSteps[extraSteps.length - 1] !== extra) extraSteps.push(extra);
  const seats = Math.min(ABSOLUTE_MAX_VIEWERS, viewers + webrtc + spare + extra);
  return { steps, rampMs, holdMs, viewers, presenters, webrtcSteps, webrtc, delivery, apiLoad, rates, durationMs, seats, spare: seats - viewers - webrtc - extra, extra, extraSteps };
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
  console.log(`${stamp()} load test ${run} against ${web} (API ${api})${prod ? "  ** PRODUCTION **" : ""}`);
  console.log(`  ${p.delivery} webinar, ${p.presenters} presenter(s)${f.screenShare ? " + screen share" : ""}, HLS viewers ${p.steps.join(" -> ")} ` +
    `(ramp ${p.rampMs / 1000}s, hold ${p.holdMs / 1000}s, about ${Math.round(p.durationMs / 60000)} min)` +
    (f.origin ? `, from the ORIGIN ${f.origin}` : ", via the playback URL join returns"));
  if (p.apiLoad) console.log(`  API load: ${JSON.stringify(p.rates)} per second`);
  if (p.webrtc) console.log(`  WebRTC tabs ${p.webrtcSteps.join(" -> ")}`);
  console.log(`  ${p.seats} seat(s); results in ${out}`);

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

  const results = { run, web, api, plan: p, presenters: [], serverViewers: [] };
  try {
    const admin = await adminSession(api);
    state.host = await createTestHost(api, admin, run, { sfuProject: f.sfuProject });
    saveState(statePath, state);
    console.log(`${stamp()} test host ${state.host.email}`);
    const host = await new Session(api, "host").login(state.host.email, state.host.password);
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

    const mediaFlags = testMediaFlags();
    if (!mediaFlags.length) console.log(`${stamp()} no ffmpeg: presenters use Chrome's built-in fake camera`);
    const who = p.presenters ? [{ ...state.host, label: "host" }, ...panelists.map((x, i) => ({ ...x, label: `panelist${i + 2}` }))] : [];
    for (const [i, x] of who.entries()) {
      presenters.push(
        await startPresenter({ web, api, slug: wb.id, email: x.email, password: x.password, label: x.label, port: 9700 + i, screenShare: i === 0 && !!f.screenShare, mediaFlags }),
      );
    }

    // The audience stream (the mix) takes a little while to start after the stage publishes.
    if (p.delivery === "edge") {
      const waitMs = parseDuration(f.waitLive, 180_000);
      let st = null;
      for (let t = 0; t < waitMs && !ctl.signal.aborted; t += 3000) {
        st = await host.call("GET", `/host/webinars/${wb.id}/edge`).catch(() => null);
        if (st?.audienceStream === "live") break;
        await sleep(3000, ctl.signal);
      }
      console.log(`${stamp()} audience stream: ${st?.audienceStream ?? "unknown"} ${st?.playbackUrl ?? ""}`);
      if (st?.audienceStream !== "live") console.log(`${stamp()} WARNING: the audience stream is not live yet; viewers will retry the playlist`);
      if (!f.origin && looksLikeOrigin(st?.playbackUrl)) {
        console.log(`${stamp()} WARNING: the playback URL is the video box itself, not a CDN pull zone: every viewer loads the origin ` +
          "(set the project's edgePlaybackBase to the pull zone; deploy/digitalocean/README.md)");
      }
    }

    let pollId = "";
    if (p.apiLoad && p.rates.vote > 0) {
      const poll = await host.call("POST", `/host/webinars/${wb.id}/polls`, { question: "Load test poll", kind: "poll", options: ["One", "Two", "Three"] });
      pollId = poll.id;
      await host.call("POST", `/host/webinars/${wb.id}/polls/${pollId}/open`);
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

    if (p.extra) {
      // The other generators: same steps, scaled, starting at the same instant as this one.
      const extraFile = join(out, "keys-extra.json");
      writeFileSync(extraFile, JSON.stringify(extraKeys));
      const startAt = Date.now() + parseDuration(f.extraWait, 90_000);
      console.log(`\n${stamp()} ${p.extra} more viewers for other generators. Copy ${extraFile} to each and run, within ` +
        `${Math.round((startAt - Date.now()) / 1000)}s (split it with --from/--steps for more than one):\n` +
        `  node hls-viewers.mjs --web ${web} --api ${api} --slug ${wb.id} --keys keys-extra.json --steps ${p.extraSteps.join(",")} ` +
        `--ramp ${p.rampMs / 1000}s --hold ${p.holdMs / 1000}s --start-at ${startAt}${f.origin ? ` --origin ${f.origin}` : ""}` +
        `${f.lowLatency === undefined ? "" : f.lowLatency ? " --low-latency" : " --no-low-latency"}${prod ? " --i-know-this-is-prod" : ""}\n`);
      await sleep(startAt - Date.now(), ctl.signal);
    }
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
    if (p.apiLoad) {
      jobs.push(
        runApiLoad({ api, slug: wb.id, keys: spareKeys.length ? spareKeys : viewerKeys, run, pollId, rates: p.rates, eventsHoldMs: 60_000, durationMs: p.durationMs, windowMs: 30_000, signal: ctl.signal })
          .then((r) => (results.apiLoad = r)),
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

    console.log("\n=== HLS viewers ===\n" + (results.hls ? hlsTable(results.hls.steps) : "(no results)"));
    if (results.apiLoad) console.log("\n=== API load ===\n" + apiTable(results.apiLoad.windows));
    if (results.serverViewers.length) {
      const peak = Math.max(...results.serverViewers.map((x) => x.viewers ?? 0));
      console.log(`\nserver-side edge viewer count peaked at ${peak} (target ${p.viewers})`);
    }
  } catch (e) {
    console.error(`${stamp()} FAILED: ${e.message}`);
    results.error = e.message;
    process.exitCode = 1;
  } finally {
    ctl.abort();
    await Promise.allSettled(presenters.map((x) => x.stop()));
    writeResults(join(out, "results.json"), results);
    console.log(`${stamp()} results: ${join(out, "results.json")}`);
    if (f.keep) {
      console.log(`${stamp()} --keep: left ${state.slug ?? "(no webinar)"} and the test accounts; clean up with: node run.mjs --cleanup ${statePath}${prod ? " --i-know-this-is-prod" : ""}`);
    } else {
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
