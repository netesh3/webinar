"use client";

import { useLocalParticipant } from "@livekit/components-react";
import { useEffect, useRef, useState } from "react";
import {
  coalesce,
  freshMessages,
  playChatCue,
  requestChatFocus,
  useChatSound,
  type ChatPreview,
} from "@/lib/chat-notify";
import { useCompact } from "@/lib/compact";
import { ChatIcon, CloseIcon } from "../icons";
import { useRoomUI } from "./context";

/* The chat preview card.
 *
 * A closed panel used to yield a number and nothing else, which is enough to know that
 * chat is happening and not enough to know whether it is worth opening — so a host
 * presenting kept either ignoring it or breaking off to check. This says who and what,
 * once, and gets out of the way.
 *
 * Where it sits is deliberate. On a desktop, top-right of the stage, immediately
 * left of the engagement rail — that is where the Chat button and its badge are.
 * The bottom-right corner would have been the obvious home and is already taken
 * twice over — the app's own toast stack is anchored there (lifted above the
 * control bar by globals.css) and the poll pop-up claims the same corner, so a
 * card there would land on top of one or the other exactly when the room is
 * busiest.
 *
 * On a phone there is no rail. The speaker fills the middle of the stage and the
 * control bar sits under it, so the card moves to the top edge of the stage:
 * above the face, still inside the stage (which is why it cannot cover the bar),
 * and a tap calls the same `tools.open("chat")` the More sheet uses.
 *
 * The logic — what counts as new, and how a burst becomes one card — is in
 * lib/chat-notify.ts, where it is tested. This is the wiring and the timers.
 */

/** How long a card stays before it withdraws. Longer than an ordinary toast because this
 *  one is worth clicking, and a card that vanishes as the cursor arrives is a card that
 *  trains people to ignore it. */
const CARD_MS = 6000;

export function ChatNotifications({
  /** The room's own answer to "is chat in front of them" — the docked tab, or a popped-out
   *  window that is not minimised. Passed in rather than recomputed so there is one
   *  definition of it and the badge and the card can never disagree. */
  chatVisible,
}: {
  chatVisible: boolean;
}) {
  const { realtime, me, tools, fileShare } = useRoomUI();
  const { isScreenShareEnabled } = useLocalParticipant();
  const { enabled: soundEnabled } = useChatSound();
  const compact = useCompact();

  const [preview, setPreview] = useState<ChatPreview | null>(null);

  /* Messages already turned into a card, and the moment this browser arrived.
   *
   * Both are refs because the arrival effect below must depend on the conversation and
   * nothing else. Made lazily rather than at mount so `joinedAt` is the first render of a
   * live room rather than a value React might discard. */
  const accounted = useRef<Set<string> | null>(null);
  const joinedAt = useRef(0);

  /* Everything the effect reads that is not the conversation, kept current in an effect
   * of its own.
   *
   * These are conditions at the instant a message lands, not reasons to re-examine the
   * conversation: listing them as dependencies would re-run the arrival effect when a
   * screen share started, and a run that has already accounted for every message
   * announces nothing — but the one where it matters is `chatVisible`, where re-running
   * on close would card the whole conversation the person just finished reading. */
  const conditions = useRef({
    chatVisible,
    soundEnabled,
    sharing: false,
    identity: me.identity,
  });
  useEffect(() => {
    conditions.current = {
      chatVisible,
      soundEnabled,
      // A shared screen usually publishes its audio, so a blip here is a blip the whole
      // audience hears. Suppressed for the person sharing rather than for everyone —
      // theirs is the machine making the noise.
      sharing: isScreenShareEnabled || fileShare.active,
      identity: me.identity,
    };
  }, [chatVisible, soundEnabled, isScreenShareEnabled, fileShare.active, me.identity]);

  useEffect(() => {
    if (accounted.current === null) {
      // The conversation as it already stood. A history fetch resolves a moment from now
      // and lands in the middle of this list; `joinedAt` is what keeps that from being
      // read as twenty people talking at once. See freshMessages.
      accounted.current = new Set(realtime.chat.map((m) => m.id));
      joinedAt.current = Date.now();
      return;
    }

    const fresh = freshMessages(
      realtime.chat,
      accounted.current,
      conditions.current.identity,
      joinedAt.current,
    );
    if (fresh.length === 0) return;
    for (const message of fresh) accounted.current.add(message.id);

    // Nothing to notify about something they are looking at. Accounted for first, so
    // closing the panel afterwards does not card the backlog they have just read.
    if (conditions.current.chatVisible) return;

    setPreview((current) => coalesce(current, fresh));
    if (conditions.current.soundEnabled && !conditions.current.sharing) playChatCue();
  }, [realtime.chat]);

  /* Opening chat answers the card, so the card goes.
   *
   * Adjusted during render rather than in an effect — the same pattern, and the same
   * reason, as the unread watermark in webinar-room.tsx: an effect paints the card one
   * more frame before clearing it, so opening the panel would flash the notification for
   * the thing you just opened it to read. React re-runs this immediately and discards the
   * intermediate result. */
  if (chatVisible && preview) setPreview(null);

  /* The withdrawal timer, keyed on the card itself.
   *
   * `coalesce` returns a new object for every arrival, so a run of messages keeps
   * restarting this — which is what makes a busy minute one card that stays for six
   * seconds after the last of it, rather than one that expires mid-conversation. */
  useEffect(() => {
    if (!preview) return;
    const timer = setTimeout(() => setPreview(null), CARD_MS);
    return () => clearTimeout(timer);
  }, [preview]);

  if (!preview) return null;

  const many = preview.count > 1;

  /* Desktop: just under the overlay header, on the right of the stage. Compact:
   * below the title pill so it cannot cover the (i) or Views control. The
   * control bar is a sibling of the stage, so a card inside the stage cannot
   * land on Leave. */
  return (
    <div
      className={
        compact
          ? "pointer-events-none absolute top-14 right-2 left-2 z-40 flex justify-center"
          : "pointer-events-none absolute top-14 right-2 z-40 flex justify-end"
      }
    >
      <div
        role="status"
        className="room-dark pointer-events-auto flex w-full max-w-md items-stretch gap-0.5 rounded-xl border border-line bg-surface/95 p-1 shadow-xl backdrop-blur md:w-[17.5rem] md:max-w-[calc(100vw-1.5rem)]"
      >
        <button
          type="button"
          onClick={() => {
            const anchor = preview.anchorId;
            setPreview(null);
            tools.open("chat");
            // After open(), so the panel is mounting in this same commit and picks the
            // request up on its first render. See useChatFocus.
            requestChatFocus(anchor);
          }}
          className="flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-surface-2 outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
        >
          <ChatIcon className="size-4 shrink-0 text-brand" />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[12.5px] font-semibold text-ink">
              {many ? `${preview.count} new messages` : preview.sender}
            </span>
            {/* Clamped rather than truncated: two lines of a real sentence is what makes
                this worth glancing at, and the text is already cut to a preview length. */}
            <span className="mt-0.5 line-clamp-2 block text-[12px] leading-snug text-ink-2">
              {many ? `${preview.sender}: ${preview.text}` : preview.text}
            </span>
          </span>
        </button>
        <button
          type="button"
          onClick={() => setPreview(null)}
          aria-label="Dismiss chat notification"
          className="grid size-11 shrink-0 place-items-center rounded-lg text-ink-3 transition-colors hover:bg-surface-2 hover:text-ink outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
        >
          <CloseIcon className="size-3.5" />
        </button>
      </div>
    </div>
  );
}
