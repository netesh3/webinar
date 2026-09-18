"use client";

import { RoomEvent, type Participant, type Room } from "livekit-client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  ChatMessage as ApiChatMessage,
  Role,
  RoomMeta,
  SendMessageRequest,
  SendMessageResponse,
  SessionControls,
} from "./api-types";

/* Chat, Q&A, raised hands and reactions, carried on the WebRTC data channel.
 *
 * There are two ways OUT of this file and one way in.
 *
 * The stage — the host and the panelists — publishes on the data channel directly.
 * The audience cannot: attendee tokens carry canPublishData=false and the SFU drops
 * anything they try to publish, so their messages go through `relay`, which POSTs to
 * our API. The server then stamps the sender, applies the host's chat destination and
 * hands the SFU the recipient list. That is what makes "panelists only" a rule rather
 * than a request: an attendee's browser never gets to name its own audience, and a
 * message addressed to the stage is never sent to the other attendees at all.
 *
 * Two constraints shape the wire format:
 *
 * 1. The sender's name travels IN the payload. When the host hides the audience,
 *    the SFU stops sending those participant records to other clients, so a
 *    receiver looking up `participant.name` would find nothing. Carrying the
 *    name means a hidden attendee's message still reads as theirs. It is also why
 *    the server has to fill it in for a relayed message.
 *
 * 2. Everything arriving here is untrusted. It comes from another browser, so
 *    every field is validated and every string is clamped before it reaches
 *    React. `decode` is the only way messages enter the app.
 */

export const DATA_TOPIC = "webcast";

const MAX_CHAT_CHARS = 2000;
const MAX_QUESTION_CHARS = 600;
const MAX_NAME_CHARS = 80;
/** Keeps a long session from growing an unbounded array in every tab. */
const MAX_CHAT_HISTORY = 500;
const MAX_QUESTIONS = 300;

/* Reactions: one tap, one or two emoji.
 *
 * One tap is still one message on the wire — every client draws its own copy, so
 * fanning out extra packets to do this would be the wrong trade. Drawing exactly
 * one every time reads as mechanical; a burst of five to ten copies of the same
 * emoji is what makes a single tap look like it landed with some weight behind it.
 *
 * The cap matters more than any one tap. Five hundred people applauding at the end of
 * a talk is the moment this feature is for and also the moment it could put ten
 * thousand animated spans on the stage, so the oldest are dropped once the screen is
 * already full of them — nobody can tell, and the tab stays alive. */

/** One tap draws a random count in this range, chosen fresh each time. */
const REACTION_COPIES_MIN = 5;
const REACTION_COPIES_MAX = 10;
/** How long one emoji takes to cross the stage, before per-emoji variation. */
const REACTION_MS = 4200;
const MAX_FLOATING = 240;

export type Sender = {
  identity: string;
  name: string;
  role: Role;
};

/** One message handed to the API for delivery. The credential and the slug are
 *  the relay's own business, so neither is here. */
export type RelayRequest = Omit<SendMessageRequest, "joinKey">;

/** An attendee's way out. Rejects with an ApiError when the server refuses — chat
 *  turned off, no panelists connected, too many messages — which is what the
 *  composer shows. */
export type Relay = (req: RelayRequest) => Promise<SendMessageResponse>;


/** The audience for a chat message.
 *
 *  The narrow form of the generated `ChatDestination`, which tygo emits as a bare
 *  `string` the same way it does for Role and WebinarStatus. Use `chatDestination`
 *  to cross from one to the other, so an unexpected value from the wire becomes
 *  "everyone" at a single known point rather than flowing into the UI as a label
 *  nobody wrote. */
export type ChatDestination = "everyone" | "panelists";

/** Narrows a destination arriving from the API or from another browser. */
export function chatDestination(value: string | undefined | null): ChatDestination {
  return value === "panelists" ? "panelists" : "everyone";
}

export type ChatMessage = {
  kind: "chat";
  id: string;
  from: Sender;
  /** Where this message was sent. Per-message, so the host changing the setting
   *  never rewrites what has already been said. */
  destination: ChatDestination;
  text: string;
  at: number;
  /** The transcript's total order, and the sync cursor. A reconnecting client asks the
   *  server for everything after the highest one it holds. */
  seq: number;
  /** An image, when the message is one. A path on our own API — see handleChatMedia. */
  media?: { url: string; mime: string; width: number; height: number };
};

export type QuestionMessage = {
  kind: "question";
  id: string;
  from: Sender;
  text: string;
  anonymous: boolean;
  at: number;
};

type UpvoteMessage = { kind: "upvote"; questionId: string; from: Sender };
type AnsweredMessage = { kind: "answered"; questionId: string };
type HandMessage = { kind: "hand"; from: Sender; raised: boolean };
type ReactionMessage = { kind: "reaction"; from: Sender; emoji: string };

/* The host answering a raised hand.
 *
 * Broadcast rather than sent to the one person, for two reasons: every host and
 * panelist is looking at the same queue and all of them should see it clear, and
 * the person who raised their hand needs their own button to reset — otherwise
 * they are still holding their hand up in a queue they have already left.
 *
 * `reason` decides whether they hear about it. Being granted the microphone
 * announces itself; being passed over is worth one quiet line rather than
 * silence, which reads as the host not having noticed. */
type LowerHandMessage = {
  kind: "lower-hand";
  from: Sender;
  identity: string;
  reason: "granted" | "dismissed";
};

/* "Re-read the polls."
 *
 * Sent only by the SERVER, on a host opening, closing or deleting one. It carries no
 * payload on purpose: the host's copy of a poll contains the tally and the correct
 * answers and the audience's does not, so putting a poll in the packet would mean
 * broadcasting one of those to a room containing both. Every client re-reads its own
 * endpoint instead.
 *
 * There is no sender to validate, because no client is allowed to send it. A packet
 * published by a participant cannot reach here as this kind and be believed —
 * attendees hold no data-publish grant at all, and a panelist forging one would only
 * make other clients re-read a list they are already entitled to. */
type PollsChangedMessage = { kind: "polls-changed" };

/* "Someone from the audience just joined."
 *
 * Sent only by the SERVER, addressed to the host alone (see announceAttendeeJoined
 * in join.go) — not broadcast to the room, the way the join itself is not something
 * the audience needs to hear about one another. A host's own client never receives
 * this for anyone but the audience: the host and panelists connecting are visible
 * on screen the moment they do, so there is nothing this would add for them. */
type AttendeeJoinedMessage = { kind: "joined"; from: Sender };

/* The host clearing the whole queue at once.
 *
 * One packet rather than one per raised hand. A well-attended session can have fifty
 * hands up when the host decides to move on, and fifty reliable data packets to five
 * hundred people is a burst worth not sending when a single message says the same
 * thing.
 *
 * Nobody is told individually. A per-person "your hand was lowered" toast is right
 * when the host passed over one person; fanning it out to everyone whose hand was up
 * turns clearing the queue into a notification storm. Their own button going back to
 * "Raise hand" is the feedback that matters. */
type HandsClearedMessage = { kind: "hands-cleared"; from: Sender };

/* "The host would like you to unmute."
 *
 * A request rather than an action, because a server cannot start somebody's
 * microphone — only their own browser can, and only after they allow it. The host
 * can mute anyone from the server, and un-mute a track that already exists, but
 * a participant who has never opened a microphone can only be asked. */
type UnmuteRequestMessage = { kind: "unmute-request"; from: Sender };

/* "That message is gone — remove it from the conversation."
 *
 * Sent only by the SERVER (see chatDeletedKind in api/internal/api/say.go), the
 * moment a host, co-host or panelist deletes an attendee's message — never
 * something a client can claim happened itself; buildPacket's own switch in
 * say.go has no case that lets a request name this kind, host or attendee alike.
 * Carries only the id: the room already has the message, there is nothing else
 * to say about it, and the deleted text has no business surviving in anyone's
 * memory once it is gone from the transcript. */
type ChatDeletedMessage = { kind: "chat-deleted"; id: string };

export type RoomMessage =
  | ChatMessage
  | QuestionMessage
  | UpvoteMessage
  | AnsweredMessage
  | HandMessage
  | LowerHandMessage
  | HandsClearedMessage
  | PollsChangedMessage
  | ReactionMessage
  | UnmuteRequestMessage
  | AttendeeJoinedMessage
  | ChatDeletedMessage;

/** The reactions a client may send. Anything else is dropped on receipt, so one
 *  patched client cannot push arbitrary strings into everyone's UI. */
export const REACTIONS = ["👏", "👍", "❤️", "😂", "🎉", "😮"] as const;
export type Reaction = (typeof REACTIONS)[number];

export type Question = QuestionMessage & {
  votes: number;
  answered: boolean;
  votedByMe: boolean;
};

/** One emoji in flight, from one tap. Randomised so a stream of taps doesn't look
 *  like copies of one thing: each crosses at a different speed, sways differently
 *  and is not the same size as the last.
 *
 *  Deliberately no name, initials or identity. A reaction says the room is with you,
 *  not who in it. */
export type FloatingReaction = {
  id: string;
  emoji: string;
  /** 0..1 across the stage width. */
  offset: number;
  /** Milliseconds to cross. */
  duration: number;
  /** Signed horizontal sway, in pixels. */
  drift: number;
  /** Rendered size, in pixels. */
  size: number;
};

export type RaisedHand = { identity: string; name: string; at: number };

// ------------------------------------------------------------------ encoding

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function encode(msg: RoomMessage): Uint8Array<ArrayBuffer> {
  // TextEncoder is specified to allocate a plain ArrayBuffer. The wider
  // ArrayBufferLike in the lib types exists for the SharedArrayBuffer case, which
  // encode() cannot produce, so narrowing it for publishData is safe.
  return encoder.encode(JSON.stringify(msg)) as Uint8Array<ArrayBuffer>;
}

function str(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, max);
}

function sender(value: unknown): Sender | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as Record<string, unknown>;
  const identity = str(raw.identity, 200);
  if (!identity) return null;
  return {
    identity,
    name: str(raw.name, MAX_NAME_CHARS) ?? "Guest",
    role: raw.role === "host" || raw.role === "panelist" ? raw.role : "attendee",
  };
}

/** The trust boundary. Returns null for anything that isn't a message this app
 *  understands, rather than letting a partial object into state. */
function decode(bytes: Uint8Array): RoomMessage | null {
  let raw: unknown;
  try {
    raw = JSON.parse(decoder.decode(bytes));
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;
  const msg = raw as Record<string, unknown>;

  switch (msg.kind) {
    case "chat": {
      const from = sender(msg.from);
      // An image message carries no text, so `text` alone can no longer decide whether
      // this is a message worth keeping.
      const text = str(msg.text, MAX_CHAT_CHARS) ?? "";
      const id = str(msg.id, 64);
      const mediaUrl = typeof msg.mediaUrl === "string" ? msg.mediaUrl : "";
      if (!from || !id || (!text && !mediaUrl)) return null;
      return {
        kind: "chat",
        id,
        from,
        destination: chatDestination(msg.destination as string | undefined),
        text,
        seq: typeof msg.seq === "number" ? msg.seq : 0,
        // Only a path on our own origin is accepted. This URL ends up in an <img src>
        // and the packet came from the SFU, so an absolute one — http:, data:,
        // javascript: — would be a load on behalf of whoever sent it.
        ...(mediaUrl.startsWith("/api/")
          ? {
              media: {
                url: mediaUrl,
                mime: typeof msg.mediaMime === "string" ? msg.mediaMime : "image/png",
                width: typeof msg.mediaWidth === "number" ? msg.mediaWidth : 0,
                height: typeof msg.mediaHeight === "number" ? msg.mediaHeight : 0,
              },
            }
          : {}),
        // Never trust a remote clock: a browser with a wrong time would sort
        // itself to the top or bottom of everyone's chat forever.
        at: Date.now(),
      };
    }
    case "question": {
      const from = sender(msg.from);
      const text = str(msg.text, MAX_QUESTION_CHARS);
      const id = str(msg.id, 64);
      if (!from || !text || !id) return null;
      return {
        kind: "question",
        id,
        from,
        text,
        anonymous: msg.anonymous === true,
        at: Date.now(),
      };
    }
    case "upvote": {
      const from = sender(msg.from);
      const questionId = str(msg.questionId, 64);
      if (!from || !questionId) return null;
      return { kind: "upvote", questionId, from };
    }
    case "answered": {
      const questionId = str(msg.questionId, 64);
      if (!questionId) return null;
      return { kind: "answered", questionId };
    }
    case "hand": {
      const from = sender(msg.from);
      if (!from) return null;
      return { kind: "hand", from, raised: msg.raised === true };
    }
    case "lower-hand": {
      const from = sender(msg.from);
      const identity = str(msg.identity, 200);
      // Only the stage may clear the queue. Without this check any attendee could
      // lower everyone else's hand.
      if (!from || from.role === "attendee" || !identity) return null;
      return {
        kind: "lower-hand",
        from,
        identity,
        reason: msg.reason === "granted" ? "granted" : "dismissed",
      };
    }
    case "polls-changed":
      return { kind: "polls-changed" };
    case "hands-cleared": {
      const from = sender(msg.from);
      // Only the stage may clear the queue, the same rule as lower-hand. Without
      // this check any attendee could wipe everyone's raised hand.
      if (!from || from.role === "attendee") return null;
      return { kind: "hands-cleared", from };
    }
    case "reaction": {
      const from = sender(msg.from);
      const emoji = typeof msg.emoji === "string" ? msg.emoji : "";
      if (!from || !(REACTIONS as readonly string[]).includes(emoji)) return null;
      return { kind: "reaction", from, emoji };
    }
    case "unmute-request": {
      const from = sender(msg.from);
      // Only the stage may ask. Without this check any attendee could spam the
      // room with prompts that look like they came from the host.
      if (!from || from.role === "attendee") return null;
      return { kind: "unmute-request", from };
    }
    case "joined": {
      const from = sender(msg.from);
      if (!from) return null;
      return { kind: "joined", from };
    }
    case "chat-deleted": {
      const id = str(msg.id, 64);
      if (!id) return null;
      return { kind: "chat-deleted", id };
    }
    default:
      return null;
  }
}

/* Merges messages into a conversation, once each, in order.
 *
 * De-duplicating by id is what makes the reconnect sync safe: a client cannot advance
 * its cursor and drain the socket in the same instant, so the overlap is expected rather
 * than a bug to be avoided. Later copies win, because the server's is more complete than
 * anything a client guessed.
 *
 * Ordered by seq where there is one and by arrival otherwise: a live message is applied
 * before its sequence is known only for the kinds that have none, and sorting a mixture
 * on `at` alone would let a clock skew reorder somebody's sentence.
 */
function mergeChat(current: ChatMessage[], incoming: ChatMessage[]): ChatMessage[] {
  if (incoming.length === 0) return current;
  const byId = new Map(current.map((m) => [m.id, m]));
  for (const msg of incoming) byId.set(msg.id, msg);

  const merged = [...byId.values()];
  merged.sort((a, b) => (a.seq && b.seq ? a.seq - b.seq : a.at - b.at));
  return merged.slice(-MAX_CHAT_HISTORY);
}

/* Turns a fetched transcript into messages the app will accept.
 *
 * Routed through the same `decode` the data channel uses, deliberately. The backlog
 * arrives over HTTPS from our own API and is therefore more trustworthy than a packet
 * from another browser — but "more trustworthy" is not a reason to have two ways in. One
 * validator means one place where a field is clamped and one place to change when the
 * shape does; two means the second one is the one that gets forgotten.
 */
export function decodeBacklog(messages: ApiChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const m of messages) {
    const decoded = decode(
      encoder.encode(
        JSON.stringify({
          kind: "chat",
          id: m.id,
          seq: m.seq,
          from: { identity: m.senderId, name: m.senderName, role: m.senderRole },
          text: m.message,
          destination: m.destination,
          mediaUrl: m.mediaUrl,
          mediaMime: m.mediaMime,
          mediaWidth: m.mediaWidth,
          mediaHeight: m.mediaHeight,
        }),
      ),
    );
    // The stored timestamp, not the moment it was fetched. `decode` stamps arrival,
    // which is right for a live packet and wrong for history — without this, a
    // reconnect would date the whole conversation to the reconnect.
    if (decoded?.kind === "chat") {
      const at = Date.parse(m.timestamp);
      out.push({ ...decoded, at: Number.isNaN(at) ? decoded.at : at });
    }
  }
  return out;
}

function newId(): string {
  // crypto.randomUUID needs a secure context, which is exactly where WebRTC
  // works anyway — but the fallback keeps an http:// dev origin usable.
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

// -------------------------------------------------------------- room metadata

/** Reads the session controls the API mirrors into LiveKit room metadata.
 *
 *  This is how one host action reaches every browser: the SFU pushes metadata
 *  down the signalling connection each client already holds, so a toggle applies
 *  in well under a second with no polling. `fallback` is the state from the join
 *  response, used until the first metadata event lands. */
export function useSessionControls(
  room: Room | null,
  fallback: SessionControls,
  joinMaxDurationMin?: number,
): {
  controls: SessionControls;
  topic: string | null;
  status: string | null;
  /** When the host took the session live (RFC3339), from room metadata once
   *  connected. Null until metadata arrives or if the stamp is absent. */
  startedAt: string | null;
  /** When the host ended the session (RFC3339). Present so the elapsed clock
   *  can freeze on the final duration. */
  endedAt: string | null;
  /** Whether the session is being recorded. From the server, not from whoever
   *  pressed the button, so every browser in the room agrees. */
  recording: boolean;
  /** The maximum meeting duration in minutes for this session. */
  maxDurationMin: number | null;
} {
  const [meta, setMeta] = useState<RoomMeta | null>(null);

  useEffect(() => {
    if (!room) return;

    const read = () => {
      if (!room.metadata) return;
      try {
        const parsed = JSON.parse(room.metadata) as RoomMeta;
        if (parsed && typeof parsed === "object" && parsed.controls) {
          setMeta(parsed);
        }
      } catch {
        // Metadata we did not write, or a partial write. Keep the last good one.
      }
    };

    read();
    room.on(RoomEvent.RoomMetadataChanged, read);
    room.on(RoomEvent.Connected, read);
    return () => {
      room.off(RoomEvent.RoomMetadataChanged, read);
      room.off(RoomEvent.Connected, read);
    };
  }, [room]);

  return useMemo(
    () => ({
      controls: meta?.controls ?? fallback,
      topic: meta?.topic ?? null,
      status: meta?.status ?? null,
      startedAt: meta?.startedAt || null,
      endedAt: meta?.endedAt || null,
      recording: meta?.recording === true,
      maxDurationMin: meta?.maxDurationMin ?? joinMaxDurationMin ?? null,
    }),
    [meta, fallback, joinMaxDurationMin],
  );
}

// -------------------------------------------------------------------- the hook

export type Realtime = {
  chat: ChatMessage[];
  questions: Question[];
  hands: RaisedHand[];
  reactions: FloatingReaction[];
  myHandRaised: boolean;
  /** Sends a chat message.
   *
   *  `destination` is honoured for the stage and IGNORED for an attendee — the
   *  server overwrites it with the host's setting. Pass the current setting anyway
   *  so nothing has to special-case the caller. Rejects with the API's error when
   *  the server refuses, which is how "No panelists are currently available."
   *  reaches the composer. */
  sendChat: (
    text: string,
    destination: ChatDestination,
  ) => Promise<{ delivered: boolean } | undefined>;
  askQuestion: (text: string, anonymous: boolean) => Promise<void>;
  upvote: (questionId: string) => Promise<void>;
  markAnswered: (questionId: string) => Promise<void>;
  toggleHand: () => Promise<void>;
  /** Host-side: takes one person out of the queue. `granted` when they are being
   *  given the microphone, `dismissed` when they are being passed over. */
  lowerHand: (identity: string, reason?: "granted" | "dismissed") => Promise<void>;
  /** Host-side: empties the queue in one message. */
  clearHands: () => Promise<void>;
  /** Bumped when the server says the polls changed. A dependency to re-read on,
   *  not the polls themselves — see PollsChangedMessage. */
  pollsRevision: number;
  /** Merges a history batch into the conversation, de-duplicating by id. */
  mergeBacklog: (messages: ChatMessage[]) => void;
  /** The highest sequence this client holds, which is what it asks the server for
   *  "everything after". Zero before anything has arrived. */
  chatCursor: number;
  react: (emoji: Reaction) => Promise<void>;
  /** Asks one participant to unmute themselves. Addressed to them alone. */
  askToUnmute: (identity: string) => Promise<void>;
};

/**
 * useRealtime owns every data-channel feature for one session.
 *
 * `me` identifies the local participant for outgoing messages; it also lets the
 * receive path recognise its own echo. LiveKit does not loop a published packet
 * back to the sender, so outgoing messages are applied optimistically.
 */
export function useRealtime(
  room: Room | null,
  me: Sender,
  /** The fallback route for a participant the SFU will not accept data from. Null
   *  means there is no fallback and such a participant simply cannot send. */
  relay: Relay | null,
  handlers?: {
    onUnmuteRequested?: (from: Sender) => void;
    /** Fires on each hand going up, so the host is told rather than left to
     *  notice a badge. Only a real message triggers it. */
    onHandRaised?: (from: Sender) => void;
    /** Fires on the local participant's own hand being lowered by the host. */
    onHandLowered?: (reason: "granted" | "dismissed") => void;
    /** Fires when an attendee joins. Only ever delivered to the host — see
     *  AttendeeJoinedMessage — so a caller need not check the role itself. */
    onAttendeeJoined?: (from: Sender) => void;
  },
): Realtime {
  const [chat, setChat] = useState<ChatMessage[]>([]);
  const [rawQuestions, setRawQuestions] = useState<QuestionMessage[]>([]);
  const [votes, setVotes] = useState<Record<string, Set<string>>>({});
  const [answered, setAnswered] = useState<Set<string>>(new Set());
  const [handMap, setHandMap] = useState<Record<string, RaisedHand>>({});
  const [reactions, setReactions] = useState<FloatingReaction[]>([]);
  // A counter rather than the polls themselves. What the room is told is "something
  // changed"; what each client is entitled to see differs, so each fetches its own.
  const [pollsRevision, setPollsRevision] = useState(0);

  // Refs so the send helpers keep a stable identity across re-renders: they end
  // up in the dependency arrays of components that would otherwise re-subscribe
  // on every message. Written in an effect rather than during render, because a
  // render can be discarded and a ref written during one cannot be rolled back.
  const meRef = useRef(me);
  useEffect(() => {
    meRef.current = me;
  }, [me]);

  const reactionTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  // Through a ref so `apply` keeps a stable identity: it is a dependency of the
  // DataReceived subscription, and re-subscribing on every render would drop
  // messages during the gap.
  const notify = useRef(handlers);
  useEffect(() => {
    notify.current = handlers;
  }, [handlers]);

  const pushReaction = useCallback((emoji: string) => {
    const copies =
      REACTION_COPIES_MIN +
      Math.floor(Math.random() * (REACTION_COPIES_MAX - REACTION_COPIES_MIN + 1));
    const items: FloatingReaction[] = Array.from({ length: copies }, () => ({
      id: newId(),
      emoji,
      // Kept off the very edges, where an emoji is half cut off by the overflow.
      offset: Math.random(),
      duration: REACTION_MS + Math.round((Math.random() - 0.5) * 1400),
      drift: Math.round((Math.random() - 0.5) * 90),
      size: 22 + Math.round(Math.random() * 16),
    }));

    setReactions((current) => [...current, ...items].slice(-MAX_FLOATING));
    for (const item of items) {
      reactionTimers.current.set(
        item.id,
        setTimeout(() => {
          setReactions((current) => current.filter((r) => r.id !== item.id));
          reactionTimers.current.delete(item.id);
        }, item.duration + 200),
      );
    }
  }, []);

  useEffect(() => {
    const timers = reactionTimers.current;
    return () => {
      timers.forEach(clearTimeout);
      timers.clear();
    };
  }, []);

  const apply = useCallback(
    (msg: RoomMessage) => {
      switch (msg.kind) {
        case "chat":
          setChat((current) => mergeChat(current, [msg]));
          break;
        case "question":
          setRawQuestions((current) => {
            if (current.some((q) => q.id === msg.id)) return current;
            return [...current, msg].slice(-MAX_QUESTIONS);
          });
          break;
        case "upvote":
          setVotes((current) => {
            const voters = new Set(current[msg.questionId] ?? []);
            voters.add(msg.from.identity);
            return { ...current, [msg.questionId]: voters };
          });
          break;
        case "answered":
          setAnswered((current) => new Set(current).add(msg.questionId));
          break;
        case "hand":
          setHandMap((current) => {
            if (!msg.raised) {
              if (!(msg.from.identity in current)) return current;
              const next = { ...current };
              delete next[msg.from.identity];
              return next;
            }
            if (current[msg.from.identity]) return current;
            return {
              ...current,
              [msg.from.identity]: {
                identity: msg.from.identity,
                name: msg.from.name,
                at: Date.now(),
              },
            };
          });
          // Announced from the message rather than by watching the list, so it
          // fires once per hand and never on a re-render.
          if (msg.raised && msg.from.identity !== meRef.current.identity) {
            notify.current?.onHandRaised?.(msg.from);
          }
          break;
        case "polls-changed":
          setPollsRevision((n) => n + 1);
          break;
        case "hands-cleared":
          setHandMap({});
          break;
        case "lower-hand":
          setHandMap((current) => {
            if (!(msg.identity in current)) return current;
            const next = { ...current };
            delete next[msg.identity];
            return next;
          });
          if (msg.identity === meRef.current.identity) {
            notify.current?.onHandLowered?.(msg.reason);
          }
          break;
        case "reaction":
          pushReaction(msg.emoji);
          break;
        case "unmute-request":
          notify.current?.onUnmuteRequested?.(msg.from);
          break;
        case "joined":
          notify.current?.onAttendeeJoined?.(msg.from);
          break;
        case "chat-deleted":
          setChat((current) => current.filter((m) => m.id !== msg.id));
          break;
      }
    },
    [pushReaction],
  );

  // Receive.
  useEffect(() => {
    if (!room) return;

    const onData = (payload: Uint8Array, _p?: Participant, _k?: unknown, topic?: string) => {
      if (topic !== undefined && topic !== DATA_TOPIC) return;
      const msg = decode(payload);
      if (msg) apply(msg);
    };

    room.on(RoomEvent.DataReceived, onData);
    return () => {
      room.off(RoomEvent.DataReceived, onData);
    };
  }, [room, apply]);

  // Someone who disconnects should not leave a raised hand behind forever.
  useEffect(() => {
    if (!room) return;
    const onLeft = (p: Participant) => {
      setHandMap((current) => {
        if (!(p.identity in current)) return current;
        const next = { ...current };
        delete next[p.identity];
        return next;
      });
    };
    room.on(RoomEvent.ParticipantDisconnected, onLeft);
    return () => {
      room.off(RoomEvent.ParticipantDisconnected, onLeft);
    };
  }, [room]);

  const publish = useCallback(
    async (msg: RoomMessage, destinationIdentities?: string[]) => {
      if (!room?.localParticipant) return;
      await room.localParticipant.publishData(encode(msg), {
        reliable: true,
        topic: DATA_TOPIC,
        ...(destinationIdentities ? { destinationIdentities } : {}),
      });
    },
    [room],
  );

  // Through a ref so every send helper below keeps a stable identity: they are
  // dependencies of the control bar and of four panels.
  const relayRef = useRef(relay);
  useEffect(() => {
    relayRef.current = relay;
  }, [relay]);

  /* One outgoing message, by whichever route this participant has.
   *
   * The route is chosen from the SFU's own answer at the moment of sending, not from
   * the role we joined with. That is what makes a mid-session change work with no
   * state to keep in step: the host promotes an attendee, the SFU grants them
   * canPublishData, and their next message goes straight down the data channel; a
   * demotion takes it away again and they fall back to the relay. Reading it here
   * also means the permissions arriving late — they come with the join response,
   * after this hook has mounted — costs nothing.
   *
   * The optimistic echo is the other half. A published packet is not looped back to
   * its sender, so a publisher has to apply its own message locally. A relayed one
   * comes back from the SFU like everybody else's, because the server includes the
   * sender in the recipient list, so applying it here too would show it twice.
   * Waiting for the round trip also makes "sent" the truth: a message the server
   * refused never appears at all. */
  const send = useCallback(
    async (
      msg: RoomMessage,
      relayed: RelayRequest,
      destinationIdentities?: string[],
    ): Promise<void> => {
      const direct = room?.localParticipant?.permissions?.canPublishData === true;
      const via = relayRef.current;
      if (!direct && via) {
        await via(relayed);
        return;
      }
      apply(msg);
      await publish(msg, destinationIdentities);
    },
    [apply, publish, room],
  );

  const sendChat = useCallback(
    async (text: string, destination: ChatDestination) => {
      const clean = text.trim().slice(0, MAX_CHAT_CHARS);
      if (!clean) return;
      const result = await relayRef.current?.({
        kind: "chat",
        id: newId(),
        text: clean,
        destination,
      });
      // A stage-only message with nobody on stage is kept and not delivered — it goes
      // into the transcript and the first panelist to connect reads it in their backlog.
      // Returned so the composer can say so, because a message that appears to vanish is
      // one somebody types again.
      return {
        delivered: (result?.recipients ?? 0) > 0 || destination === "everyone",
      };
    },
    [],
  );

  /* Merges a backlog fetched over HTTP into the live conversation.
   *
   * By id, so a message that arrived on the data channel and then again in a backlog —
   * which is the normal case on a reconnect, because the cursor cannot be advanced and
   * the socket drained atomically — appears once. Sorted by seq, so a batch that arrives
   * out of order with the live stream still reads in the order it was said.
   */
  const mergeBacklog = useCallback((messages: ChatMessage[]) => {
    setChat((current) => mergeChat(current, messages));
  }, []);

  const askQuestion = useCallback(
    async (text: string, anonymous: boolean) => {
      const clean = text.trim().slice(0, MAX_QUESTION_CHARS);
      if (!clean) return;
      const msg: QuestionMessage = {
        kind: "question",
        id: newId(),
        from: meRef.current,
        text: clean,
        anonymous,
        at: Date.now(),
      };
      await send(msg, { kind: "question", id: msg.id, text: clean, anonymous });
    },
    [send],
  );

  const upvote = useCallback(
    async (questionId: string) => {
      const msg: UpvoteMessage = { kind: "upvote", questionId, from: meRef.current };
      await send(msg, { kind: "upvote", questionId });
    },
    [send],
  );

  // Published directly, not relayed: only the stage can mark a question answered,
  // and the stage holds canPublishData. The relay refuses this kind for the same
  // reason — see api/internal/api/say.go.
  const markAnswered = useCallback(
    async (questionId: string) => {
      const msg: AnsweredMessage = { kind: "answered", questionId };
      apply(msg);
      await publish(msg);
    },
    [apply, publish],
  );

  // The sync cursor. Derived rather than tracked separately, so it cannot disagree
  // with what is actually on screen — the two drifting apart is how a reconnect either
  // re-fetches the whole session or silently skips a message.
  const chatCursor = useMemo(
    () => chat.reduce((highest, m) => (m.seq > highest ? m.seq : highest), 0),
    [chat],
  );

  const myHandRaised = !!handMap[me.identity];

  // toggleHand reads the current hand state through a ref rather than depending
  // on it, so the callback identity stays stable for the control bar.
  const handMapRef = useRef(handMap);
  useEffect(() => {
    handMapRef.current = handMap;
  }, [handMap]);

  const toggleHand = useCallback(async () => {
    const raised = !handMapRef.current[meRef.current.identity];
    const msg: HandMessage = { kind: "hand", from: meRef.current, raised };
    // Applied locally before the round trip, not just for the host/stage path
    // that already gets this from `send`. An attendee without canPublishData
    // goes through the relay, and waiting on that round trip before the button
    // updates is what made a raised hand look like it hadn't registered, or a
    // second tap look like it did nothing. `apply` for "hand" is idempotent, so
    // the later echo re-applying the same state is a no-op.
    apply(msg);
    await send(msg, { kind: "hand", raised });
  }, [apply, send]);

  /** Host-side dismissal, broadcast so the person's own hand comes down too.
   *
   *  Clearing only the host's copy was the earlier behaviour and it left the two
   *  sides disagreeing: the host had dealt with the request, and the attendee was
   *  still sitting there with their hand up. */
  const lowerHand = useCallback(
    async (identity: string, reason: "granted" | "dismissed" = "dismissed") => {
      const msg: LowerHandMessage = {
        kind: "lower-hand",
        from: meRef.current,
        identity,
        reason,
      };
      apply(msg);
      await publish(msg);
    },
    [apply, publish],
  );

  // Stage-only, so it is published directly rather than relayed — the same as
  // lowerHand and markAnswered.
  const clearHands = useCallback(async () => {
    const msg: HandsClearedMessage = { kind: "hands-cleared", from: meRef.current };
    apply(msg);
    await publish(msg);
  }, [apply, publish]);

  const react = useCallback(
    async (emoji: Reaction) => {
      const msg: ReactionMessage = { kind: "reaction", from: meRef.current, emoji };
      await send(msg, { kind: "reaction", emoji });
    },
    [send],
  );

  const askToUnmute = useCallback(
    async (identity: string) => {
      const msg: UnmuteRequestMessage = { kind: "unmute-request", from: meRef.current };
      // Addressed to one person: a room-wide "please unmute" would prompt 500
      // people at once.
      await publish(msg, [identity]);
    },
    [publish],
  );

  const questions = useMemo<Question[]>(() => {
    return rawQuestions
      .map((q) => {
        const voters = votes[q.id];
        return {
          ...q,
          votes: voters?.size ?? 0,
          answered: answered.has(q.id),
          votedByMe: voters?.has(me.identity) ?? false,
        };
      })
      // Unanswered first, then most-upvoted, then oldest — the order a host
      // actually wants to work down.
      .sort((a, b) => {
        if (a.answered !== b.answered) return a.answered ? 1 : -1;
        if (a.votes !== b.votes) return b.votes - a.votes;
        return a.at - b.at;
      });
  }, [rawQuestions, votes, answered, me.identity]);

  const hands = useMemo(
    () => Object.values(handMap).sort((a, b) => a.at - b.at),
    [handMap],
  );

  return {
    chat,
    questions,
    hands,
    reactions,
    myHandRaised,
    sendChat,
    askQuestion,
    upvote,
    markAnswered,
    toggleHand,
    lowerHand,
    clearHands,
    pollsRevision,
    mergeBacklog,
    chatCursor,
    react,
    askToUnmute,
  };
}
