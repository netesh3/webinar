"use client";

import { useConnectionState, useRoomContext } from "@livekit/components-react";
import { ConnectionState } from "livekit-client";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { api, API_BASE } from "@/lib/api";
import { formatBytes, formatClock } from "@/lib/format";
import { canRecordLocally, localRecordingTransport } from "@/lib/local-recording";
import {
  canRecord,
  SessionRecorder,
  type RecorderCallbacks,
  type RecorderState,
  type RecordingTransport,
} from "@/lib/recorder";
import { canRecordScreen, ScreenRecorder } from "@/lib/screen-recorder";
import {
  readRememberedTarget,
  recordAvailability,
  recordButtonTitle,
  recordingDetail,
  recordingTag,
  resolveMainClick,
  writeRememberedTarget,
  type RecordTarget,
  type TargetAvailability,
} from "@/lib/record-target";
import { Spinner } from "../controls";
import { useAppConfig, useToast } from "../providers";
import { recordingRetentionDays } from "@/lib/recording-retention";
import { ChevronDownIcon, DeviceIcon, RecordIcon, StopIcon } from "../icons";
import { useRoomUI } from "./context";
import { RecordTargetDialog } from "./record-target-dialog";

/* The recording control, and the indicator everyone else sees.
 *
 * Two separate things on purpose. The control belongs to whoever may record — the
 * host and the panelists, which is what their publish permission already means.
 * The indicator belongs to the room: it is driven by the server's room metadata,
 * so an attendee is told they are being recorded even though nothing in their
 * browser is doing the recording.
 *
 * Two DESTINATIONS as of this file, not one, and they no longer share a
 * capture pipeline either. "Cloud" (SessionRecorder, lib/recorder.ts) draws
 * every participant onto a canvas and uploads the encoded result — that
 * compositing is what makes a recording of "the webinar" rather than one
 * person's screen, and it costs CPU the live call is already spending. "This
 * device" (ScreenRecorder, lib/screen-recorder.ts) instead captures the
 * host's screen directly via getDisplayMedia — no canvas, no per-frame
 * compositing — and writes straight to a file the host picked
 * (lib/local-recording.ts), with nothing going over the network. It trades
 * the composited layout for materially less CPU contention with the live
 * call, which is the point for a host who found the composited version
 * laggy. It is deliberately NOT wired into the server-side "recording" indicator or the
 * Recordings list: there is no row for it to be, since nothing was told.
 * Attendees are not informed of a local recording by this app any more than
 * they would be if the host recorded their own screen with a separate tool —
 * that is the host's responsibility, same as it is for anyone using OBS.
 */

const subscribeNothing = () => () => {};
const readCanRecord = () => canRecord();
const readCanRecordOnServer = () => false;
// Local recording needs BOTH: somewhere to write the file (canRecordLocally)
// and something to capture (canRecordScreen, since it records the screen
// directly rather than compositing the room onto a canvas — see
// lib/screen-recorder.ts).
const readCanRecordLocally = () => canRecordLocally() && canRecordScreen();
const readCanRecordLocallyOnServer = () => false;
// The two halves separately, so the chooser can say WHICH one is missing.
const readCanSaveLocally = () => canRecordLocally();
const readCanCaptureScreen = () => canRecordScreen();

/** A recording's suggested filename: the topic, filesystem-safe, plus the date
 *  so a host who records the same series weekly does not have to rename one
 *  file before the next save prompt. */
function suggestedFileName(topic: string): string {
  const safe = topic.trim().replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim();
  const date = new Date().toISOString().slice(0, 10);
  return `${safe || "webinar"} — ${date}`;
}

export type RecorderContextValue = {
  state: RecorderState;
  bytes: number;
  startedAt: number | null;
  destination: "cloud" | "local" | null;
  start: (destination: "cloud" | "local") => Promise<void>;
  stop: () => Promise<void>;
  mine: boolean;
  isEgress: boolean;
};

const defaultRecorderContext: RecorderContextValue = {
  state: "idle",
  bytes: 0,
  startedAt: null,
  destination: null,
  start: async () => {},
  stop: async () => {},
  mine: false,
  isEgress: false,
};

const RecorderContext = createContext<RecorderContextValue>(defaultRecorderContext);

export function useRoomRecorder(): RecorderContextValue {
  return useContext(RecorderContext);
}

export function RecorderProvider({ children }: { children: React.ReactNode }) {
  const recorder = useRecorder();
  return (
    <RecorderContext.Provider value={recorder}>
      {children}
    </RecorderContext.Provider>
  );
}

/** Owns the recorder for this tab.
 *
 *  A ref rather than state for the recorder itself: it holds a canvas, an
 *  AudioContext and an upload queue, none of which should be recreated by a
 *  re-render. React state carries only what the UI draws. */
function useRecorder(): RecorderContextValue {
  const { slug, topic } = useRoomUI();
  const room = useRoomContext();
  const { notify } = useToast();
  const { recordingMode } = useAppConfig();
  const isEgress = recordingMode === "egress";

  const [state, setState] = useState<RecorderState>("idle");
  const [bytes, setBytes] = useState(0);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [destination, setDestination] = useState<"cloud" | "local" | null>(null);

  const [stoppedRecently, setStoppedRecently] = useState(false);
  const { recording: serverRecording } = useRoomUI();

  // Cleared when the server stops reporting a recording — on that edge, during
  // render, rather than in an effect after it. Only the edge: stop() raising the
  // flag while the server already says "not recording" must not clear it.
  const [seenServerRecording, setSeenServerRecording] = useState(serverRecording);
  if (serverRecording !== seenServerRecording) {
    setSeenServerRecording(serverRecording);
    if (!serverRecording) setStoppedRecently(false);
  }

  // Local recording is a ScreenRecorder (lib/screen-recorder.ts), not a
  // SessionRecorder — no canvas compositing, see recording.tsx's module
  // comment for why that is the point.
  const recorder = useRef<SessionRecorder | ScreenRecorder | null>(null);
  /** What is in flight, readable from an event handler that cannot wait for a
   *  render. Null when nothing is being recorded. `local: true` means there is
   *  no server-side row for the pagehide handler below to close. */
  const recording = useRef<{
    id: string;
    startedAt: number;
    local: boolean;
    egress?: boolean;
  } | null>(null);

  // Kept in refs so the recorder's callbacks never close over a stale render.
  const notifyRef = useRef(notify);
  useEffect(() => {
    notifyRef.current = notify;
  }, [notify]);

  const start = useCallback(
    async (dest: "cloud" | "local") => {
      if (recorder.current || recording.current) return;
      setStoppedRecently(false);
      setState("starting");
      setDestination(dest);

      const local = dest === "local";

      if (!local && isEgress) {
        try {
          const rec = await api.startRecording(slug, "video/mp4");
          const began = Date.now();
          recording.current = { id: rec.id, startedAt: began, local: false, egress: true };
          setState("recording");
          setStartedAt(began);
          setBytes(0);
          notifyRef.current("Recording started.", "ok");
        } catch (err: unknown) {
          recording.current = null;
          setState("idle");
          setStartedAt(null);
          setDestination(null);
          notifyRef.current(
            err instanceof Error ? err.message : "Could not start cloud recording.",
            "error",
          );
        }
        return;
      }

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

      const callbacks: RecorderCallbacks = {
        onStarted: (id) => {
          const began = Date.now();
          recording.current = { id, startedAt: began, local };
          setState("recording");
          setStartedAt(began);
          setBytes(0);
          notifyRef.current(
            local
              ? "Recording started — saving your screen straight to the file you chose. Keep this tab open."
              : "Recording started. Everyone can see it — keep this tab open.",
            "ok",
          );
        },
        onStopped: () => {
          recording.current = null;
          setState("idle");
          setStartedAt(null);
          setDestination(null);
          recorder.current = null;
          notifyRef.current(
            local
              ? "Recording saved to your device."
              : "Recording stopped. It will be available in your recordings tab.",
            "ok",
          );
        },
        onError: (message) => {
          recording.current = null;
          setState("idle");
          setStartedAt(null);
          setDestination(null);
          recorder.current = null;
          notifyRef.current(message, "error");
        },
        onProgress: setBytes,
      };

      // Local recording captures the host's screen directly (ScreenRecorder) —
      // no canvas, no compositing, no per-frame CPU competing with the live
      // call. Cloud recording keeps the full composited stage (SessionRecorder)
      // so everyone watching it back sees the webinar the way the room did.
      const instance = local
        ? new ScreenRecorder(room, transport, callbacks)
        : new SessionRecorder(room, topic, transport, callbacks);

      recorder.current = instance;
      try {
        await instance.start();
      } catch (err: unknown) {
        recorder.current = null;
        recording.current = null;
        setState("idle");
        setStartedAt(null);
        setDestination(null);
        notifyRef.current(
          err instanceof Error ? err.message : "Could not start recording.",
          "error",
        );
        return;
      }

      // start() reports failure through onError, which has already cleared the ref.
      if (recorder.current === instance && instance.getState() === "idle") {
        recorder.current = null;
        setState("idle");
        setDestination(null);
      }
    },
    [isEgress, room, slug, topic],
  );

  const stop = useCallback(async () => {
    setStoppedRecently(true);
    if (recording.current?.egress) {
      setState("stopping");
      const current = recording.current;
      try {
        await api.completeRecording(slug, current.id, Date.now() - current.startedAt);
        notifyRef.current(
          "Recording stopped. It will be available in your recordings tab.",
          "ok",
        );
      } catch (err: unknown) {
        notifyRef.current(
          err instanceof Error ? err.message : "Error stopping cloud recording.",
          "error",
        );
      } finally {
        recording.current = null;
        setState("idle");
        setStartedAt(null);
        setDestination(null);
      }
      return;
    }

    const instance = recorder.current;
    if (instance) {
      setState("stopping");
      try {
        await instance.stop();
      } catch (err: unknown) {
        notifyRef.current(
          err instanceof Error ? err.message : "Error stopping recording.",
          "error",
        );
      } finally {
        recorder.current = null;
        recording.current = null;
        setState("idle");
        setStartedAt(null);
        setDestination(null);
      }
      return;
    }

    // Fallback: stopping an active cloud recording started elsewhere or before reload
    try {
      setState("stopping");
      const recs = await api.recordings(slug);
      const active = recs.find((r) => r.status === "recording" || r.status === "active");
      if (active) {
        await api.completeRecording(slug, active.id, 0);
      } else {
        await api.completeRecording(slug, "active", 0);
      }
      notifyRef.current(
        "Recording stopped. It will be available in your recordings tab.",
        "ok",
      );
    } catch (err: unknown) {
      notifyRef.current(
        err instanceof Error ? err.message : "Could not stop recording.",
        "error",
      );
    } finally {
      recording.current = null;
      setState("idle");
      setStartedAt(null);
      setDestination(null);
    }
  }, [slug]);

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

  const mine = !stoppedRecently && (state === "recording" || state === "stopping" || state === "starting");

  return { state, bytes, startedAt, destination, start, stop, mine, isEgress };
}

/** The control bar's record button: a split button — the main half records or
 *  stops, the chevron opens a menu of destinations.
 *
 *  The main half does not assume a destination any more. Unless the host ticked
 *  "Remember my choice", it opens RecordTargetDialog (record-target-dialog.tsx)
 *  to ask Cloud or This computer; with a remembered, still-available choice it
 *  starts there directly. While recording it only ever stops — no popup between
 *  a host and Stop. The decisions are in lib/record-target.ts. */
export function RecordButton() {
  const { join, recording: serverRecording, isHost } = useRoomUI();
  const { recordingMode, recordingsRetentionDays, cloudRecordingEnabled } = useAppConfig();
  const keepDays = recordingRetentionDays(undefined, recordingsRetentionDays);
  const isEgress = recordingMode === "egress";
  const { notify } = useToast();
  const { state, bytes, startedAt, destination, start, stop, mine } = useRoomRecorder();
  const connection = useConnectionState();
  const [choosing, setChoosing] = useState(false);
  const [asking, setAsking] = useState<{ initial: RecordTarget | null } | null>(null);
  const [remembered, setRemembered] = useState<RecordTarget | null>(() =>
    typeof window === "undefined" ? null : readRememberedTarget(safeLocalStorage()),
  );
  const [lastUsed, setLastUsed] = useState<RecordTarget | null>(null);
  const wrap = useRef<HTMLDivElement | null>(null);

  // Whether this browser can encode video at all. Read through
  // useSyncExternalStore because it is a client-only capability: false during the
  // server render, the real answer afterwards.
  const supported = useSyncExternalStore(
    subscribeNothing,
    readCanRecord,
    readCanRecordOnServer,
  );
  // Same reasoning, for the File System Access API specifically — Chrome/Edge only.
  const localSupported = useSyncExternalStore(
    subscribeNothing,
    readCanRecordLocally,
    readCanRecordLocallyOnServer,
  );
  const canSaveLocally = useSyncExternalStore(
    subscribeNothing,
    readCanSaveLocally,
    readCanRecordLocallyOnServer,
  );
  const canCaptureScreen = useSyncExternalStore(
    subscribeNothing,
    readCanCaptureScreen,
    readCanRecordLocallyOnServer,
  );

  const availability = useMemo(
    () =>
      recordAvailability({
        cloudEnabled: cloudRecordingEnabled,
        isEgress,
        canComposite: supported,
        canSaveLocally,
        canCaptureScreen,
      }),
    [cloudRecordingEnabled, isEgress, supported, canSaveLocally, canCaptureScreen],
  );

  const remember = useCallback((target: RecordTarget | null) => {
    writeRememberedTarget(safeLocalStorage(), target);
    setRemembered(target);
  }, []);

  // Called synchronously from a click (the dialog's Start, the menu, or the main
  // button) so local recording's getDisplayMedia/showSaveFilePicker keep their
  // user activation — see lib/screen-recorder.ts.
  const go = useCallback(
    (dest: RecordTarget) => {
      setChoosing(false);
      setAsking(null);
      setLastUsed(dest);
      void start(dest).catch((err: unknown) =>
        notify(err instanceof Error ? err.message : "Could not start recording.", "error"),
      );
    },
    [start, notify],
  );

  const cancelAsking = useCallback(() => setAsking(null), []);
  const startFromDialog = useCallback(
    (target: RecordTarget, rememberIt: boolean) => {
      if (rememberIt) remember(target);
      go(target);
    },
    [go, remember],
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

  if (!join.canRecord && !isHost) return null;
  if (!supported && !isEgress && !localSupported) return null;
  if (connection !== ConnectionState.Connected) return null;

  const busy = state === "starting" || state === "stopping";
  const isRecording = mine || (serverRecording && (join.canRecord || isHost));
  // Someone else's recording (another host, or before a reload) is always a
  // server one — local recordings are never announced to the room.
  const activeTarget: RecordTarget = mine && destination === "local" ? "local" : "cloud";

  const label =
    state === "starting"
      ? "Starting recording"
      : state === "stopping"
        ? "Saving recording"
        : isRecording
          ? `Stop recording (${recordingTag(activeTarget)})`
          : recordButtonTitle(remembered, availability);

  const onMainClick = () => {
    setChoosing(false);
    const action = resolveMainClick({ recording: isRecording, remembered, lastUsed, availability });
    if (action.kind === "stop") {
      void stop();
    } else if (action.kind === "start") {
      go(action.target);
    } else {
      setAsking({ initial: action.initial });
    }
  };

  return (
    <div ref={wrap} className="relative inline-flex items-center">
      <div
        className={`flex items-stretch overflow-hidden rounded-lg transition-colors ${
          isRecording
            ? "bg-live/20 text-live-soft"
            : "text-white/75 hover:bg-white/10 hover:text-white"
        }`}
      >
        {/* Main button: Record or Stop */}
        <button
          type="button"
          aria-label={label}
          aria-pressed={isRecording}
          aria-haspopup={!isRecording && !(remembered && availability[remembered].available) ? "dialog" : undefined}
          title={isRecording ? `Stop recording (${recordingTag(activeTarget)})` : recordButtonTitle(remembered, availability)}
          disabled={busy}
          onClick={onMainClick}
          className="relative inline-flex h-10 shrink-0 flex-col items-center justify-center gap-0.5 px-2 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-white/50 sm:min-w-14"
        >
          {isRecording ? <StopIcon className="size-5" /> : <RecordIcon className="size-5" />}
          <span className="hidden text-[9.5px] leading-none font-medium sm:block">
            {state === "starting"
              ? "Starting"
              : state === "stopping"
                ? "Saving"
                : isRecording
                  ? "Stop"
                  : "Record"}
          </span>
        </button>

        {/* Divider line between main button and chevron arrow */}
        <div className="w-px bg-white/15 my-1.5" aria-hidden />

        {/* Dropdown chevron arrow */}
        <button
          type="button"
          aria-label="Recording options"
          aria-haspopup="menu"
          aria-expanded={choosing}
          title="Choose recording destination"
          disabled={busy}
          onClick={() => setChoosing((v) => !v)}
          className="flex w-5 sm:w-6 items-center justify-center text-white/60 hover:bg-white/10 hover:text-white outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-white/50 cursor-pointer"
        >
          <ChevronDownIcon
            className={`size-3.5 transition-transform duration-150 ${choosing ? "rotate-180" : ""}`}
          />
        </button>
      </div>

      {/* A pill rather than a label change so the bar's width does not jump when
          recording starts. Deliberately terse — "REC · 12:38" — with where it is
          going (and a local file's size) in the tooltip / accessible name. */}
      {isRecording && (
        <RecordingPill target={activeTarget} startedAt={startedAt} bytes={bytes} />
      )}

      {/* Options Popover Menu: the destinations, one click each. */}
      {choosing && (
        <div
          role="menu"
          aria-label="Recording options"
          className="room-dark absolute bottom-full left-0 z-50 mb-2 w-72 rounded-xl border border-line bg-surface p-1.5 text-ink shadow-2xl backdrop-blur-xl"
        >
          {!isRecording && (
            <>
              <RecordMenuItem
                target="cloud"
                title="Record to the Cloud"
                hint={
                  keepDays > 0
                    ? `Stored for ${keepDays} days. Download a copy if you need it longer.`
                    : "Saved to your recordings list."
                }
                availability={availability.cloud}
                isDefault={remembered === "cloud"}
                disabled={busy}
                onPick={() => go("cloud")}
              />
              <RecordMenuItem
                target="local"
                title="Record on this Computer"
                hint="Saved as a local file. Nothing is uploaded or auto-deleted."
                availability={availability.local}
                isDefault={remembered === "local"}
                disabled={busy}
                onPick={() => go("local")}
              />
              {remembered && (
                <div className="mt-1 border-t border-line/60 pt-1">
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      remember(null);
                      setChoosing(false);
                    }}
                    className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[12.5px] text-ink-2 transition-colors outline-none hover:bg-surface-2 hover:text-ink focus-visible:ring-2 focus-visible:ring-brand/40 cursor-pointer"
                  >
                    Ask where to save every time
                  </button>
                </div>
              )}
            </>
          )}

          {/* If currently recording, show where it is going and a direct Stop */}
          {isRecording && (
            <>
              <div className="flex items-center justify-between px-2.5 py-1.5 text-[11.5px] text-ink-3">
                <span>Recording to</span>
                <span className="font-medium text-live">
                  {activeTarget === "local" ? "This computer" : "Cloud"}
                </span>
              </div>
              <div className="mt-1 border-t border-line/60 pt-1">
                <button
                  type="button"
                  role="menuitem"
                  disabled={busy}
                  onClick={() => {
                    setChoosing(false);
                    void stop();
                  }}
                  className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-live transition-colors outline-none hover:bg-live/10 focus-visible:ring-2 focus-visible:ring-live/50 cursor-pointer font-medium text-[13px]"
                >
                  <StopIcon className="size-4" />
                  Stop recording
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {asking && (
        <RecordTargetDialog
          availability={availability}
          initial={asking.initial}
          keepDays={keepDays}
          isEgress={isEgress}
          onCancel={cancelAsking}
          onStart={startFromDialog}
        />
      )}
    </div>
  );
}

function RecordMenuItem({
  target,
  title,
  hint,
  availability,
  isDefault,
  disabled,
  onPick,
}: {
  target: RecordTarget;
  title: string;
  hint: string;
  availability: TargetAvailability;
  isDefault: boolean;
  disabled: boolean;
  onPick: () => void;
}) {
  const Icon = target === "cloud" ? RecordIcon : DeviceIcon;
  const off = !availability.available;
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled || off}
      aria-disabled={off || undefined}
      onClick={onPick}
      className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors outline-none focus-visible:ring-2 focus-visible:ring-brand/40 ${
        off ? "cursor-not-allowed opacity-55" : "cursor-pointer hover:bg-surface-2"
      }`}
    >
      <Icon className={`size-4 shrink-0 ${target === "cloud" ? "text-live" : "text-brand"}`} />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className="block text-[13px] font-medium text-ink">{title}</span>
          {isDefault && !off && (
            <span className="rounded bg-brand/15 px-1.5 py-px text-[9.5px] font-semibold tracking-wide text-brand uppercase">
              Default
            </span>
          )}
        </span>
        <span className="mt-0.5 block text-[11px] leading-snug text-ink-3">
          {off ? availability.reason : hint}
        </span>
      </span>
    </button>
  );
}

function safeLocalStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** "● REC · 12:38" above the Record/Stop button, with the detail on hover or
 *  focus. Focusable so keyboard users can reach the tooltip, and a tap focuses
 *  it on touch. The detail is also its accessible name (role="img" keeps it one
 *  atomic element, and nothing live-announces the ticking clock).
 *  Ticks on its own so the bar does not re-render every second. */
function RecordingPill({
  target,
  startedAt,
  bytes,
}: {
  target: RecordTarget;
  startedAt: number | null;
  bytes: number;
}) {
  const [mountTime] = useState(() => Date.now());
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const elapsed = formatClock(Math.max(0, now - (startedAt ?? mountTime)));
  const detail = recordingDetail(target, elapsed, bytes > 0 ? formatBytes(bytes) : null);

  return (
    <span
      data-record-pill={target}
      tabIndex={0}
      role="img"
      aria-label={detail}
      className="group/pill absolute -top-7 left-1/2 hidden -translate-x-1/2 cursor-default items-center gap-1 rounded-md bg-black/75 px-1.5 py-0.5 text-[10px] font-medium whitespace-nowrap text-white outline-none focus-visible:ring-2 focus-visible:ring-white/50 sm:inline-flex"
    >
      <span className="size-1.5 animate-pulse rounded-full bg-live" aria-hidden />
      <span className="font-semibold tracking-wide">REC</span>
      <span className="font-mono tabular-nums text-white/80">· {elapsed}</span>
      <span
        aria-hidden
        className="room-dark pointer-events-none absolute bottom-full left-1/2 mb-1.5 -translate-x-1/2 rounded-md border border-line bg-surface px-2 py-1 text-[11px] font-medium text-ink opacity-0 shadow-lg transition-opacity duration-100 group-hover/pill:opacity-100 group-focus/pill:opacity-100"
      >
        {detail}
      </span>
    </span>
  );
}

/** Top recording banner displayed prominently when recording is active. */
export function RecordingBanner() {
  const { recording: serverRecording, isHost, join } = useRoomUI();
  const { state, startedAt, destination, stop, mine } = useRoomRecorder();
  const [minimized, setMinimized] = useState(false);

  const isRecordingActive =
    serverRecording || state === "recording" || state === "starting" || state === "stopping";

  if (!isRecordingActive) return null;

  const isLocal = destination === "local";
  const canControl = isHost || join.canRecord || mine;
  const isStopping = state === "stopping";

  if (minimized) {
    return (
      <div className="pointer-events-none absolute inset-x-0 top-12 z-30 flex justify-center px-3">
        <button
          type="button"
          onClick={() => setMinimized(false)}
          className="pointer-events-auto inline-flex items-center gap-2 rounded-full border border-white/15 bg-black/85 px-3 py-1 text-xs font-medium text-white shadow-xl backdrop-blur-md hover:bg-black/95 transition-all cursor-pointer"
          title="Expand recording banner"
        >
          <span className="relative flex size-2">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-live opacity-75" />
            <span className="relative inline-flex size-2 rounded-full bg-live" />
          </span>
          <span className="font-semibold text-live-soft">REC</span>
          <span className="font-mono text-white/80 tabular-nums">
            <Elapsed since={startedAt} />
          </span>
          <ChevronDownIcon className="size-3 text-white/60" />
        </button>
      </div>
    );
  }

  return (
    <div className="pointer-events-none absolute inset-x-0 top-12 sm:top-14 z-30 flex justify-center px-3">
      <div className="pointer-events-auto flex items-center gap-2.5 sm:gap-3 rounded-full border border-white/20 bg-black/85 px-3.5 py-1.5 sm:px-4 sm:py-2 text-white shadow-2xl backdrop-blur-md transition-all">
        {/* Pulsing red REC indicator */}
        <div className="flex items-center gap-2 shrink-0">
          <span className="relative flex size-2.5">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-live opacity-75" />
            <span className="relative inline-flex size-2.5 rounded-full bg-live" />
          </span>
          <span className="text-[12px] sm:text-[13px] font-semibold text-white">
            {isLocal ? "Recording to this Computer" : "Recording to Cloud"}
          </span>
        </div>

        {/* Monospace elapsed duration */}
        <div className="flex items-center gap-1 font-mono text-[11.5px] sm:text-[12.5px] font-medium text-white/90 tabular-nums">
          <Elapsed since={startedAt} />
        </div>

        {/* Stop button for authorized users */}
        {canControl && (
          <div className="flex items-center gap-1.5 pl-1">
            <div className="h-3.5 w-px bg-white/20 mr-1" aria-hidden />
            <button
              type="button"
              onClick={() => void stop()}
              disabled={isStopping}
              aria-label="Stop recording"
              className="inline-flex items-center gap-1.5 rounded-full bg-live px-2.5 py-1 text-[11.5px] sm:text-[12px] font-semibold text-white transition hover:bg-live/90 focus-visible:ring-2 focus-visible:ring-white/50 disabled:opacity-50 cursor-pointer"
            >
              {isStopping ? (
                <Spinner className="size-3" />
              ) : (
                <StopIcon className="size-3.5" />
              )}
              <span>{isStopping ? "Saving…" : "Stop"}</span>
            </button>
          </div>
        )}

        {/* Minimize banner button */}
        <button
          type="button"
          onClick={() => setMinimized(true)}
          aria-label="Minimize recording banner"
          title="Minimize recording banner"
          className="ml-0.5 grid size-5 place-items-center rounded-full text-white/40 hover:bg-white/15 hover:text-white transition-colors cursor-pointer"
        >
          <ChevronDownIcon className="size-3 rotate-180" />
        </button>
      </div>
    </div>
  );
}

/** Ticks once a second while recording. Its own component so the whole control
 *  bar does not re-render for the clock. */
function Elapsed({ since }: { since?: number | null }) {
  const [mountTime] = useState(() => Date.now());
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const base = since ?? mountTime;
  return <>{formatClock(Math.max(0, now - base))}</>;
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
