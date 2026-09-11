"use client";

import { useConnectionState, useRoomContext } from "@livekit/components-react";
import { ConnectionState } from "livekit-client";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { api, API_BASE } from "@/lib/api";
import { formatBytes, formatClock } from "@/lib/format";
import { canRecordLocally, localRecordingTransport } from "@/lib/local-recording";
import { canRecord, SessionRecorder, type RecorderState, type RecordingTransport } from "@/lib/recorder";
import { useAppConfig, useToast } from "../providers";
import { DeviceIcon, RecordIcon, StopIcon } from "../icons";
import { useRoomUI } from "./context";

/* The recording control, and the indicator everyone else sees.
 *
 * Two separate things on purpose. The control belongs to whoever may record — the
 * host and the panelists, which is what their publish permission already means.
 * The indicator belongs to the room: it is driven by the server's room metadata,
 * so an attendee is told they are being recorded even though nothing in their
 * browser is doing the recording.
 *
 * Two DESTINATIONS as of this file, not one. "Cloud" is the original path: bytes
 * go to the server, which is what makes the room-wide indicator and the
 * Recordings tab possible. "This device" (lib/local-recording.ts) is the same
 * capture pipeline writing straight to a file the host picked, with nothing
 * going over the network — for a host who does not want a copy sitting on the
 * server at all, or whose server has no recording storage configured. It is
 * deliberately NOT wired into the server-side "recording" indicator or the
 * Recordings list: there is no row for it to be, since nothing was told.
 * Attendees are not informed of a local recording by this app any more than
 * they would be if the host recorded their own screen with a separate tool —
 * that is the host's responsibility, same as it is for anyone using OBS.
 */

const subscribeNothing = () => () => {};
const readCanRecord = () => canRecord();
const readCanRecordOnServer = () => false;
const readCanRecordLocally = () => canRecordLocally();
const readCanRecordLocallyOnServer = () => false;

/** A recording's suggested filename: the topic, filesystem-safe, plus the date
 *  so a host who records the same series weekly does not have to rename one
 *  file before the next save prompt. */
function suggestedFileName(topic: string): string {
  const safe = topic.trim().replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim();
  const date = new Date().toISOString().slice(0, 10);
  return `${safe || "webinar"} — ${date}`;
}

/** Owns the recorder for this tab.
 *
 *  A ref rather than state for the recorder itself: it holds a canvas, an
 *  AudioContext and an upload queue, none of which should be recreated by a
 *  re-render. React state carries only what the UI draws. */
function useRecorder() {
  const { slug, topic } = useRoomUI();
  const room = useRoomContext();
  const { notify } = useToast();

  const [state, setState] = useState<RecorderState>("idle");
  const [bytes, setBytes] = useState(0);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const recorder = useRef<SessionRecorder | null>(null);
  /** What is in flight, readable from an event handler that cannot wait for a
   *  render. Null when nothing is being recorded. `local: true` means there is
   *  no server-side row for the pagehide handler below to close. */
  const recording = useRef<{ id: string; startedAt: number; local: boolean } | null>(
    null,
  );

  // Kept in refs so the recorder's callbacks never close over a stale render.
  const notifyRef = useRef(notify);
  useEffect(() => {
    notifyRef.current = notify;
  }, [notify]);

  const start = useCallback(
    async (destination: "cloud" | "local") => {
      if (recorder.current) return;
      setState("starting");

      const local = destination === "local";
      const transport: RecordingTransport = local
        ? localRecordingTransport(suggestedFileName(topic))
        : {
            start: async (mime) => {
              const rec = await api.startRecording(slug, mime);
              return { id: rec.id };
            },
            chunk: async (id, blob) => {
              await api.recordingChunk(slug, id, blob);
            },
            complete: async (id, durationMs) => {
              await api.completeRecording(slug, id, durationMs);
            },
          };

      const instance = new SessionRecorder(room, topic, transport, {
        onStarted: (id) => {
          const began = Date.now();
          recording.current = { id, startedAt: began, local };
          setState("recording");
          setStartedAt(began);
          setBytes(0);
          notifyRef.current(
            local
              ? "Recording started — saving to the file you chose. Keep this tab open."
              : "Recording started. Everyone can see it — keep this tab open.",
            "ok",
          );
        },
        onStopped: () => {
          recording.current = null;
          setState("idle");
          setStartedAt(null);
          recorder.current = null;
          notifyRef.current(
            local
              ? "Recording saved to your device."
              : "Recording saved. It's on the webinar's page under Recordings.",
            "ok",
          );
        },
        onError: (message) => {
          recording.current = null;
          setState("idle");
          setStartedAt(null);
          recorder.current = null;
          notifyRef.current(message, "error");
        },
        onProgress: setBytes,
      });

      recorder.current = instance;
      await instance.start();
      // start() reports failure through onError, which has already cleared the ref.
      if (recorder.current === instance && instance.getState() === "idle") {
        recorder.current = null;
        setState("idle");
      }
    },
    [room, slug, topic],
  );

  const stop = useCallback(async () => {
    const instance = recorder.current;
    if (!instance) return;
    setState("stopping");
    await instance.stop();
  }, []);

  // A recording is bytes on somebody's disk, so leaving the page has to close it
  // properly rather than abandoning it half-written. This runs on unmount, which
  // covers pressing Leave and navigating away.
  useEffect(() => {
    return () => {
      void recorder.current?.stop();
      recorder.current = null;
    };
  }, []);

  // Closing the tab outright does not run cleanup in time to await anything, so
  // the recording is closed with a fire-and-forget request the browser is required
  // to finish after the page is gone. Without it the row stays open until the
  // server's staleness sweep notices, and the room shows a recording indicator for
  // a recorder that no longer exists.
  useEffect(() => {
    const onLeave = () => {
      // A local recording has no server-side row to close — closing the file
      // handle in time is not possible from pagehide anyway, which is the
      // honest cost of this path and is stated in the "keep this tab open"
      // notice when it starts.
      if (!recording.current || recording.current.local) return;
      const { id, startedAt: began } = recording.current;
      void fetch(
        `${API_BASE}/api/host/webinars/${encodeURIComponent(slug)}/recordings/${encodeURIComponent(id)}/complete?durationMs=${Date.now() - began}`,
        { method: "POST", credentials: "include", keepalive: true },
      ).catch(() => {});
    };
    window.addEventListener("pagehide", onLeave);
    return () => window.removeEventListener("pagehide", onLeave);
  }, [slug]);

  return { state, bytes, startedAt, start, stop };
}

/** The control bar's record button. Rendered only for people who may record. */
export function RecordButton() {
  const { join, recording } = useRoomUI();
  const { cloudRecordingEnabled } = useAppConfig();
  const { notify } = useToast();
  const { state, bytes, startedAt, start, stop } = useRecorder();
  const connection = useConnectionState();
  const [choosing, setChoosing] = useState(false);
  const wrap = useRef<HTMLDivElement | null>(null);

  // Whether this browser can encode video at all. Read through
  // useSyncExternalStore because it is a client-only capability: false during the
  // server render, the real answer afterwards.
  const supported = useSyncExternalStore(
    subscribeNothing,
    readCanRecord,
    readCanRecordOnServer,
  );
  // Same reasoning, for the File System Access API specifically — Chrome/Edge
  // only.
  const localSupported = useSyncExternalStore(
    subscribeNothing,
    readCanRecordLocally,
    readCanRecordLocallyOnServer,
  );

  // Which destinations this press could actually reach. Cloud needs the
  // instance to have storage configured (AppConfig.cloudRecordingEnabled) —
  // separate from join.canRecord, which is about the ACCOUNT, not the
  // instance; an instance with RECORDINGS_ENABLED=false must not offer a
  // button that always 503s. Local needs the browser's File System Access API.
  const cloudAvailable = cloudRecordingEnabled;
  const localAvailable = localSupported;

  const go = useCallback(
    (destination: "cloud" | "local") => {
      setChoosing(false);
      void start(destination).catch((err: unknown) =>
        notify(err instanceof Error ? err.message : "Could not start recording.", "error"),
      );
    },
    [start, notify],
  );

  useEffect(() => {
    if (!choosing) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setChoosing(false);
    const onDown = (e: PointerEvent) => {
      if (wrap.current?.contains(e.target as Node)) return;
      setChoosing(false);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onDown);
    };
  }, [choosing]);

  // Only the host and the panelists may record, and the server says which — see
  // JoinResponse.CanRecord.
  //
  // Reading publish permission instead was wrong in both directions. An attendee
  // the host promoted publishes exactly like a panelist, so they were offered a
  // button whose every request came back 401: they have a microphone, not an
  // account on this webinar's stage roster, and requireStage wants the account.
  if (!join.canRecord) return null;
  if (!supported) return null;
  // Neither destination can actually be reached — an instance with cloud
  // storage off, in a browser without the File System Access API. Offering a
  // button with nothing behind it is worse than not offering one.
  if (!cloudAvailable && !localAvailable) return null;

  /* And not until there is a session to record.
   *
   * The button used to appear the moment the control bar mounted, which is while the
   * connection is still being established — so a host looking at "Connecting…" was offered
   * Record, and pressing it would capture a black stage or fail outright. The recorder
   * composites what is on the stage; before connect there is nothing on it. */
  if (connection !== ConnectionState.Connected) return null;

  const mine = state === "recording" || state === "stopping" || state === "starting";
  const busy = state === "starting" || state === "stopping";

  // The label says what pressing it does, which is not "stop" until there is
  // something to stop. Labelling the in-flight states "Stop recording" told a
  // screen reader — and anything driving this UI — that a recording existed while
  // the request that creates it was still on the wire.
  const label =
    state === "starting"
      ? "Starting recording"
      : state === "stopping"
        ? "Saving recording"
        : state === "recording"
          ? "Stop recording"
          : "Start recording";

  // Somebody else is recording — through the server, the only kind this can know
  // about. A local recording is deliberately invisible to everyone but the
  // person running it, so it cannot conflict with this and does not reach here.
  if (recording && !mine) {
    return (
      <span className="hidden items-center gap-1.5 rounded-lg bg-live/15 px-2.5 py-1.5 text-[11.5px] font-medium text-live-soft sm:inline-flex">
        <span className="size-1.5 animate-pulse rounded-full bg-live" aria-hidden />
        Recording
      </span>
    );
  }

  return (
    <div ref={wrap} className="relative">
      <button
        type="button"
        aria-label={label}
        aria-pressed={state === "recording"}
        aria-expanded={choosing || undefined}
        title={state === "recording" ? "Stop recording" : "Record this session"}
        disabled={busy}
        onClick={() => {
          if (mine) {
            void stop();
            return;
          }
          // Straight to whichever one destination is reachable — one-click,
          // same as this button has always been — and only pause to ask when
          // there is an actual choice between the two.
          if (cloudAvailable && !localAvailable) {
            go("cloud");
            return;
          }
          if (localAvailable && !cloudAvailable) {
            go("local");
            return;
          }
          setChoosing((v) => !v);
        }}
        className={`relative inline-flex h-10 shrink-0 flex-col items-center justify-center gap-0.5 rounded-lg px-2 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-white/50 sm:min-w-14 ${
          mine
            ? "bg-live/20 text-live-soft"
            : "text-white/75 hover:bg-white/10 hover:text-white"
        }`}
      >
        {mine ? <StopIcon className="size-5" /> : <RecordIcon className="size-5" />}
        <span className="hidden text-[9.5px] leading-none font-medium sm:block">
          {state === "starting" ? "Starting" : state === "stopping" ? "Saving" : mine ? "Stop" : "Record"}
        </span>
        {/* Elapsed time and size, so a presenter can see it is actually working
            rather than trusting a red dot. */}
        {state === "recording" && startedAt !== null && (
          <span className="absolute -top-7 left-1/2 hidden -translate-x-1/2 rounded-md bg-black/70 px-1.5 py-0.5 text-[10px] font-medium whitespace-nowrap text-white sm:block">
            <Elapsed since={startedAt} /> · {formatBytes(bytes)}
          </span>
        )}
      </button>

      {choosing && (
        <div
          role="menu"
          aria-label="Where to save the recording"
          className="room-dark absolute bottom-full left-0 z-50 mb-2 w-56 rounded-xl border border-line bg-surface p-1.5 text-ink shadow-2xl"
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => go("local")}
            className="flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors outline-none hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-brand/40"
          >
            <DeviceIcon className="mt-0.5 size-4 shrink-0 text-ink-2" />
            <span>
              <span className="block text-[13px] font-medium">This device</span>
              <span className="block text-[11.5px] leading-tight text-ink-3">
                Saves straight to a file you choose. Never leaves this computer.
              </span>
            </span>
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => go("cloud")}
            className="flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors outline-none hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-brand/40"
          >
            <RecordIcon className="mt-0.5 size-4 shrink-0 text-ink-2" />
            <span>
              <span className="block text-[13px] font-medium">The cloud</span>
              <span className="block text-[11.5px] leading-tight text-ink-3">
                Uploads as it records. Everyone sees the REC indicator, and it
                lands on the webinar's Recordings tab.
              </span>
            </span>
          </button>
        </div>
      )}
    </div>
  );
}

/** Ticks once a second while recording. Its own component so the whole control
 *  bar does not re-render for the clock. */
function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return <>{formatClock(Math.max(0, now - since))}</>;
}

/**
 * The room-wide indicator, for everybody including the audience.
 *
 * Driven by room metadata rather than by local state, so it is on for an attendee
 * whose browser is doing nothing. Consent is the point: people are entitled to
 * know, and to know from the moment it starts.
 */
export function RecordingIndicator() {
  const { recording } = useRoomUI();
  const { notify } = useToast();

  // Announced once per transition, not on every render.
  const announced = useRef(recording);
  useEffect(() => {
    if (recording === announced.current) return;
    announced.current = recording;
    notify(
      recording
        ? "This session is being recorded."
        : "Recording has stopped.",
      "info",
    );
  }, [recording, notify]);

  if (!recording) return null;

  return (
    <span
      className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-live/15 px-2 py-0.5 text-[10.5px] font-semibold text-live-soft"
      title="This session is being recorded"
    >
      <span className="size-1.5 animate-pulse rounded-full bg-live" aria-hidden />
      REC
    </span>
  );
}
