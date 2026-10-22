import type { LiveParticipant, LiveRoom } from "./api-types";
import type { RaisedHand } from "./realtime";

/* How the host's roster is cut into sections, and when the search box appears.
 *
 * These are pure because the failure they guard against is one a live session
 * will not demonstrate on demand: a raised-hand queue sorted alphabetically
 * (newest question first by accident of the name), a search box that covers
 * half the list when three people are in the room, and a "Panelists" heading
 * that includes attendees because the sort mixed everyone into one pile.
 */

/** Search is noise on a short list. Once the room is too long to scan, or the
 *  host has already typed, the box earns its keep. */
export const ROSTER_SEARCH_AFTER = 8;

export function shouldShowRosterSearch(count: number, query: string): boolean {
  return query.trim().length > 0 || count >= ROSTER_SEARCH_AFTER;
}

/** Search typing is free-form and names are not ASCII: "perez" should find
 *  "Pérez", "ANA" should find "ana", and a stray double space must not turn a
 *  hit into a miss. NFD splits an accented letter into base + combining mark,
 *  and the marks are then dropped. */
export function normalizeRosterText(text: string | null | undefined): string {
  return (text ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** Whether somebody matches what the host typed.
 *
 *  Every word of the query has to appear somewhere in the name or identity, in
 *  any order — so "perez ana" finds "Ana Pérez", and a first-name-plus-initial
 *  like "ana p" narrows rather than misses. The identity is searched too because
 *  display names collide; it is the one thing that tells two "Ana"s apart. */
export function matchRosterQuery(
  person: Pick<LiveParticipant, "name" | "identity">,
  query: string,
): boolean {
  const needle = normalizeRosterText(query);
  if (!needle) return true;
  const haystack = `${normalizeRosterText(person.name)} ${normalizeRosterText(person.identity)}`;
  return needle.split(" ").every((word) => haystack.includes(word));
}

export type HostRosterSections = {
  raised: LiveParticipant[];
  panelists: LiveParticipant[];
  attendees: LiveParticipant[];
};

export function isBotOrEgress(identity: string): boolean {
  return identity.startsWith("EG_") || identity.startsWith("REC_") || identity.startsWith("CAP_");
}

/** Host and panelists in one section, attendees in another, raised hands as a
 *  queue of their own.
 *
 *  The queue is oldest-first because that is the order the host works down a
 *  Q&A: the person who has been waiting longest, not the one whose name sorts
 *  first. Hands that are not in this filtered list (search missed them) are
 *  dropped rather than shown as a hole. */
export function partitionHostRoster(
  rows: readonly LiveParticipant[],
  hands: readonly RaisedHand[],
): HostRosterSections {
  const cleanRows = rows.filter((p) => !isBotOrEgress(p.identity));
  const byIdentity = new Map(cleanRows.map((p) => [p.identity, p]));

  const raised: LiveParticipant[] = [];
  const seenRaised = new Set<string>();
  const ordered = [...hands].sort((a, b) => a.at - b.at || a.identity.localeCompare(b.identity));
  for (const hand of ordered) {
    const person = byIdentity.get(hand.identity);
    if (!person || seenRaised.has(person.identity)) continue;
    seenRaised.add(person.identity);
    raised.push(person);
  }

  const byName = (a: LiveParticipant, b: LiveParticipant) =>
    a.name.localeCompare(b.name) || a.identity.localeCompare(b.identity);

  const panelists = cleanRows
    .filter((p) => p.role === "host" || p.role === "panelist")
    .sort((a, b) => {
      const rank = (p: LiveParticipant) =>
        p.role === "host" ? 0 : p.coHost ? 1 : 2;
      const delta = rank(a) - rank(b);
      return delta !== 0 ? delta : byName(a, b);
    });

  const attendees = cleanRows.filter((p) => p.role === "attendee").sort(byName);

  return { raised, panelists, attendees };
}

/** The host is in the room the moment they open this panel, but the first SFU
 *  poll can still come back without them. Without this they would stare at
 *  "Nobody on the stage" in their own webinar. */
export function withLocalOnRoster(
  rows: readonly LiveParticipant[],
  self: { identity: string; name: string; role: LiveParticipant["role"] },
): LiveParticipant[] {
  if (rows.some((p) => p.identity === self.identity)) return [...rows];
  const onStage = self.role === "host" || self.role === "panelist";
  return [
    {
      identity: self.identity,
      name: self.name,
      role: onStage ? self.role : "attendee",
      joinedAt: new Date().toISOString(),
      publishing: [],
      audioMuted: true,
      hidden: false,
      canPublish: onStage,
      canSpeak: onStage,
      audioOnly: false,
      mutedByHost: false,
      coHost: false,
    },
    ...rows,
  ];
}

/** The pill beside a name on the host's roster. Mirrors the one-word role line
 *  the row used to print, just drawn as a badge: brand for the people who run the
 *  room, neutral for the stage, nothing for the audience. */
export function rosterBadge(
  p: Pick<LiveParticipant, "role" | "coHost" | "audioOnly">,
): { label: string; tone: "stage" | "neutral" } | null {
  if (p.role === "host") return { label: "Host", tone: "stage" };
  if (p.role !== "panelist") return null;
  if (p.coHost) return { label: "Co-host", tone: "stage" };
  // An attendee the host allowed to speak: on the stage in LiveKit's terms, but
  // only with a microphone — the row used to say "Allowed to speak" here.
  return p.audioOnly ? { label: "Speaker", tone: "neutral" } : { label: "Panelist", tone: "neutral" };
}

/** What the row says about somebody the video server does not list (LiveParticipant.via):
 *  how they are connected, in the host's words rather than the plumbing's. Null for
 *  everyone on the video server. */
export function rosterConnectionLabel(p: Pick<LiveParticipant, "via">): string | null {
  if (p.via === "stream") return "Watching via stream";
  if (p.via === "limited") return "Limited connection";
  return null;
}

/** Folds a new roster read into the last one.
 *
 *  A full read replaces the last one. A partial one (`partial`: the video server could not
 *  be read this time, so only the people reached another way are in it) keeps the previous
 *  read's video-server rows, so a slow video server does not empty the stage for a poll.
 *  Either way every identity appears once, and when rows had to be merged or dropped the
 *  counts are recomputed from them, so the header and the list cannot disagree. */
export function mergeRosterSnapshot(prev: LiveRoom | null, next: LiveRoom): LiveRoom {
  const incoming = next.participants ?? [];
  const seen = new Set<string>();
  const rows: LiveParticipant[] = [];
  const keep = (p: LiveParticipant) => {
    if (seen.has(p.identity)) return;
    seen.add(p.identity);
    rows.push(p);
  };
  if (next.partial && prev) {
    // The video server's rows first: they win over a viewer row for the same person.
    for (const p of prev.participants ?? []) if (!p.via) keep(p);
  }
  for (const p of incoming) keep(p);
  if (!next.partial && rows.length === incoming.length) return next;
  const counted = rows.filter((p) => !isBotOrEgress(p.identity));
  return {
    ...next,
    participants: rows,
    attendees: counted.filter((p) => p.role === "attendee").length,
    onStage: counted.filter((p) => p.role !== "attendee").length,
  };
}

/** How long a hand has been up, as the queue shows it: "just now" under a
 *  minute, then whole minutes, then hours. Read at render time, which the roster's
 *  own refresh keeps within a few seconds of true. */
export function handWaitLabel(raisedAt: number, now: number): string {
  const minutes = Math.floor(Math.max(0, now - raisedAt) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return `${hours} h ${minutes % 60} min`;
}
