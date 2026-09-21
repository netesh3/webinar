import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { captionText, downsample, rms } from "./caption-audio.ts";

describe("captionText", () => {
  it("drops Whisper's silence hallucinations", () => {
    assert.equal(captionText("Thank you."), "");
    assert.equal(captionText("  thanks for watching  "), "");
    assert.equal(captionText("you"), "");
  });

  /* What the model actually returns on a quiet line. Verified against
   * Xenova/whisper-tiny.en itself, which answered " [BLANK_AUDIO]" for 3.2s of
   * a faint tone — audio above the RMS gate, so this reaches a viewer's screen
   * unless it is dropped here. */
  it("drops Whisper's non-speech tags", () => {
    assert.equal(captionText(" [BLANK_AUDIO]"), "");
    assert.equal(captionText("[ Silence ]"), "");
    assert.equal(captionText("(applause)"), "");
    assert.equal(captionText("[MUSIC PLAYING]"), "");
  });

  it("keeps the speech around a tag it strips", () => {
    assert.equal(
      captionText("So [BLANK_AUDIO] where were we"),
      "So where were we",
    );
  });

  /* The reported failure, verbatim off the screen: Whisper looping one fragment
   * until it ran out of tokens, filling the caption bar and spilling past the
   * edge of the video. Bounded generation makes this rarer; nothing makes it
   * impossible, so it has to die here too. */
  it("drops a decoder that has fallen into a loop", () => {
    assert.equal(captionText("ste" + "'e".repeat(80)), "");
    assert.equal(captionText("biasesVIDEO ".repeat(11).trim()), "");
    assert.equal(
      captionText("proc bicy at fare " + "biasesVIDEO ".repeat(8).trim()),
      "",
    );
  });

  /* Repetition is also something people say, so the rule is proportional rather
   * than "no repeats". These are short, and mostly not a repeated fragment. */
  it("keeps speech that repeats a word on purpose", () => {
    assert.equal(captionText("no no no no"), "no no no no");
    assert.equal(captionText("that is very very good"), "that is very very good");
  });

  it("keeps a real sentence", () => {
    assert.equal(
      captionText("  Let's look at the next slide. "),
      "Let's look at the next slide.",
    );
    assert.equal(
      captionText("I'm just going to share my screen for a moment"),
      "I'm just going to share my screen for a moment",
    );
  });
});

describe("downsample", () => {
  it("is a no-op when the rates match", () => {
    const src = new Float32Array([0, 0.5, 1]);
    assert.equal(downsample(src, 16000, 16000), src);
  });

  it("halves a 32 kHz buffer to 16 kHz", () => {
    const src = new Float32Array([0, 1, 2, 3, 4, 5, 6, 7]);
    const out = downsample(src, 32000, 16000);
    assert.equal(out.length, 4);
    assert.deepEqual(Array.from(out), [0, 2, 4, 6]);
  });
});

describe("rms", () => {
  it("is zero for silence", () => {
    assert.equal(rms(new Float32Array(32)), 0);
  });
});
