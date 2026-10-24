/* One simulated edge (LL-HLS) viewer, following the browser's path (web/lib/edge-*.ts,
 * components/room/edge-player.tsx) as far as the server can tell the difference:
 *
 *   1. POST /api/webinars/{slug}/join {joinKey}         -> playbackUrl, eventsToken, lowLatency
 *   2. GET  /api/webinars/{slug}/events?t=<token>       held open (SSE); on connect the backlogs
 *      GET  /chat?since=0&joinKey, /questions?joinKey, /polls?joinKey, as the room does;
 *      "reconnect" -> reconnect after 0.5-2 s; 401 -> join again with ?rejoin=1 (3 tries);
 *      other failures back off 2 s .. 60 s.
 *   3. POST /api/webinars/{slug}/events/beat?t=<token>  every 30 s (attendance: a visit with no
 *      beat for 150 s is closed, so a viewer without beats would stop counting)
 *   4. the playlist and media as hls.js with lowLatencyMode does: multivariant -> one variant
 *      (+ its audio rendition, if separate), init segment once, start PART-HOLD-BACK behind
 *      live, fetch every part (or segment, without low latency) once in order, and alongside
 *      that reload the playlist with _HLS_msn/_HLS_part blocking requests while it advances,
 *      recovering from a failed one with a plain reload as hls.js does (nextReload below).
 *   5. POST /api/webinars/{slug}/events/leave?t=<token> at the end (pagehide's beacon).
 *
 * The bytes are read and dropped. A PlayerModel turns arrival times into stalls and a live
 * latency (wall clock minus EXT-X-PROGRAM-DATE-TIME at the playhead). */
import { timed } from "./client.mjs";
import { readSSE } from "./sse.mjs";
import { isMultivariant, parseMultivariant, parseMedia, nextBlockingRequest, withBlocking, pendingMedia } from "./hls.mjs";
import { PlayerModel } from "./player.mjs";
import { sleep } from "./args.mjs";

const BEAT_MS = 30_000;
// An empty buffer shorter than this is not counted as a stall (a frame or two; jitter).
const STALL_MIN_MS = 100;

/** Origin URL for a CDN playback URL: <originBase>/<slug>/... (playback is <base>/<slug>/index.m3u8). */
export function toOrigin(playbackUrl, slug, originBase) {
  const u = new URL(playbackUrl);
  const at = u.pathname.indexOf(`/${slug}/`);
  if (at < 0) throw new Error(`playback URL ${playbackUrl} has no /${slug}/ in it`);
  return originBase.replace(/\/$/, "") + u.pathname.slice(at) + u.search;
}

export class EdgeViewer {
  constructor(o, ctx) {
    this.o = o; // { api, slug, joinKey, originBase?, lowLatency?: bool|null, variant, events, backlog, beatMs }
    this.ctx = ctx; // { step } the current Step
    this.ctl = new AbortController();
    this.player = new PlayerModel();
    this.state = { joined: false, joinFailed: false, eventsOpen: false, playing: false };
    this.token = "";
    this.playback = "";
    this.serverLowLatency = false;
  }

  get step() {
    return this.ctx.step;
  }

  gauges() {
    return {
      active: this.state.joined && !this.ctl.signal.aborted ? 1 : 0,
      joinFailed: this.state.joinFailed ? 1 : 0,
      eventsOpen: this.state.eventsOpen ? 1 : 0,
      playing: this.player.startedAt !== null ? 1 : 0,
      stalledNow: this.player.isStalled() ? 1 : 0,
      bufferMs: Math.round(this.player.bufferAhead() * 1000),
    };
  }

  rec(name, r, what = name) {
    this.step.sample(name, r.ms);
    if (!r.ok) this.step.error(what, r.status);
    if (r.bytes) this.step.bytes += r.bytes;
  }

  async join(rejoin = false) {
    const { api, slug, joinKey } = this.o;
    for (let attempt = 0; attempt < 3; attempt++) {
      const r = await timed(`${api}/webinars/${slug}/join${rejoin ? "?rejoin=1" : ""}`, {
        method: "POST",
        body: { joinKey },
        signal: this.ctl.signal,
      });
      this.rec(rejoin ? "rejoin" : "join", r);
      if (r.ok) {
        const j = JSON.parse(r.body);
        if (j.delivery !== "edge" || !j.playbackUrl || !j.eventsToken) {
          this.step.error("join", "not-edge");
          this.state.joinFailed = true;
          return false;
        }
        this.token = j.eventsToken;
        this.playback = this.o.originBase ? toOrigin(j.playbackUrl, slug, this.o.originBase) : j.playbackUrl;
        this.serverLowLatency = !!j.lowLatency;
        this.state.joined = true;
        this.state.joinFailed = false;
        this.step.count(rejoin ? "rejoinOk" : "joinOk");
        return true;
      }
      this.step.count(rejoin ? "rejoinFail" : "joinFail");
      // 409 too_early/not_started and 429 are worth a retry; the rest are not.
      if (![409, 429, 500, 502, 503, 504, "timeout", "neterr"].includes(r.status)) break;
      await sleep(1000 * (attempt + 1), this.ctl.signal);
    }
    this.state.joinFailed = true;
    return false;
  }

  async start() {
    if (!(await this.join())) return;
    const tasks = [this.hls()];
    if (this.o.events !== false) tasks.push(this.events(), this.beats());
    await Promise.allSettled(tasks);
  }

  async stop() {
    this.ctl.abort();
    if (this.token) {
      // The page's sendBeacon on pagehide; not timed into the step (it is the end).
      await timed(`${this.o.api}/webinars/${this.o.slug}/events/leave?t=${encodeURIComponent(this.token)}`, {
        method: "POST",
        timeoutMs: 5000,
      });
    }
  }

  // ---------------------------------------------------------------- events + beats

  async events() {
    const { api, slug } = this.o;
    let backoff = 2000;
    let rejoins = 0;
    while (!this.ctl.signal.aborted) {
      const url = `${api}/webinars/${slug}/events?t=${encodeURIComponent(this.token)}`;
      const r = await timed(url, { stream: true, timeoutMs: 15000, signal: this.ctl.signal, headers: { accept: "text/event-stream" } });
      if (this.ctl.signal.aborted) break;
      this.step.sample("eventsConnect", r.ms);
      if (r.status === 401 && rejoins < 3) {
        rejoins++;
        this.step.error("events", 401);
        if (await this.join(true)) continue;
      }
      if (!r.ok) {
        this.step.error("events", r.status);
        this.step.count("eventsFail");
        try {
          await r.res?.body?.cancel();
        } catch {}
        await sleep(backoff, this.ctl.signal);
        backoff = Math.min(60000, backoff * 2);
        continue;
      }
      backoff = 2000;
      this.state.eventsOpen = true;
      this.step.count("eventsOpen");
      if (this.o.backlog !== false) this.backlogs().catch(() => {});
      let reconnect = false;
      const bytes = await readSSE(r.res, {
        onEvent: (name) => {
          this.step.count(`event:${name}`);
          if (name === "reconnect") reconnect = true;
        },
      });
      this.step.bytes += bytes;
      this.state.eventsOpen = false;
      if (this.ctl.signal.aborted) break;
      this.step.count(reconnect ? "eventsReconnect" : "eventsDropped");
      await sleep(reconnect ? 500 + Math.random() * 1500 : 2000, this.ctl.signal);
    }
    this.state.eventsOpen = false;
  }

  async backlogs() {
    const { api, slug, joinKey } = this.o;
    const k = encodeURIComponent(joinKey);
    const urls = [
      `${api}/webinars/${slug}/chat?since=0&joinKey=${k}`,
      `${api}/webinars/${slug}/questions?joinKey=${k}`,
      `${api}/webinars/${slug}/polls?joinKey=${k}`,
    ];
    await Promise.all(
      urls.map(async (u) => {
        const r = await timed(u, { signal: this.ctl.signal });
        if (!this.ctl.signal.aborted) this.rec("backlog", r);
      }),
    );
  }

  async beats() {
    const { api, slug } = this.o;
    const every = this.o.beatMs ?? BEAT_MS;
    // The first beat is the event stream connecting (edge.go); then every 30 s, with a little
    // jitter so a ramp does not beat in lockstep.
    await sleep(every * (0.8 + Math.random() * 0.4), this.ctl.signal);
    while (!this.ctl.signal.aborted) {
      const r = await timed(`${api}/webinars/${slug}/events/beat?t=${encodeURIComponent(this.token)}`, {
        method: "POST",
        signal: this.ctl.signal,
      });
      if (this.ctl.signal.aborted) break;
      this.rec("beat", r);
      this.step.count(r.ok ? "beatOk" : "beatFail");
      await sleep(every, this.ctl.signal);
    }
  }

  // ---------------------------------------------------------------- HLS

  async hls() {
    const sig = this.ctl.signal;
    // The multivariant playlist. Before the mix is up it 404s; hls.js retries every second.
    let master = null;
    for (let i = 0; i < 120 && !sig.aborted; i++) {
      const r = await timed(this.playback, { signal: sig });
      if (sig.aborted) return;
      this.rec("master", r);
      if (r.ok) {
        master = r;
        break;
      }
      await sleep(1000, sig);
    }
    if (!master) return;
    const text = master.body;
    if (!isMultivariant(text)) {
      await this.track(this.playback, text, true);
      return;
    }
    const mv = parseMultivariant(text, this.playback);
    if (!mv.variants.length) {
      this.step.error("master", "no-variants");
      return;
    }
    // hls.js starts on the first listed variant; --variant highest|lowest pins one instead.
    const v =
      this.o.variant === "lowest"
        ? mv.variants[mv.variants.length - 1]
        : this.o.variant === "highest"
          ? mv.variants[0]
          : (mv.variants.find((x) => x.index === 0) ?? mv.variants[0]);
    const tracks = [this.track(v.uri, null, true)];
    const audio = mv.media.find((m) => m.type === "AUDIO" && m.default) ?? mv.media.find((m) => m.type === "AUDIO");
    if (audio && audio.uri !== v.uri) tracks.push(this.track(audio.uri, null, false));
    await Promise.allSettled(tracks);
  }

  /* One media playlist, played to the end of the run. `main` drives the player model (video).
   *
   * Two loops, as in hls.js: the playlist loader (reloads(): its level / audio-track
   * controller) and the media loader (media(): its stream controller) run side by side and
   * share the newest playlist. They used to be one loop that reloaded only once every pending
   * part had arrived, so a part that took 10 s left the next blocking reload 10 s stale. */
  async track(url, firstText, main) {
    const sig = this.ctl.signal;
    let first = null;
    if (firstText !== null && firstText !== undefined) first = { pl: parseMedia(firstText, url), ageSec: 0, ms: 0 };
    while (!first && !sig.aborted) {
      const r = await timed(url, { signal: sig });
      if (sig.aborted) return;
      this.rec("playlist", r);
      if (r.ok) first = { pl: parseMedia(r.body, url), ageSec: ageOf(r), ms: r.ms };
      else await sleep(1000, sig);
    }
    if (!first) return;
    const pl = first.pl;
    const ll = (this.o.lowLatency ?? this.serverLowLatency) && pl.partTarget > 0;
    const startBack = ll ? pl.partHoldBack || 3 * pl.partTarget : pl.holdBack || 3 * pl.targetDuration;
    if (pl.map) {
      const r = await timed(pl.map.uri, { signal: sig });
      if (sig.aborted) return;
      this.rec("init", r);
    }
    const live = new Latest(pl, sig);
    const media = { lastNew: Date.now() };
    await Promise.allSettled([this.reloads(url, live, ll, first, media), this.media(live, ll, startBack, main, media)]);
  }

  /* The playlist loader: blocking reloads with delivery directives while the playlist
   * advances, and hls.js's recovery when one fails (nextReload). */
  async reloads(url, live, ll, first, media) {
    const sig = this.ctl.signal;
    let last = { ok: true, advanced: true, ageSec: first.ageSec, elapsedMs: first.ms };
    let errors = 0;
    let tuneInGoal = 0;
    while (!sig.aborted && !live.value.endList) {
      const pl = live.value;
      const plan = nextReload({ pl, ll, ...last, retry: errors, tuneInGoal });
      tuneInGoal = plan.tuneInGoal;
      if (plan.delayMs > 0) await sleep(plan.delayMs, sig);
      if (sig.aborted) return;
      const blocking = plan.req !== null;
      const r = await timed(withBlocking(url, plan.req), {
        signal: sig,
        timeoutMs: blocking ? blockingTimeoutMs(pl) : PLAYLIST_TIMEOUT_MS,
      });
      if (sig.aborted) return;
      this.rec(blocking ? "playlistBlocking" : "playlist", r, "playlist");
      if (r.ok) {
        const next = parseMedia(r.body, url);
        if (errors > 0) this.step.count("playlistRecovered");
        errors = 0;
        last = { ok: true, advanced: playlistAdvanced(pl, next), ageSec: ageOf(r), elapsedMs: r.ms };
        live.set(next);
      } else {
        last = { ok: false, timedOut: r.status === "timeout", blocking, elapsedMs: r.ms };
        errors++;
      }
      if (Date.now() - media.lastNew > 30000) {
        // The stream stopped producing (presenter gone, mix stopped): note it once a while.
        this.step.error("hls", "no-new-media-30s");
        media.lastNew = Date.now();
      }
    }
  }

  /* The media loader: every part (or segment) once, in order, from the newest playlist. */
  async media(live, ll, startBack, main, media) {
    const sig = this.ctl.signal;
    let cursor = null;
    while (!sig.aborted) {
      const pl = live.value;
      const seen = live.version;
      // Behind the start of the sliding window (after an outage): hls.js does not try to play
      // what the origin has dropped, it starts again at the live sync position.
      if (cursor !== null && fellOutOfWindow(pl, cursor)) {
        this.step.count("rejoinLive");
        cursor = null;
      }
      const items = pendingMedia(pl, cursor, { lowLatency: ll, startBackSec: startBack });
      if (!items.length) {
        if (pl.endList) return;
        await live.changed(seen);
        continue;
      }
      for (const it of items) {
        if (sig.aborted) return;
        const r = await timed(it.uri, { signal: sig, timeoutMs: Math.max(10000, pl.targetDuration * 3000) });
        if (sig.aborted) return;
        const kind = it.part ? "part" : "segment";
        this.rec(kind, r);
        cursor = it.key;
        if (!r.ok) continue; // hls.js skips a part it cannot load and carries on
        this.step.count(kind);
        media.lastNew = Date.now();
        if (main) {
          const { stalledMs, latencyMs } = this.player.append(it.duration, it.pdt);
          // A few ms of an empty buffer is timer jitter, not something a viewer sees.
          if (stalledMs >= STALL_MIN_MS) {
            this.step.count("stall");
            this.step.sample("stallMs", stalledMs);
          }
          if (latencyMs !== null) this.step.sample("liveLatency", latencyMs);
        }
        // The window moved past the rest of this list while it was fetched: start again from
        // the newest playlist rather than ask for media the origin no longer has.
        if (live.version !== seen && fellOutOfWindow(live.value, cursor)) break;
      }
    }
  }
}

/* ---------------------------------------------------------------- reload policy (pure)
 *
 * What hls.js 1.7 (base-playlist-controller.ts playlistLoaded / checkRetry,
 * playlist-loader.ts, error-controller.ts) asks for after each media playlist response, with
 * the player's config (web/lib/edge-hls.ts: levelLoadingMaxRetry 60 and
 * levelLoadingRetryDelay 1000, so a playlist error is retried after 1 s, doubling to 8 s).
 *
 * Spelled out because of the 1,000-viewer CDN run of 2026-10-24. The kit retried a failed
 * blocking reload with the same _HLS_msn/_HLS_part every second, for ever. MediaMTX
 * (gohlslib muxer_stream.go) answers 400 at once to an _HLS_msn more than one segment past
 * the one being written, or older than the oldest segment it still lists, so once a CDN 503
 * or an 11 s timeout had held a viewer a few seconds its URL was out of the window and every
 * retry was another 400: one bad response took a track off the stream for the rest of the
 * step (one part timeout -> 173 x "playlist 400" in step 2 on lg2; ~1 a second per stuck
 * track in step 3). hls.js never repeats a failed request's directives: it reloads the plain
 * playlist (at once after a blocking-reload timeout, else after the retry delay) and asks
 * for the part after the newest that one lists. */

const PLAYLIST_TIMEOUT_MS = 10_000; // playlistLoadPolicy maxTimeToFirstByteMs

/** hls.js's timeout for a blocking reload: max(3 part targets, 0.8 target durations). */
export function blockingTimeoutMs(pl) {
  if (!(pl.partTarget > 0) || !(pl.targetDuration > 0)) return PLAYLIST_TIMEOUT_MS;
  return Math.min(PLAYLIST_TIMEOUT_MS, Math.max(pl.partTarget * 3, pl.targetDuration * 0.8) * 1000);
}

/** The newest media a playlist lists, as hls.js LevelDetails has it: endSn, lastPartSn, lastPartIndex. */
export function playlistEdge(pl) {
  const last = pl.segments[pl.segments.length - 1];
  const endSn = last ? last.msn : pl.mediaSequence - 1;
  if (pl.trailingParts.length) return { endSn, partSn: endSn + 1, partIndex: pl.trailingParts.length - 1 };
  if (last && last.parts.length) return { endSn, partSn: endSn, partIndex: last.parts.length - 1 };
  return { endSn, partSn: endSn, partIndex: -1 };
}

/** LevelDetails.reloaded: whether `next` lists media past `prev`'s newest. */
export function playlistAdvanced(prev, next) {
  if (!prev) return true;
  const a = playlistEdge(prev);
  const b = playlistEdge(next);
  const partSnDiff = b.partSn - a.partSn;
  return b.endSn > a.endSn || partSnDiff > 0 || (partSnDiff === 0 && b.partIndex > a.partIndex);
}

/* nextReload -> { req: {msn, part}|null, delayMs, tuneInGoal }: the next playlist request
 * (req null: the plain playlist, no delivery directives) and how long to wait before it.
 *
 *   pl                  the newest playlist this viewer has
 *   ll                  low-latency mode (blocking reloads)
 *   ok                  whether the last playlist request succeeded
 *   advanced, ageSec    (ok) whether it listed anything new; its Age header (CDN cache age)
 *   timedOut, blocking  (failed) a timeout or not; whether it carried directives
 *   retry               failures in a row before this one (hls.js playlistError)
 *   elapsedMs           how long the last request took
 *   tuneInGoal          the last call's tuneInGoal */
export function nextReload({ pl, ll, ok, advanced = true, ageSec = 0, timedOut = false, blocking = false, retry = 0, elapsedMs = 0, tuneInGoal = 0 }) {
  const td = pl.targetDuration > 0 ? pl.targetDuration : 1;
  if (!ok) {
    // checkRetry: "The LL-HLS request already timed out so retry immediately" without
    // directives; any other failure (400, 503, network) after the retry delay, also without.
    if (timedOut && blocking) return { req: null, delayMs: 0, tuneInGoal };
    return { req: null, delayMs: Math.min(1000 * 2 ** retry, 8000), tuneInGoal };
  }
  if (ll && pl.canBlockReload && advanced) {
    let req = nextBlockingRequest(pl);
    let goal = 0;
    // Low-Latency CDN tune-in: a playlist the CDN had cached for a while is that far behind
    // live, so ask for the one that much further on, or for the plain playlist if it is old.
    const want = Math.min(ageSec - pl.partTarget, td * 1.5);
    if (want > 0) {
      if (ageSec > td * 3) req = null;
      else if (!(tuneInGoal && ageSec - pl.partTarget > tuneInGoal)) {
        goal = want;
        const part = req.part === null ? null : req.part + Math.round((goal % td) / pl.partTarget);
        req = { msn: req.msn + Math.floor(goal / td), part };
      }
    }
    return { req, delayMs: 0, tuneInGoal: goal };
  }
  // Polling (no blocking reloads, or the playlist did not advance): computeReloadInterval, a
  // target duration after the last request started, half of one when nothing changed.
  const interval = advanced ? td * 1000 : td * 500;
  return { req: null, delayMs: Math.max(0, Math.round(interval - elapsedMs)), tuneInGoal: 0 };
}

/** Whether what follows `cursor` (a pendingMedia key) has already left the playlist. */
export function fellOutOfWindow(pl, cursor) {
  const first = pl.segments[0];
  if (!first) return false;
  return Math.floor(cursor / 1000) < first.msn - 1;
}

function ageOf(r) {
  const v = Number(r.headers?.get?.("age"));
  return Number.isFinite(v) && v > 0 ? v : 0;
}

/* The newest value two loops share, and a wait for the next one. One abort listener for the
 * lot rather than one per wait: a viewer waits several times a second. */
class Latest {
  constructor(value, signal) {
    this.value = value;
    this.version = 0;
    this.signal = signal;
    this.waiters = [];
    signal.addEventListener("abort", () => this.wake(), { once: true });
  }
  set(value) {
    this.value = value;
    this.version++;
    this.wake();
  }
  wake() {
    const w = this.waiters;
    this.waiters = [];
    for (const f of w) f();
  }
  /** Resolves once there is a value newer than `version`, or the run ends. */
  changed(version) {
    if (this.version !== version || this.signal.aborted) return Promise.resolve();
    return new Promise((r) => this.waiters.push(r));
  }
}
