import { insertMention, type Draft } from "./mentions.ts";

/* The raised-hand queue on the toolbar.
 *
 * Participants used to swap its headcount for the number of raised hands, which
 * hid how many people were in the room at the moment a host most needed both
 * numbers. The queue is its own button now, and only while someone is waiting.
 *
 * Pure on purpose: the button, the order and the "lower / invite" calls are the
 * things a live room will not sit still for.
 */

export type RaisedHandsViewer = {
  isHost: boolean;
  /** Live role. A promoted attendee becomes "panelist" on the wire. */
  role: string;
  /** Lifted out of the audience. Still an attendee — not the queue. */
  promoted: boolean;
  canPublish: boolean;
};

/** Hosts (including co-hosts) and scheduled panelists. Not the audience, and
 *  not someone the host only allowed to speak. */
export function canSeeRaisedHandsQueue(viewer: RaisedHandsViewer): boolean {
  if (viewer.promoted) return false;
  if (viewer.isHost) return true;
  if (viewer.role === "panelist") return true;
  // A seat that can publish without having been promoted is on the stage.
  // Preview chrome is the case this catches: the panelist seat is not `isHost`
  // and its fixture role is not always "panelist".
  return viewer.canPublish && viewer.role !== "attendee";
}

/** What the Participants button shows. The hand count never replaces this —
 *  `raisedHands` is accepted so a caller cannot quietly drop it back in. */
export function participantsButtonCount(
  headcount: number | undefined,
  raisedHands: number,
): number | undefined {
  void raisedHands;
  return headcount;
}

/** Badge on the Raised hands button. Null means the button is not rendered. */
export function raisedHandsButtonCount(viewer: RaisedHandsViewer, handCount: number): number | null {
  if (!canSeeRaisedHandsQueue(viewer)) return null;
  if (handCount <= 0) return null;
  return handCount;
}

/** Phone bar cannot take another standing button. Desktop shows it in the
 *  strip; a narrow bar puts it with the other overflow tools. */
export function raisedHandsPlacement(
  compact: boolean,
  count: number | null,
): "bar" | "overflow" | "hidden" {
  if (count == null || count <= 0) return "hidden";
  return compact ? "overflow" : "bar";
}

export type RaisedHandRow = { identity: string; name?: string; at?: number };

/** Earliest raised first. A missing timestamp sorts last and is not invented. */
export function orderedRaisedHands<T extends RaisedHandRow>(hands: readonly T[]): T[] {
  const at = (hand: T) =>
    typeof hand.at === "number" && Number.isFinite(hand.at) ? hand.at : Number.POSITIVE_INFINITY;
  return [...hands].sort(
    (a, b) => at(a) - at(b) || a.identity.localeCompare(b.identity),
  );
}

/** "raised 15s ago" / "raised 1m 20s ago". Null when the hand has no clock. */
export function raisedAgoLabel(at: number | undefined, now: number): string | null {
  if (typeof at !== "number" || !Number.isFinite(at)) return null;
  const totalSec = Math.floor(Math.max(0, now - at) / 1000);
  if (totalSec < 60) return `raised ${totalSec}s ago`;
  const minutes = Math.floor(totalSec / 60);
  const seconds = totalSec % 60;
  if (minutes < 60) {
    return seconds === 0 ? `raised ${minutes}m ago` : `raised ${minutes}m ${seconds}s ago`;
  }
  const hours = Math.floor(minutes / 60);
  const remMin = minutes % 60;
  return remMin === 0 ? `raised ${hours}h ago` : `raised ${hours}h ${remMin}m ago`;
}

/** Already able to speak. Inviting them again would re-apply a stage grant. */
export function handAlreadyOnStage(
  person: { role?: string; canSpeak?: boolean } | undefined,
): boolean {
  if (!person) return false;
  return person.role === "host" || person.role === "panelist" || person.canSpeak === true;
}

type LowerHand = (identity: string, reason?: "granted" | "dismissed") => Promise<void>;

/** One person's hand, through the host/panelist lower-hand message. */
export async function lowerOneHand(lowerHand: LowerHand, identity: string): Promise<void> {
  await lowerHand(identity, "dismissed");
}

/** Every raised hand, through the existing clear — the same broadcast the
 *  Participants "Lower All Hands" control already sends. Not a local hide. */
export async function lowerAllHands(clearHands: () => Promise<void>): Promise<void> {
  await clearHands();
}

/** Allow-to-speak, the path the roster row and the hand toast already share.
 *  `audioOnly` is that path: a microphone, not a second promotion. Someone
 *  already on stage is left alone. */
export async function inviteHandToSpeak(
  promote: (
    slug: string,
    lowerHand: LowerHand,
    identity: string,
    role: string,
    audioOnly: boolean,
    handUp: boolean,
  ) => Promise<"invited" | "done">,
  input: {
    slug: string;
    lowerHand: LowerHand;
    identity: string;
    alreadyOnStage: boolean;
  },
): Promise<"invited" | "done" | "skipped"> {
  if (input.alreadyOnStage) return "skipped";
  return promote(input.slug, input.lowerHand, input.identity, "panelist", true, true);
}

/** There is no per-person direct message. Messaging opens the room chat. */
export function messageRaisedHandTarget(): "room-chat" {
  return "room-chat";
}

/** Composer seed so the room chat opens addressed to that person. An @mention
 *  in the room, not a private thread. */
export function chatFocusDraft(person: { identity: string; name: string }): Draft {
  const next = insertMention({ text: "", mentions: [] }, 0, 0, {
    identity: person.identity,
    name: person.name,
    role: "attendee",
  });
  return { text: next.text, mentions: next.mentions };
}

/** One docked drawer. Opening the queue remembers the tab it covered. */
export type RaisedHandsSession = {
  open: boolean;
  restore: string | null;
};

export function beginRaisedHands(currentPanel: string | null): RaisedHandsSession {
  return { open: true, restore: currentPanel };
}

export function endRaisedHands(session: RaisedHandsSession): {
  session: RaisedHandsSession;
  restore: string | null;
} {
  return {
    session: { open: false, restore: null },
    restore: session.open ? session.restore : null,
  };
}

/** Another panel was chosen. Do not put the covered tab back on top of it. */
export function dismissRaisedHands(): RaisedHandsSession {
  return { open: false, restore: null };
}
