// The captions check (run.mjs --captions): text normalisation and WER, aligning lines to the
// script, the packet parsers (SSE, data channel, transcript.txt), the voice schedule and WAV
// maths, the page tap in a stub browser, and the analysis and verdicts on synthetic sessions.
import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import {
  numberWords,
  normalise,
  wer,
  align,
  findCaptionJson,
  parseCaptionEvent,
  captionFromPacket,
  parseTranscript,
  scriptTimeline,
  loopOf,
  contended,
  chooseAnchor,
  anchorCandidates,
  placeLines,
  werOver,
  edgeHoldMs,
  captionChecks,
  CAPTION_TAP,
  CAPTION_THRESHOLDS,
} from "../lib/captions.mjs";
import { scheduleVoices, readWav, writeWav, resample, trimSilence, SCRIPTS, RATE } from "../lib/voice.mjs";
import { analyseCaptions, edgeDelivery, summariseSource, pageCaptions } from "../captions.mjs";
import { plan, captionsPlan, checksRows } from "../run.mjs";
import { EdgeViewer } from "../lib/viewer.mjs";
import { Step } from "../lib/stats.mjs";
import { withVoice } from "../presenter.mjs";

test("numbers in words", () => {
  assert.equal(numberWords(0), "zero");
  assert.equal(numberWords(45), "forty five");
  assert.equal(numberWords(100), "one hundred");
  assert.equal(numberWords(2300), "two thousand three hundred");
  assert.equal(numberWords(1_000_024), "one million twenty four");
});

test("normalise: case, punctuation, digits, contractions, fillers", () => {
  assert.deepEqual(normalise("Good morning, everyone!"), ["good", "morning", "everyone"]);
  assert.deepEqual(normalise("About 45 minutes"), normalise("about forty five minutes"));
  assert.deepEqual(normalise("brings 20% more"), ["brings", "twenty", "percent", "more"]);
  assert.deepEqual(normalise("$5 at 10:30"), ["five", "dollars", "at", "ten", "thirty"]);
  assert.deepEqual(normalise("1,000 people, 2.5 times"), ["one", "thousand", "people", "two", "point", "five", "times"]);
  assert.deepEqual(normalise("the 3rd and 21st"), ["the", "third", "and", "twenty", "first"]);
  assert.deepEqual(normalise("We're here, it's fine, don't"), ["we", "are", "here", "it", "is", "fine", "do", "not"]);
  assert.deepEqual(normalise("um, follow-up, OK"), ["follow", "up", "okay"]);
  assert.deepEqual(normalise("twenty four hours"), normalise("24 hours"));
  // Every script sentence survives normalisation with its words.
  for (const s of SCRIPTS.flat()) assert.ok(normalise(s).length >= 4, s);
});

test("word error rate", () => {
  const w = (a, b) => wer(normalise(a), normalise(b));
  assert.equal(w("the cat sat", "the cat sat").wer, 0);
  const sub = w("the cat sat on the mat", "the cat sat on the hat");
  assert.deepEqual([sub.sub, sub.del, sub.ins, sub.n], [1, 0, 0, 6]);
  const del = w("one two three four", "one three four");
  assert.deepEqual([del.del, del.errors], [1, 1]);
  const ins = w("one two", "one big two");
  assert.deepEqual([ins.ins, ins.wer], [1, 0.5]);
  assert.equal(w("", "").wer, 0);
  assert.equal(w("", "noise").wer, 1);
  assert.equal(w("nothing was heard", "").wer, 1);
  // Numbers: spoken words vs Whisper's digits are not errors.
  assert.equal(w("about forty five minutes and twenty percent", "About 45 minutes and 20%.").wer, 0);
});

test("align: where a line sits in the script", () => {
  const ref = normalise("one two three four five six seven eight nine ten");
  assert.deepEqual(align(normalise("five six seven"), ref), { start: 4, end: 7, matches: 3, score: 6 });
  const a = align(normalise("five sex seven eight"), ref);
  assert.equal(a.start, 4);
  assert.equal(a.end, 8);
  assert.equal(align(normalise("x y z"), ref), null, "nothing matches");
  assert.equal(align(["five"], ref), null, "one word is too short to place");
});

test("caption packets: SSE, data channel bytes, transcript.txt", () => {
  const pkt = { from: { identity: "u1", name: "Host", role: "host" }, id: "u1:1", kind: "caption", text: "Hello {world}", startedAt: 1, endedAt: 2, lagMs: 300 };
  assert.deepEqual(parseCaptionEvent("packet", JSON.stringify(pkt)), { identity: "u1", name: "Host", text: "Hello {world}", id: "u1:1", startedAt: 1, endedAt: 2, lagMs: 300 });
  assert.equal(parseCaptionEvent("packet", JSON.stringify({ kind: "chat", text: "caption" })), null);
  assert.equal(parseCaptionEvent("meta", JSON.stringify(pkt)), null);
  assert.equal(parseCaptionEvent("packet", "{not json"), null);
  assert.equal(parseCaptionEvent("packet", JSON.stringify({ ...pkt, partial: true })).partial, true);
  // A LiveKit DataPacket: protobuf framing around the JSON payload, and a stray "{" before it.
  const bytes = Buffer.concat([Buffer.from([0x0a, 0x7b, 0x12, 0x8a, 0x01]), Buffer.from(JSON.stringify(pkt)), Buffer.from([0x1a, 0x07]), Buffer.from("webcast")]);
  const found = findCaptionJson(new TextDecoder().decode(bytes));
  assert.equal(found.text, "Hello {world}");
  assert.equal(findCaptionJson("no packet here"), null);
  assert.equal(captionFromPacket({ kind: "caption", text: "  " }), null);
  assert.deepEqual(pageCaptions([{ at: 5, packet: pkt }, { at: 6, packet: { kind: "chat" } }]).map((e) => e.at), [5]);
  const lines = parseTranscript("10:00:01 host_1: Good morning: all\n10:00:03 pan_2: Thank you\n\n[transcript truncated]\n");
  assert.deepEqual(lines, [
    { time: "10:00:01", identity: "host_1", text: "Good morning: all" },
    { time: "10:00:03", identity: "pan_2", text: "Thank you" },
  ]);
});

test("the page tap records caption packets and microphone opens (stub browser)", async () => {
  class Chan {
    constructor() {
      this._h = null;
      this._ls = [];
    }
    get onmessage() {
      return this._h;
    }
    set onmessage(f) {
      this._h = f;
    }
    addEventListener(t, f) {
      if (t === "message") this._ls.push(f);
    }
  }
  Object.defineProperty(Chan.prototype, "onmessage", Object.getOwnPropertyDescriptor(Chan.prototype, "onmessage"));
  class Track {
    constructor(id) {
      this.id = id;
      this.kind = "audio";
    }
    clone() {
      return new Track(`${this.id}-c`);
    }
  }
  const win = {};
  const ctx = {
    window: win,
    RTCDataChannel: Chan,
    MediaStreamTrack: Track,
    TextDecoder,
    ArrayBuffer,
    WeakSet,
    Date,
    Object,
    JSON,
    Uint8Array,
    navigator: { mediaDevices: { getUserMedia: async () => ({ getAudioTracks: () => [new Track("mic1")] }) } },
  };
  vm.createContext(ctx);
  vm.runInContext(CAPTION_TAP, ctx);
  const ch = new Chan();
  let got = 0;
  ch.onmessage = () => got++;
  const pkt = JSON.stringify({ kind: "caption", from: { identity: "a" }, text: "hi there" });
  ch._h({ data: new TextEncoder().encode(`\x0a\x05${pkt}`).buffer });
  assert.equal(got, 1, "LiveKit's own handler still runs");
  assert.equal(win.__load.captions.length, 1);
  assert.equal(win.__load.captions[0].packet.text, "hi there");
  const s = await ctx.navigator.mediaDevices.getUserMedia({ audio: true });
  const t = s.getAudioTracks()[0];
  assert.equal(win.__load.audioOpens.length, 1);
  const c = t.clone();
  assert.equal(win.__load.trackOpen[c.id], win.__load.trackOpen["mic1"], "a clone keeps its source's open time");
});

test("voice schedule: turns with overlap, one loop for all", () => {
  const d = [[3000, 2000], [1000, 1000, 1000], [5000]];
  const s = scheduleVoices(d, { leadMs: 1000, gapMs: 500, overlapMs: 2000, tailMs: 4000 });
  assert.deepEqual(s.presenters[0].sentences, [{ startMs: 1000, endMs: 4000 }, { startMs: 4500, endMs: 6500 }]);
  // Presenter 2 starts 2 s before presenter 1 stops.
  assert.equal(s.presenters[1].startMs, 4500);
  assert.equal(s.presenters[1].endMs, 4500 + 3000 + 1000);
  assert.equal(s.presenters[2].startMs, 8500 - 2000);
  assert.equal(s.loopMs, 6500 + 5000 + 4000);
  // An overlap longer than the speaker before never starts before them.
  const t = scheduleVoices([[1000], [1000]], { leadMs: 0, overlapMs: 5000 });
  assert.equal(t.presenters[1].startMs, 0);
  assert.equal(scheduleVoices([[1000]], { tailMs: 4000, leadMs: 1000 }).loopMs, 6000);
});

test("WAV: write, read, resample, trim", () => {
  const n = RATE / 10;
  const x = new Float32Array(n).map((_, i) => 0.5 * Math.sin((2 * Math.PI * 440 * i) / RATE));
  const back = readWav(writeWav(x));
  assert.equal(back.rate, RATE);
  assert.equal(back.samples.length, n);
  assert.ok(Math.abs(back.samples[100] - x[100]) < 1e-3);
  assert.equal(resample(x, RATE, 22050).length, Math.round((n * 22050) / RATE));
  assert.equal(resample(x, 22050, RATE).length, Math.round((n * RATE) / 22050));
  const padded = new Float32Array(RATE).fill(0);
  padded.set(x, RATE / 2);
  const tr = trimSilence(padded);
  assert.ok(tr.length < n + RATE * 0.07 && tr.length >= n - 10, `trimmed to ${tr.length}`);
  assert.throws(() => readWav(Buffer.from("nope")), /WAV/);
});

// A synthetic session: three presenters, 4 s per sentence, captions arriving after a known
// delay, with known anchors (when each one's microphone opened).
function fixture({ errors = 0, partialMs = 1500, finalMs = 1200, presenters = 2, drop = () => false } = {}) {
  const scripts = SCRIPTS.slice(0, presenters).map((s) => s.slice(0, 6));
  const sched = scheduleVoices(scripts.map((s) => s.map(() => 4000)), { leadMs: 1000, gapMs: 500, overlapMs: 6000, tailMs: 4000 });
  const voices = {
    engine: "test",
    loopMs: sched.loopMs,
    presenters: sched.presenters.map((pp, p) => ({ wav: `p${p}.wav`, sentences: pp.sentences.map((x, s) => ({ text: scripts[p][s], ...x })) })),
  };
  const t0 = 1_800_000_000_000;
  const anchors = voices.presenters.map((_, p) => t0 + p * 1300);
  const events = [];
  let bad = errors;
  for (const [p, v] of voices.presenters.entries()) {
    for (let K = 0; K < 3; K++) {
      for (const [s, x] of v.sentences.entries()) {
        if (drop(p, K, s)) continue;
        const spoken = anchors[p] + K * voices.loopMs + x.startMs;
        const words = x.text.split(" ");
        let text = x.text;
        if (bad > 0) {
          text = words.map((w, i) => (i === 1 ? "banana" : w)).join(" ");
          bad--;
        }
        const id = `id${p}:${spoken}`;
        events.push({ at: spoken + partialMs, identity: `id${p}`, text: words.slice(0, 3).join(" "), id, partial: true });
        events.push({ at: anchors[p] + K * voices.loopMs + x.endMs + finalMs, identity: `id${p}`, text, id, startedAt: spoken + 80, endedAt: spoken + 4000, lagMs: finalMs });
      }
    }
  }
  events.sort((a, b) => a.at - b.at);
  // The microphones: the sent track's open is the anchor; an earlier preview open is a decoy.
  const audio = anchors.map((a) => ({ opens: [{ at: a - 20_000, id: "preview" }, { at: a, id: "mic" }], sent: [{ id: "mic", at: a, enabled: true, state: "live" }] }));
  return { voices, events, anchors, audio, t0 };
}

test("script timeline, loops and anchors", () => {
  const { voices, events, anchors } = fixture();
  const tl = scriptTimeline(voices.presenters[0], voices.loopMs);
  assert.equal(tl.wordAt(0), voices.presenters[0].sentences[0].startMs);
  const s1 = tl.sentences[1];
  assert.equal(tl.wordAt(s1.w0), s1.startMs);
  assert.ok(tl.wordAt(s1.w0 + 1) > s1.startMs && tl.wordAt(s1.w0 + 1) < s1.endMs);
  assert.equal(tl.wordAt(tl.n + s1.w0), voices.loopMs + s1.startMs, "the next loop");
  assert.equal(tl.sentenceOf(s1.w0 + 1), 1);
  assert.equal(loopOf(anchors[0] + 2 * voices.loopMs + s1.startMs + 2500, anchors[0], tl, s1.w0), 2);
  // The anchor: the sent track's open time agrees with the agent's speech starts; the decoy not.
  const mine = events.filter((e) => e.identity === "id0" && !e.partial);
  const a = chooseAnchor([anchors[0] - 20_000, anchors[0]], mine, tl);
  assert.equal(a.anchor, anchors[0]);
  assert.ok(Math.abs(a.skewMs - 80) < 400, `skew ${a.skewMs}`);
  assert.deepEqual(chooseAnchor([], mine, tl), { anchor: null, skewMs: null });
  assert.deepEqual(anchorCandidates({ opens: [{ at: 1 }, { at: 2 }], sent: [{ at: 2, state: "live" }] }), [2, 1]);
});

test("placing lines: by arrival with an anchor, by order without", () => {
  const { voices, events, anchors } = fixture();
  const tl = scriptTimeline(voices.presenters[0], voices.loopMs);
  const finals = events.filter((e) => e.identity === "id0" && !e.partial);
  const timed = placeLines(finals, tl, { anchor: anchors[0] });
  const ordered = placeLines(finals, tl);
  assert.deepEqual(timed.map((l) => l.K), ordered.map((l) => l.K));
  assert.deepEqual([...new Set(timed.map((l) => l.K))], [0, 1, 2]);
  const w = werOver(timed, tl);
  assert.equal(w.wer, 0);
  assert.equal(w.n, 3 * tl.n);
});

test("contention: a third concurrent speaker's sentences are left out", () => {
  const { voices, anchors } = fixture({ presenters: 3 });
  const tls = voices.presenters.map((v) => scriptTimeline(v, voices.loopMs));
  const two = contended(tls.slice(0, 2), anchors.slice(0, 2));
  assert.equal(two(0, 0, 5), false, "two speakers are never contended");
  // Line all three up exactly: presenter 1 talks over 0's end and 2's start.
  const same = [0, -tls[1].sentences[0].startMs + tls[0].sentences[4].startMs, -tls[2].sentences[0].startMs + tls[0].sentences[4].startMs];
  const c = contended(tls, same);
  assert.equal(c(0, 0, 4), true);
  assert.equal(c(0, 0, 0), false);
  assert.equal(contended(tls, [null, null, null])(0, 0, 4), false, "no anchors: nothing excluded");
});

test("edge hold mirrors web/lib/caption-sync.ts", () => {
  assert.equal(edgeHoldMs(null, 500), 0);
  assert.equal(edgeHoldMs(3, 1000), 2500);
  assert.equal(edgeHoldMs(3, undefined), 2500);
  assert.equal(edgeHoldMs(30, 0), 10_000);
  assert.equal(edgeHoldMs(1, 5000), 0);
});

function analyse(f, extra = {}) {
  const tlines = f.events.filter((e) => !e.partial).map((e) => `10:00:00 ${e.identity}: ${e.text}`).join("\n");
  return analyseCaptions({
    voices: f.voices,
    labels: f.voices.presenters.map((_, i) => (i ? `panelist${i + 1}` : "host")),
    webrtc: f.events,
    edge: f.events.map((e) => ({ ...e, at: e.at + 200 })),
    audio: f.audio,
    edgeLatencyMs: 3000,
    delivery: { viewers: 100, finalsPerViewer: 20, tapFinals: 20, ratio: 1, total: 4000 },
    transcript: tlines,
    sourceSamples: [{ at: 1, captionsEnabled: true, server: false, pending: true }, { at: 2, captionsEnabled: true, server: true }, { at: 3, captionsEnabled: true, server: true }],
    edgeRoom: true,
    ...extra,
  });
}

test("analysis: a clean session passes every check", () => {
  const r = analyse(fixture());
  const failed = r.checks.filter((c) => !c.pass);
  assert.deepEqual(failed, [], JSON.stringify(failed, null, 1));
  assert.equal(r.report.webrtc.latency.p50, 1500, "phrase start -> the first partial");
  // Edge: on screen after the page's hold (3 s delay + 0.5 s - lag 1 s default for a partial).
  assert.equal(r.report.edge.latency.p50, 1500 + 200 + edgeHoldMs(3, undefined));
  assert.equal(r.report.webrtc.presenters[0].wer.wer, 0);
  assert.equal(r.report.stored.presenters[1].wer.wer, 0);
  assert.deepEqual(r.report.identities, { id0: 0, id1: 1 });
  assert.ok(r.report.anchors.every((a) => a.agentSkewMs !== null && Math.abs(a.agentSkewMs - 80) < 400));
  assert.equal(r.report.webrtc.presenters[0].missed, 0);
});

test("analysis: wrong words, late lines, missing lines and the wrong source fail", () => {
  // One wrong word in every line: about 1 in 13 words.
  const noisy = analyse(fixture({ errors: 1000 }));
  const w = noisy.report.webrtc.presenters[0].wer;
  assert.ok(w.wer > 0.06 && w.wer < 0.1, `wer ${w.wer}`);
  assert.ok(noisy.checks.find((c) => c.name === "live WER host").pass, "under 25 %");
  assert.equal(noisy.checks.find((c) => c.name === "stored WER host").pass, true);
  const strict = analyse(fixture({ errors: 1000 }), { thresholds: { ...CAPTION_THRESHOLDS, liveWer: 0.05, storedWer: 0.05 } });
  assert.equal(strict.checks.find((c) => c.name === "live WER host").pass, false);
  assert.equal(strict.checks.find((c) => c.name === "stored WER panelist2").pass, false);
  // Partials 6 s late: WebRTC p95 over 4 s.
  const late = analyse(fixture({ partialMs: 6000, finalMs: 7000 }));
  assert.equal(late.checks.find((c) => c.name === "WebRTC p95").pass, false);
  // Every other sentence of the panelist never captioned: deletions, and missed phrases.
  const holes = analyse(fixture({ drop: (p, K, s) => p === 1 && s % 2 === 1 && s < 5 }));
  const pan = holes.report.webrtc.presenters[1];
  assert.ok(pan.missed >= 4, `missed ${pan.missed}`);
  assert.ok(pan.wer.del > 0 && pan.wer.wer > 0.25, `wer ${pan.wer.wer}`);
  assert.equal(holes.checks.find((c) => c.name === "live WER panelist2").pass, false);
  // On-device only: the source check fails unless any source is accepted.
  const dev = analyse(fixture(), { sourceSamples: [{ at: 1, captionsEnabled: true, server: false, pending: true }] });
  assert.equal(dev.checks.find((c) => c.area === "source").pass, false);
  const any = analyse(fixture(), { sourceSamples: [{ at: 1, captionsEnabled: true, server: false }], thresholds: { ...CAPTION_THRESHOLDS, source: "any" } });
  assert.equal(any.checks.find((c) => c.area === "source").pass, true);
  // Nothing heard at all.
  const none = analyse(fixture(), { webrtc: [], edge: [], transcript: "" });
  assert.equal(none.pass, false);
  assert.equal(none.checks.find((c) => c.name === "WebRTC observer").pass, false);
  assert.equal(none.checks.find((c) => c.name === "live WER host").pass, false);
});

test("captionChecks verdicts from fixtures", () => {
  const presenter = (wer, finals = 10) => ({ label: "host", finals, partials: 0, wer: { wer, n: 100, sub: 1, del: 1, ins: 1 }, latency: { n: 5, p50: 1000, p95: 2000 }, phrases: 5, missed: 0 });
  const stream = (p95, wer) => ({ finals: 10, partials: 5, unattributed: 0, latency: { n: 5, p50: 1000, p95 }, presenters: [presenter(wer)] });
  const base = { source: { server: true, samples: 3, liveSamples: 3 }, edgeRoom: true, edgeLatencyMs: 2500, delivery: { viewers: 10, finalsPerViewer: 9.5, tapFinals: 10, ratio: 0.95, total: 95 } };
  const ok = captionChecks({ ...base, webrtc: stream(3999, 0.1), edge: stream(6400, 0.1), stored: { presenters: [{ label: "host", lines: 10, wer: { wer: 0.2, n: 100 } }] } });
  assert.ok(ok.every((c) => c.pass), JSON.stringify(ok.filter((c) => !c.pass)));
  const bad = captionChecks({ ...base, delivery: { ...base.delivery, ratio: 0.5 }, webrtc: stream(4001, 0.26), edge: stream(6600, 0.1), stored: { presenters: [{ label: "host", lines: 10, wer: { wer: 0.21, n: 100 } }] } });
  const failed = bad.filter((c) => !c.pass).map((c) => c.name);
  assert.deepEqual(failed.sort(), ["WebRTC p95", "edge p95 (on screen)", "edge viewers", "live WER host", "stored WER host"].sort());
  // A standard (WebRTC) room has no edge rows.
  const std = captionChecks({ source: { server: true }, edgeRoom: false, webrtc: stream(1000, 0.1) });
  assert.ok(!std.some((c) => /edge/.test(c.name)));
  assert.ok(captionChecks({ ...base, storedError: "transcript.txt: 500" }).some((c) => c.name === "stored transcript" && !c.pass));
});

test("source and edge delivery summaries", () => {
  const s = summariseSource([
    { at: 0, captionsEnabled: false, server: false },
    { at: 1, captionsEnabled: true, server: false, pending: true },
    ...Array.from({ length: 10 }, (_, i) => ({ at: 2 + i, captionsEnabled: true, server: i !== 3 })),
  ]);
  assert.equal(s.server, true);
  assert.equal(s.samples, 11);
  assert.equal(s.liveSamples, 9);
  assert.equal(summariseSource([{ at: 1, captionsEnabled: true, server: false, pending: true }]).pending, true);
  const start = Date.parse("2026-10-24T10:00:00Z");
  const local = { startedAt: new Date(start).toISOString(), seconds: 150, active: 50 };
  const all = { ...local, capHoldViewers: 40, capHoldFinals: 380, counts: { caption: 1000, captionPartial: 500 } };
  const tap = [
    { at: start + 10_000 }, // in the ramp: not counted
    ...Array.from({ length: 10 }, (_, i) => ({ at: start + 40_000 + i * 1000 })),
    { at: start + 50_000, partial: true },
    { at: start + 200_000 }, // after the step
  ];
  const d = edgeDelivery(local, all, tap, 30_000);
  assert.deepEqual([d.viewers, d.tapFinals, d.finalsPerViewer, d.total], [40, 10, 9.5, 1500]);
  assert.equal(d.ratio, 0.95);
  assert.equal(edgeDelivery(null, null, tap, 0), null);
});

test("edge viewers count captions and report the hold gauge", () => {
  const step = new Step("step 1", 1);
  step.startedAt = Date.now() - 10_000;
  const v = new EdgeViewer({ rampMs: 5000 }, { step });
  assert.deepEqual(v.captionGauges(), { capHoldViewers: 0, capHoldFinals: 0 }, "no events stream yet");
  v.firstEventsAt = step.startedAt + 1000; // before the hold
  v.capTimes.push(step.startedAt + 2000); // in the ramp
  v.onCaption({ text: "a" });
  v.onCaption({ text: "b" });
  v.onCaption({ text: "a b", partial: true });
  assert.deepEqual(v.captionGauges(), { capHoldViewers: 1, capHoldFinals: 2 });
  assert.equal(step.counts.get("caption"), 2);
  assert.equal(step.counts.get("captionPartial"), 1);
  v.firstEventsAt = step.startedAt + 6000; // joined in the hold: not comparable
  assert.equal(v.captionGauges().capHoldViewers, 0);
});

test("run plan with --captions: the tap's seat, thresholds, presenters needed", () => {
  const p = plan({ steps: "10", captions: true, presenters: "2", captionsLiveWer: "30%", captionsLatency: "5s" });
  assert.equal(p.tap, 1);
  assert.equal(p.seats, 11);
  assert.equal(p.captions.thresholds.liveWer, 0.3);
  assert.equal(p.captions.thresholds.webrtcP95Ms, 5000);
  assert.equal(p.captions.thresholds.storedWer, 0.2);
  assert.equal(plan({ steps: "10", captions: true, delivery: "standard" }).tap, 0, "no edge, no tap");
  assert.equal(plan({ steps: "10" }).captions, null);
  assert.throws(() => captionsPlan({}, 0), /presenters/);
  assert.throws(() => captionsPlan({ captionsLiveWer: "2" }, 1), /fraction/);
  assert.throws(() => captionsPlan({ captionsSource: "browser" }, 1), /server or any/);
  const rows = checksRows({ captions: { checks: [{ area: "latency", name: "x", pass: true }] }, recording: { checks: [{ name: "ready", pass: true }] } });
  assert.deepEqual(rows.map((r) => r.area), ["recording", "captions latency"]);
});

test("presenter voice flags replace the tone", () => {
  assert.deepEqual(withVoice(["--use-file-for-fake-video-capture=v.mjpeg", "--use-file-for-fake-audio-capture=tone.wav"], "p1.wav"),
    ["--use-file-for-fake-video-capture=v.mjpeg", "--use-file-for-fake-audio-capture=p1.wav"]);
  assert.deepEqual(withVoice([], "p1.wav"), ["--use-file-for-fake-audio-capture=p1.wav"]);
});
