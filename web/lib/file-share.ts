"use client";

import { RoomEvent, Track, type Room } from "livekit-client";
import { useCallback, useEffect, useMemo, useState } from "react";

/* Sharing a recorded video into a live session.
 *
 * The requirement is that the audience cannot tell. That rules out the obvious
 * implementation — hand every client the file and keep their players in step —
 * for three reasons, each of which the audience would notice:
 *
 *   it would not stay in sync. Five hundred players against a wall clock drift,
 *   stall and rebuffer independently. Somebody is always ten seconds behind, and
 *   the chat gives it away.
 *
 *   it would need the file five hundred times. A recorded webinar is hundreds of
 *   megabytes; the bandwidth arithmetic in docs/CAPACITY.md applies to the file
 *   too, and rather worse.
 *
 *   it would look like a video. A <video> element buffering, or a player that
 *   can be right-clicked, is a tell.
 *
 * So the file is played once, in the presenter's tab, and published as their
 * SCREEN SHARE. That single decision satisfies almost the whole brief for free:
 *
 *   - Synchronisation is not implemented at all, because there is nothing to
 *     synchronise. Everyone is subscribed to one live track, which is the same
 *     guarantee they have for the presenter's camera.
 *   - A late joiner subscribes and receives frames from that moment, which IS
 *     the current playback position. No seeking, no catch-up.
 *   - The audience sees a screen share, full-bleed, with the normal webinar
 *     interface around it. There is no playback UI to hide because there is no
 *     player at their end.
 *   - Playback controls exist only in this tab, as DOM around a hidden element.
 *     They are never in the captured frames.
 *
 * What it costs, stated plainly: the presenter's tab has to stay open and it
 * spends CPU encoding, exactly like the browser-side recorder. And the audience
 * sees a re-encoded stream, so the ladder in lib/network.ts bounds the quality.
 * The alternative is a server-side ingest service, which is the upgrade path.
 */

/** A video element that can be captured. Neither method is in lib.dom. */
type Capturable = HTMLVideoElement & {
  captureStream?: () => MediaStream;
  mozCaptureStream?: () => MediaStream;
};

function capture(el: HTMLVideoElement): MediaStream | null {
  const c = el as Capturable;
  if (typeof c.captureStream === "function") return c.captureStream();
  if (typeof c.mozCaptureStream === "function") return c.mozCaptureStream();
  return null;
}

/** Whether this browser can do it at all.
 *
 *  Safari has no captureStream on a media element, so the option is not offered
 *  there rather than offered and then failing after the host has picked a file. */
export function canShareFile(): boolean {
  if (typeof document === "undefined") return false;
  if (typeof AudioContext === "undefined") return false;
  const probe = document.createElement("video") as Capturable;
  return typeof probe.captureStream === "function" || typeof probe.mozCaptureStream === "function";
}

/** Where the video came from. The engine only needs a URL; the kind is carried so
 *  the UI can say what is playing, and so an object URL gets revoked. */
export type FileSource = {
  kind: "local" | "recording" | "drive";
  /** Shown to the host. Never sent anywhere — the audience sees a screen share. */
  name: string;
  url: string;
  /** Bytes, when known. Zero for a streamed recording. */
  size: number;
  /** Called when the source is discarded. Releases an object URL. */
  release?: () => void;
};

export type FileShareState = {
  /** True from the moment the track is published to the moment it is unpublished. */
  active: boolean;
  source: FileSource | null;
  playing: boolean;
  /** Seconds. Host-only — this is what the playback bar renders. */
  position: number;
  duration: number;
  /** Whether the presenter hears the file locally. Off by default: the room hears
   *  it either way, and a presenter with speakers on feeds it back through their
   *  own microphone. */
  monitor: boolean;
  starting: boolean;
  error: string | null;
};

export type FileShareApi = FileShareState & {
  start: (source: FileSource, startAt?: number) => Promise<void>;
  stop: () => Promise<void>;
  play: () => void;
  pause: () => void;
  seek: (seconds: number) => void;
  setMonitor: (on: boolean) => void;
};

const IDLE: FileShareState = {
  active: false,
  source: null,
  playing: false,
  position: 0,
  duration: 0,
  monitor: false,
  starting: false,
  error: null,
};

/* Everything the engine owns while a share is running.
 *
 * Held outside React entirely — a module-level object rather than a ref — because
 * a MediaStream, an AudioContext and two published tracks have to be torn down
 * exactly once, and their lifetime has nothing to do with a component tree. The
 * same reasoning as SessionRecorder in lib/recorder.ts, and for the same reason:
 * a re-render must not be able to touch any of it.
 */
type Rig = {
  video: HTMLVideoElement;
  host: HTMLDivElement;
  stream: MediaStream;
  audio: { ctx: AudioContext; source: MediaElementAudioSourceNode; dest: MediaStreamAudioDestinationNode } | null;
  videoTrack: MediaStreamTrack;
  audioTrack: MediaStreamTrack | null;
  source: FileSource;
};

let rig: Rig | null = null;

/** How often the host's playback bar updates. `timeupdate` fires about four times
 *  a second in Chrome, which is enough for a progress bar and cheaper than a
 *  frame-rate loop. */
const TICK_EVENT = "timeupdate";

async function teardown(room: Room | null): Promise<void> {
  const r = rig;
  rig = null;
  if (!r) return;

  // Unpublish before stopping the tracks. The other way round hands the SFU a
  // dead track and the audience sees a frozen last frame until it times out.
  if (room) {
    for (const track of [r.videoTrack, r.audioTrack]) {
      if (!track) continue;
      try {
        await room.localParticipant.unpublishTrack(track, true);
      } catch {
        // Already gone, or the room is disconnecting. Either way the local
        // teardown below still has to happen.
      }
    }
  }

  r.video.pause();
  r.video.removeAttribute("src");
  r.video.load();
  for (const track of r.stream.getTracks()) track.stop();
  r.videoTrack.stop();
  r.audioTrack?.stop();
  if (r.audio) {
    r.audio.source.disconnect();
    r.audio.dest.disconnect();
    await r.audio.ctx.close().catch(() => {});
  }
  r.host.remove();
  r.source.release?.();
}

/**
 * Publishes a video file as the presenter's screen share.
 *
 * `room` is passed in rather than captured, so the engine has no opinion about
 * where the connection comes from.
 */
export function useFileShare(room: Room | null): FileShareApi {
  const [state, setState] = useState<FileShareState>(IDLE);

  const stop = useCallback(async () => {
    await teardown(room);
    setState(IDLE);
  }, [room]);

  const start = useCallback(
    async (source: FileSource, startAt = 0) => {
      if (!room) return;
      // One at a time. Starting a second share while the first is publishing
      // would leave the first one's tracks orphaned on the SFU.
      await teardown(room);
      setState({ ...IDLE, source, starting: true });

      /* The element is in the DOM, off screen, not detached.
       *
       * A detached video element is not required to render, and Safari hands back
       * black frames for one — the same lesson the recorder's VideoSources
       * learned. 2x2 rather than 1x1 because a zero-area element is a candidate
       * for the same treatment. */
      const host = document.createElement("div");
      host.setAttribute("aria-hidden", "true");
      host.style.cssText =
        "position:fixed;left:-9999px;top:0;width:2px;height:2px;overflow:hidden;pointer-events:none";
      const video = document.createElement("video");
      video.playsInline = true;
      video.preload = "auto";
      /* No crossOrigin, for ANY source kind — including a recording.
       *
       * A recording is fetched from our own API, but this deployment always
       * serves the app and the API from the same origin (the Cloudflare
       * Worker proxies /api/* — see docs/DEPLOYMENT-TOPOLOGY.md), so it is a
       * same-origin request and the session cookie travels with it regardless
       * of crossOrigin: browsers attach cookies to a same-origin fetch by
       * default, no CORS opt-in required. Setting crossOrigin anyway forces
       * the browser into an explicit CORS-mode fetch it did not need — and
       * the observed failure matched exactly what a CORS-tainted element does:
       * the host's audience heard the file's audio but never saw a frame of
       * it, because captureStream() refuses to hand over pixels from a
       * tainted element far more strictly than Web Audio mutes one. Dropping
       * crossOrigin makes this element behave exactly like the untainted
       * preview player in PreviewStep, which already plays every source kind
       * correctly.
       *
       * "local" and "drive" sources are blob: URLs — bytes already in this
       * tab, nothing to fetch, no origin to cross — where crossOrigin was
       * already confirmed to cause the identical symptom. */
      video.src = source.url;
      host.appendChild(video);
      document.body.appendChild(host);

      const fail = async (message: string) => {
        host.remove();
        source.release?.();
        setState({ ...IDLE, error: message });
      };

      try {
        // Wait for real dimensions. captureStream on a video with no metadata
        // produces a track that never delivers a frame, and the audience sees an
        // empty share that looks exactly like a broken connection.
        await new Promise<void>((resolve, reject) => {
          const ok = () => {
            cleanup();
            resolve();
          };
          const bad = () => {
            cleanup();
            reject(new Error("That file couldn't be decoded. Try an MP4 or WebM."));
          };
          const cleanup = () => {
            video.removeEventListener("loadedmetadata", ok);
            video.removeEventListener("error", bad);
            clearTimeout(timer);
          };
          const timer = setTimeout(bad, 20_000);
          video.addEventListener("loadedmetadata", ok);
          video.addEventListener("error", bad);
        });

        if (video.videoWidth === 0 || video.videoHeight === 0) {
          throw new Error("That file has no video track.");
        }
        if (startAt > 0 && startAt < video.duration) video.currentTime = startAt;

        /* Audio through Web Audio rather than out of captureStream.
         *
         * captureStream hands back an audio track too, and whether muting the
         * element silences it is not something to depend on. Routing the element
         * through a MediaElementAudioSourceNode makes it explicit: the node takes
         * over the element's output, so the room hears it via the destination node
         * and the presenter hears nothing unless monitoring is asked for. */
        const ctx = new AudioContext();
        const src = ctx.createMediaElementSource(video);
        const dest = ctx.createMediaStreamDestination();
        src.connect(dest);
        // Suspended until a gesture; picking a file and pressing Share is that
        // gesture, so resuming here is both allowed and required.
        if (ctx.state === "suspended") await ctx.resume().catch(() => {});

        // Playing before capturing: a paused element's captureStream produces a
        // track in a state some versions of Chrome never leave.
        await video.play();

        const stream = capture(video);
        if (!stream) throw new Error("This browser can't capture a video file.");
        const videoTrack = stream.getVideoTracks()[0];
        if (!videoTrack) throw new Error("Nothing to capture from that file.");
        // The stream's own audio track is redundant now and would be published
        // twice if left running.
        for (const t of stream.getAudioTracks()) t.stop();
        const audioTrack = dest.stream.getAudioTracks()[0] ?? null;

        rig = {
          video,
          host,
          stream,
          audio: { ctx, source: src, dest },
          videoTrack,
          audioTrack,
          source,
        };

        /* Published as ScreenShare, which is what makes it indistinguishable.
         *
         * The stage already renders a share full-bleed and the tile labels it
         * "<name>'s screen". Nothing downstream needs to know or care that the
         * frames came from a file, and nothing downstream is told. */
        await room.localParticipant.publishTrack(videoTrack, {
          source: Track.Source.ScreenShare,
          name: "screen",
          // A recorded webinar is mostly faces and slides in motion. `motion`
          // tells the encoder to spend its bitrate on frame rate rather than on
          // sharpness, which is the opposite of what a live desktop share wants
          // and the right choice for video.
          videoCodec: "vp8",
          simulcast: true,
          degradationPreference: "maintain-framerate",
        });
        if (audioTrack) {
          await room.localParticipant.publishTrack(audioTrack, {
            source: Track.Source.ScreenShareAudio,
            name: "screen-audio",
            dtx: false,
            red: true,
          });
        }

        setState({
          active: true,
          source,
          playing: true,
          position: video.currentTime,
          duration: Number.isFinite(video.duration) ? video.duration : 0,
          monitor: false,
          starting: false,
          error: null,
        });
      } catch (err) {
        await teardown(room);
        await fail(
          err instanceof Error ? err.message : "That file couldn't be shared.",
        );
      }
    },
    [room],
  );

  // Playback position and the end of the file. Subscribed to the element rather
  // than polled, so a paused share costs nothing.
  useEffect(() => {
    if (!state.active) return;
    const video = rig?.video;
    if (!video) return;

    const tick = () =>
      setState((c) =>
        c.active
          ? {
              ...c,
              position: video.currentTime,
              duration: Number.isFinite(video.duration) ? video.duration : c.duration,
            }
          : c,
      );
    const onPlay = () => setState((c) => (c.active ? { ...c, playing: true } : c));
    const onPause = () => setState((c) => (c.active ? { ...c, playing: false } : c));
    // The file running out ends the share. Leaving a black frame published would
    // be a screen share of nothing, which is worse than the share ending.
    const onEnded = () => void stop();

    video.addEventListener(TICK_EVENT, tick);
    video.addEventListener("play", onPlay);
    video.addEventListener("pause", onPause);
    video.addEventListener("ended", onEnded);
    return () => {
      video.removeEventListener(TICK_EVENT, tick);
      video.removeEventListener("play", onPlay);
      video.removeEventListener("pause", onPause);
      video.removeEventListener("ended", onEnded);
    };
  }, [state.active, stop]);

  /* Losing the right to share has to take the share down with it.
   *
   * Driven by the SFU's own permission event rather than by a prop derived from it.
   * That is both more accurate — this is the moment the grant actually changed, not
   * the render after — and the only shape that is honest about what is going on: a
   * callback from an external system, which is what an effect is for. Watching a
   * prop and tearing down in the effect body was a state update on a cascade.
   */
  useEffect(() => {
    if (!room) return;
    const check = () => {
      if (!rig) return;
      const permissions = room.localParticipant?.permissions;
      if (!permissions) return;
      const sources = (permissions.canPublishSources ?? []).map((s) => Track.sourceFromProto(s));
      // An EMPTY source list means every source — the trap documented in
      // lib/permissions.ts. Reading it as "nothing allowed" would tear down every
      // share the moment any permission changed.
      const mayShare =
        permissions.canPublish &&
        (sources.length === 0 || sources.includes(Track.Source.ScreenShare));
      if (!mayShare) void stop();
    };
    room.on(RoomEvent.ParticipantPermissionsChanged, check);
    return () => {
      room.off(RoomEvent.ParticipantPermissionsChanged, check);
    };
  }, [room, stop]);

  // Unmount is the last chance to clean up: a tab navigating away with a
  // published track leaves the audience watching a frozen frame.
  useEffect(
    () => () => {
      if (rig) void teardown(room);
    },
    [room],
  );

  return useMemo<FileShareApi>(
    () => ({
      ...state,
      start,
      stop,
      play: () => void rig?.video.play().catch(() => {}),
      pause: () => rig?.video.pause(),
      seek: (seconds) => {
        const video = rig?.video;
        if (!video || !Number.isFinite(video.duration)) return;
        video.currentTime = Math.min(Math.max(seconds, 0), video.duration);
      },
      setMonitor: (on) => {
        const audio = rig?.audio;
        if (!audio) return;
        // Connecting and disconnecting the destination, rather than setting a
        // gain: the room's copy comes off `dest`, so touching gain here would
        // change what the audience hears too.
        try {
          if (on) audio.source.connect(audio.ctx.destination);
          else audio.source.disconnect(audio.ctx.destination);
        } catch {
          // Disconnecting something that was never connected throws. Harmless.
        }
        setState((c) => ({ ...c, monitor: on }));
      },
    }),
    [state, start, stop],
  );
}

/** mm:ss, or h:mm:ss past an hour. For the host's playback bar. */
export function formatPosition(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const total = Math.floor(seconds);
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/** What the file picker accepts.
 *
 *  Deliberately narrow. A browser will happily open a .mkv it cannot decode, and
 *  finding that out after the host has picked it — in front of an audience — is
 *  the worst possible moment. */
export const VIDEO_ACCEPT = "video/mp4,video/webm,video/quicktime,.mp4,.webm,.mov,.m4v";

export function looksLikeVideo(file: File): boolean {
  if (file.type.startsWith("video/")) return true;
  return /\.(mp4|webm|mov|m4v)$/i.test(file.name);
}
