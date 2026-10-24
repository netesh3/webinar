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
 *      live, fetch every part (or segment, without low latency) once in order, reload the
 *      playlist with _HLS_msn/_HLS_part blocking requests when the server can block, else
 *      every target duration.
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

  /* One media playlist, played to the end of the run. `main` drives the player model (video). */
  async track(url, firstText, main) {
    const sig = this.ctl.signal;
    let pl = null;
    if (firstText !== null && firstText !== undefined) pl = parseMedia(firstText, url);
    while (!pl && !sig.aborted) {
      const r = await timed(url, { signal: sig });
      if (sig.aborted) return;
      this.rec("playlist", r);
      if (r.ok) pl = parseMedia(r.body, url);
      else await sleep(1000, sig);
    }
    if (!pl) return;
    const ll = (this.o.lowLatency ?? this.serverLowLatency) && pl.partTarget > 0;
    const startBack = ll ? pl.partHoldBack || 3 * pl.partTarget : pl.holdBack || 3 * pl.targetDuration;
    if (pl.map) {
      const r = await timed(pl.map.uri, { signal: sig });
      if (sig.aborted) return;
      this.rec("init", r);
    }
    let cursor = null;
    let lastNew = Date.now();
    while (!sig.aborted && !pl.endList) {
      const items = pendingMedia(pl, cursor, { lowLatency: ll, startBackSec: startBack });
      for (const it of items) {
        if (sig.aborted) return;
        const r = await timed(it.uri, { signal: sig, timeoutMs: Math.max(10000, pl.targetDuration * 3000) });
        if (sig.aborted) return;
        const kind = it.part ? "part" : "segment";
        this.rec(kind, r);
        cursor = it.key;
        if (!r.ok) continue; // hls.js skips a part it cannot load and carries on
        this.step.count(kind);
        lastNew = Date.now();
        if (main) {
          const { stalledMs, latencyMs } = this.player.append(it.duration, it.pdt);
          // A few ms of an empty buffer is timer jitter, not something a viewer sees.
          if (stalledMs >= STALL_MIN_MS) {
            this.step.count("stall");
            this.step.sample("stallMs", stalledMs);
          }
          if (latencyMs !== null) this.step.sample("liveLatency", latencyMs);
        }
      }
      // Next playlist: blocking reload when the server can hold it, else poll like hls.js.
      const req = ll ? nextBlockingRequest(pl) : null;
      if (req) {
        const r = await timed(withBlocking(url, req), { signal: sig, timeoutMs: pl.targetDuration * 3000 + 5000 });
        if (sig.aborted) return;
        this.rec("playlistBlocking", r, "playlist");
        if (r.ok) pl = parseMedia(r.body, url);
        else await sleep(1000, sig);
      } else {
        const wait = items.length ? pl.targetDuration * 1000 : (pl.targetDuration * 1000) / 2;
        await sleep(wait, sig);
        const r = await timed(url, { signal: sig });
        if (sig.aborted) return;
        this.rec("playlist", r);
        if (r.ok) pl = parseMedia(r.body, url);
      }
      if (Date.now() - lastNew > 30000) {
        // The stream stopped producing (presenter gone, mix stopped): note it once a while.
        this.step.error("hls", "no-new-media-30s");
        lastNew = Date.now();
      }
    }
  }
}
