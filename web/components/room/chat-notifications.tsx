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
import { coalesceMentions, mentionHeadline, type MentionPreview } from "@/lib/mentions";
import { CloseIcon } from "../icons";
import { SenderAvatar } from "../sender-avatar";
import { RoleBadge } from "./chat-badges";
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
 *
 * A message that @mentions this person gets a card of its own ("Alex mentioned you"),
 * which outranks the ordinary one: it replaces it, ordinary chatter does not bump it,
 * and it stays twice as long. Its rules differ from the ordinary card's in two places,
 * both deliberately narrow:
 *
 *   - It sounds a cue of its own, which is not swallowed by an ordinary cue a second
 *     earlier — and it sounds even with the chat open if this tab is in the
 *     background, because a panel nobody is looking at is not "in front of them".
 *   - Everything else still holds: no card for a panel that is in front of you (the
 *     line is highlighted there, and the catch-up pill says it mentions you), the
 *     sound preference is respected, and nothing plays while you share your screen.
 *
 * Mention logic is in lib/mentions.ts, next to the rest of it, and tested there.
 */

/** How long a card stays before it withdraws. Longer than an ordinary toast because this
 *  one is worth clicking, and a card that vanishes as the cursor arrives is a card that
 *  trains people to ignore it. */
const CARD_MS = 6000;
/** A mention is addressed to you by name, so it waits longer for you to look up. */
const MENTION_CARD_MS = 12000;

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
  const [mention, setMention] = useState<MentionPreview | null>(null);

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

    const { chatVisible, soundEnabled, sharing, identity } = conditions.current;
    const mentioned = coalesceMentions(null, fresh, identity) !== null;
    const audible = soundEnabled && !sharing;

    // Nothing to notify about something they are looking at. Accounted for first, so
    // closing the panel afterwards does not card the backlog they have just read. A
    // mention still sounds if the whole tab is behind another one.
    if (chatVisible) {
      if (mentioned && audible && document.visibilityState === "hidden") playChatCue("mention");
      return;
    }

    if (mentioned) {
      setMention((current) => coalesceMentions(current, fresh, identity));
      // The mention card says more than the ordinary one would; two cards about one
      // arrival is one too many.
      setPreview(null);
      if (audible) playChatCue("mention");
      return;
    }
    setPreview((current) => coalesce(current, fresh));
    if (audible) playChatCue();
  }, [realtime.chat]);

  /* Opening chat answers the card, so the card goes.
   *
   * Adjusted during render rather than in an effect — the same pattern, and the same
   * reason, as the unread watermark in webinar-room.tsx: an effect paints the card one
   * more frame before clearing it, so opening the panel would flash the notification for
   * the thing you just opened it to read. React re-runs this immediately and discards the
   * intermediate result. */
  if (chatVisible && preview) setPreview(null);
  if (chatVisible && mention) setMention(null);

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

  useEffect(() => {
    if (!mention) return;
    const timer = setTimeout(() => setMention(null), MENTION_CARD_MS);
    return () => clearTimeout(timer);
  }, [mention]);

  if (mention) {
    return (
      <Card
        compact={compact}
        label="Mention notification"
        onOpen={() => {
          const anchor = mention.anchorId;
          setMention(null);
          setPreview(null);
          tools.open("chat");
          requestChatFocus(anchor);
        }}
        onDismiss={() => {
          setMention(null);
          setPreview(null);
        }}
        mention
      >
        <span className="relative shrink-0">
          <SenderAvatar
            name={mention.sender}
            identity={mention.senderIdentity}
            size="lg"
            ring={mention.senderRole !== "attendee"}
          />
          <span
            aria-hidden
            className="absolute -right-1 -bottom-[3px] grid size-4 place-items-center rounded-full bg-brand text-[10px] leading-none font-bold text-stage ring-2 ring-surface"
          >
            @
          </span>
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-1.5 text-[12.5px] font-semibold text-ink">
            {/* No role pill: the headline is the point, and the avatar's ring already
                says the sender is on the stage. */}
            <span className="truncate">{mentionHeadline(mention)}</span>
          </span>
          <span className="mt-0.5 line-clamp-2 block text-[12px] leading-snug text-ink-2">
            {mention.count > 1 && (
              <span className="font-semibold text-ink">{mention.sender}: </span>
            )}
            {mention.text}
          </span>
        </span>
      </Card>
    );
  }

  if (!preview) return null;

  const many = preview.count > 1;

  return (
    <Card
      compact={compact}
      label="Chat notification"
      onOpen={() => {
        const anchor = preview.anchorId;
        setPreview(null);
        tools.open("chat");
        // After open(), so the panel is mounting in this same commit and picks the
        // request up on its first render. See useChatFocus.
        requestChatFocus(anchor);
      }}
      onDismiss={() => setPreview(null)}
    >
      <span className="relative shrink-0">
        <SenderAvatar
          name={preview.sender}
          identity={preview.senderIdentity}
          size="lg"
          ring={preview.senderRole !== "attendee"}
        />
        {many && (
          <span
            aria-hidden
            className="absolute -right-1 -bottom-[3px] grid h-4 min-w-4 place-items-center rounded-full bg-brand px-1 text-[9.5px] font-bold text-stage tabular-nums ring-2 ring-surface"
          >
            {preview.count > 99 ? "99+" : preview.count}
          </span>
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-1.5 text-[12.5px] font-semibold text-ink">
          <span className="truncate">
            {many ? `${preview.count} new messages` : preview.sender}
          </span>
          {!many && preview.senderRole !== "attendee" && (
            <RoleBadge role={preview.senderRole} />
          )}
        </span>
        {/* Clamped rather than truncated: two lines of a real sentence is what makes
            this worth glancing at, and the text is already cut to a preview length. */}
        <span className="mt-0.5 line-clamp-2 block text-[12px] leading-snug text-ink-2">
          {many ? (
            <>
              <span className="font-semibold text-ink">{preview.sender}:</span>{" "}
              {preview.text}
            </>
          ) : (
            preview.text
          )}
        </span>
      </span>
    </Card>
  );
}

/* The card's frame: where it sits, the open button, and dismiss.
 *
 * Desktop: just under the overlay header, on the right of the stage. Compact: below the
 * title pill so it cannot cover the (i) or Views control. The control bar is a sibling
 * of the stage, so a card inside the stage cannot land on Leave.
 *
 * A mention card carries a brand accent bar down its left edge — the same mark a
 * message that mentions you carries in the panel, so the two read as one thing. */
function Card({
  compact,
  label,
  mention = false,
  onOpen,
  onDismiss,
  children,
}: {
  compact: boolean;
  label: string;
  mention?: boolean;
  onOpen: () => void;
  onDismiss: () => void;
  children: React.ReactNode;
}) {
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
        className={`room-dark pointer-events-auto flex w-full max-w-md items-stretch gap-0.5 rounded-xl border bg-surface/95 p-1 shadow-xl backdrop-blur md:w-[17.5rem] md:max-w-[calc(100vw-1.5rem)] ${
          mention ? "border-brand/50 shadow-[inset_3px_0_0_var(--color-brand)]" : "border-line"
        }`}
      >
        <button
          type="button"
          onClick={onOpen}
          className="flex min-h-11 min-w-0 flex-1 items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-surface-2 outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
        >
          {children}
        </button>
        <button
          type="button"
          onClick={onDismiss}
          aria-label={`Dismiss ${label.toLowerCase()}`}
          className="grid size-11 shrink-0 place-items-center rounded-lg text-ink-3 transition-colors hover:bg-surface-2 hover:text-ink outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
        >
          <CloseIcon className="size-3.5" />
        </button>
      </div>
    </div>
  );
}
