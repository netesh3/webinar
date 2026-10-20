/* Tests for the lock-screen keep-alive's checkable parts (lib/lock-screen-audio.ts).
 *
 * Run with `make test-web`. The flag decides who runs an experiment, so it must do exactly
 * what the link says and nothing on its own. The clip must be a WAV a browser will play, and
 * must stay far below anything audible: a hiss under a webinar would be worse than the bug.
 */

import {
  CLIP_SECONDS,
  isAndroid,
  lockScreenChoice,
  lockScreenState,
  setLockScreenState,
  silentWav,
} from "./lock-screen-audio.ts";

let failures = 0;
let checks = 0;

function ok(condition: boolean, what: string, detail = ""): void {
  checks++;
  if (condition) return;
  failures++;
  console.log(`  FAIL  ${what}${detail ? `\n        ${detail}` : ""}`);
}

function eq<T>(actual: T, expected: T, what: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  ok(a === e, what, a === e ? "" : `got ${a}\n        want ${e}`);
}

// ---------------------------------------------------------------- the platform

ok(
  isAndroid("Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36"),
  "Chrome's reduced user agent on Android still says Android",
);
ok(
  !isAndroid("Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1"),
  "an iPhone, which keeps playing locked already, is not Android",
);
ok(
  !isAndroid("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36"),
  "nor is a laptop",
);

// ---------------------------------------------------------------- the flag

eq(lockScreenChoice("", null), { on: false }, "off by default, and nothing is written");
eq(lockScreenChoice("?k=abc", null), { on: false }, "a room link's own key does not turn it on");
eq(lockScreenChoice("?k=abc&bg=1", null), { on: true, store: "1" }, "?bg=1 turns it on and remembers");
eq(lockScreenChoice("?k=abc", "1"), { on: true }, "remembered, a later join needs no flag");
eq(lockScreenChoice("?bg=0", "1"), { on: false, store: null }, "?bg=0 turns it off and forgets");
eq(lockScreenChoice("?bg=yes", "1"), { on: true }, "anything else in bg leaves the choice alone");
eq(lockScreenChoice("?bg=yes", null), { on: false }, "and does not turn it on");

// ---------------------------------------------------------------- the clip

{
  const wav = silentWav();
  const v = new DataView(wav);
  const text = (at: number, n: number) =>
    String.fromCharCode(...Array.from({ length: n }, (_, i) => v.getUint8(at + i)));
  eq([text(0, 4), text(8, 4), text(12, 4), text(36, 4)], ["RIFF", "WAVE", "fmt ", "data"], "a RIFF/WAVE file");
  eq([v.getUint16(20, true), v.getUint16(22, true), v.getUint16(34, true)], [1, 1, 16], "PCM, mono, 16-bit");
  const rate = v.getUint32(24, true);
  const bytes = v.getUint32(40, true);
  eq(v.getUint32(4, true), wav.byteLength - 8, "the RIFF size is the file less its first eight bytes");
  eq(bytes, wav.byteLength - 44, "the data size is everything after the header");
  eq(v.getUint32(28, true), rate * 2, "bytes per second agree with the rate");
  const seconds = bytes / 2 / rate;
  ok(seconds === CLIP_SECONDS, "as long as CLIP_SECONDS", `${seconds}s`);
  ok(seconds > 5, "over Chrome's five-second floor for media with a lock-screen card");

  let loudest = 0;
  let nonZero = 0;
  for (let at = 44; at < wav.byteLength; at += 2) {
    const s = v.getInt16(at, true);
    loudest = Math.max(loudest, Math.abs(s));
    if (s !== 0) nonZero++;
  }
  ok(loudest <= 1, "no sample louder than one step: about −90 dBFS", `peak ${loudest}`);
  ok(nonZero === bytes / 2, "and none exactly zero, which an audio path may skip as silence");
}

// ---------------------------------------------------------------- the state

{
  eq(lockScreenState(), "off", "nothing is running until the room starts it");
  setLockScreenState("playing");
  eq(lockScreenState(), "playing", "the room's state is what the report reads");
  setLockScreenState("off");
}

if (failures) {
  console.log(`\n${failures} of ${checks} failed`);
  process.exit(1);
}
console.log(`\n${checks} ok`);
