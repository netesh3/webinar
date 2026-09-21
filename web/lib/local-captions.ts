"use client";

import { useEffect, useRef } from "react";
import { api } from "@/lib/api";
import { captionText, downsample, rms } from "./caption-audio";

/* On-device captions.
 *
 * The previous engine was the browser's Web Speech API. Chrome implements that
 * by shipping audio to Google; when that request fails it raises `network`,
 * which is exactly "Speech recognition couldn't reach its service." Firefox
 * does not implement it at all. Neither is a captioner we control.
 *
 * This runs OpenAI's Whisper tiny.en through Transformers.js / ONNX Runtime
 * in the speaker's own tab. Nothing leaves the machine except the text we
 * already broadcast. The weights are fetched once (then cached by the
 * browser); the ONNX WASM is served from this origin, same reason MediaPipe
 * and RNNoise are.
 *
 * Captions still come from the speaker's published microphone, not a second
 * getUserMedia: a second capture was a second permission prompt and a second
 * device, and after a headset unplug those two would disagree.
 */

const MODEL_ID = "Xenova/whisper-tiny.en";
const TARGET_RATE = 16_000;
/** Seconds of audio per inference. Tiny Whisper is trained on 30s pads; a
 *  short window keeps latency in the 2–4s range a live caption can tolerate. */
const WINDOW_S = 3.2;
/** Hop inside the window so a word split across a boundary is not lost. */
const HOP_S = 1.6;
const MIN_RMS = 0.012;

/* Audio in, text out, and deliberately no `language` or `task` options.
 *
 * MODEL_ID is an English-only checkpoint, and Transformers.js throws on either
 * of those for one — "Cannot specify `task` or `language` for an English-only
 * model" — because there is no multilingual token for it to force. English
 * transcription is the only thing the model does, so both arguments were
 * redundant as well as fatal. Kept off the type so they cannot come back
 * without this comment being read. */
type Transcriber = (audio: Float32Array) => Promise<{ text?: string } | string>;

let transcriber: Promise<Transcriber> | null = null;

async function loadTranscriber(
  report: (key: string, message: string, tone?: "error" | "info") => void,
): Promise<Transcriber> {
  if (!transcriber) {
    transcriber = (async () => {
      report(
        "loading",
        "Loading captions on this device. The first time takes a moment; after that it stays on the machine.",
        "info",
      );
      const { pipeline, env } = await import("@huggingface/transformers");
      // WASM from our origin. The model still comes from the Hub on first use
      // and is then in the browser cache — inference itself never calls out.
      const wasm = env.backends.onnx.wasm;
      if (wasm) wasm.wasmPaths = "/onnxruntime/";
      env.allowLocalModels = false;
      env.useBrowserCache = true;

      const device =
        typeof navigator !== "undefined" && "gpu" in navigator
          ? "webgpu"
          : "wasm";

      try {
        return (await pipeline("automatic-speech-recognition", MODEL_ID, {
          device,
          dtype: "q8",
        })) as unknown as Transcriber;
      } catch (webgpuErr) {
        if (device === "wasm") throw webgpuErr;
        return (await pipeline("automatic-speech-recognition", MODEL_ID, {
          device: "wasm",
          dtype: "q8",
        })) as unknown as Transcriber;
      }
    })().catch((err) => {
      transcriber = null;
      throw err;
    });
  }
  return transcriber;
}

/**
 * Runs Whisper against `track` while `active` is true, and pushes recognised
 * lines through `send` / the captions log. `track` may be missing (mic off);
 * we wait rather than opening a second capture.
 */
export function useLocalCaptions(opts: {
  active: boolean;
  track: MediaStreamTrack | undefined;
  slug: string;
  joinKey: string | undefined;
  send: (text: string) => Promise<void>;
  report: (key: string, message: string, tone?: "error" | "info") => void;
}): void {
  const send = useRef(opts.send);
  useEffect(() => {
    send.current = opts.send;
  }, [opts.send]);
  const report = useRef(opts.report);
  useEffect(() => {
    report.current = opts.report;
  }, [opts.report]);

  const trackId = opts.track?.id;
  const { active, track, slug, joinKey } = opts;

  useEffect(() => {
    if (!active) return;
    if (!track || track.readyState === "ended") return;

    let stopped = false;
    const pending: number[] = [];
    let busy = false;
    let last = "";
    let lastPersistedAt = 0;

    const windowN = Math.round(WINDOW_S * TARGET_RATE);
    const hopN = Math.round(HOP_S * TARGET_RATE);

    const transcribe = async (pcm: Float32Array) => {
      if (stopped || rms(pcm) < MIN_RMS) return;
      const asr = await loadTranscriber(report.current);
      if (stopped) return;
      const out = await asr(pcm);
      const raw = typeof out === "string" ? out : (out.text ?? "");
      const clean = captionText(raw);
      if (!clean || clean === last) return;
      last = clean;
      void send.current(clean);
      const now = Date.now();
      if (now - lastPersistedAt > 2500) {
        lastPersistedAt = now;
        void api.appendCaption(slug, { joinKey, text: clean }).catch(() => undefined);
      }
    };

    const flush = () => {
      if (busy || pending.length < windowN) return;
      const pcm = Float32Array.from(pending.slice(0, windowN));
      pending.splice(0, hopN);
      busy = true;
      void transcribe(pcm)
        .catch((err) => {
          report.current(
            "failed",
            err instanceof Error
              ? `Captions couldn't start: ${err.message}`
              : "Captions couldn't start on this device.",
          );
        })
        .finally(() => {
          busy = false;
          if (!stopped) flush();
        });
    };

    const ctx = new AudioContext();
    const source = ctx.createMediaStreamSource(new MediaStream([track]));
    // 4096 is coarse enough that this is not a hot path, and ScriptProcessor
    // is the capture that does not need a separate worklet file. Output is
    // silenced — we must connect it or the callback never fires.
    const processor = ctx.createScriptProcessor(4096, 1, 1);
    processor.onaudioprocess = (ev) => {
      if (stopped) return;
      const input = ev.inputBuffer.getChannelData(0);
      const at16 = downsample(input, ctx.sampleRate, TARGET_RATE);
      for (let i = 0; i < at16.length; i++) pending.push(at16[i]!);
      const cap = windowN * 3;
      if (pending.length > cap) pending.splice(0, pending.length - cap);
      flush();
    };
    const drain = ctx.createGain();
    drain.gain.value = 0;
    source.connect(processor);
    processor.connect(drain);
    drain.connect(ctx.destination);
    void ctx.resume().catch(() => undefined);

    return () => {
      stopped = true;
      processor?.disconnect();
      source?.disconnect();
      drain?.disconnect();
      void ctx?.close().catch(() => undefined);
    };
  }, [active, trackId, track, slug, joinKey]);
}
