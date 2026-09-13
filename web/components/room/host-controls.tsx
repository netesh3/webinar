"use client";

import { useState } from "react";
import { api } from "@/lib/api";
import type { ControlsPatch } from "@/lib/api-types";
import { chatDestination, type ChatDestination } from "@/lib/realtime";
import { Alert, ConfirmModal, Spinner, Toggle } from "../controls";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  ChevronDownIcon,
  EyeOffIcon,
  LockIcon,
  MicIcon,
  MicOffIcon,
} from "../icons";
import { useToast } from "../providers";
import { useRoomUI } from "./context";

/* The host's in-session control panel.
 *
 * Essentials up front (mute all, lock, end). Everything else — privacy,
 * participation toggles, chat routing — lives behind "More options" so the
 * first glance matches how hosts actually run a session.
 */

export function HostControls() {
  const { slug, controls } = useRoomUI();
  const chatTo = chatDestination(controls.chatDestination);
  const { notify } = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmEnd, setConfirmEnd] = useState(false);
  const [ending, setEnding] = useState(false);
  const [confirmAllowAll, setConfirmAllowAll] = useState(false);
  const [allowingAll, setAllowingAll] = useState(false);
  const [confirmStageAll, setConfirmStageAll] = useState(false);
  const [stagingAll, setStagingAll] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);

  async function set(key: keyof ControlsPatch, value: boolean, label: string) {
    setBusy(key);
    setError(null);
    try {
      await api.updateControls(slug, { [key]: value } satisfies ControlsPatch);
      notify(label, "ok");
    } catch (err) {
      setError(err instanceof Error ? err.message : "That didn't apply.");
    } finally {
      setBusy(null);
    }
  }

  async function setChatDestination(to: ChatDestination) {
    if (to === chatTo) return;
    setBusy("chatDestination");
    setError(null);
    try {
      await api.updateControls(slug, { chatDestination: to } satisfies ControlsPatch);
      notify(
        to === "panelists"
          ? "Attendee chat now goes to you and the panelists only."
          : "Attendee chat is visible to everyone again.",
        "ok",
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "That didn't apply.");
    } finally {
      setBusy(null);
    }
  }

  async function muteEveryone() {
    setBusy("muteAll");
    setError(null);
    try {
      const { muted } = await api.muteAll(slug);
      notify(
        muted === 0
          ? "Nobody had an open microphone."
          : `Muted ${muted} ${muted === 1 ? "microphone" : "microphones"}.`,
        "ok",
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not mute everyone.");
    } finally {
      setBusy(null);
    }
  }

  // Confirmed separately from the rest of `busy`, the same way ending the
  // webinar is: this hands every attendee a microphone and a screen share at
  // once, which is the kind of click a host wants a second before committing
  // to, not the quick undo "mute everyone" is.
  async function allowEveryoneToSpeak() {
    setAllowingAll(true);
    setError(null);
    try {
      const { count } = await api.allowAllToSpeak(slug);
      setConfirmAllowAll(false);
      notify(
        count === 0
          ? "Everyone already has the stage, or nobody's in the audience."
          : `${count} ${count === 1 ? "attendee" : "attendees"} can now speak and share their screen.`,
        "ok",
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not allow everyone to speak.");
    } finally {
      setAllowingAll(false);
    }
  }

  // Same reasoning as allowEveryoneToSpeak's own confirm, and a step further:
  // this hands every attendee a camera as well, so it gets its own dialog
  // rather than folding into that one — a host meaning "everyone can talk"
  // must not land on "everyone's face is now visible" by mis-click.
  async function bringEveryoneOnStage() {
    setStagingAll(true);
    setError(null);
    try {
      const { count } = await api.bringAllOnStage(slug);
      setConfirmStageAll(false);
      notify(
        count === 0
          ? "Everyone already has the stage, or nobody's in the audience."
          : `${count} ${count === 1 ? "attendee is" : "attendees are"} now on camera and mic.`,
        "ok",
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not bring everyone on stage.");
    } finally {
      setStagingAll(false);
    }
  }

  // No confirmation: this only takes something away, the same reason "mute
  // everyone" does not ask first either. Takes back either bulk grant above —
  // it does not distinguish how someone came to be on stage.
  async function revokeEveryonesSpeaking() {
    setBusy("revokeAll");
    setError(null);
    try {
      const { count } = await api.revokeAllSpeaking(slug);
      notify(
        count === 0
          ? "Nobody had been given the stage."
          : `Sent ${count} ${count === 1 ? "person" : "people"} back to the audience.`,
        "ok",
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not revoke everyone's speaking permission.");
    } finally {
      setBusy(null);
    }
  }

  async function endForAll() {
    setEnding(true);
    try {
      await api.endWebinar(slug);
      setConfirmEnd(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not end the webinar.");
      setEnding(false);
    }
  }

  return (
    <>
      <div className="min-h-0 flex-1 overflow-y-auto p-3.5">
        <div className="space-y-4">
          {error && <Alert tone="error">{error}</Alert>}

          <section className="space-y-1">
            <button
              type="button"
              onClick={() => void muteEveryone()}
              disabled={busy !== null}
              className="flex w-full items-center gap-3 rounded-lg border border-line-2 px-3.5 py-3 text-left transition-colors hover:bg-surface-2 disabled:opacity-50 outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
            >
              <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-surface-2 text-ink-2">
                {busy === "muteAll" ? (
                  <Spinner className="size-4" />
                ) : (
                  <MicOffIcon className="size-4" />
                )}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-[13px] font-medium text-ink">
                  Mute everyone
                </span>
                <span className="mt-0.5 block text-[12px] leading-relaxed text-ink-2">
                  Mutes every microphone except yours.
                </span>
              </span>
            </button>

            <div className="rounded-lg border border-line-2 p-1.5">
              <Toggle
                tone="warn"
                checked={controls.locked}
                disabled={busy !== null}
                onChange={(v) =>
                  void set(
                    "locked",
                    v,
                    v ? "The webinar is locked." : "The webinar is open again.",
                  )
                }
                label={
                  <span className="flex items-center gap-1.5">
                    <LockIcon className="size-3.5 text-ink-3" />
                    Lock the webinar
                  </span>
                }
                description="Nobody new can join. People already here stay."
              />
            </div>
          </section>

          <section className="space-y-1">
            <button
              type="button"
              onClick={() => setConfirmAllowAll(true)}
              disabled={busy !== null}
              className="flex w-full items-center gap-3 rounded-lg border border-line-2 px-3.5 py-3 text-left transition-colors hover:bg-surface-2 disabled:opacity-50 outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
            >
              <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-surface-2 text-ink-2">
                <MicIcon className="size-4" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-[13px] font-medium text-ink">
                  Allow everyone to speak
                </span>
                <span className="mt-0.5 block text-[12px] leading-relaxed text-ink-2">
                  Gives every attendee a microphone and a screen share, no camera.
                </span>
              </span>
            </button>

            <button
              type="button"
              onClick={() => setConfirmStageAll(true)}
              disabled={busy !== null}
              className="flex w-full items-center gap-3 rounded-lg border border-line-2 px-3.5 py-3 text-left transition-colors hover:bg-surface-2 disabled:opacity-50 outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
            >
              <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-surface-2 text-ink-2">
                <ArrowUpIcon className="size-4" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-[13px] font-medium text-ink">
                  Bring everyone on stage
                </span>
                <span className="mt-0.5 block text-[12px] leading-relaxed text-ink-2">
                  Gives every attendee a camera, a microphone and a screen share.
                </span>
              </span>
            </button>

            <button
              type="button"
              onClick={() => void revokeEveryonesSpeaking()}
              disabled={busy !== null}
              className="flex w-full items-center gap-3 rounded-lg border border-line-2 px-3.5 py-3 text-left transition-colors hover:bg-surface-2 disabled:opacity-50 outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
            >
              <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-surface-2 text-ink-2">
                {busy === "revokeAll" ? (
                  <Spinner className="size-4" />
                ) : (
                  <ArrowDownIcon className="size-4" />
                )}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-[13px] font-medium text-ink">
                  Remove everyone&apos;s speaking permission
                </span>
                <span className="mt-0.5 block text-[12px] leading-relaxed text-ink-2">
                  Sends everyone you promoted back to the audience. Scheduled
                  panelists keep their seats.
                </span>
              </span>
            </button>
          </section>

          <section>
            <button
              type="button"
              onClick={() => setMoreOpen((v) => !v)}
              aria-expanded={moreOpen}
              className="flex w-full items-center justify-between rounded-lg px-1 py-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
            >
              <span className="text-[11px] font-semibold tracking-[0.06em] text-ink-3 uppercase">
                More options
              </span>
              <ChevronDownIcon
                className={`size-4 text-ink-3 transition-transform ${moreOpen ? "rotate-180" : ""}`}
              />
            </button>

            {moreOpen && (
              <div className="mt-1 space-y-4">
                <div>
                  <h3 className="mb-1.5 text-[11px] font-semibold tracking-[0.06em] text-ink-3 uppercase">
                    Audio
                  </h3>
                  <Toggle
                    checked={controls.muteOnEntry}
                    disabled={busy !== null}
                    onChange={(v) =>
                      void set(
                        "muteOnEntry",
                        v,
                        v ? "New panelists will join muted." : "New panelists can join live.",
                      )
                    }
                    label="Mute panelists on entry"
                    description="They can still unmute if you allow it below."
                  />
                  <Toggle
                    checked={controls.allowUnmute}
                    disabled={busy !== null}
                    onChange={(v) =>
                      void set(
                        "allowUnmute",
                        v,
                        v ? "Panelists can unmute themselves." : "Only you can unmute panelists now.",
                      )
                    }
                    label="Let panelists unmute themselves"
                  />
                </div>

                <div>
                  <h3 className="mb-1.5 text-[11px] font-semibold tracking-[0.06em] text-ink-3 uppercase">
                    Privacy
                  </h3>
                  <div className="rounded-lg border border-line-2 p-1.5">
                    <Toggle
                      checked={controls.hideAttendees}
                      disabled={busy !== null}
                      onChange={(v) =>
                        void set(
                          "hideAttendees",
                          v,
                          v
                            ? "Attendees can no longer see each other."
                            : "Attendees can see each other again.",
                        )
                      }
                      label={
                        <span className="flex items-center gap-1.5">
                          <EyeOffIcon className="size-3.5 text-ink-3" />
                          Hide attendees from each other
                        </span>
                      }
                      description="Attendees see only the stage — not each other."
                    />
                  </div>
                </div>

                <div>
                  <h3 className="mb-1.5 text-[11px] font-semibold tracking-[0.06em] text-ink-3 uppercase">
                    What attendees can do
                  </h3>
                  <Toggle
                    checked={controls.chatEnabled}
                    disabled={busy !== null}
                    onChange={(v) =>
                      void set("chatEnabled", v, v ? "Chat is on." : "Chat is off for attendees.")
                    }
                    label="Chat"
                  />
                  {controls.chatEnabled && (
                    <div className="mt-1 mb-1 rounded-lg border border-line-2 px-3 py-2.5">
                      <p className="text-[13px] font-medium text-ink">Attendees can chat with</p>
                      <div className="mt-2 flex items-center gap-1.5">
                        {(["everyone", "panelists"] as const).map((to) => (
                          <button
                            key={to}
                            type="button"
                            onClick={() => void setChatDestination(to)}
                            disabled={busy !== null}
                            aria-pressed={chatTo === to}
                            className={`inline-flex h-8 items-center gap-1.5 rounded-lg px-3 text-[12.5px] font-medium transition-colors disabled:opacity-60 outline-none focus-visible:ring-2 focus-visible:ring-brand/40 ${
                              chatTo === to
                                ? "bg-brand-soft text-brand"
                                : "border border-line-2 text-ink-2 hover:bg-surface-2"
                            }`}
                          >
                            {busy === "chatDestination" && chatTo !== to && (
                              <Spinner className="size-3.5" />
                            )}
                            {to === "everyone" ? "Everyone" : "Panelists"}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                  <Toggle
                    checked={controls.qaEnabled}
                    disabled={busy !== null}
                    onChange={(v) => void set("qaEnabled", v, v ? "Q&A is on." : "Q&A is closed.")}
                    label="Q&A"
                  />
                  <Toggle
                    checked={controls.raiseHandEnabled}
                    disabled={busy !== null}
                    onChange={(v) =>
                      void set(
                        "raiseHandEnabled",
                        v,
                        v ? "Raise hand is on." : "Raise hand is off.",
                      )
                    }
                    label="Raise hand"
                  />
                  <Toggle
                    checked={controls.reactionsEnabled}
                    disabled={busy !== null}
                    onChange={(v) =>
                      void set(
                        "reactionsEnabled",
                        v,
                        v ? "Reactions are on." : "Reactions are off.",
                      )
                    }
                    label="Reactions"
                  />
                  <Toggle
                    checked={controls.pollsEnabled}
                    disabled={busy !== null}
                    onChange={(v) =>
                      void set(
                        "pollsEnabled",
                        v,
                        v ? "Polls are on." : "Polls are hidden from attendees.",
                      )
                    }
                    label="Polls and quizzes"
                  />
                </div>
              </div>
            )}
          </section>

          <section className="border-t border-line pt-4">
            <button
              type="button"
              onClick={() => setConfirmEnd(true)}
              className="w-full rounded-lg bg-live px-3.5 py-2.5 text-[13px] font-medium text-white transition-colors hover:bg-live/90 outline-none focus-visible:ring-2 focus-visible:ring-live/40"
            >
              End webinar for everyone
            </button>
            <p className="mt-1.5 text-center text-[11.5px] text-ink-3">
              Leave also offers ending or assigning another host.
            </p>
          </section>
        </div>
      </div>

      <ConfirmModal
        dark
        open={confirmEnd}
        busy={ending}
        onClose={() => setConfirmEnd(false)}
        onConfirm={() => void endForAll()}
        title="End this webinar for everyone?"
        body="Everyone is disconnected and the webinar is marked as ended. Registrations and the attendance record are kept, but nobody can rejoin."
        confirmLabel="End for everyone"
      />

      <ConfirmModal
        dark
        open={confirmAllowAll}
        busy={allowingAll}
        onClose={() => setConfirmAllowAll(false)}
        onConfirm={() => void allowEveryoneToSpeak()}
        title="Allow everyone to speak?"
        body="Every attendee gets a microphone and a screen share, no camera — the same grant as Allow to speak, given to the whole audience at once. You can take it back for everyone with one click too."
        confirmLabel="Allow everyone"
      />

      <ConfirmModal
        dark
        open={confirmStageAll}
        busy={stagingAll}
        onClose={() => setConfirmStageAll(false)}
        onConfirm={() => void bringEveryoneOnStage()}
        title="Bring everyone on stage?"
        body="Every attendee gets a camera, a microphone and a screen share — the same grant as Bring on stage, given to the whole audience at once. Everyone becomes visible and audible the moment they turn their camera or mic on. You can take it back for everyone with one click too."
        confirmLabel="Bring everyone on stage"
      />
    </>
  );
}
