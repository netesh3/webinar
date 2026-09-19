"use client";

import { RoomEvent, Track, type Participant, type Room } from "livekit-client";

/* Recording a session, from the browser of whoever pressed record.
 *
 * Three things happen here, and they are separate on purpose:
 *
 *   1. COMPOSITE  — the tracks in the room are drawn onto a canvas, laid out the
 *      way a viewer sees them, and the participants' audio is mixed into one
 *      stream. This is what makes the file a recording of the webinar rather than
 *      a folder of separate streams somebody has to edit together.
 *   2. ENCODE     — MediaRecorder turns that into a container the browser can
 *      produce. Which container that is differs by browser, so it is negotiated
 *      rather than assumed.
 *   3. UPLOAD     — each chunk is sent as it is produced, in order, one at a time.
 *      Nothing is held in memory: a forty-minute recording is gigabytes, and a
 *      tab that accumulates it crashes before anyone can save it.
 *
 * Why in the browser: it records exactly what was on screen, including the screen
 * share, with no second renderer to keep in step with the room's layout, and it
 * needs no infrastructure. The cost is honest and stated in the UI — it stops if
 * this tab closes, and it uses this machine's CPU. Zoom's local recording has the
 * same property. The server API is the same shape a server-side recorder would
 * use, so moving this to LiveKit Egress later changes nothing a host sees.
 */

/** Canvas size: 1080p Full HD for razor-sharp presentation text & video. */
const WIDTH = 1920;
const HEIGHT = 1080;
const FPS = 30;

/** How much video is buffered before a chunk is emitted. Five seconds is a
 *  compromise: shorter means more requests, longer means more lost if the tab
 *  dies. */
const CHUNK_MS = 5000;

const VIDEO_BITS = 6_000_000; // 6.0 Mbps for crisp 1080p screenshare & camera
const AUDIO_BITS = 192_000; // 192 kbps high-fidelity stereo/mixed audio

/** Containers in order of preference.
 *
 *  Hardware-accelerated VP8 and H.264 first for smooth 30 FPS recording with near-zero CPU.
 *  Software-only VP9 is kept as fallback. */
const CANDIDATE_MIMES = [
  'video/webm;codecs="vp8,opus"',
  'video/mp4;codecs="avc1.42E01E,mp4a.40.2"',
  'video/mp4;codecs="avc1.640028,mp4a.40.2"',
  "video/mp4",
  "video/webm",
  'video/webm;codecs="vp9,opus"',
];

export function pickRecordingMime(): string | null {
  if (typeof MediaRecorder === "undefined") return null;
  for (const mime of CANDIDATE_MIMES) {
    if (MediaRecorder.isTypeSupported(mime)) return mime;
  }
  return null;
}

/** Whether this browser can record at all. Firefox has MediaRecorder but no
 *  canvas.captureStream on older versions, and a control that fails on click is
 *  worse than one that is not offered. */
export function canRecord(): boolean {
  return (
    typeof MediaRecorder !== "undefined" &&
    typeof HTMLCanvasElement !== "undefined" &&
    typeof HTMLCanvasElement.prototype.captureStream === "function" &&
    typeof AudioContext !== "undefined" &&
    pickRecordingMime() !== null
  );
}

// --------------------------------------------------------------- compositing

type VideoSource = {
  key: string;
  el: HTMLVideoElement;
  isScreen: boolean;
  name: string;
};

/**
 * Keeps one hidden <video> element per video track being recorded.
 *
 * The elements are in the DOM, not detached: a detached element is not required
 * to render, and Safari in particular will hand back black frames for one. They
 * are 1×1 and invisible, and removed when their track goes away.
 */
class VideoSources {
  private els = new Map<string, VideoSource>();
  private host: HTMLDivElement;
  private cachedList: VideoSource[] = [];

  constructor(private room: Room) {
    this.host = document.createElement("div");
    this.host.setAttribute("aria-hidden", "true");
    // Place in DOM with non-zero dimensions and tiny opacity rather than -9999px / 1px
    // so Chrome and Safari compositors classify the video elements as active on-screen
    // surfaces and decode frames at full 30/60 fps without dropping or throttling.
    this.host.style.cssText =
      "position:fixed;left:0;top:0;width:320px;height:180px;opacity:0.001;pointer-events:none;z-index:-9999;overflow:hidden;";
    document.body.appendChild(this.host);
    this.sync();
    for (const ev of RECORDER_EVENTS) {
      this.room.on(ev, this.onRoomChange);
    }
  }

  private onRoomChange = () => {
    this.sync();
  };

  getSources(): VideoSource[] {
    return this.cachedList;
  }

  /** Reconciles the elements against what the room is publishing right now. */
  sync(): VideoSource[] {
    const wanted = new Map<string, { track: MediaStreamTrack; isScreen: boolean; name: string }>();

    const collect = (p: Participant) => {
      for (const source of [Track.Source.ScreenShare, Track.Source.Camera]) {
        const pub = p.getTrackPublication(source);
        const track = pub?.track?.mediaStreamTrack;
        if (!track || pub?.isMuted || track.readyState !== "live") continue;
        wanted.set(`${p.identity}:${source}`, {
          track,
          isScreen: source === Track.Source.ScreenShare,
          name: p.name || p.identity,
        });
      }
    };
    collect(this.room.localParticipant);
    this.room.remoteParticipants.forEach(collect);

    for (const [key, existing] of this.els) {
      if (!wanted.has(key)) {
        existing.el.srcObject = null;
        existing.el.remove();
        this.els.delete(key);
      }
    }

    for (const [key, want] of wanted) {
      const existing = this.els.get(key);
      if (existing) {
        existing.name = want.name;
        continue;
      }
      const el = document.createElement("video");
      el.muted = true;
      el.playsInline = true;
      el.autoplay = true;
      el.style.cssText = "width:320px;height:180px;object-fit:contain;";
      el.srcObject = new MediaStream([want.track]);
      this.host.appendChild(el);
      void el.play().catch(() => {});
      this.els.set(key, { key, el, isScreen: want.isScreen, name: want.name });
    }

    this.cachedList = [...this.els.values()].sort(
      (a, b) => Number(b.isScreen) - Number(a.isScreen) || a.key.localeCompare(b.key),
    );
    return this.cachedList;
  }

  dispose(): void {
    for (const ev of RECORDER_EVENTS) {
      this.room.off(ev, this.onRoomChange);
    }
    for (const { el } of this.els.values()) {
      el.srcObject = null;
      el.remove();
    }
    this.els.clear();
    this.cachedList = [];
    this.host.remove();
  }
}

/** Draws one video into a box, preserving aspect ratio and staying inside it.
 *
 *  `cover` for a camera — letterboxing a face wastes half the tile. `contain` for
 *  a screen share, because cropping a slide is how the bottom line of a terminal
 *  goes missing. The same rule as the live tiles, for the same reason.
 *
 *  The clip is not defensive tidying, it is the point. `cover` scales the image
 *  until it is at least as large as the box, so it is LARGER than the box in one
 *  dimension by definition, and a canvas draw is not bounded by the rectangle you
 *  computed it from — it is bounded by the canvas. Without the clip each tile
 *  painted over its neighbours and the last one drawn won: a two-person recording
 *  came out as a 25% slice of one participant beside an off-centre 75% of the
 *  other, which is what a viewer sees as "the recording is misaligned". */
function drawInto(
  ctx: CanvasRenderingContext2D,
  el: HTMLVideoElement,
  x: number,
  y: number,
  w: number,
  h: number,
  mode: "cover" | "contain",
): void {
  const vw = el.videoWidth;
  const vh = el.videoHeight;
  if (!vw || !vh) return;

  const scale =
    mode === "cover" ? Math.max(w / vw, h / vh) : Math.min(w / vw, h / vh);
  const dw = vw * scale;
  const dh = vh * scale;

  ctx.save();
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "medium";
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  ctx.drawImage(el, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
  ctx.restore();
}

/** Text widths for `label`, keyed by the string. The font never changes, so a
 *  width measured once stays correct — and it is worth caching, because
 *  `measureText` runs inside the draw loop, once per visible tile, every
 *  single frame. A session's set of names is small and stops growing once
 *  everyone has joined, so this never needs eviction. */
const labelWidths = new Map<string, number>();

function label(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, w: number): void {
  if (!text) return;
  ctx.save();
  ctx.font = "500 15px system-ui, -apple-system, sans-serif";
  let width = labelWidths.get(text);
  if (width === undefined) {
    width = ctx.measureText(text).width;
    labelWidths.set(text, width);
  }
  const padding = 8;
  const boxWidth = Math.min(width + padding * 2, w - 8);
  ctx.fillStyle = "rgba(0,0,0,0.55)";
  ctx.fillRect(x + 4, y - 28, boxWidth, 24);
  ctx.fillStyle = "#fff";
  ctx.textBaseline = "middle";
  ctx.save();
  ctx.beginPath();
  ctx.rect(x + 4, y - 28, boxWidth, 24);
  ctx.clip();
  ctx.fillText(text, x + 4 + padding, y - 16);
  ctx.restore();
  ctx.restore();
}

/** The shape every tile is laid out at. Cameras and shares are 16:9, so a tile of
 *  any other shape has to crop or letterbox something. */
const TILE_ASPECT = 16 / 9;

/**
 * Chooses the grid, and the 16:9 tile size that fits it.
 *
 * Dividing the canvas evenly is the obvious thing and it is wrong. Two people on a
 * 16:9 frame gives two 640×720 cells — nearly square, in portrait — and a 16:9
 * camera filling one of those loses half its width. Both faces came out as
 * vertical slices, which is what the recording looked like.
 *
 * So the tiles are sized at 16:9 and the block they form is centred, letterboxing
 * whatever is left over. Two people become two 640×360 tiles across the middle
 * with bars above and below: nothing cropped, and the same arrangement the live
 * stage and every other conferencing tool uses.
 *
 * The grid is picked by trying every column count and keeping the one that makes
 * the largest tile, with ties going to the wider grid — that is what puts two
 * people side by side rather than stacked, and three as two-over-one.
 */
function gridFor(count: number): { cols: number; rows: number; tileW: number; tileH: number } {
  let best = { cols: 1, rows: count, tileW: 0, tileH: 0 };
  for (let cols = 1; cols <= count; cols++) {
    const rows = Math.ceil(count / cols);
    const tileW = Math.min(WIDTH / cols, (HEIGHT / rows) * TILE_ASPECT);
    const tileH = tileW / TILE_ASPECT;
    // >= rather than > so the widest of equally good grids wins.
    if (tileW * tileH >= best.tileW * best.tileH) best = { cols, rows, tileW, tileH };
  }
  return best;
}

/**
 * Lays the sources out on the canvas.
 *
 * A screen share takes the whole frame with the presenters as small tiles down the
 * corner, because the share is the content. Otherwise it is a centred grid of 16:9
 * tiles. Both match what the live stage does, so the recording looks like the
 * meeting people remember being in.
 */
function paint(
  ctx: CanvasRenderingContext2D,
  sources: VideoSource[],
  topic: string,
): void {
  ctx.fillStyle = "#0d0d11";
  ctx.fillRect(0, 0, WIDTH, HEIGHT);

  if (sources.length === 0) {
    ctx.fillStyle = "rgba(255,255,255,0.5)";
    ctx.font = "500 20px system-ui, -apple-system, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(topic || "Waiting for the stage", WIDTH / 2, HEIGHT / 2);
    ctx.textAlign = "left";
    return;
  }

  const share = sources.find((s) => s.isScreen);
  if (share) {
    drawInto(ctx, share.el, 0, 0, WIDTH, HEIGHT, "contain");
    label(ctx, `${share.name} — screen`, 0, HEIGHT - 8, WIDTH);

    // Up to three faces stacked in the corner. More than that and each one is
    // too small to be worth the pixels.
    const others = sources.filter((s) => !s.isScreen).slice(0, 3);
    const tileW = 240;
    const tileH = 135;
    others.forEach((source, i) => {
      const x = WIDTH - tileW - 16;
      const y = 16 + i * (tileH + 12);
      ctx.fillStyle = "#16161c";
      ctx.fillRect(x, y, tileW, tileH);
      drawInto(ctx, source.el, x, y, tileW, tileH, "cover");
      label(ctx, source.name, x, y + tileH - 4, tileW);
    });
    return;
  }

  const count = Math.min(sources.length, 9);
  const { cols, rows, tileW, tileH } = gridFor(count);
  const originX = (WIDTH - cols * tileW) / 2;
  const originY = (HEIGHT - rows * tileH) / 2;
  const gap = 4;

  sources.slice(0, count).forEach((source, i) => {
    const row = Math.floor(i / cols);
    // A last row that is not full is centred on its own, so three people are two
    // above and one in the middle rather than one hugging the left edge.
    const inRow = Math.min(cols, count - row * cols);
    const x = originX + ((cols - inRow) * tileW) / 2 + (i % cols) * tileW;
    const y = originY + row * tileH;

    const w = tileW - gap;
    const h = tileH - gap;
    ctx.fillStyle = "#16161c";
    ctx.fillRect(x + gap / 2, y + gap / 2, w, h);
    drawInto(ctx, source.el, x + gap / 2, y + gap / 2, w, h, "cover");
    label(ctx, source.name, x + gap / 2, y + tileH - gap, w);
  });
}

// -------------------------------------------------------------- audio mixing

/**
 * Mixes every audio track in the room into one stream.
 *
 * Web Audio rather than picking one track: a recording with only the host's
 * microphone loses the question that was asked, which is usually the part worth
 * keeping. Sources are reconciled as people speak and leave.
 */
export class AudioMixer {
  private ctx: AudioContext;
  private dest: MediaStreamAudioDestinationNode;
  private nodes = new Map<string, MediaStreamAudioSourceNode>();

  constructor(private room: Room) {
    this.ctx = new AudioContext();
    this.dest = this.ctx.createMediaStreamDestination();
    this.sync();
    for (const ev of RECORDER_EVENTS) {
      this.room.on(ev, this.onRoomChange);
    }
  }

  private onRoomChange = () => {
    this.sync();
  };

  get track(): MediaStreamTrack | null {
    return this.dest.stream.getAudioTracks()[0] ?? null;
  }

  sync(): void {
    const wanted = new Map<string, MediaStreamTrack>();
    /* Microphones AND the audio of anything being shared.
     *
     * Only microphones were collected, which meant a recording of a session where the host
     * played a video captured the picture and none of its sound — the same silence the
     * audience used to get, preserved in the file. A shared clip is usually the reason the
     * recording exists.
     *
     * Keyed by identity AND source, because one participant can be a microphone and a shared
     * video at the same time and they are two nodes; keying on identity alone would have the
     * second overwrite the first. */
    const collect = (p: Participant) => {
      for (const source of [Track.Source.Microphone, Track.Source.ScreenShareAudio]) {
        const pub = p.getTrackPublication(source);
        const track = pub?.track?.mediaStreamTrack;
        if (track && !pub?.isMuted && track.readyState === "live") {
          wanted.set(`${p.identity}:${source}`, track);
        }
      }
    };
    collect(this.room.localParticipant);
    this.room.remoteParticipants.forEach(collect);

    // `key` rather than `identity`: it is now identity:source, because one person can be
    // both a microphone and a shared video and each needs its own node.
    for (const [key, node] of this.nodes) {
      if (!wanted.has(key)) {
        node.disconnect();
        this.nodes.delete(key);
      }
    }
    for (const [key, track] of wanted) {
      if (this.nodes.has(key)) continue;
      const node = this.ctx.createMediaStreamSource(new MediaStream([track]));
      node.connect(this.dest);
      this.nodes.set(key, node);
    }
  }

  /** Browsers start an AudioContext suspended until a gesture; pressing record is
   *  that gesture, so this is safe to call here and required for audio to flow. */
  createClock(onTick: () => void): () => void {
    try {
      const scriptNode = this.ctx.createScriptProcessor(1024, 1, 1);
      scriptNode.onaudioprocess = () => {
        onTick();
      };
      const dummyGain = this.ctx.createGain();
      dummyGain.gain.value = 0;
      scriptNode.connect(dummyGain);
      dummyGain.connect(this.ctx.destination);
      return () => {
        try {
          scriptNode.disconnect();
          dummyGain.disconnect();
        } catch {}
      };
    } catch {
      return () => {};
    }
  }

  async resume(): Promise<void> {
    if (this.ctx.state === "suspended") {
      await this.ctx.resume().catch(() => {});
    }
  }

  async dispose(): Promise<void> {
    for (const ev of RECORDER_EVENTS) {
      this.room.off(ev, this.onRoomChange);
    }
    for (const node of this.nodes.values()) node.disconnect();
    this.nodes.clear();
    await this.ctx.close().catch(() => {});
  }
}

/**
 * A clock that does not get throttled when the tab is hidden / in the background.
 *
 * Browsers throttle window.setInterval down to 1000ms (1 FPS) in hidden tabs,
 * and requestAnimationFrame stops completely. A Web Worker runs on an independent
 * thread and is not throttled to 1s by Chrome's background timer limits, keeping
 * the 30 FPS draw loop rock-solid when the presenter is watching YouTube or slides
 * in another tab/window.
 */
class PrecisionTicker {
  private worker: Worker | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private blobUrl: string | null = null;

  constructor(intervalMs: number, onTick: () => void) {
    this.timer = setInterval(onTick, intervalMs);
    if (typeof Worker !== "undefined" && typeof Blob !== "undefined" && typeof URL !== "undefined") {
      try {
        const blob = new Blob(
          [`setInterval(function(){postMessage(0);}, ${Math.round(intervalMs)});`],
          { type: "application/javascript" },
        );
        this.blobUrl = URL.createObjectURL(blob);
        const w = new Worker(this.blobUrl);
        w.onmessage = () => onTick();
        w.onerror = () => {
          try { w.terminate(); } catch {}
          this.worker = null;
        };
        this.worker = w;
      } catch {
        // Fallback already running
      }
    }
  }

  stop(): void {
    if (this.worker) {
      try { this.worker.terminate(); } catch {}
      this.worker = null;
    }
    if (this.blobUrl) {
      try { URL.revokeObjectURL(this.blobUrl); } catch {}
      this.blobUrl = null;
    }
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

// ------------------------------------------------------------------ recorder

export type RecorderState = "idle" | "starting" | "recording" | "stopping";

export type RecorderCallbacks = {
  /** Called with the recording id once the server has accepted it. */
  onStarted: (id: string) => void;
  onStopped: (id: string | null) => void;
  /** Fatal problems only: the recording has already stopped by the time this
   *  fires, so the message needs to say what happened to the file. */
  onError: (message: string) => void;
  /** Bytes uploaded so far, for the "recording" indicator. */
  onProgress?: (bytes: number) => void;
};

export type RecordingTransport = {
  start: (mime: string) => Promise<{ id: string }>;
  chunk: (id: string, blob: Blob) => Promise<void>;
  complete: (id: string, durationMs: number) => Promise<void>;
};

/**
 * One recording session.
 *
 * Deliberately a class rather than a hook: it owns a canvas, an AudioContext, a
 * MediaRecorder and an upload queue, all of which must survive re-renders and be
 * torn down exactly once. A hook would tie their lifetime to a component tree
 * that has nothing to do with it.
 */
export class SessionRecorder {
  private state: RecorderState = "idle";
  private canvas: HTMLCanvasElement | null = null;
  private ticker: PrecisionTicker | null = null;
  private stopAudioClock: (() => void) | null = null;
  private animationFrameId: number | null = null;
  private active = false;
  private sources: VideoSources | null = null;
  private mixer: AudioMixer | null = null;
  private recorder: MediaRecorder | null = null;
  private id: string | null = null;
  private startedAt = 0;
  private bytes = 0;
  /** Uploads are chained rather than fired in parallel: the file is an ordered
   *  byte stream, and two chunks racing produce an unplayable file. */
  private queue: Promise<unknown> = Promise.resolve();
  private failed = false;

  constructor(
    private room: Room,
    private topic: string,
    private transport: RecordingTransport,
    private callbacks: RecorderCallbacks,
  ) {}

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
      // The server row first. If it refuses — somebody else is already recording,
      // or the webinar is not live — nothing has been captured yet and there is
      // nothing to clean up.
      const { id } = await this.transport.start(mime);
      this.id = id;

      this.canvas = document.createElement("canvas");
      this.canvas.width = WIDTH;
      this.canvas.height = HEIGHT;
      const ctx = this.canvas.getContext("2d", { alpha: false });
      if (!ctx) throw new Error("This browser wouldn't give us a canvas to draw on.");

      this.sources = new VideoSources(this.room);
      this.mixer = new AudioMixer(this.room);
      await this.mixer.resume();

      this.active = true;
      let lastDraw = 0;
      const minInterval = 1000 / (FPS + 5); // ~28ms for 30fps

      const draw = (nowMs = performance.now()) => {
        if (!this.active || !ctx) return;
        const sources = this.sources?.getSources() ?? [];
        paint(ctx, sources, this.topic);
        lastDraw = nowMs;
      };

      // 1. requestAnimationFrame for foreground VSync-aligned frames
      const renderLoop = (nowMs: number) => {
        if (!this.active) return;
        if (nowMs - lastDraw >= minInterval) {
          draw(nowMs);
        }
        this.animationFrameId = requestAnimationFrame(renderLoop);
      };

      draw();
      this.animationFrameId = requestAnimationFrame(renderLoop);

      // 2. Web Worker + interval clock for background tab rendering
      this.ticker = new PrecisionTicker(Math.round(1000 / FPS), () => {
        const now = performance.now();
        if (now - lastDraw >= minInterval) {
          draw(now);
        }
      });

      // 3. Web Audio real-time hardware clock (audio thread is never throttled)
      this.stopAudioClock = this.mixer.createClock(() => {
        const now = performance.now();
        if (now - lastDraw >= minInterval) {
          draw(now);
        }
      });

      const stream = this.canvas.captureStream(FPS);
      const audio = this.mixer.track;
      if (audio) stream.addTrack(audio);

      this.recorder = new MediaRecorder(stream, {
        mimeType: mime,
        videoBitsPerSecond: VIDEO_BITS,
        audioBitsPerSecond: AUDIO_BITS,
      });
      this.recorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) this.enqueue(e.data);
      };
      this.recorder.onerror = () => {
        this.callbacks.onError("The recorder stopped unexpectedly. What was captured is saved.");
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

  /** Queues one chunk. Failures are retried twice — a recording should survive a
   *  dropped request — and after that the recording is stopped rather than
   *  silently losing the middle of the file. */
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
              `Recording stopped: ${err instanceof Error ? err.message : "an upload failed"}. What was uploaded is kept.`,
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

    // Wait for the encoder to hand over everything it is holding.
    //
    // This await is the whole difference between a playable file and a useless
    // one. `ondataavailable` fires on a later task than `stop()`, and Chrome's MP4
    // muxer holds most of a short recording until then — so closing the recording
    // without waiting uploaded a 1 KB header, rejected the real data as "already
    // finished", and produced a file nothing could decode. `onstop` is specified to
    // fire after the final chunk, which is exactly the signal needed.
    await new Promise<void>((resolve) => {
      const recorder = this.recorder;
      if (!recorder || recorder.state === "inactive") {
        resolve();
        return;
      }
      // A recorder that never fires onstop must not hang the button forever. Ten
      // seconds is far longer than a flush takes and still finite.
      const failsafe = setTimeout(resolve, 10_000);
      recorder.onstop = () => {
        clearTimeout(failsafe);
        resolve();
      };
      try {
        recorder.requestData(); // emit the partial chunk before finalising
        recorder.stop();
      } catch {
        clearTimeout(failsafe);
        resolve();
      }
    });

    await this.teardown();
    // Every queued upload has to land before the recording is marked finished,
    // or the server closes it while bytes are still in flight.
    await Promise.race([
      this.queue.catch(() => {}),
      new Promise<void>((r) => setTimeout(r, 6000)),
    ]);

    if (id) {
      try {
        await this.transport.complete(id, durationMs);
      } catch (err) {
        // If already closed or completed on the server, log and proceed with onStopped
        console.warn("Complete recording transport note:", err);
      }
    }

    this.state = "idle";
    this.id = null;
    this.callbacks.onStopped(id);
  }

  private async teardown(): Promise<void> {
    this.active = false;
    if (this.animationFrameId !== null) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }
    if (this.ticker !== null) {
      this.ticker.stop();
      this.ticker = null;
    }
    if (this.stopAudioClock) {
      this.stopAudioClock();
      this.stopAudioClock = null;
    }
    this.recorder = null;
    this.sources?.dispose();
    this.sources = null;
    await this.mixer?.dispose();
    this.mixer = null;
    this.canvas = null;
  }
}

/** Subscribes to the events that change what should be on the canvas. */
export const RECORDER_EVENTS = [
  RoomEvent.TrackSubscribed,
  RoomEvent.TrackUnsubscribed,
  RoomEvent.TrackMuted,
  RoomEvent.TrackUnmuted,
  RoomEvent.LocalTrackPublished,
  RoomEvent.LocalTrackUnpublished,
  RoomEvent.ParticipantConnected,
  RoomEvent.ParticipantDisconnected,
] as const;
