/* "Asha wants to speak" — the raised-hand toasts.
 *
 * One mechanism, not two. What the room used to call "X wants to speak" (to the host)
 * and "X raised their hand" (to a panelist) were the same event: a `hand` packet on
 * the data channel, folded into `realtime.hands`. These toasts read that list rather
 * than the packet stream, because the list is what the Participants panel draws —
 * so a toast appears when somebody joins the queue and goes the moment they leave
 * it, whoever took them out of it (this host, another co-host in the panel, the
 * attendee lowering their own hand, or them leaving the room).
 *
 * Pure, with the clock passed in, for the same reason as lib/join-toasts.ts: a
 * burst of hands, a co-host arriving mid-queue and a flapping hand are all about
 * time, and none of them can be produced on demand in a live room.
 */

import { namesSentence } from "./join-toasts.ts";

export type HandRole = "host" | "panelist" | "attendee";

export type HandPerson = {
  identity: string;
  name: string;
  role: HandRole;
  coHost?: boolean;
  audioOnly?: boolean;
  /** When the hand went up, as the realtime list recorded it. Sorts the stack. */
  raisedAt: number;
};

export type HandEntry = HandPerson & {
  /** When the toast went up — the timeout runs from here, not from `raisedAt`. */
  shownAt: number;
  /** "invited": the host asked them to the stage and the invite is still open, so
   *  the hand is still up but there is nothing left to do from the toast. */
  phase: "raised" | "invited";
  /** When a pointer or keyboard focus is on the toast: it does not time out under
   *  somebody who is about to press a button in it. */
  held?: boolean;
};

export type HandToastView =
  | { key: string; kind: "person"; entry: HandEntry }
  | { key: string; kind: "summary"; entries: HandEntry[] };

/** Who is told, and what they can do about it.
 *
 *  - "act": the host and co-hosts. They are who the Participants panel gives the
 *    Allow to speak / Lower hand buttons to (it gates on isHost, which includes a
 *    co-host), so the toast offers the same buttons.
 *  - "inform": an ordinary panelist. They were already told about hands before this
 *    — so somebody on stage notices the person waiting — but their Participants
 *    panel has no queue and no actions, so their toast says it and nothing more.
 *  - null: attendees, who were never told about each other's hands. */
export type HandAudience = "act" | "inform" | null;

export function handAudience(viewer: { isHost: boolean; role: string }): HandAudience {
  if (viewer.isHost) return "act";
  if (viewer.role === "panelist") return "inform";
  return null;
}

/** The buttons a toast offers — the same set the host's roster row offers for a hand.
 *  "Allow to speak" is attendee-only there too: somebody already on the stage has a
 *  microphone, and narrowing a panelist to audio-only by accident is worse than
 *  one click more in the panel. */
export function handActions(
  audience: HandAudience,
  entry: Pick<HandEntry, "role" | "phase">,
): { allow: boolean; lower: boolean; view: boolean } {
  if (audience !== "act") return { allow: false, lower: false, view: false };
  if (entry.phase === "invited") return { allow: false, lower: false, view: true };
  return { allow: entry.role === "attendee", lower: true, view: true };
}

/** How long an actionable hand toast stays. Long enough to finish a sentence and
 *  reach for the mouse; after that the hand is still in the queue and on the
 *  Participants badge, which is where a host who was busy will find it. */
export const HAND_TOAST_MS = 15_000;
/** The panelist's heads-up, which has nothing to act on. */
export const HAND_INFO_MS = 6_000;
/** "Invite sent" lingers this long once the host has pressed Allow to speak. */
export const INVITED_LINGER_MS = 4_000;
/** After a pointer leaves a held toast, it gets at least this long again. */
export const HOLD_GRACE_MS = 4_000;
/** A hand that drops and comes back this soon is the same hand — a relay retry, a
 *  double-tap on the button — and is not announced twice. */
export const REPEAT_QUIET_MS = 5_000;
/** More toasts than this at once and they fold into one summary. */
export const MAX_INDIVIDUAL = 2;

export const HAND_SUMMARY_KEY = "hand:summary";

export function handKey(identity: string): string {
  return `hand:${identity}`;
}

export class HandTracker {
  private readonly self: string;
  private readonly timeoutMs: number;
  private baselined = false;
  /** Everybody whose hand is up right now, toasted or not. */
  private up = new Set<string>();
  /** When a hand came down, for telling a flap from a fresh raise. */
  private down = new Map<string, number>();
  private entries = new Map<string, HandEntry>();
  /** Once the stack has folded into a summary it stays folded until it is down to
   *  one, so a hand lowered out of a burst of three does not split the summary
   *  back into two cards that reshuffle under the host's pointer. */
  private folded = false;

  constructor(selfIdentity: string, timeoutMs = HAND_TOAST_MS) {
    this.self = selfIdentity;
    this.timeoutMs = timeoutMs;
  }

  /** A fresh reading of the raised-hand list. */
  hands(people: readonly HandPerson[], now: number): void {
    const seen = new Map<string, HandPerson>();
    for (const p of people) if (p.identity !== this.self) seen.set(p.identity, p);

    // The first reading is what was already true when this viewer started looking —
    // a co-host promoted mid-queue, a host whose tab remounted. Not news.
    if (!this.baselined) {
      this.baselined = true;
      for (const identity of seen.keys()) this.up.add(identity);
      return;
    }

    for (const identity of [...this.up]) {
      if (seen.has(identity)) continue;
      this.up.delete(identity);
      this.down.set(identity, now);
      // Handled — by this host, another host, or the person themselves.
      this.entries.delete(identity);
    }

    for (const [identity, p] of seen) {
      const entry = this.entries.get(identity);
      if (entry) {
        // The roster may have caught up with who they are since the hand went up.
        this.entries.set(identity, { ...entry, ...pick(p) });
        continue;
      }
      if (this.up.has(identity)) continue;
      this.up.add(identity);
      const downAt = this.down.get(identity);
      this.down.delete(identity);
      if (downAt !== undefined && now - downAt < REPEAT_QUIET_MS) continue;
      this.entries.set(identity, { ...pick(p), shownAt: now, phase: "raised" });
    }
    this.settleFold();
  }

  /** The viewer closed the toast, or opened the panel. The hand is still up and
   *  still in `up`, so it is not announced again. */
  dismiss(identities: readonly string[]): void {
    for (const identity of identities) this.entries.delete(identity);
    this.settleFold();
  }

  /** Allow to speak sent an invite rather than a grant: the hand stays up until
   *  they accept, and the toast says so briefly instead of offering the buttons
   *  again. */
  invited(identity: string, now: number): void {
    const entry = this.entries.get(identity);
    if (!entry) return;
    this.entries.set(identity, { ...entry, phase: "invited", shownAt: now, held: false });
  }

  /** Pointer or focus on the toast(s) for these people. Releasing gives them at
   *  least HOLD_GRACE_MS more, so moving away to think does not lose the toast. */
  hold(identities: readonly string[], held: boolean, now: number): void {
    for (const identity of identities) {
      const entry = this.entries.get(identity);
      if (!entry || entry.held === held) continue;
      const shownAt = held ? entry.shownAt : Math.max(entry.shownAt, now + HOLD_GRACE_MS - this.lifetime(entry));
      this.entries.set(identity, { ...entry, held, shownAt });
    }
  }

  /** Expire whatever has run its course. Returns whether anything changed. */
  tick(now: number): boolean {
    let changed = false;
    // A summary goes as one: its members expire together, from the newest arrival,
    // so a burst does not shrink one name at a time.
    if (this.folded) {
      const deadline = this.summaryDeadline();
      if (deadline !== null && now >= deadline) {
        this.entries.clear();
        changed = true;
      }
    } else {
      for (const [identity, e] of this.entries) {
        if (e.held) continue;
        if (now - e.shownAt >= this.lifetime(e)) {
          this.entries.delete(identity);
          changed = true;
        }
      }
    }
    for (const [identity, at] of this.down) {
      if (now - at >= REPEAT_QUIET_MS) this.down.delete(identity);
    }
    this.settleFold();
    return changed;
  }

  /** When `tick` next has something to do, or null when nothing is showing. */
  nextDeadline(): number | null {
    if (this.folded) return this.summaryDeadline();
    let next: number | null = null;
    for (const e of this.entries.values()) {
      if (e.held) continue;
      const at = e.shownAt + this.lifetime(e);
      if (next === null || at < next) next = at;
    }
    return next;
  }

  view(): HandToastView[] {
    const ordered = [...this.entries.values()].sort(
      (a, b) => a.raisedAt - b.raisedAt || a.identity.localeCompare(b.identity),
    );
    if (this.folded) return [{ key: HAND_SUMMARY_KEY, kind: "summary", entries: ordered }];
    return ordered.map((entry) => ({ key: handKey(entry.identity), kind: "person", entry }));
  }

  private lifetime(e: HandEntry): number {
    return e.phase === "invited" ? INVITED_LINGER_MS : this.timeoutMs;
  }

  private summaryDeadline(): number | null {
    let latest: number | null = null;
    for (const e of this.entries.values()) {
      if (e.held) return null;
      if (latest === null || e.shownAt > latest) latest = e.shownAt;
    }
    return latest === null ? null : latest + this.timeoutMs;
  }

  private settleFold(): void {
    if (this.entries.size > MAX_INDIVIDUAL) this.folded = true;
    else if (this.entries.size <= 1) this.folded = false;
  }
}

function pick(p: HandPerson): HandPerson {
  return {
    identity: p.identity,
    name: p.name,
    role: p.role,
    coHost: p.coHost,
    audioOnly: p.audioOnly,
    raisedAt: p.raisedAt,
  };
}

/** The two lines a summary says: "3 people raised their hands", "Asha, Ravi and Meera". */
export function handSummaryText(entries: readonly HandEntry[]): { title: string; detail: string } {
  const n = entries.length;
  return {
    title: n === 1 ? "1 person raised their hand" : `${n} people raised their hands`,
    detail: namesSentence(entries.map((e) => e.name)),
  };
}

/** What a single toast says, in plain text — the fallback card and the live region. */
export function handPersonText(entry: HandEntry, audience: HandAudience): string {
  if (entry.phase === "invited") return `Invited ${entry.name} to speak — waiting for them to accept`;
  // An attendee's hand is a request for the microphone; a panelist already has one,
  // so theirs is just a hand. The host's copy says what is being asked for.
  if (audience === "act" && entry.role === "attendee") return `${entry.name} wants to speak`;
  return `${entry.name} raised their hand`;
}
