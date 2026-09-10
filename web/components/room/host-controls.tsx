"use client";

import { useState } from "react";
import { api } from "@/lib/api";
import type { ControlsPatch } from "@/lib/api-types";
import { chatDestination, type ChatDestination } from "@/lib/realtime";
import { Alert, ConfirmModal, Spinner, Toggle } from "../controls";
import { EyeOffIcon, LockIcon, MicOffIcon } from "../icons";
import { useToast } from "../providers";
import { useRoomUI } from "./context";

/* The host's in-session control panel.
 *
 * Every switch here writes to the API, which persists it and mirrors it into
 * LiveKit room metadata. That second step is what makes a toggle apply to 500
 * browsers at once without any of them polling — and persisting it is what makes
 * it apply to somebody who joins ten minutes later.
 *
 * The two controls the product is really about:
 *
 *   Mute everyone   mutes every published microphone except the host's own, then
 *                   latches mute-on-entry so it means more than "mute whoever
 *                   happens to be here this second".
 *
 *   Hide attendees  minted into each attendee's token as hidden=true, so the SFU
 *                   never tells one attendee about another. Not a filter in our
 *                   JavaScript: a patched client still cannot enumerate the room.
 */

/* The body of the Host tools window. The window supplies the title bar, the
 * geometry and the close button; the confirmation below stays a real blocking
 * modal, because ending the webinar for five hundred people is not something to
 * put behind a button in a window that can be half off screen. */
export function HostControls() {
  const { slug, controls } = useRoomUI();
  // Narrowed once: the generated type is a bare string.
  const chatTo = chatDestination(controls.chatDestination);
  const { notify } = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmEnd, setConfirmEnd] = useState(false);
  const [ending, setEnding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** Applies a control change. The new state arrives back through room metadata,
   *  so nothing local needs updating — the whole room, including this tab, reacts
   *  to the same broadcast. */
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

  /** Where the AUDIENCE's chat goes. Not a toggle, so it does not go through
   *  `set` — and worth stating plainly on screen, because it is the one control
   *  here that changes who can read something rather than who can do something. */
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

  async function endForAll() {
    setEnding(true);
    try {
      await api.endWebinar(slug);
      // No navigation here: the SFU deletes the room, every client including this
      // one is disconnected, and the room's own onDisconnected handles the exit.
      setConfirmEnd(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not end the webinar.");
      setEnding(false);
    }
  }

  return (
    <>
      <div className="min-h-0 flex-1 overflow-y-auto p-3.5">
        <div className="space-y-5">
          <p className="text-[12px] text-ink-3">
            Changes apply to everyone immediately, and to anyone who joins later.
          </p>
          {error && <Alert tone="error">{error}</Alert>}

          {/* ---- audio ---- */}
          <section>
            <h3 className="mb-1.5 text-[11px] font-semibold tracking-[0.06em] text-ink-3 uppercase">
              Audio
            </h3>

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
                  Mutes every microphone except yours, and keeps new arrivals muted.
                </span>
              </span>
            </button>

            <div className="mt-1">
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
                description="They can still turn their own microphone on if you allow it below."
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
                description="Off means you decide when each of them is heard."
              />
            </div>
          </section>

          {/* ---- privacy ---- */}
          <section>
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
                description="Attendees see only you and the panelists — not the rest of the audience, and not each other's names. You still see everyone in the participants list."
              />
            </div>
            {controls.hideAttendees && (
              <p className="mt-1.5 pl-1 text-[11.5px] leading-relaxed text-ink-3">
                Enforced by the media server, not by the app: attendee connections
                are never told about one another.
              </p>
            )}
          </section>

          {/* ---- participation ---- */}
          <section>
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
              description="Panelists can always chat."
            />

            {/* Only meaningful while attendees can chat at all. Shown rather than
                hidden when chat is off would be a control that appears to do
                nothing. */}
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
                <p className="mt-2 text-[12px] leading-relaxed text-ink-2">
                  {chatTo === "panelists"
                    ? "Attendees' messages reach you and the panelists only — they can't see each other's. Yours and the panelists' still go wherever each of you chooses."
                    : "Attendees' messages are visible to the whole room."}
                </p>
                <p className="mt-1.5 text-[11.5px] leading-relaxed text-ink-3">
                  Applied by the server, not by the app: a message meant for the
                  panelists is never sent to the other attendees&apos; browsers. Messages
                  already sent keep the audience they were sent to.
                </p>
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
                void set("raiseHandEnabled", v, v ? "Raise hand is on." : "Raise hand is off.")
              }
              label="Raise hand"
              description="You can bring anyone with a raised hand onto the stage."
            />
            <Toggle
              checked={controls.reactionsEnabled}
              disabled={busy !== null}
              onChange={(v) =>
                void set("reactionsEnabled", v, v ? "Reactions are on." : "Reactions are off.")
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
              description="You write the questions in the Polls panel and launch them one at a time. Nothing appears for attendees until you do."
            />
          </section>

          {/* ---- access ---- */}
          <section>
            <h3 className="mb-1.5 text-[11px] font-semibold tracking-[0.06em] text-ink-3 uppercase">
              Access
            </h3>
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
                description="Nobody new can join. People already here are unaffected."
              />
            </div>
          </section>

          {/* ---- end ---- */}
          <section className="border-t border-line pt-4">
            <button
              type="button"
              onClick={() => setConfirmEnd(true)}
              className="w-full rounded-lg bg-live px-3.5 py-2.5 text-[13px] font-medium text-white transition-colors hover:bg-live/90 outline-none focus-visible:ring-2 focus-visible:ring-live/40"
            >
              End webinar for everyone
            </button>
            <p className="mt-1.5 text-center text-[11.5px] text-ink-3">
              Leaving on your own keeps the webinar running.
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
    </>
  );
}
