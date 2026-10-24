/* The captions check (run.mjs --captions; docs/LOAD-TESTING.md "Captions"): the presenters
 * speak known scripts (lib/voice.mjs), and this module
 *
 *   - turns captions on for the session (the test webinar is created with "Live captions"
 *     ticked; PATCH /host/webinars/{slug}/controls {captionsEnabled: true} once the stage is
 *     up, which brings the server caption agent in where the host has the captions feature;
 *     AI does not have to be on since PR #711);
 *   - samples which source serves them: GET /host/webinars/{slug}/ controls.serverCaptions
 *     (the agent reported live) / serverCaptionsPending (asked for, not live: on-device meanwhile);
 *   - listens as one edge viewer would (EdgeCaptionTap: its own seat, the SSE events stream)
 *     while lib/viewer.mjs counts captions per simulated viewer, and as a WebRTC participant
 *     (the presenters' pages record the caption packets off LiveKit's data channels);
 *   - reads the stored transcript back after the session (GET .../transcript.txt);
 *   - scores it all against the scripts: delivery, latency, word error rate (lib/captions.mjs). */
import { timed } from "./lib/client.mjs";
import { readSSE } from "./lib/sse.mjs";
import { sleep } from "./lib/args.mjs";
import {
  parseCaptionEvent,
  captionFromPacket,
  scriptTimeline,
  mapIdentities,
  anchorCandidates,
  chooseAnchor,
  contended,
  analyseStream,
  analyseStored,
  parseTranscript,
  edgeHoldMs,
  captionChecks,
  CAPTION_THRESHOLDS,
} from "./lib/captions.mjs";

/** Captions on, mid-session (the room's Captions button does the same PATCH). */
export async function enableCaptions(host, slug) {
  return host.call("PATCH", `/host/webinars/${slug}/controls`, { captionsEnabled: true });
}

/** Which source is serving: { at, captionsEnabled, server, pending }. */
export async function captionSource(host, slug) {
  const wb = await host.call("GET", `/host/webinars/${slug}/`);
  const c = wb?.controls ?? {};
  return { at: Date.now(), captionsEnabled: !!c.captionsEnabled, server: !!c.serverCaptions, pending: !!c.serverCaptionsPending };
}

/* summariseSource(samples) -> { server, pending, onDevice, samples, liveSamples, firstLiveAt }:
 * server when the agent went live and stayed live in at least 90 % of the samples after that. */
export function summariseSource(samples) {
  const on = samples.filter((s) => s.captionsEnabled);
  const first = on.findIndex((s) => s.server);
  const after = first >= 0 ? on.slice(first) : [];
  const live = after.filter((s) => s.server).length;
  const server = first >= 0 && live >= 0.9 * after.length;
  return {
    server,
    pending: !server && on.some((s) => s.pending),
    onDevice: !server && on.length > 0,
    samples: on.length,
    liveSamples: on.filter((s) => s.server).length,
    firstLiveAt: first >= 0 ? new Date(on[first].at).toISOString() : null,
  };
}

/* One edge viewer's events stream, kept only for its captions (and the room metadata's
 * serverCaptions): its own seat, joined like any viewer, reconnecting like one, no video. */
export class EdgeCaptionTap {
  constructor({ api, slug, joinKey }) {
    this.o = { api, slug, joinKey };
    this.ctl = new AbortController();
    this.events = [];
    this.meta = []; // { at, serverCaptions } as the room metadata changed
    this.connects = 0;
    this.token = "";
  }

  async join() {
    const r = await timed(`${this.o.api}/webinars/${this.o.slug}/join${this.token ? "?rejoin=1" : ""}`, {
      method: "POST",
      body: { joinKey: this.o.joinKey },
      signal: this.ctl.signal,
    });
    if (!r.ok) return false;
    const j = JSON.parse(r.body);
    this.token = j.eventsToken ?? "";
    return !!this.token;
  }

  onEvent(name, data) {
    const at = Date.now();
    if (name === "meta") {
      try {
        const m = JSON.parse(data);
        const sc = !!m?.controls?.serverCaptions;
        if (this.meta[this.meta.length - 1]?.serverCaptions !== sc) this.meta.push({ at, serverCaptions: sc });
      } catch {}
      return;
    }
    const c = parseCaptionEvent(name, data);
    if (c && this.events.length < 100_000) this.events.push({ at, ...c });
  }

  start() {
    this.done = (async () => {
      const sig = this.ctl.signal;
      while (!sig.aborted && !(await this.join())) await sleep(3000, sig);
      const beats = (async () => {
        while (!sig.aborted) {
          await sleep(30_000, sig);
          if (!sig.aborted) await timed(`${this.o.api}/webinars/${this.o.slug}/events/beat?t=${encodeURIComponent(this.token)}`, { method: "POST", signal: sig });
        }
      })();
      while (!sig.aborted) {
        const r = await timed(`${this.o.api}/webinars/${this.o.slug}/events?t=${encodeURIComponent(this.token)}`, {
          stream: true, timeoutMs: 15000, signal: sig, headers: { accept: "text/event-stream" },
        });
        if (sig.aborted) break;
        if (r.status === 401) {
          await this.join();
          continue;
        }
        if (!r.ok) {
          await sleep(2000, sig);
          continue;
        }
        this.connects++;
        await readSSE(r.res, { onEvent: (n, d) => this.onEvent(n, d) });
        await sleep(500, sig);
      }
      await beats;
    })().catch(() => {});
    return this;
  }

  async stop() {
    this.ctl.abort();
    await this.done;
    if (this.token) await timed(`${this.o.api}/webinars/${this.o.slug}/events/leave?t=${encodeURIComponent(this.token)}`, { method: "POST", timeoutMs: 5000 });
  }
}

/** A presenter page's drained packets -> caption events. */
export function pageCaptions(drained) {
  const out = [];
  for (const d of drained ?? []) {
    const c = captionFromPacket(d?.packet);
    if (c && Number.isFinite(d.at)) out.push({ at: d.at, ...c });
  }
  return out;
}

/* edgeDelivery(localTop, allTop, tapEvents, rampMs) -> { viewers, finalsPerViewer, tapFinals,
 * ratio, total }: over the top step's hold, the finals each viewer that had its events stream
 * open since before the hold received (lib/viewer.mjs gauges capHoldViewers/capHoldFinals,
 * summed over processes and generators), against what the tap received in the same window. */
export function edgeDelivery(localTop, allTop, tapEvents, rampMs) {
  if (!localTop) return null;
  const s = allTop ?? localTop;
  const start = Date.parse(localTop.startedAt);
  const holdStart = start + rampMs;
  const end = start + localTop.seconds * 1000;
  const tapFinals = tapEvents.filter((e) => !e.partial && e.at >= holdStart && e.at <= end).length;
  const viewers = s.capHoldViewers ?? 0;
  const finalsPerViewer = viewers ? (s.capHoldFinals ?? 0) / viewers : 0;
  return {
    viewers,
    active: s.active ?? null,
    finalsPerViewer,
    tapFinals,
    ratio: tapFinals ? finalsPerViewer / tapFinals : 0,
    total: (s.counts?.caption ?? 0) + (s.counts?.captionPartial ?? 0),
  };
}

/* analyseCaptions(o) -> { pass, checks, report }. o: { voices (makeVoices), labels, webrtc:
 * [events] | null, edge: [events] | null, audio: [AUDIO_STATE per presenter], edgeLatencyMs,
 * delivery, transcript (text) | null, transcriptError, sourceSamples, edgeRoom, thresholds }. */
export function analyseCaptions(o) {
  const timelines = o.voices.presenters.map((v) => scriptTimeline(v, o.voices.loopMs));
  const all = [...(o.webrtc ?? []), ...(o.edge ?? [])];
  const identities = mapIdentities(all, timelines);
  const anchors = [];
  const anchorInfo = [];
  for (const [p, tl] of timelines.entries()) {
    const mine = all.filter((e) => identities[e.identity] === p && !e.partial);
    const cands = anchorCandidates(o.audio?.[p]);
    const a = chooseAnchor(cands, mine, tl);
    anchors.push(a.anchor);
    anchorInfo.push({ label: o.labels[p], anchor: a.anchor ? new Date(a.anchor).toISOString() : null, candidates: cands.length, agentSkewMs: a.skewMs });
  }
  const excluded = contended(timelines, anchors);
  const ctx = { timelines, labels: o.labels, anchors, identities, excluded, holdMs: () => 0 };
  const webrtc = o.webrtc ? analyseStream(o.webrtc, ctx) : null;
  const delaySec = Number.isFinite(o.edgeLatencyMs) ? o.edgeLatencyMs / 1000 : null;
  const edge = o.edge ? analyseStream(o.edge, { ...ctx, holdMs: (e) => edgeHoldMs(delaySec, e.lagMs) }) : null;
  let stored = null;
  if (typeof o.transcript === "string") stored = analyseStored(parseTranscript(o.transcript), ctx, (webrtc?.finals ? webrtc : edge)?.placed ?? []);
  const source = summariseSource(o.sourceSamples ?? []);
  const checks = captionChecks({ source, webrtc, edge, edgeLatencyMs: o.edgeLatencyMs, delivery: o.delivery, stored, storedError: o.transcriptError, edgeRoom: o.edgeRoom }, o.thresholds ?? CAPTION_THRESHOLDS);
  return {
    pass: checks.every((c) => c.pass),
    checks,
    report: { source, identities, anchors: anchorInfo, loopMs: o.voices.loopMs, engine: o.voices.engine, webrtc, edge, stored, delivery: o.delivery ?? null, edgeLatencyMs: o.edgeLatencyMs ?? null },
  };
}
