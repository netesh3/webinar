/* The pure half of the captions check (run.mjs --captions; the I/O is in ../captions.mjs):
 * text normalisation and word error rate, aligning a caption line to the script it came from,
 * the caption packet as it arrives (SSE event, or bytes off a LiveKit data channel), the audio
 * anchor, and the analysis that turns caption events into latency, coverage and WER.
 *
 * Where captions travel (api/internal/api/server_captions.go, deploy/captions/README.md):
 *   - WebRTC participants: the agent publishes {kind:"caption", from, text, id, startedAt,
 *     endedAt, lagMs, partial?} as a LiveKit data packet (topic "webcast", reliable) itself;
 *     the API relays it only when the agent could not. On-device captions are the same packet
 *     from the speaker's browser, without id/startedAt/lagMs.
 *   - Edge (LL-HLS) viewers: the agent posts each line to the API, which puts the same packet
 *     on the edge events stream: SSE `event: packet`, data = the packet JSON. Partials too.
 *     The page holds a line by edgeHoldMs (web/lib/caption-sync.ts) so it lands with the video.
 *   - Stored: every final line goes to session_captions; the host reads them back as
 *     GET /host/webinars/{slug}/transcript.txt ("HH:MM:SS identity: text" per line). */

// ------------------------------------------------------------------ text

const ONES = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve",
  "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];

/** 0 .. 999,999,999,999 in words, no "and": 45 -> "forty five", 2300 -> "two thousand three hundred". */
export function numberWords(n) {
  n = Math.floor(Number(n));
  if (!Number.isFinite(n) || n < 0) return String(n);
  if (n < 20) return ONES[n];
  if (n < 100) return TENS[Math.floor(n / 10)] + (n % 10 ? ` ${ONES[n % 10]}` : "");
  if (n < 1000) return `${ONES[Math.floor(n / 100)]} hundred` + (n % 100 ? ` ${numberWords(n % 100)}` : "");
  for (const [size, name] of [[1e9, "billion"], [1e6, "million"], [1e3, "thousand"]]) {
    if (n >= size) return `${numberWords(Math.floor(n / size))} ${name}` + (n % size ? ` ${numberWords(n % size)}` : "");
  }
  return String(n);
}

const ORDINAL = { one: "first", two: "second", three: "third", five: "fifth", eight: "eighth", nine: "ninth", twelve: "twelfth" };
function ordinalWords(n) {
  const w = numberWords(n).split(" ");
  const last = w.pop();
  const o = ORDINAL[last] ?? (last.endsWith("y") ? `${last.slice(0, -1)}ieth` : `${last}th`);
  return [...w, o].join(" ");
}

const CONTRACTIONS = [
  [/\b(can)'t\b/g, "can not"], [/\bwon't\b/g, "will not"], [/\b(\w+)n't\b/g, "$1 not"],
  [/\b(i)'m\b/g, "$1 am"], [/\b(\w+)'re\b/g, "$1 are"], [/\b(\w+)'ll\b/g, "$1 will"], [/\b(\w+)'ve\b/g, "$1 have"],
  [/\b(\w+)'d\b/g, "$1 would"], [/\blet's\b/g, "let us"], [/\b(it|that|there|what|here|he|she|who)'s\b/g, "$1 is"],
];
const FILLERS = new Set(["um", "uh", "er", "erm", "hmm", "mm", "ah"]);
const SAME = { ok: "okay", cannot: "can not", percentage: "percent" };

/* normalise(text) -> [words]: lower case, contractions expanded, digits to words ("45%" ->
 * "forty five percent", "$5" -> "five dollars", "1,000" -> "one thousand", "2.5" -> "two point
 * five", "10:30" -> "ten thirty", "3rd" -> "third"), hyphens split, punctuation and fillers
 * dropped. The script and the captions go through the same function. */
export function normalise(text) {
  let t = String(text ?? "").toLowerCase().replace(/[\u2018\u2019\u02bc`]/g, "'").replace(/[\u2013\u2014]/g, " ");
  for (const [re, to] of CONTRACTIONS) t = t.replace(re, to);
  t = t
    .replace(/\$(\d[\d,]*(?:\.\d+)?)/g, "$1 dollars")
    .replace(/(\d)\s*%/g, "$1 percent")
    .replace(/(\d),(?=\d{3}\b)/g, "$1")
    .replace(/\b(\d{1,2}):(\d{2})\b/g, (_, h, m) => `${numberWords(h)} ${m === "00" ? "" : Number(m) < 10 ? `oh ${numberWords(m)}` : numberWords(m)}`)
    .replace(/\b(\d+)(st|nd|rd|th)\b/g, (_, d) => ordinalWords(d))
    .replace(/\b(\d+)\.(\d+)\b/g, (_, a, b) => `${numberWords(a)} point ${b.split("").map((x) => ONES[x]).join(" ")}`)
    .replace(/\d+/g, (d) => ` ${numberWords(d)} `)
    .replace(/-/g, " ")
    .replace(/'s\b/g, "s")
    .replace(/[^a-z' ]+/g, " ")
    .replace(/'/g, "");
  return t
    .split(/\s+/)
    .filter((w) => w && !FILLERS.has(w))
    .flatMap((w) => (SAME[w] ?? w).split(" "));
}

/* wer(ref, hyp) -> { n, sub, del, ins, errors, wer }: word-level Levenshtein of two word arrays
 * (normalise() them first). wer is errors / n; 0 for two empty arrays, 1 for nothing heard. */
export function wer(ref, hyp) {
  const n = ref.length;
  const m = hyp.length;
  if (!n) return { n: 0, sub: 0, del: 0, ins: m, errors: m, wer: m ? 1 : 0 };
  // cost and the three op counts per cell, two rows at a time
  let prev = Array.from({ length: m + 1 }, (_, j) => ({ c: j, s: 0, d: 0, i: j }));
  for (let i = 1; i <= n; i++) {
    const cur = [{ c: i, s: 0, d: i, i: 0 }];
    for (let j = 1; j <= m; j++) {
      const eq = ref[i - 1] === hyp[j - 1];
      const diag = prev[j - 1];
      const up = prev[j];
      const left = cur[j - 1];
      let best = { c: diag.c + (eq ? 0 : 1), s: diag.s + (eq ? 0 : 1), d: diag.d, i: diag.i };
      if (up.c + 1 < best.c) best = { c: up.c + 1, s: up.s, d: up.d + 1, i: up.i };
      if (left.c + 1 < best.c) best = { c: left.c + 1, s: left.s, d: left.d, i: left.i + 1 };
      cur.push(best);
    }
    prev = cur;
  }
  const r = prev[m];
  return { n, sub: r.s, del: r.d, ins: r.i, errors: r.c, wer: r.c / n };
}

/* align(words, ref) -> { start, end, matches, score } or null: where in `ref` (a word array)
 * the caption `words` sit best. Semi-global: the whole caption, any stretch of the reference
 * (match +2, mismatch/gap -1). end is exclusive. null when fewer than 2 words, or under half
 * of them, match: a line too short or too wrong to place. */
export function align(words, ref, { minMatches = 2, minFraction = 0.5 } = {}) {
  const m = words.length;
  const n = ref.length;
  if (m < minMatches || !n) return null;
  const W = n + 1;
  const score = new Float64Array((m + 1) * W);
  const from = new Uint8Array((m + 1) * W); // 0 start, 1 diag, 2 up (caption word extra), 3 left (ref word skipped)
  const hits = new Uint16Array((m + 1) * W);
  for (let i = 1; i <= m; i++) {
    score[i * W] = -i;
    from[i * W] = 2;
  }
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const eq = words[i - 1] === ref[j - 1];
      const d = score[(i - 1) * W + j - 1] + (eq ? 2 : -1);
      const u = score[(i - 1) * W + j] - 1;
      const l = score[i * W + j - 1] - 1;
      const k = i * W + j;
      if (d >= u && d >= l) {
        score[k] = d;
        from[k] = 1;
        hits[k] = hits[(i - 1) * W + j - 1] + (eq ? 1 : 0);
      } else if (u >= l) {
        score[k] = u;
        from[k] = 2;
        hits[k] = hits[(i - 1) * W + j];
      } else {
        score[k] = l;
        from[k] = 3;
        hits[k] = hits[i * W + j - 1];
      }
    }
  }
  let bestJ = 0;
  for (let j = 1; j <= n; j++) if (score[m * W + j] > score[m * W + bestJ]) bestJ = j;
  const matches = hits[m * W + bestJ];
  if (matches < minMatches || matches < minFraction * m) return null;
  // Trace back to where the caption's first word sits.
  let i = m;
  let j = bestJ;
  let start = bestJ;
  while (i > 0) {
    const f = from[i * W + j];
    if (f === 1) {
      start = j - 1;
      i--;
      j--;
    } else if (f === 2) i--;
    else j--;
  }
  return { start, end: bestJ, matches, score: score[m * W + bestJ] };
}

// ------------------------------------------------------------------ the packet

/* captionFromPacket(obj) -> a caption event or null: the room packet's caption fields
 * (web/lib/realtime.ts decode, case "caption"). */
export function captionFromPacket(p) {
  if (!p || p.kind !== "caption" || typeof p.text !== "string" || !p.text.trim()) return null;
  const from = p.from && typeof p.from === "object" ? p.from : {};
  const out = { identity: String(from.identity ?? ""), name: String(from.name ?? ""), text: p.text };
  if (typeof p.id === "string" && p.id) out.id = p.id;
  if (p.partial === true) out.partial = true;
  for (const k of ["startedAt", "endedAt", "lagMs"]) if (typeof p[k] === "number" && Number.isFinite(p[k])) out[k] = p[k];
  return out;
}

/** An edge events-stream event: SSE `packet` whose data is a caption packet -> event, else null. */
export function parseCaptionEvent(name, data) {
  if (name !== "packet" || typeof data !== "string" || !data.includes('"caption"')) return null;
  try {
    return captionFromPacket(JSON.parse(data));
  } catch {
    return null;
  }
}

/* findCaptionJson(text) -> the caption packet object inside `text`, or null. A LiveKit data
 * message is a protobuf DataPacket whose user payload is the packet's JSON bytes verbatim, so
 * decoded as text the JSON sits among a few binary bytes: try each "{" until one parses to a
 * caption. Self-contained (it is also stringified into the presenter page, CAPTION_TAP). */
export function findCaptionJson(text) {
  if (typeof text !== "string" || text.indexOf('"caption"') < 0) return null;
  for (let at = text.indexOf("{"); at >= 0; at = text.indexOf("{", at + 1)) {
    let depth = 0;
    let str = false;
    let esc = false;
    for (let i = at; i < text.length; i++) {
      const c = text[i];
      if (str) {
        if (esc) esc = false;
        else if (c === "\\") esc = true;
        else if (c === '"') str = false;
      } else if (c === '"') str = true;
      else if (c === "{") depth++;
      else if (c === "}" && --depth === 0) {
        try {
          const o = JSON.parse(text.slice(at, i + 1));
          if (o && o.kind === "caption") return o;
        } catch {}
        break;
      }
    }
  }
  return null;
}

/* Added to every document of a presenter's page (with chrome.mjs WATCH_PCS): records each
 * caption packet that reaches the page over a LiveKit data channel, with its arrival time, in
 * window.__load.captions; and when each microphone track was opened (getUserMedia), in
 * window.__load.audioOpens, since Chrome's fake audio file starts playing at that moment. */
export const CAPTION_TAP = `
(() => {
  const L = (window.__load = window.__load || { pcs: [] });
  L.captions = []; L.audioOpens = []; L.trackOpen = {};
  const find = ${findCaptionJson.toString()};
  const dec = new TextDecoder();
  const seen = new WeakSet();
  const take = (ev) => {
    if (!ev || seen.has(ev)) return; seen.add(ev);
    const at = Date.now();
    const d = ev.data;
    let text = null;
    if (typeof d === 'string') text = d;
    else if (d instanceof ArrayBuffer) text = dec.decode(new Uint8Array(d));
    else if (ArrayBuffer.isView(d)) text = dec.decode(d);
    const one = (t) => { const o = find(t); if (o && L.captions.length < 50000) L.captions.push({ at, packet: o }); };
    if (text !== null) one(text);
    else if (d && typeof d.arrayBuffer === 'function') d.arrayBuffer().then((b) => one(dec.decode(new Uint8Array(b))), () => {});
  };
  const P = RTCDataChannel.prototype;
  const desc = Object.getOwnPropertyDescriptor(P, 'onmessage');
  if (desc && desc.set) {
    Object.defineProperty(P, 'onmessage', { configurable: true, enumerable: desc.enumerable,
      get() { return desc.get.call(this); },
      set(fn) { desc.set.call(this, typeof fn === 'function' ? function (ev) { take(ev); return fn.call(this, ev); } : fn); } });
  }
  const add = P.addEventListener;
  P.addEventListener = function (type, fn, opts) {
    if (type === 'message' && typeof fn === 'function') { const f = fn; fn = function (ev) { take(ev); return f.call(this, ev); }; }
    return add.call(this, type, fn, opts);
  };
  const md = navigator.mediaDevices;
  if (md && md.getUserMedia) {
    const gum = md.getUserMedia.bind(md);
    md.getUserMedia = async (c) => {
      const s = await gum(c);
      const at = Date.now();
      for (const t of s.getAudioTracks()) { L.trackOpen[t.id] = at; L.audioOpens.push({ at, id: t.id, label: t.label }); }
      return s;
    };
  }
  const clone = MediaStreamTrack.prototype.clone;
  MediaStreamTrack.prototype.clone = function () {
    const c = clone.call(this);
    if (L.trackOpen[this.id] !== undefined) L.trackOpen[c.id] = L.trackOpen[this.id];
    return c;
  };
})();
`;

/** Expression: drains the page's caption packets: [{ at, packet }]. */
export const DRAIN_CAPTIONS = "(window.__load && window.__load.captions ? window.__load.captions.splice(0) : [])";

/* Expression: the microphone as the page sends it: { opens: [{ at, id }], sent: [{ id, at,
 * enabled, state }] } where sent are the audio tracks on the peer connections' senders and at
 * is when that track (or the one it was cloned from) was opened. */
export const AUDIO_STATE = `(() => {
  const L = window.__load || {};
  const sent = [];
  for (const pc of (L.pcs || [])) {
    let ss = []; try { ss = pc.getSenders(); } catch {}
    for (const s of ss) { const t = s.track; if (t && t.kind === 'audio') sent.push({ id: t.id, at: (L.trackOpen || {})[t.id] ?? null, enabled: t.enabled, state: t.readyState }); }
  }
  return { opens: (L.audioOpens || []).map((o) => ({ at: o.at, id: o.id })), sent };
})()`;

/* anchorCandidates(state) -> [ms]: when the published microphone's file may have started:
 * the sent track's open time first, then every other open (Chrome may share one capture
 * between tracks, so the first open can be the one whose clock the file follows). */
export function anchorCandidates(state) {
  const out = [];
  for (const s of state?.sent ?? []) if (s.at && s.state !== "ended") out.push(s.at);
  for (const o of state?.opens ?? []) out.push(o.at);
  return [...new Set(out.filter((x) => Number.isFinite(x)))];
}

// ------------------------------------------------------------------ the script, in time

/* scriptTimeline(voice) -> { words, n, loopMs, sentences: [{ startMs, endMs, w0, w1 }], wordAt(j) }:
 * a presenter's script as normalised words, each sentence's word range, and the time into the
 * loop at which word j is spoken (linear within its sentence). voice is one of
 * makeVoices().presenters plus the loop length. */
export function scriptTimeline(voice, loopMs) {
  const words = [];
  const sentences = voice.sentences.map((s) => {
    const w = normalise(s.text);
    const w0 = words.length;
    words.push(...w);
    return { startMs: s.startMs, endMs: s.endMs, w0, w1: words.length };
  });
  const sentenceOf = (j) => {
    const jj = ((j % words.length) + words.length) % words.length;
    let lo = 0;
    let hi = sentences.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (sentences[mid].w0 <= jj) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
  const wordAt = (j) => {
    const loops = Math.floor(j / words.length);
    const s = sentences[sentenceOf(j)];
    const jj = j - loops * words.length;
    const f = s.w1 > s.w0 ? (jj - s.w0) / (s.w1 - s.w0) : 0;
    return loops * loopMs + s.startMs + f * (s.endMs - s.startMs);
  };
  return { words, n: words.length, loopMs, sentences, sentenceOf, wordAt, doubled: [...words, ...words] };
}

/** The loop a line belongs to, from when it arrived: the most recent time its first word was spoken before it arrived (less `typicalMs`). */
export function loopOf(arrivalMs, anchorMs, tl, j0, typicalMs = 1500) {
  return Math.round((arrivalMs - anchorMs - tl.wordAt(j0) - typicalMs) / tl.loopMs);
}

/* contended(timelines, anchors, { maxSpeakers, lingerMs }) -> (p, K, s) => bool: whether
 * sentence s of presenter p in loop K was spoken while at least maxSpeakers others were also
 * talking (each speaker's sentence stretched by lingerMs, CAPTIONS_SPEAKER_LINGER_S): the agent
 * captions only the most active maxSpeakers, so such a sentence may rightly go uncaptioned and
 * is left out of the coverage and WER. No anchors: nothing is contended. */
export function contended(timelines, anchors, { maxSpeakers = 2, lingerMs = 3000 } = {}) {
  return (p, K, s) => {
    const a = anchors[p];
    if (!Number.isFinite(a) || timelines.length <= maxSpeakers) return false;
    const tl = timelines[p];
    const t0 = a + K * tl.loopMs + tl.sentences[s].startMs;
    const t1 = a + K * tl.loopMs + tl.sentences[s].endMs;
    let others = 0;
    for (const [q, tq] of timelines.entries()) {
      if (q === p || !Number.isFinite(anchors[q])) continue;
      const k0 = Math.floor((t0 - anchors[q]) / tq.loopMs) - 1;
      let hit = false;
      for (let k = k0; k <= k0 + 2 && !hit; k++) {
        for (const x of tq.sentences) {
          const s0 = anchors[q] + k * tq.loopMs + x.startMs;
          const s1 = anchors[q] + k * tq.loopMs + x.endMs + lingerMs;
          if (s0 < t1 && s1 > t0) {
            hit = true;
            break;
          }
        }
      }
      if (hit) others++;
    }
    return others >= maxSpeakers;
  };
}

/* edgeHoldMs: how long the edge page holds a line before showing it (web/lib/caption-sync.ts):
 * the player's delay behind live, plus the mix's ingest, minus how old the line already is. */
export const EDGE_INGEST_MS = 500;
export function edgeHoldMs(videoDelaySec, lagMs) {
  if (videoDelaySec == null || !Number.isFinite(videoDelaySec) || videoDelaySec <= 0) return 0;
  const lag = typeof lagMs === "number" && Number.isFinite(lagMs) && lagMs >= 0 ? lagMs : 1000;
  return Math.min(10_000, Math.max(0, Math.round(videoDelaySec * 1000 + EDGE_INGEST_MS - lag)));
}

export function pct(values, p) {
  if (!values.length) return null;
  const s = values.slice().sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))];
}

const median = (v) => pct(v, 50);

/* mapIdentities(events, timelines) -> { identity: presenter index }: which script each speaker
 * reads, by majority over their lines' best alignment. */
export function mapIdentities(events, timelines) {
  const votes = {};
  const used = {};
  for (const e of events) {
    // Finals are enough to tell who reads what; a couple of hundred each keeps it quick.
    if (e.partial || (used[e.identity] = (used[e.identity] ?? 0) + 1) > 200) continue;
    const w = normalise(e.text);
    if (w.length < 3) continue;
    let best = -1;
    let bestScore = -Infinity;
    for (const [p, tl] of timelines.entries()) {
      const a = align(w, tl.doubled);
      if (a && a.score > bestScore) {
        best = p;
        bestScore = a.score;
      }
    }
    if (best < 0) continue;
    const v = (votes[e.identity] ??= {});
    v[best] = (v[best] ?? 0) + 1;
  }
  const out = {};
  for (const [id, v] of Object.entries(votes)) out[id] = Number(Object.entries(v).sort((a, b) => b[1] - a[1])[0][0]);
  return out;
}

/* placeLines(lines, tl, { anchor }) -> lines with { words, j0, j1, K, g0, g1 } (g = K*n + j, the
 * position in the script unrolled over its loops) where they could be aligned. With an anchor,
 * K comes from when each line arrived; without, from the order (a line that starts more than
 * half a script before the one before it is the next loop). Unaligned lines get the loop of
 * the line before them and no position. Lines in arrival order. */
export function placeLines(lines, tl, { anchor = null } = {}) {
  let prevK = 0;
  let prevJ = null;
  return lines.map((l) => {
    const words = normalise(l.text);
    const a = align(words, tl.doubled);
    if (!a) return { ...l, words, K: l.K ?? prevK };
    let j0 = a.start;
    let j1 = a.end;
    if (j0 >= tl.n) {
      j0 -= tl.n;
      j1 -= tl.n;
    }
    let K;
    if (Number.isFinite(l.K)) K = l.K;
    else if (Number.isFinite(anchor) && Number.isFinite(l.at)) K = loopOf(l.at, anchor, tl, j0);
    else K = prevJ !== null && j0 < prevJ - tl.n / 2 ? prevK + 1 : prevK;
    prevK = K;
    prevJ = j0;
    return { ...l, words, j0, j1, K, g0: K * tl.n + j0, g1: K * tl.n + j1 };
  });
}

/* werOver(placed, tl, excluded) -> { n, errors, sub, del, ins, wer, words } over the stretch of
 * the unrolled script the lines cover (first line's start to the last one's end), less the
 * excluded sentences (excluded(K, s)), the hypothesis being the lines' words in order. Done in
 * chunks of about `chunk` reference words, cut between lines, so an hour stays cheap. */
export function werOver(placed, tl, excluded = () => false, { chunk = 300 } = {}) {
  const at = placed.filter((l) => l.g0 !== undefined);
  if (!at.length) {
    const hyp = placed.flatMap((l) => l.words ?? normalise(l.text));
    return { n: 0, errors: hyp.length, sub: 0, del: 0, ins: hyp.length, wer: hyp.length ? 1 : null, words: hyp.length };
  }
  const g0 = Math.min(...at.map((l) => l.g0));
  const g1 = Math.max(...at.map((l) => l.g1));
  const refWord = (g) => {
    const K = Math.floor(g / tl.n);
    const j = g - K * tl.n;
    return excluded(K, tl.sentenceOf(j)) ? null : tl.words[j];
  };
  // Lines in script order; an unaligned line rides with the one before it.
  const ordered = [];
  let carry = g0;
  for (const l of placed) {
    const g = l.g0 ?? carry;
    carry = l.g1 ?? carry;
    if (l.g0 !== undefined) {
      const K = Math.floor(l.g0 / tl.n);
      if (excluded(K, tl.sentenceOf(l.j0))) continue;
    }
    ordered.push({ g, words: l.words ?? normalise(l.text) });
  }
  ordered.sort((a, b) => a.g - b.g);
  const tot = { n: 0, errors: 0, sub: 0, del: 0, ins: 0, words: 0 };
  let i = 0;
  let from = g0;
  while (from < g1 || i < ordered.length) {
    // This chunk: lines until the reference has `chunk` words, cut at the next line's start.
    let to = g1;
    let k = i;
    while (k < ordered.length && ordered[k].g < from + chunk) k++;
    if (k < ordered.length) to = Math.max(from + 1, Math.min(g1, ordered[k].g));
    else k = ordered.length;
    const ref = [];
    for (let g = from; g < to; g++) {
      const w = refWord(g);
      if (w) ref.push(w);
    }
    const hyp = ordered.slice(i, k).flatMap((l) => l.words);
    const r = wer(ref, hyp);
    tot.n += r.n;
    tot.errors += r.errors;
    tot.sub += r.sub;
    tot.del += r.del;
    tot.ins += r.ins;
    tot.words += hyp.length;
    i = k;
    if (to >= g1 && i >= ordered.length) break;
    from = to;
  }
  return { ...tot, wer: tot.n ? tot.errors / tot.n : null };
}

/* phraseLatency(events, tl, anchor, { excluded, holdMs }) -> { latencies: [ms], phrases, missed }:
 * for every sentence start inside the stretch the finals cover, the time from when it was
 * spoken (anchor + K*loop + its start) to the first caption event (partial or final) whose
 * aligned words include the sentence's first word, plus holdMs(event) (the edge page's hold).
 * events are placeLines() output. */
export function phraseLatency(events, tl, anchor, { excluded = () => false, holdMs = () => 0 } = {}) {
  const placed = events.filter((e) => e.g0 !== undefined);
  const finals = placed.filter((e) => !e.partial);
  if (!Number.isFinite(anchor) || !finals.length) return { latencies: [], phrases: 0, missed: 0 };
  const g0 = Math.min(...finals.map((e) => e.g0));
  const g1 = Math.max(...finals.map((e) => e.g1));
  const latencies = [];
  let phrases = 0;
  let missed = 0;
  const byArrival = placed.slice().sort((a, b) => a.at - b.at);
  for (let K = Math.floor(g0 / tl.n); K <= Math.floor(g1 / tl.n); K++) {
    for (const [s, x] of tl.sentences.entries()) {
      const gs = K * tl.n + x.w0;
      if (gs < g0 || gs >= g1 || excluded(K, s)) continue;
      phrases++;
      const spoken = anchor + K * tl.loopMs + x.startMs;
      const first = byArrival.find((e) => e.g0 <= gs + 2 && e.g1 > gs && e.at >= spoken - 1000);
      if (!first) missed++;
      else latencies.push(first.at + holdMs(first) - spoken);
    }
  }
  return { latencies, phrases, missed };
}

/* chooseAnchor(candidates, lines, tl) -> { anchor, skewMs }: of the times the microphone might
 * have started, the one the agent's own speech-start times (startedAt) agree with best; skewMs
 * is the median of startedAt minus when the script says the line's first word was spoken (the
 * agent's speech detection plus the clocks' difference). No startedAt: the first candidate. */
export function chooseAnchor(candidates, lines, tl) {
  const c = candidates.filter((x) => Number.isFinite(x));
  if (!c.length) return { anchor: null, skewMs: null };
  const timed = [];
  for (const l of lines) {
    if (!Number.isFinite(l.startedAt)) continue;
    const a = align(normalise(l.text), tl.doubled);
    if (a) timed.push({ startedAt: l.startedAt, w: tl.wordAt(a.start % tl.n) });
  }
  if (!timed.length) return { anchor: c[0], skewMs: null };
  const wrap = (x) => x - Math.round(x / tl.loopMs) * tl.loopMs;
  let best = null;
  for (const a of c) {
    const res = timed.map((t) => wrap(t.startedAt - a - t.w));
    const m = median(res.map(Math.abs));
    if (!best || m < best.m) best = { anchor: a, m, skewMs: median(res) };
  }
  return { anchor: best.anchor, skewMs: Math.round(best.skewMs) };
}

/* analyseStream(events, ctx) -> per presenter { label, identity, lines, finals, partials,
 * wer, latency: { p50, p95, n }, phrases, missed } and the totals: one observer's caption events
 * (edge tap or a WebRTC page) against the scripts. ctx: { timelines, labels, anchors (chosen),
 * identities (from mapIdentities), excluded (contended()), holdMs (edge only) }. */
export function analyseStream(events, ctx) {
  const out = { events: events.length, finals: 0, partials: 0, unattributed: 0, presenters: [] };
  const all = [];
  const placedAll = [];
  for (const [p, tl] of ctx.timelines.entries()) {
    const mine = events.filter((e) => ctx.identities[e.identity] === p).sort((a, b) => a.at - b.at);
    const placed = placeLines(mine, tl, { anchor: ctx.anchors[p] });
    const finals = placed.filter((e) => !e.partial);
    placedAll.push(finals);
    const ex = (K, s) => ctx.excluded(p, K, s);
    const w = werOver(finals, tl, ex);
    const lat = phraseLatency(placed, tl, ctx.anchors[p], { excluded: ex, holdMs: ctx.holdMs });
    all.push(...lat.latencies);
    out.finals += finals.length;
    out.partials += placed.length - finals.length;
    out.presenters.push({
      label: ctx.labels[p],
      anchor: ctx.anchors[p] ?? null,
      identity: Object.keys(ctx.identities).find((k) => ctx.identities[k] === p) ?? null,
      finals: finals.length,
      partials: placed.length - finals.length,
      wer: w,
      latency: { n: lat.latencies.length, p50: pct(lat.latencies, 50), p95: pct(lat.latencies, 95) },
      phrases: lat.phrases,
      missed: lat.missed,
    });
  }
  out.unattributed = events.filter((e) => ctx.identities[e.identity] === undefined).length;
  out.latency = { n: all.length, p50: pct(all, 50), p95: pct(all, 95) };
  // The placed finals, for analyseStored; not written to results.json.
  Object.defineProperty(out, "placed", { value: placedAll, enumerable: false });
  return out;
}

/** parseTranscript(text) -> [{ time, identity, text }]: transcript.txt's "HH:MM:SS identity: text" lines. */
export function parseTranscript(text) {
  const out = [];
  for (const line of String(text ?? "").split("\n")) {
    const m = /^(\d\d:\d\d:\d\d) (\S.*?): (.*)$/.exec(line.trim());
    if (m && m[3].trim()) out.push({ time: m[1], identity: m[2], text: m[3] });
  }
  return out;
}

/* analyseStored(lines, ctx, liveFinals) -> per presenter WER of the stored transcript. Each
 * stored line takes the loop of the live final with the same words from the same speaker
 * (they are the same lines), else follows the order. */
export function analyseStored(lines, ctx, liveByPresenter = []) {
  const out = { lines: lines.length, presenters: [] };
  for (const [p, tl] of ctx.timelines.entries()) {
    const live = (liveByPresenter[p] ?? []).map((e) => ({ key: normalise(e.text).join(" "), K: e.K }));
    const mine = lines.filter((l) => ctx.identities[l.identity] === p).map((l) => {
      const key = normalise(l.text).join(" ");
      const i = live.findIndex((x) => x.key === key && Number.isFinite(x.K));
      if (i < 0) return { ...l };
      const K = live[i].K;
      live.splice(0, i + 1);
      return { ...l, K };
    });
    const placed = placeLines(mine, tl);
    out.presenters.push({ label: ctx.labels[p], lines: mine.length, wer: werOver(placed, tl, (K, s) => ctx.excluded(p, K, s)) });
  }
  out.unattributed = lines.filter((l) => ctx.identities[l.identity] === undefined).length;
  return out;
}

// ------------------------------------------------------------------ verdicts

export const CAPTION_THRESHOLDS = {
  liveWer: 0.25, // live captions vs the script
  storedWer: 0.2, // the stored transcript vs the script
  webrtcP95Ms: 4000, // phrase start -> first caption with it, WebRTC
  edgeSlackMs: 4000, // edge: on screen (after the page's hold) <= edge live latency + this
  edgeDelivery: 0.9, // finals per edge viewer over the top step's hold, vs the edge tap's
  source: "server", // which source must have served: server | any
};

const pctStr = (x) => (x === null || x === undefined ? "-" : `${(x * 100).toFixed(1)}%`);
const sStr = (ms) => (ms === null || ms === undefined ? "-" : `${(ms / 1000).toFixed(1)} s`);

/* captionChecks(r, thresholds) -> [{ area, name, pass, detail }]. r: { source, webrtc (analyseStream
 * or null), edge (analyseStream or null), edgeLatencyMs, delivery: { viewers, finalsPerViewer,
 * tapFinals, ratio } or null, stored (analyseStored or null), edgeRoom }. */
export function captionChecks(r, th = CAPTION_THRESHOLDS) {
  th = { ...CAPTION_THRESHOLDS, ...th };
  const rows = [];
  const add = (area, name, pass, detail) => rows.push({ area, name, pass: !!pass, detail });
  const src = r.source ?? {};
  add("source", "served by", th.source === "any" ? (src.server || src.onDevice) : src.server,
    `${src.server ? "server (caption agent live)" : src.pending ? "on-device: server agent asked for but never live" : "on-device"}` +
      (src.samples ? `, server live in ${src.liveSamples}/${src.samples} samples` : "") + (th.source === "any" ? " (any source accepted)" : ""));
  if (r.webrtc) {
    add("delivery", "WebRTC observer", r.webrtc.finals > 0, `${r.webrtc.finals} final(s), ${r.webrtc.partials} partial(s) on the data channel` +
      (r.webrtc.unattributed ? `, ${r.webrtc.unattributed} not matched to a script` : ""));
  }
  if (r.edgeRoom) {
    add("delivery", "edge tap (SSE)", (r.edge?.finals ?? 0) > 0, r.edge ? `${r.edge.finals} final(s), ${r.edge.partials} partial(s) on the events stream` : "no tap");
    const d = r.delivery;
    add("delivery", "edge viewers", !!d && d.tapFinals > 0 && d.viewers > 0 && d.ratio >= th.edgeDelivery,
      d ? `top step hold: ${d.viewers} viewer(s) on the stream all along got ${d.finalsPerViewer?.toFixed(1)} final(s) each, the tap ${d.tapFinals} ` +
        `(${pctStr(d.ratio)}; PASS at >= ${pctStr(th.edgeDelivery)}); ${d.total ?? 0} caption events across all viewers` : "no viewer numbers");
  }
  if (r.webrtc) {
    const l = r.webrtc.latency;
    add("latency", "WebRTC p95", l.n > 0 && l.p95 <= th.webrtcP95Ms, l.n ? `p50 ${sStr(l.p50)}, p95 ${sStr(l.p95)} over ${l.n} phrase(s) (PASS at <= ${sStr(th.webrtcP95Ms)})` : "no phrase timed (no audio anchor or no captions)");
  }
  if (r.edgeRoom && r.edge) {
    const l = r.edge.latency;
    const limit = (r.edgeLatencyMs ?? 0) + th.edgeSlackMs;
    add("latency", "edge p95 (on screen)", l.n > 0 && Number.isFinite(r.edgeLatencyMs) && l.p95 <= limit,
      l.n ? `p50 ${sStr(l.p50)}, p95 ${sStr(l.p95)} over ${l.n} phrase(s), incl. the page's hold; edge live latency ${sStr(r.edgeLatencyMs)} (PASS at <= ${sStr(limit)})` : "no phrase timed");
  }
  // Accuracy: per presenter, from the WebRTC observer if it heard them, else the edge tap.
  const n = Math.max(r.webrtc?.presenters.length ?? 0, r.edge?.presenters.length ?? 0);
  for (let p = 0; p < n; p++) {
    const w = r.webrtc?.presenters[p];
    const e = r.edge?.presenters[p];
    const use = w && w.finals ? { s: w, via: "WebRTC" } : e && e.finals ? { s: e, via: "edge" } : null;
    const label = (w ?? e)?.label ?? `presenter ${p + 1}`;
    if (!use) {
      add("accuracy", `live WER ${label}`, false, "no captions attributed to this presenter");
      continue;
    }
    const x = use.s.wer;
    const cov = use.s.phrases ? ` coverage ${use.s.phrases - use.s.missed}/${use.s.phrases} phrases;` : "";
    add("accuracy", `live WER ${label}`, x.wer !== null && x.wer <= th.liveWer,
      `${pctStr(x.wer)} (${x.sub} sub, ${x.del} del, ${x.ins} ins over ${x.n} words, ${use.via});${cov} PASS at <= ${pctStr(th.liveWer)}` +
        (w && e && w.finals && e.finals ? `; edge ${pctStr(e.wer.wer)}` : ""));
  }
  if (r.stored) {
    for (const s of r.stored.presenters) {
      add("accuracy", `stored WER ${s.label}`, s.wer.wer !== null && s.wer.wer <= th.storedWer,
        s.lines ? `${pctStr(s.wer.wer)} over ${s.wer.n} words in ${s.lines} line(s) of transcript.txt; PASS at <= ${pctStr(th.storedWer)}` : "no stored lines for this presenter");
    }
  } else if (r.storedError) add("accuracy", "stored transcript", false, r.storedError);
  return rows;
}
