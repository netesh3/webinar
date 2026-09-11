"use client";

import { Track, type Room } from "livekit-client";
import { canRecord, pickRecordingMime } from "./recorder";
import type { RecorderCallbacks, RecorderState, RecordingTransport } from "./recorder";

/* Recording the host's screen directly, instead of compositing the whole stage.
 *
 * SessionRecorder (recorder.ts) draws every participant onto a canvas 20-25
 * times a second and re-encodes that — CPU the live call is already spending
 * on decoding everyone else's video and encoding this participant's own. This
 * class skips the canvas entirely: getDisplayMedia hands MediaRecorder the
 * screen capture the OS/browser already produces, so there is no JS-driven
 * repaint loop competing with the call for CPU. What is lost is the layout —
 * this records exactly what is on the host's screen, with no camera
 * thumbnails overlaid — which is the trade a host asking for "no lag" is
 * making on purpose.
 *
 * A second file, not a mode flag on SessionRecorder: the two have almost
 * nothing in common past the RecordingTransport they both write to, and
 * forcing one class to do both would make the composited path — the one every
 * cloud recording still uses — harder to read for a feature that only ever
 * runs locally.
 *
 * Two permission prompts, one click. getDisplayMedia (the screen picker) and,
 * for local saving, showSaveFilePicker (see local-recording.ts) both require
 * a user gesture. Both are attempted back to back from the same click with
 * nothing else awaited in between, which is what keeps the second one inside
 * the same activation window as the first — see `start` below.
 */

const CHUNK_MS = 5000;
const VIDEO_BITS = 2_000_000;
const AUDIO_BITS = 128_000;

export class ScreenRecorder {
  private state: RecorderState = "idle";
  private display: MediaStream | null = null;
  private micTrack: MediaStreamTrack | null;
  private audioCtx: AudioContext | null = null;
  private recorder: MediaRecorder | null = null;
  private id: string | null = null;
  private startedAt = 0;
  private bytes = 0;
  /** Uploads/writes are chained rather than fired in parallel — see
   *  SessionRecorder's identical comment: the file is an ordered byte stream. */
  private queue: Promise<unknown> = Promise.resolve();
  private failed = false;

  constructor(
    room: Room,
    private transport: RecordingTransport,
    private callbacks: RecorderCallbacks,
  ) {
    // Read once, at construction, not tracked live: the mic can be muted or
    // swapped mid-recording, and this is a best-effort narration track for a
    // screen capture, not something that needs to track every change the way
    // the live call's own audio does.
    this.micTrack =
      room.localParticipant.getTrackPublication(Track.Source.Microphone)?.track
        ?.mediaStreamTrack ?? null;
  }

  getState(): RecorderState {
    return this.state;
  }

  async start(): Promise<void> {
    if (this.state !== "idle") return;
    const mime = pickRecordingMime();
    if (!mime) {
      this.callbacks.onError("This browser can't record video.");
      return;
    }

    this.state = "starting";
    try {
      // The FIRST await, deliberately, with nothing before it — the screen
      // picker needs an unbroken chain back to the click that started this.
      this.display = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: true, // the "share audio" checkbox, if the host ticks it
      });

      const videoTrack = this.display.getVideoTracks()[0];
      if (!videoTrack) throw new Error("No screen was selected.");
      // Same choice the app's own screen-share button makes: hold pixels over
      // frame rate, which is what keeps on-screen text legible under load.
      try {
        videoTrack.contentHint = "text";
      } catch {
        // Not every browser honours contentHint; the recording still works.
      }
      // The browser's own "Stop sharing" bar ends the track directly — treat
      // that exactly like pressing this app's Stop button, so a host who
      // stops from there still gets a finished, playable file instead of a
      // recorder left waiting on a stream that is already gone.
      videoTrack.addEventListener("ended", () => {
        void this.stop();
      });

      // The second permission prompt from this same click — see the module
      // doc comment above.
      const { id } = await this.transport.start(mime);
      this.id = id;

      const outStream = new MediaStream([videoTrack]);
      const audio = this.mixedAudio();
      if (audio) outStream.addTrack(audio);

      this.recorder = new MediaRecorder(outStream, {
        mimeType: mime,
        videoBitsPerSecond: VIDEO_BITS,
        audioBitsPerSecond: AUDIO_BITS,
      });
      this.recorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) this.enqueue(e.data);
      };
      this.recorder.onerror = () => {
        this.callbacks.onError(
          "The recorder stopped unexpectedly. What was captured is saved.",
        );
        void this.stop();
      };

      this.startedAt = Date.now();
      this.recorder.start(CHUNK_MS);
      this.state = "recording";
      this.callbacks.onStarted(id);
    } catch (err) {
      await this.teardown();
      this.state = "idle";
      this.callbacks.onError(
        err instanceof Error ? err.message : "Could not start recording.",
      );
    }
  }

  /** Mixes the host's own microphone with whatever audio the shared screen
   *  itself carries (a shared browser tab's sound, if "share audio" was
   *  ticked). Both, one or neither may exist — a screen with no shared audio
   *  and a muted host is a silent recording, which is still a valid choice
   *  rather than an error. */
  private mixedAudio(): MediaStreamTrack | null {
    const sources: MediaStreamTrack[] = [];
    const shared = this.display?.getAudioTracks()[0];
    if (shared) sources.push(shared);
    if (this.micTrack) sources.push(this.micTrack);

    if (sources.length === 0) return null;
    if (sources.length === 1) return sources[0];

    this.audioCtx = new AudioContext();
    const dest = this.audioCtx.createMediaStreamDestination();
    for (const track of sources) {
      this.audioCtx.createMediaStreamSource(new MediaStream([track])).connect(dest);
    }
    return dest.stream.getAudioTracks()[0] ?? null;
  }

  /** Queues one chunk. Same retry policy as SessionRecorder's: two retries,
   *  then the recording is stopped rather than silently losing the middle of
   *  the file. */
  private enqueue(blob: Blob): void {
    const id = this.id;
    if (!id || this.failed) return;

    this.queue = this.queue.then(async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await this.transport.chunk(id, blob);
          this.bytes += blob.size;
          this.callbacks.onProgress?.(this.bytes);
          return;
        } catch (err) {
          if (attempt === 2) {
            this.failed = true;
            this.callbacks.onError(
              `Recording stopped: ${err instanceof Error ? err.message : "a write failed"}. What was saved is kept.`,
            );
            void this.stop();
            return;
          }
          await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
        }
      }
    });
  }

  async stop(): Promise<void> {
    if (this.state !== "recording" && this.state !== "starting") return;
    this.state = "stopping";
    const id = this.id;
    const durationMs = this.startedAt ? Date.now() - this.startedAt : 0;

    // Wait for the encoder to hand over everything it is holding — see
    // SessionRecorder's identical wait for why this await is not optional.
    await new Promise<void>((resolve) => {
      const recorder = this.recorder;
      if (!recorder || recorder.state === "inactive") {
        resolve();
        return;
      }
      const failsafe = setTimeout(resolve, 10_000);
      recorder.onstop = () => {
        clearTimeout(failsafe);
        resolve();
      };
      try {
        recorder.requestData();
        recorder.stop();
      } catch {
        clearTimeout(failsafe);
        resolve();
      }
    });

    await this.teardown();
    // Every queued write has to land before the recording is marked
    // finished, or the transport closes the file while bytes are still
    // pending.
    await this.queue.catch(() => {});

    if (id) {
      try {
        await this.transport.complete(id, durationMs);
      } catch (err) {
        this.callbacks.onError(
          err instanceof Error
            ? `Couldn't close the recording: ${err.message}`
            : "Couldn't close the recording.",
        );
      }
    }

    this.state = "idle";
    this.id = null;
    this.callbacks.onStopped(id);
  }

  private async teardown(): Promise<void> {
    this.recorder = null;
    this.display?.getTracks().forEach((t) => t.stop());
    this.display = null;
    if (this.audioCtx) {
      await this.audioCtx.close().catch(() => {});
      this.audioCtx = null;
    }
  }
}

/** Whether this browser can capture the screen at all. Distinct from
 *  canRecordLocally (local-recording.ts), which is about SAVING; this is
 *  about CAPTURING, and the two are independent — a browser can have one
 *  without the other. */
export function canRecordScreen(): boolean {
  return (
    canRecord() &&
    typeof navigator !== "undefined" &&
    typeof navigator.mediaDevices?.getDisplayMedia === "function"
  );
}
