"use client";

import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import type { ControlsPatch } from "@/lib/api-types";
import {
  imageFromPaste,
  isSupportedImage,
  prepareImage,
  ImageError,
} from "@/lib/chat-images";
import { textRuns } from "@/lib/chat-text";
import { chatDestination, type ChatDestination, type ChatMessage } from "@/lib/realtime";
import { Alert, Spinner } from "../controls";
import { ImageIcon, SendIcon } from "../icons";
import { useRoomUI } from "./context";

/* Chat.
 *
 * Where an ATTENDEE's message goes is the host's decision, not the sender's. The
 * picker below is the host's; an attendee gets a label telling them who will read
 * what they are about to write, and no way to change it.
 *
 * That is not a UI arrangement. Attendee tokens carry canPublishData=false, so
 * their messages travel through our API, which reads the host's setting and hands
 * the SFU the recipient list — see lib/realtime.ts and api/internal/api/say.go. A
 * message addressed to the stage is never sent to the other attendees at all,
 * which is why nothing here has to filter one out.
 *
 * The sender's name travels in the payload rather than being looked up from the
 * participant list, because a hidden attendee has no participant record on the
 * receiving side.
 */

const MAX_CHARS = 2000;

/** The host's segmented control offers one more choice than `ChatDestination`
 *  carries: turning attendee chat off is a separate flag (`chatEnabled`), not
 *  a third destination, but the picker presents all three as one choice. */
type AudienceChatOption = ChatDestination | "disabled";

export function ChatPanel() {
  const { slug, joinKey, realtime, controls, permissions, isHost, me } = useRoomUI();
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Saved but not delivered, which is not an error. See send().
  const [note, setNote] = useState<string | null>(null);

  // The host and the panelists pick per message; theirs is local state. Everyone
  // else follows the room, so there is nothing local to hold.
  const [stageTo, setStageTo] = useState<ChatDestination>("everyone");
  // Which switch the host is currently flipping, so the segmented control can show
  // it landing rather than appearing to do nothing for a round trip.
  const [switching, setSwitching] = useState<AudienceChatOption | null>(null);

  const [uploading, setUploading] = useState(false);

  const list = useRef<HTMLDivElement>(null);
  const pinnedToBottom = useRef(true);
  const filePicker = useRef<HTMLInputElement>(null);

  // Follow new messages, but only while the reader is already at the bottom.
  // Yanking someone back down while they scroll up to re-read something is the
  // single most annoying thing a chat panel can do.
  useEffect(() => {
    if (pinnedToBottom.current) {
      list.current?.scrollTo({ top: list.current.scrollHeight });
    }
  }, [realtime.chat]);

  // Attendee chat can be switched off by the host mid-session. The stage keeps
  // talking either way, so this is scoped to the audience.
  const muted = !controls.chatEnabled && !permissions.canPublish;

  // The room's setting, as the host last left it. Narrowed here because the
  // generated type is a bare string.
  const roomTo = chatDestination(controls.chatDestination);
  // What the segmented control below shows as selected: "disabled" swallows
  // whatever destination was last chosen, so switching chat back on returns to
  // it rather than defaulting to "everyone" every time.
  const roomOption: AudienceChatOption = controls.chatEnabled ? roomTo : "disabled";
  // A publisher chooses; the audience is told. `permissions.canPublish` rather than
  // the joined role, so an attendee the host promotes gains the choice without a
  // rejoin — and loses it again if they are sent back.
  const canChoose = permissions.canPublish || isHost;
  const destination = canChoose ? stageTo : roomTo;

  async function send() {
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    setError(null);
    setNote(null);
    try {
      const result = await realtime.sendChat(text, destination);
      setDraft("");
      // A stage-only message with nobody on the stage is kept and not delivered: it goes
      // into the transcript and the first panelist to connect reads it in their backlog.
      // Said plainly, because a message that appears to vanish is one somebody types
      // again.
      setNote(
        result && !result.delivered
          ? "No panelists are connected — your message is saved, and they'll see it when they join."
          : null,
      );
    } catch (err) {
      // The server refuses for reasons worth reading: no panelists connected, chat
      // turned off a second ago, too many messages. Showing its words beats a
      // generic failure, and the draft is deliberately left in the box.
      setError(err instanceof Error ? err.message : "That message didn't send.");
    } finally {
      setSending(false);
    }
  }

  /* Sends an image.
   *
   * Compressed and re-encoded before it leaves — see lib/chat-images.ts. The server has
   * a five-megabyte cap, but it is a backstop against a client that skipped this step,
   * not the working limit: rejecting a four-megabyte upload after it has crossed hotel
   * wifi is a minute of somebody's life for an error message.
   *
   * Nothing is rendered locally. The server stores the bytes, writes the row, and
   * broadcasts the message, which arrives here on the data channel like anybody else's —
   * so what appears is what was actually recorded.
   */
  async function sendImage(file: File) {
    if (uploading) return;
    setUploading(true);
    setError(null);
    try {
      const prepared = await prepareImage(file);
      await api.chatImage(slug, {
        id: crypto.randomUUID(),
        blob: prepared.blob,
        mime: prepared.mime,
        width: prepared.width,
        height: prepared.height,
        destination,
        joinKey,
      });
    } catch (err) {
      setError(
        err instanceof ImageError || err instanceof Error
          ? err.message
          : "That image didn't send.",
      );
    } finally {
      setUploading(false);
    }
  }

  /** The host changing where the AUDIENCE's chat goes.
   *
   *  Written to the API, which persists it and mirrors it into room metadata — so
   *  it reaches every browser in the room at once and still applies to somebody who
   *  joins ten minutes later. Nothing local is updated: this tab reacts to the same
   *  broadcast as everyone else, which is what keeps them in agreement. */
  async function setRoomDestination(to: AudienceChatOption) {
    if (to === roomOption || switching) return;
    setSwitching(to);
    setError(null);
    try {
      const patch: ControlsPatch =
        to === "disabled"
          ? { chatEnabled: false }
          : { chatEnabled: true, chatDestination: to };
      await api.updateControls(slug, patch);
    } catch (err) {
      setError(err instanceof Error ? err.message : "That didn't apply.");
    } finally {
      setSwitching(null);
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* ---- the host's control over the audience's chat ---- */}
      {isHost && (
        <div className="shrink-0 border-b border-line px-3 py-2.5">
          <p className="text-[11px] font-semibold tracking-[0.06em] text-ink-3 uppercase">
            Attendees can chat with
          </p>
          <div className="mt-1.5 flex items-center gap-1">
            {(["everyone", "panelists", "disabled"] as const).map((to) => (
              <button
                key={to}
                type="button"
                onClick={() => void setRoomDestination(to)}
                disabled={switching !== null}
                aria-pressed={roomOption === to}
                className={`inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-[12px] font-medium transition-colors disabled:opacity-60 outline-none focus-visible:ring-2 focus-visible:ring-brand/40 ${
                  roomOption === to
                    ? "bg-brand-soft text-brand"
                    : "text-ink-2 hover:bg-surface-2"
                }`}
              >
                {switching === to && <Spinner className="size-3" />}
                {to === "everyone" ? "Everyone" : to === "panelists" ? "Panelists" : "Disabled"}
              </button>
            ))}
          </div>
          <p className="mt-1.5 text-[11.5px] leading-relaxed text-ink-3">
            {roomOption === "disabled"
              ? "Attendees can't send messages. Turn it back on anytime."
              : roomOption === "panelists"
                ? "Attendees' messages reach you and the panelists only. They cannot see each other's."
                : "Attendees' messages are visible to the whole room."}
          </p>
        </div>
      )}

      <div
        ref={list}
        onScroll={(e) => {
          const el = e.currentTarget;
          pinnedToBottom.current =
            el.scrollHeight - el.scrollTop - el.clientHeight < 48;
        }}
        className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-3"
        aria-live="polite"
        aria-atomic="false"
      >
        {realtime.chat.length === 0 ? (
          <p className="py-8 text-center text-[12.5px] leading-relaxed text-ink-3">
            No messages yet.
            <br />
            Say something, or paste a screenshot.
          </p>
        ) : (
          realtime.chat.map((m) => {
            const mine = m.from.identity === me.identity;
            return (
              <div key={m.id} className="text-[13px]">
                <div className="flex items-baseline gap-1.5">
                  <span
                    className={`truncate text-[12px] font-semibold ${
                      m.from.role === "attendee" ? "text-ink" : "text-brand"
                    }`}
                  >
                    {mine ? "You" : m.from.name}
                  </span>
                  {m.from.role !== "attendee" && (
                    <span className="shrink-0 text-[10.5px] text-ink-3">
                      {m.from.role === "host" ? "Host" : "Panelist"}
                    </span>
                  )}
                  {/* Carried on the message rather than read from the current
                      setting, so switching it never rewrites what has already been
                      said. */}
                  {m.destination === "panelists" && (
                    <span className="shrink-0 rounded bg-warn-soft px-1.5 text-[10px] font-medium text-warn">
                      Panelists only
                    </span>
                  )}
                  <span className="ml-auto shrink-0 text-[10.5px] tabular-nums text-ink-3">
                    {new Date(m.at).toLocaleTimeString("en-GB", {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </span>
                </div>
                <MessageBody message={m} />
              </div>
            );
          })
        )}
      </div>

      <div className="shrink-0 border-t border-line p-2.5">
        {muted ? (
          <Alert tone="warn">The host has turned off chat for attendees.</Alert>
        ) : (
          <>
            {error && (
              <div className="mb-2">
                <Alert tone="error">{error}</Alert>
              </div>
            )}
            {note && !error && (
              <div className="mb-2">
                <Alert tone="warn">{note}</Alert>
              </div>
            )}

            {canChoose ? (
              // A publisher picks their own audience per message. Sending to the
              // panelists is addressed to the people already in that conversation,
              // so there is no boundary being crossed.
              <div className="mb-2 flex items-center gap-1 text-[11.5px]">
                <span className="text-ink-3">To</span>
                {(["everyone", "panelists"] as const).map((to) => (
                  <button
                    key={to}
                    type="button"
                    onClick={() => setStageTo(to)}
                    aria-pressed={stageTo === to}
                    className={`rounded-md px-2 py-0.5 font-medium transition-colors ${
                      stageTo === to
                        ? "bg-brand-soft text-brand"
                        : "text-ink-2 hover:bg-surface-2"
                    }`}
                  >
                    {to === "everyone" ? "Everyone" : "Panelists"}
                  </button>
                ))}
              </div>
            ) : (
              // Told, not asked. Saying who will read this before it is written is
              // the difference between a private question and an accident.
              <p className="mb-2 text-[11.5px] text-ink-3">
                {destination === "panelists"
                  ? "Your messages go to the host and panelists only."
                  : "Your messages are visible to everyone."}
              </p>
            )}

            <form
              onSubmit={(e) => {
                e.preventDefault();
                void send();
              }}
              className="flex items-end gap-2"
            >
              <textarea
                className="field max-h-28 min-h-9 flex-1 resize-none py-2 text-[13px]"
                rows={1}
                placeholder={
                  destination === "panelists"
                    ? "Message panelists…"
                    : "Message everyone…"
                }
                maxLength={MAX_CHARS}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                // Paste to upload. A screenshot arrives on the clipboard as a file with
                // no name, which is why the items are inspected rather than the text —
                // and it is the way people actually share one during a call.
                onPaste={(e) => {
                  const file = imageFromPaste(e.clipboardData);
                  if (!file) return;
                  e.preventDefault();
                  void sendImage(file);
                }}
                onKeyDown={(e) => {
                  // Enter sends, Shift+Enter breaks a line — the convention
                  // everyone already has muscle memory for.
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    void send();
                  }
                }}
                aria-label="Chat message"
              />

              <input
                ref={filePicker}
                type="file"
                accept="image/png,image/jpeg,image/webp"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  // Cleared so choosing the same file twice fires again.
                  e.target.value = "";
                  if (isSupportedImage(file)) void sendImage(file);
                }}
              />
              <button
                type="button"
                onClick={() => filePicker.current?.click()}
                disabled={uploading}
                aria-label="Send an image"
                title="Send an image — or just paste a screenshot"
                className="grid size-9 shrink-0 place-items-center rounded-lg text-ink-2 transition-colors hover:bg-surface-2 hover:text-ink disabled:opacity-40 outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
              >
                {uploading ? <Spinner className="size-4" /> : <ImageIcon className="size-4" />}
              </button>

              <button
                type="submit"
                disabled={!draft.trim() || sending}
                aria-label="Send message"
                className="grid size-9 shrink-0 place-items-center rounded-lg bg-brand text-white transition-colors hover:bg-brand-hover disabled:opacity-40 outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
              >
                {sending ? <Spinner className="size-4" /> : <SendIcon className="size-4" />}
              </button>
            </form>
          </>
        )}
      </div>
    </div>
  );
}

/* One message's content: an image, some text, or both.
 *
 * The text is split into plain runs and link runs and rendered as React children — no
 * HTML is constructed, so there is no sanitiser to get wrong. See lib/chat-text.ts for
 * why emphasis is not supported and why only http and https become links.
 */
function MessageBody({ message }: { message: ChatMessage }) {
  return (
    <>
      {message.media && (
        // Sized from the stored dimensions so the panel reserves the right space before
        // the bytes arrive. A chat log that reflows as each thumbnail loads is a chat log
        // that jumps under the cursor while you are reading it.
        <a
          href={message.media.url}
          target="_blank"
          rel="noreferrer noopener"
          className="mt-1 block w-fit max-w-full overflow-hidden rounded-lg border border-line outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
          title="Open full size"
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={message.media.url}
            alt={`Image from ${message.from.name}`}
            width={message.media.width || undefined}
            height={message.media.height || undefined}
            loading="lazy"
            decoding="async"
            className="block h-auto max-h-64 w-auto max-w-full object-contain"
          />
        </a>
      )}

      {message.text && (
        // wrap-anywhere so a pasted URL cannot widen the panel and push the layout
        // sideways.
        <p className="mt-0.5 leading-relaxed break-words wrap-anywhere text-ink-2">
          {textRuns(message.text).map((run, i) =>
            "href" in run ? (
              <a
                key={i}
                href={run.href}
                target="_blank"
                // noreferrer as well as noopener: the target should not learn which
                // session somebody was in from the referrer.
                rel="noreferrer noopener nofollow"
                className="text-brand underline decoration-brand/40 underline-offset-2 hover:decoration-brand"
              >
                {run.text}
              </a>
            ) : (
              <span key={i}>{run.text}</span>
            ),
          )}
        </p>
      )}
    </>
  );
}
