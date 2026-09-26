import type { LiveParticipant } from "./api-types";
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

export function matchRosterQuery(
  person: Pick<LiveParticipant, "name" | "identity">,
  query: string,
): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return (
    person.name.toLowerCase().includes(needle) ||
    person.identity.toLowerCase().includes(needle)
  );
}

export type HostRosterSections = {
  raised: LiveParticipant[];
  panelists: LiveParticipant[];
  attendees: LiveParticipant[];
};

export function isBotOrEgress(identity: string): boolean {
  return identity.startsWith("EG_") || identity.startsWith("REC_");
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
