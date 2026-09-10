"use client";

import { useConnectionState, useRoomContext } from "@livekit/components-react";
import { ConnectionState } from "livekit-client";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { api, API_BASE } from "@/lib/api";
import { formatBytes, formatClock } from "@/lib/format";
import { canRecord, SessionRecorder, type RecorderState } from "@/lib/recorder";
import { useToast } from "../providers";
import { RecordIcon, StopIcon } from "../icons";
import { useRoomUI } from "./context";

/* The recording control, and the indicator everyone else sees.
 *
 * Two separate things on purpose. The control belongs to whoever may record — the
 * host and the panelists, which is what their publish permission already means.
 * The indicator belongs to the room: it is driven by the server's room metadata,
 * so an attendee is told they are being recorded even though nothing in their
 * browser is doing the recording.
 */

const subscribeNothing = () => () => {};
const readCanRecord = () => canRecord();
const readCanRecordOnServer = () => false;

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
   *  render. Null when nothing is being recorded. */
  const recording = useRef<{ id: string; startedAt: number } | null>(null);

  // Kept in refs so the recorder's callbacks never close over a stale render.
  const notifyRef = useRef(notify);
  useEffect(() => {
    notifyRef.current = notify;
  }, [notify]);

  const start = useCallback(async () => {
    if (recorder.current) return;
    setState("starting");

    const instance = new SessionRecorder(
      room,
      topic,
      {
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
      },
      {
        onStarted: (id) => {
          const began = Date.now();
          recording.current = { id, startedAt: began };
          setState("recording");
          setStartedAt(began);
          setBytes(0);
          notifyRef.current(
            "Recording started. Everyone can see it — keep this tab open.",
            "ok",
          );
        },
        onStopped: () => {
          recording.current = null;
          setState("idle");
          setStartedAt(null);
          recorder.current = null;
          notifyRef.current(
            "Recording saved. It's on the webinar's page under Recordings.",
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
      },
    );

    recorder.current = instance;
    await instance.start();
    // start() reports failure through onError, which has already cleared the ref.
    if (recorder.current === instance && instance.getState() === "idle") {
      recorder.current = null;
      setState("idle");
    }
  }, [room, slug, topic]);

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
      if (!recording.current) return;
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
  const { notify } = useToast();
  const { state, bytes, startedAt, start, stop } = useRecorder();
  const connection = useConnectionState();

  // Whether this browser can encode video at all. Read through
  // useSyncExternalStore because it is a client-only capability: false during the
  // server render, the real answer afterwards.
  const supported = useSyncExternalStore(
    subscribeNothing,
    readCanRecord,
    readCanRecordOnServer,
  );

  // Only the host and the panelists may record, and the server says which — see
  // JoinResponse.CanRecord.
  //
  // Reading publish permission instead was wrong in both directions. An attendee
  // the host promoted publishes exactly like a panelist, so they were offered a
  // button whose every request came back 401: they have a microphone, not an
  // account on this webinar's stage roster, and requireStage wants the account. It
  // also showed the button where recording is turned off for the instance, which
  // was only discoverable by pressing it and reading a 503.
  if (!join.canRecord) return null;
  if (!supported) return null;

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

  // Somebody else is recording. One recording per session, enforced by the
  // database, so the honest thing is to say who has it rather than offer a button
  // that returns a conflict.
  if (recording && !mine) {
    return (
      <span className="hidden items-center gap-1.5 rounded-lg bg-live/15 px-2.5 py-1.5 text-[11.5px] font-medium text-live-soft sm:inline-flex">
        <span className="size-1.5 animate-pulse rounded-full bg-live" aria-hidden />
        Recording
      </span>
    );
  }

  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={state === "recording"}
      title={state === "recording" ? "Stop recording" : "Record this session"}
      disabled={busy}
      onClick={() => {
        if (mine) {
          void stop();
          return;
        }
        void start().catch((err: unknown) =>
          notify(err instanceof Error ? err.message : "Could not start recording.", "error"),
        );
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
