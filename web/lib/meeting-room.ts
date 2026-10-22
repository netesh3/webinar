/* What a meeting's room does differently from a webinar's, as pure functions.
 *
 * A meeting (Webinar.kind "meeting", JoinResponse.meeting on every token for one) has no
 * audience: the host lets somebody in from the lobby and they arrive on the stage, as a
 * panelist does. So the room keeps almost everything a webinar room has — chat, Q&A, polls,
 * recording, mute and remove — and loses the handful of things that only mean something when
 * there is an audience to act on: raising a hand to be brought up, promoting and demoting,
 * "allow everyone to speak", hiding attendees from each other, and streaming the stage out to
 * an audience somewhere else.
 *
 * The other half is the door. Webinar panelists remember their own mic and camera from last
 * time (lib/media.ts); a meeting guest arrives muted with their camera on, the way every
 * meeting app opens, and can change either on the pre-join screen. A refresh is the exception
 * that wins over both: somebody who was talking a second ago comes back talking
 * (lib/rejoin.ts).
 *
 * Pure so node can test it — see meeting-room.test.mts, run by `make test-web`.
 */

import type { LobbyAdmitAllResponse, LobbyEntry } from "./api-types.ts";
import type { SavedMedia } from "./rejoin.ts";
import type { ToolId } from "./tools.ts";

// ------------------------------------------------------------------- tools

/* The tools a meeting never offers.
 *
 * Raise hand stays. In a webinar it asks to be brought on the stage; in a meeting, where
 * everyone already is, it means what it means in Zoom — "I'd like to speak" — and the host
 * answers by calling on them and lowering it. The toasts and the roster already offer only
 * Lower hand for someone on the stage (handActions), so no stage action is ever offered.
 *
 * The four stream destinations: a meeting has no audience to send anywhere, and the server
 * refuses stream destinations for one outright. */
export const MEETING_HIDDEN_TOOLS: readonly ToolId[] = [
  "youtube",
  "linkedin",
  "instagram",
  "facebook",
];

/** The tools this person may use, narrowed for a meeting. A webinar's list is returned as
 *  it came, order and all, so nothing about a webinar room changes. */
export function meetingTools(tools: readonly ToolId[], meeting: boolean): ToolId[] {
  if (!meeting) return [...tools];
  return tools.filter((t) => !MEETING_HIDDEN_TOOLS.includes(t));
}

// ------------------------------------------------------------- entry media

type EntryMedia = { micEnabled: boolean; cameraEnabled: boolean };

/* Whether this person enters on a meeting's defaults rather than their own remembered ones.
 *
 * Everyone in a meeting except the host. The host is the one person who opened the room and
 * knows what they want; everybody else is walking into a conversation already going, and
 * arriving unmuted into it is the thing every meeting app has learned not to do. */
export function usesMeetingEntry(meeting: boolean | undefined, role: string): boolean {
  return meeting === true && role !== "host";
}

/** What the pre-join screen's toggles start at.
 *
 *  A meeting guest: mic off, camera on — still theirs to change before they press Join.
 *  Anyone else: their remembered preferences, exactly as before. */
export function prejoinMedia(prefs: EntryMedia, meetingEntry: boolean): EntryMedia {
  if (!meetingEntry) return { micEnabled: prefs.micEnabled, cameraEnabled: prefs.cameraEnabled };
  return { micEnabled: false, cameraEnabled: true };
}

/* What a publisher re-enters with on an automatic rejoin, for a meeting guest.
 *
 * The saved per-webinar state wins: that is what they had a second ago, and a refresh must
 * not turn a camera off or a microphone on behind somebody's back. A host-enforced mute
 * still wins over the saved mic, as rejoinEntry has it for a webinar.
 *
 * With nothing saved — a reopened link with storage cleared, a different tab — a webinar
 * panelist comes back dark and muted (rejoinEntry(null)), which reads as "you were not
 * presenting". A meeting guest was in a conversation, and comes back the way they first
 * walked in: muted, camera on. */
export function meetingRejoinEntry(saved: SavedMedia | null, hostMuted: boolean): EntryMedia {
  if (saved) return { micEnabled: saved.mic && !hostMuted, cameraEnabled: saved.camera };
  return { micEnabled: false, cameraEnabled: true };
}

// ------------------------------------------------------------------- lobby

/* The server's lobby packet, {"kind":"lobby","waiting":N} (announceLobby in meeting.go).
 *
 * Only the count: the names are read from GET /lobby, which is the host's to read. The packet
 * is a hint to read it NOW rather than at the next five-second poll — so a forged one costs
 * one extra request and shows nothing the server did not say. Anything that is not a
 * non-negative whole number is not a lobby packet. */
export function lobbyWaitingFrom(raw: Record<string, unknown>): number | null {
  if (raw.kind !== "lobby") return null;
  const n = raw.waiting;
  if (typeof n !== "number" || !Number.isInteger(n) || n < 0) return null;
  return Math.min(n, 10_000);
}

/** The people in `entries` the host has not been told about yet, oldest first. What decides
 *  whether a toast goes up: a poll that brings back the same queue announces nothing. */
export function lobbyArrivals(known: ReadonlySet<string>, entries: readonly LobbyEntry[]): LobbyEntry[] {
  return entries.filter((e) => !known.has(e.id));
}

/** Oldest first, the order the server admits in (AdmitOldest), so the list reads as the
 *  queue it is. An unparseable time sorts last rather than throwing the list out. */
export function sortLobby(entries: readonly LobbyEntry[]): LobbyEntry[] {
  const at = (e: LobbyEntry) => {
    const t = Date.parse(e.requestedAt);
    return Number.isFinite(t) ? t : Number.POSITIVE_INFINITY;
  };
  return [...entries].sort((a, b) => at(a) - at(b) || a.name.localeCompare(b.name));
}

/** The toast's words for who is waiting. */
export function lobbyToastText(entries: readonly LobbyEntry[]): string {
  if (entries.length === 0) return "";
  if (entries.length === 1) return `${entries[0].name || "Someone"} is waiting to join.`;
  if (entries.length === 2) return `${entries[0].name} and ${entries[1].name} are waiting to join.`;
  return `${entries[0].name} and ${entries.length - 1} others are waiting to join.`;
}

/** The header chip and the panel heading: "Waiting (3)". */
export function lobbyLabel(waiting: number): string {
  return `Waiting (${waiting})`;
}

/* 409 meeting_full, in words a host can act on.
 *
 * The server's message carries the cap ("it holds 10 people at once, including the host"),
 * which is the useful number — it is what an admin would raise. Read out of the message
 * rather than asked for separately, so the host is told in the same moment the admit fails. */
export function meetingFullMessage(serverMessage?: string | null): string {
  const m = /holds (\d+) (?:people|person)/.exec(serverMessage ?? "");
  return m
    ? `Meeting is full (${m[1]}). Ask an admin to raise it.`
    : "Meeting is full. Ask an admin to raise it.";
}

/** What "Admit all" did: everyone, or as many as fit. */
export function admitAllMessage(res: LobbyAdmitAllResponse): string {
  const who = (n: number) => `${n} ${n === 1 ? "person" : "people"}`;
  if (res.admitted === 0 && res.left > 0) return meetingFullMessage();
  if (res.admitted === 0) return "Nobody is waiting.";
  if (res.left === 0) return `Let in ${who(res.admitted)}.`;
  return `Let in ${who(res.admitted)}. The meeting is full, so ${who(res.left)} ${res.left === 1 ? "is" : "are"} still waiting.`;
}
