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

  it("keeps a real sentence", () => {
    assert.equal(
      captionText("  Let's look at the next slide. "),
      "Let's look at the next slide.",
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
