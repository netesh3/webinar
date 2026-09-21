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

export function captionText(raw: string): string {
  const clean = raw.replace(/\s+/g, " ").trim();
  if (!clean) return "";
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
