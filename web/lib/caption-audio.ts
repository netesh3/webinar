/** Tiny Whisper hallucinates these on silence. Dropped rather than shown. */
const HALLUCINATIONS = new Set([
  "thank you",
  "thanks",
  "thanks for watching",
  "thank you for watching",
  "you",
  "the",
  "a",
  ".",
  "...",
]);

/* Whisper reports non-speech as a bracketed tag rather than an empty string:
 * [BLANK_AUDIO], [MUSIC], (applause). On a quiet line [BLANK_AUDIO] is its most
 * common output by far — the RMS gate in local-captions.ts skips true silence,
 * but room noise just above that threshold still reaches the model and comes
 * back as one of these. None of them is something a viewer reading captions
 * asked for.
 *
 * Stripped inline rather than only when the tag is the whole output, because
 * Whisper mixes them into a line it does transcribe. Speech itself is not
 * parenthesised, so there is nothing of value in the brackets to lose. */
const NON_SPEECH_TAG = /\[[^\]]*\]|\([^)]*\)/g;

/** Any short fragment repeated back to back three or more times. */
const RUN = /(.{1,20}?)\1{2,}/g;

/* Whisper loops, and greedy decoding on a three-second window is where it does
 * it: a cut mid-word, or noise the RMS gate let through, and it repeats one
 * fragment until the token budget runs out. The reported case filled the caption
 * bar with "ste'e'e'e'e'e'…" and ran off the side of the screen.
 *
 * Bounded generation in local-captions.ts makes this rarer and shorter. It does
 * not make it impossible — the model is free to return whatever it likes — and
 * one of these on screen in front of an audience is worse than a dropped line,
 * so the text is judged too.
 *
 * Proportional rather than a flat "no repeats" rule, because repetition is also
 * something people say. "no no no no" is eleven characters and survives; a line
 * that is half one repeated fragment, or contains a "word" longer than any real
 * one, was not spoken by anybody.
 */
function isDegenerate(s: string): boolean {
  if (/\S{40,}/.test(s)) return true;
  if (s.length < 30) return false;
  return s.replace(RUN, "$1").length < s.length / 2;
}

export function captionText(raw: string): string {
  const clean = raw.replace(NON_SPEECH_TAG, " ").replace(/\s+/g, " ").trim();
  if (!clean) return "";
  if (isDegenerate(clean)) return "";
  const key = clean.toLowerCase().replace(/[!.?]+$/g, "").trim();
  if (HALLUCINATIONS.has(key)) return "";
  if (key.length < 2) return "";
  return clean;
}

export function downsample(
  input: Float32Array,
  inRate: number,
  outRate: number,
): Float32Array {
  if (inRate === outRate) return input;
  if (inRate <= 0 || outRate <= 0 || input.length === 0) {
    return new Float32Array(0);
  }
  const ratio = inRate / outRate;
  const n = Math.max(1, Math.floor(input.length / ratio));
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = input[Math.min(input.length - 1, Math.floor(i * ratio))]!;
  }
  return out;
}

export function rms(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) {
    const v = samples[i]!;
    sum += v * v;
  }
  return Math.sqrt(sum / samples.length);
}
