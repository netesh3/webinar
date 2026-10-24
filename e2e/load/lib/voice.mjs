/* Spoken audio for the presenters, for the captions check (run.mjs --captions).
 *
 * Each presenter reads its own known English script (SCRIPTS, numbers spelled out) in its own
 * voice, synthesised on the generator with espeak-ng (setup-generator.sh installs it) or, on a
 * Mac, `say`. Every sentence is synthesised on its own, so where it starts and ends in the file
 * is known to the sample; the sentences are then laid end to end into one 48 kHz mono 16-bit
 * WAV per presenter, which Chrome plays as the microphone (--use-file-for-fake-audio-capture,
 * looping).
 *
 * The presenters take turns: presenter i starts talking `overlapMs` before presenter i-1 stops,
 * so two people talk at once for a while (the agent captions the two most active speakers), and
 * every file is padded with silence to the same length, the loop. The phase between presenters
 * is whatever their Chrome opened the microphone at; lib/captions.mjs measures it (the audio
 * anchors) rather than assuming it.
 *
 * Nothing here needs a network: the WAVs are cached under the OS temp directory by a hash of
 * the scripts, voices and engine. */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const RATE = 48000;

/* Plain webinar sentences. No contractions, no names, no digits: numbers are words, so the
 * reference is what a person would say. One script per presenter, in turn order. */
export const SCRIPTS = [
  [
    "Good morning everyone and welcome to this session about planning a small online event.",
    "Today we will cover three topics in about forty five minutes.",
    "First we will look at how to choose a date and a time that suits your audience.",
    "Second we will talk about writing a clear invitation that people actually read.",
    "Third we will share a simple checklist for the day of the event.",
    "Most teams send their first reminder one week before the session.",
    "A second reminder one hour before the start usually brings twenty percent more people.",
    "Keep the title short and say exactly what people will learn.",
    "Ask one question in the registration form and no more than that.",
    "Test your microphone and your camera the day before.",
    "Have a friend join as a guest so you can see what the audience sees.",
    "Now I will hand over to my colleague who will talk about engagement.",
  ],
  [
    "Thank you and hello to everyone joining us from different cities.",
    "Engagement starts in the first five minutes of any session.",
    "Open with a quick poll so people get used to clicking.",
    "We usually see about sixty people answer the first poll out of every hundred.",
    "Questions are easier to manage when the audience can vote for them.",
    "Pick the top three questions and answer them in order.",
    "Chat should feel friendly, so greet people by name when you can.",
    "Short breaks every fifteen minutes help people stay with you.",
    "Use slides with large text and very few words on each one.",
    "A good rule is one idea for every slide.",
    "At the end, share two links and a clear next step.",
    "Let me pass it on for the last part about what comes next.",
  ],
  [
    "Thanks, I will finish with what happens after the event ends.",
    "Send the recording to every guest within twenty four hours.",
    "People who missed the live session often watch the first ten minutes.",
    "Write a short summary with the three main points from today.",
    "Include the answers to questions that we did not have time for.",
    "A simple survey with four questions tells you what to change.",
    "Look at how many people stayed until the end of the session.",
    "If half of them left early, the session was probably too long.",
    "Plan your next event while the feedback is still fresh.",
    "Small steps every month add up over a whole year.",
    "Thank you all for listening and for your great questions.",
    "We hope to see you again at our next session.",
  ],
];

// A different voice per presenter, per engine.
export const VOICES = {
  "espeak-ng": ["en-us", "en-gb", "en-us+f3"],
  say: ["Samantha", "Daniel", "Karen"],
};

/** The TTS engine on this machine: $LOAD_TTS, else espeak-ng, else macOS say; null if none. */
export function ttsEngine(env = process.env) {
  const want = env.LOAD_TTS;
  const has = (bin) => {
    try {
      execFileSync("which", [bin], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  };
  if (want) return has(want) ? want : null;
  if (has("espeak-ng")) return "espeak-ng";
  if (process.platform === "darwin" && has("say")) return "say";
  return null;
}

/* scheduleVoices(durations, opts) -> { loopMs, presenters: [{ startMs, endMs, sentences: [{ startMs, endMs }] }] }.
 * durations[p][s] is sentence s of presenter p in ms. Presenter 0 starts at leadMs; each sentence
 * follows the one before after gapMs; presenter p starts overlapMs before presenter p-1 stops
 * (never before presenter p-1 starts). The loop is the last presenter's end plus tailMs, so the
 * last speaker and the first one of the next loop do not overlap. Pure: the tests check it. */
export function scheduleVoices(durations, { leadMs = 1000, gapMs = 600, overlapMs = 8000, tailMs = 4000 } = {}) {
  const presenters = [];
  let prev = null;
  for (const ds of durations) {
    const startMs = prev ? Math.max(prev.startMs, prev.endMs - overlapMs) : leadMs;
    const sentences = [];
    let t = startMs;
    for (const [i, d] of ds.entries()) {
      if (i) t += gapMs;
      sentences.push({ startMs: Math.round(t), endMs: Math.round(t + d) });
      t += d;
    }
    prev = { startMs, endMs: Math.round(t), sentences };
    presenters.push(prev);
  }
  const loopMs = presenters.length ? Math.max(...presenters.map((p) => p.endMs)) + tailMs : 0;
  return { loopMs, presenters };
}

// ------------------------------------------------------------------ WAV

/** readWav(buffer) -> { rate, samples: Float32Array (mono, -1..1) }. 16-bit PCM or 32-bit float. */
export function readWav(buf) {
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") throw new Error("not a WAV file");
  let at = 12;
  let fmt = null;
  let data = null;
  while (at + 8 <= buf.length) {
    const id = buf.toString("ascii", at, at + 4);
    let size = buf.readUInt32LE(at + 4);
    const body = at + 8;
    // A streamed WAV (espeak-ng to stdout) leaves the size at 0 or 0xFFFFFFFF: the rest of the file.
    if (id === "data" && (size === 0 || body + size > buf.length)) size = buf.length - body;
    if (id === "fmt ") {
      fmt = {
        format: buf.readUInt16LE(body),
        channels: buf.readUInt16LE(body + 2),
        rate: buf.readUInt32LE(body + 4),
        bits: buf.readUInt16LE(body + 14),
      };
      if (fmt.format === 0xfffe && size >= 26) fmt.format = buf.readUInt16LE(body + 24);
    } else if (id === "data") {
      data = buf.subarray(body, body + size);
      break;
    }
    at = body + size + (size % 2);
  }
  if (!fmt || !data) throw new Error("WAV without fmt or data");
  const bytes = fmt.bits / 8;
  const frames = Math.floor(data.length / (bytes * fmt.channels));
  const out = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let sum = 0;
    for (let c = 0; c < fmt.channels; c++) {
      const o = (i * fmt.channels + c) * bytes;
      if (fmt.format === 3 && fmt.bits === 32) sum += data.readFloatLE(o);
      else if (fmt.bits === 16) sum += data.readInt16LE(o) / 32768;
      else if (fmt.bits === 8) sum += (data.readUInt8(o) - 128) / 128;
      else if (fmt.bits === 24) sum += data.readIntLE(o, 3) / 8388608;
      else if (fmt.bits === 32) sum += data.readInt32LE(o) / 2147483648;
      else throw new Error(`unsupported WAV: ${fmt.bits}-bit format ${fmt.format}`);
    }
    out[i] = sum / fmt.channels;
  }
  return { rate: fmt.rate, samples: out };
}

/** Linear-interpolation resample to `to` Hz. Plenty for speech recognition. */
export function resample(samples, from, to = RATE) {
  if (from === to) return samples;
  const n = Math.round((samples.length * to) / from);
  const out = new Float32Array(n);
  const step = from / to;
  for (let i = 0; i < n; i++) {
    const x = i * step;
    const j = Math.floor(x);
    const f = x - j;
    const a = samples[j] ?? 0;
    const b = samples[j + 1] ?? a;
    out[i] = a + (b - a) * f;
  }
  return out;
}

/** writeWav(samples Float32Array, rate) -> Buffer: mono 16-bit PCM. */
export function writeWav(samples, rate = RATE) {
  const data = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    data.writeInt16LE(Math.round(v < 0 ? v * 32768 : v * 32767), i * 2);
  }
  const h = Buffer.alloc(44);
  h.write("RIFF", 0, "ascii");
  h.writeUInt32LE(36 + data.length, 4);
  h.write("WAVE", 8, "ascii");
  h.write("fmt ", 12, "ascii");
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); // PCM
  h.writeUInt16LE(1, 22); // mono
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36, "ascii");
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

/** Trims leading/trailing near-silence (the engines pad each utterance), keeping 30 ms. */
export function trimSilence(samples, rate = RATE, threshold = 0.004) {
  let a = 0;
  let b = samples.length - 1;
  while (a < b && Math.abs(samples[a]) < threshold) a++;
  while (b > a && Math.abs(samples[b]) < threshold) b--;
  const pad = Math.round(rate * 0.03);
  return samples.subarray(Math.max(0, a - pad), Math.min(samples.length, b + 1 + pad));
}

/** One sentence through the engine -> mono samples at RATE. */
function synth(engine, voice, text, file) {
  if (engine === "espeak-ng") {
    // 160 words a minute: a calm presenter; -a 160 is a little louder than the default 100.
    execFileSync("espeak-ng", ["-v", voice, "-s", "160", "-a", "160", "-w", file, text], { stdio: "ignore" });
  } else if (engine === "say") {
    execFileSync("say", ["-v", voice, "-r", "170", "-o", file, "--file-format=WAVE", `--data-format=LEI16@${RATE}`, text], { stdio: "ignore" });
  } else throw new Error(`unknown TTS engine ${engine}`);
  const { rate, samples } = readWav(readFileSync(file));
  return trimSilence(resample(samples, rate, RATE));
}

/** Peak-normalise to `peak` (Chrome's AGC does the rest), in place. */
function normalise(samples, peak = 0.7) {
  let m = 0;
  for (const v of samples) m = Math.max(m, Math.abs(v));
  if (m > 0) for (let i = 0; i < samples.length; i++) samples[i] = (samples[i] / m) * peak;
  return samples;
}

/* makeVoices(n, { engine, dir, ...schedule opts }) -> { engine, loopMs, presenters: [{ label?, wav,
 * voice, script: [sentence], sentences: [{ text, startMs, endMs }], startMs, endMs }] }.
 * Builds (once, cached) one WAV per presenter. Throws without a TTS engine. */
export function makeVoices(n, o = {}) {
  const engine = o.engine ?? ttsEngine();
  if (!engine) throw new Error("--captions needs a text-to-speech engine: apt-get install espeak-ng (setup-generator.sh does), or macOS say");
  if (n < 1 || n > SCRIPTS.length) throw new Error(`voices for 1-${SCRIPTS.length} presenters`);
  const voices = (o.voices ?? VOICES[engine] ?? []).slice(0, n);
  const sched = { leadMs: o.leadMs ?? 1000, gapMs: o.gapMs ?? 600, overlapMs: o.overlapMs ?? 8000, tailMs: o.tailMs ?? 4000 };
  const scripts = SCRIPTS.slice(0, n);
  const key = createHash("sha256").update(JSON.stringify({ engine, voices, scripts, sched, v: 1 })).digest("hex").slice(0, 12);
  const dir = join(o.dir ?? join(tmpdir(), "webinarliv-load-media"), `voice-${key}`);
  const meta = join(dir, "voices.json");
  if (existsSync(meta)) {
    const m = JSON.parse(readFileSync(meta, "utf8"));
    if (m.presenters.every((p) => existsSync(p.wav))) return m;
  }
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, "sentence.wav");
  const clips = scripts.map((lines, p) => lines.map((text) => normalise(synth(engine, voices[p] ?? voices[0], text, tmp))));
  rmSync(tmp, { force: true });
  const plan = scheduleVoices(clips.map((cs) => cs.map((c) => (c.length / RATE) * 1000)), sched);
  const total = Math.ceil((plan.loopMs / 1000) * RATE);
  const presenters = plan.presenters.map((pp, p) => {
    const out = new Float32Array(total);
    for (const [s, c] of clips[p].entries()) out.set(c.subarray(0, Math.max(0, total - Math.round((pp.sentences[s].startMs / 1000) * RATE))), Math.round((pp.sentences[s].startMs / 1000) * RATE));
    const wav = join(dir, `presenter${p + 1}.wav`);
    writeFileSync(wav, writeWav(out));
    return {
      wav,
      voice: voices[p] ?? voices[0],
      startMs: pp.startMs,
      endMs: pp.endMs,
      sentences: pp.sentences.map((x, s) => ({ text: scripts[p][s], ...x })),
    };
  });
  const m = { engine, loopMs: plan.loopMs, rate: RATE, presenters };
  writeFileSync(meta, JSON.stringify(m, null, 2));
  return m;
}
