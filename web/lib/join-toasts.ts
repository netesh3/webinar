/* "X is joining…" → "X joined", as the host's toasts tell it.
 *
 * Two signals, from two places, arriving seconds apart:
 *
 *  - JOINING is the earliest hint that somebody is on their way: the server's
 *    "joined" packet, which it sends the moment it hands an attendee a token — before
 *    their browser has even opened the connection — or LiveKit's ParticipantConnected
 *    for anybody the host's own connection sees arrive.
 *  - JOINED is the person being on the roster the Participants panel draws, which is
 *    the server's list of who the SFU actually has. Saying "joined" any sooner is what
 *    this replaces: a toast naming somebody the panel did not contain yet.
 *
 * Pure, with the clock passed in, because every interesting case is about time — a
 * join that never lands, a burst of arrivals, a reconnect — and none of those can be
 * produced on demand in a live room. The component owns the timers and asks
 * `nextDeadline` when to call `tick` again.
 */

export type JoinRole = "host" | "panelist" | "attendee";

export type JoinPerson = {
  identity: string;
  name: string;
  role: JoinRole;
  coHost?: boolean;
  audioOnly?: boolean;
};

export type JoinEntry = JoinPerson & {
  phase: "joining" | "joined";
  /** When the joining signal arrived (or the roster showed them, if it came first). */
  startedAt: number;
  /** When they reached the roster. Absent while still joining. */
  joinedAt?: number;
};

export type JoinToastView =
  | { key: string; kind: "person"; entry: JoinEntry }
  | { key: string; kind: "summary"; joined: JoinEntry[]; joining: JoinEntry[] };

/** Somebody still "joining" after this is dismissed without a word: they may be
 *  sitting on the pre-join screen, or have closed the tab. Neither is an error. */
export const JOIN_TIMEOUT_MS = 25_000;
/** How long "X joined" stays up once it has turned green. */
export const JOINED_LINGER_MS = 3_500;
/** Somebody back on the roster this soon after dropping off it is a reconnect — a
 *  reloaded tab, a wifi blip — and not news to the host. */
export const REJOIN_QUIET_MS = 60_000;
/** More toasts than this at once and the attendees fold into one summary. */
export const MAX_INDIVIDUAL = 3;
/** Past this many attendees in the room, attendee arrivals are not toasted at all:
 *  the headcount badge is the right way to follow a crowd filling up. Hosts and
 *  panelists are always announced, because each of them matters on their own. */
export const ATTENDEE_TOAST_LIMIT = 50;

export const SUMMARY_KEY = "join:summary";

export function personKey(identity: string): string {
  return `join:${identity}`;
}

const isStage = (p: Pick<JoinPerson, "role">) => p.role === "host" || p.role === "panelist";

export class JoinTracker {
  private readonly self: string;
  private baselined = false;
  /** Who the roster had at its last reading, with their role for the headcount. */
  private present = new Map<string, JoinRole>();
  /** When somebody dropped off the roster, for telling a reconnect from a return. */
  private gone = new Map<string, number>();
  private entries = new Map<string, JoinEntry>();

  constructor(selfIdentity: string) {
    this.self = selfIdentity;
  }

  /** A hint that `person` is on their way in. */
  joining(person: JoinPerson, now: number): void {
    // Before the first roster there is nothing to compare against, and a host who has
    // just connected would otherwise be told about everyone already in the room.
    if (!this.baselined) return;
    if (person.identity === this.self) return;
    if (this.present.has(person.identity)) return;
    if (this.isReconnect(person.identity, now)) return;

    const existing = this.entries.get(person.identity);
    if (existing) {
      // A second token for somebody still on their way (a reload on the pre-join
      // screen): same toast, fresh timeout, the newer name.
      if (existing.phase === "joining") {
        this.entries.set(person.identity, { ...existing, ...pick(person), startedAt: now });
      }
      return;
    }
    if (!this.eligible(person)) return;
    this.entries.set(person.identity, { ...pick(person), phase: "joining", startedAt: now });
  }

  /** A fresh reading of the roster the Participants panel renders. */
  roster(people: readonly JoinPerson[], now: number): void {
    const seen = new Set<string>();
    for (const p of people) seen.add(p.identity);

    if (!this.baselined) {
      this.baselined = true;
      for (const p of people) this.present.set(p.identity, p.role);
      return;
    }

    for (const identity of [...this.present.keys()]) {
      if (seen.has(identity)) continue;
      this.present.delete(identity);
      this.gone.set(identity, now);
    }

    for (const p of people) {
      if (this.present.has(p.identity)) {
        this.present.set(p.identity, p.role);
        continue;
      }
      const entry = this.entries.get(p.identity);
      const reconnect = this.isReconnect(p.identity, now);
      this.present.set(p.identity, p.role);
      this.gone.delete(p.identity);

      if (p.identity === this.self) continue;
      if (entry) {
        if (entry.phase === "joining") {
          this.entries.set(p.identity, { ...entry, ...pick(p), phase: "joined", joinedAt: now });
        }
        continue;
      }
      // No joining hint reached us — the packet was lost, or the attendee is hidden
      // from the host's own connection. They are on the panel now, which is the fact
      // that matters, so say "joined" straight away.
      if (reconnect) continue;
      if (!this.eligible(p)) continue;
      this.entries.set(p.identity, { ...pick(p), phase: "joined", startedAt: now, joinedAt: now });
    }
  }

  /** They left before the roster ever showed them: drop the "joining" toast. A
   *  "joined" toast is left to finish — it was true when it was said. */
  left(identity: string): void {
    if (this.entries.get(identity)?.phase === "joining") this.entries.delete(identity);
  }

  /** The host clicked a toast away. */
  dismiss(identities: readonly string[]): void {
    for (const identity of identities) this.entries.delete(identity);
  }

  /** Expire whatever has run its course. Returns whether anything changed. */
  tick(now: number): boolean {
    let changed = false;
    for (const [identity, e] of this.entries) {
      const expired =
        e.phase === "joining"
          ? now - e.startedAt >= JOIN_TIMEOUT_MS
          : now - (e.joinedAt ?? e.startedAt) >= JOINED_LINGER_MS;
      if (expired) {
        this.entries.delete(identity);
        changed = true;
      }
    }
    for (const [identity, at] of this.gone) {
      if (now - at >= REJOIN_QUIET_MS) this.gone.delete(identity);
    }
    return changed;
  }

  /** When `tick` next has something to do, or null when nothing is showing. */
  nextDeadline(): number | null {
    let next: number | null = null;
    for (const e of this.entries.values()) {
      const at =
        e.phase === "joining" ? e.startedAt + JOIN_TIMEOUT_MS : (e.joinedAt ?? e.startedAt) + JOINED_LINGER_MS;
      if (next === null || at < next) next = at;
    }
    return next;
  }

  view(): JoinToastView[] {
    return layoutJoinToasts([...this.entries.values()]);
  }

  private isReconnect(identity: string, now: number): boolean {
    const at = this.gone.get(identity);
    return at !== undefined && now - at < REJOIN_QUIET_MS;
  }

  private eligible(p: JoinPerson): boolean {
    if (isStage(p)) return true;
    let attendees = 0;
    for (const role of this.present.values()) if (role === "attendee") attendees++;
    return attendees < ATTENDEE_TOAST_LIMIT;
  }
}

function pick(p: JoinPerson): JoinPerson {
  return { identity: p.identity, name: p.name, role: p.role, coHost: p.coHost, audioOnly: p.audioOnly };
}

/** Which toasts to draw: one each while there are few, and once there are more than
 *  MAX_INDIVIDUAL, the hosts and panelists keep their own (up to two) and everybody
 *  else shares one summary. Oldest first, so the stack does not reshuffle as people
 *  arrive. */
export function layoutJoinToasts(entries: readonly JoinEntry[]): JoinToastView[] {
  const ordered = [...entries].sort(
    (a, b) => a.startedAt - b.startedAt || a.identity.localeCompare(b.identity),
  );
  const single = (entry: JoinEntry): JoinToastView => ({
    key: personKey(entry.identity),
    kind: "person",
    entry,
  });
  if (ordered.length <= MAX_INDIVIDUAL) return ordered.map(single);

  const individual = ordered.filter(isStage).slice(0, MAX_INDIVIDUAL - 1);
  const kept = new Set(individual.map((e) => e.identity));
  const rest = ordered.filter((e) => !kept.has(e.identity));
  return [
    ...individual.map(single),
    {
      key: SUMMARY_KEY,
      kind: "summary",
      joined: rest.filter((e) => e.phase === "joined"),
      joining: rest.filter((e) => e.phase === "joining"),
    },
  ];
}

/** "Asha", "Asha and Ravi", "Asha, Ravi and Meera", "Asha, Ravi and 4 others". */
export function namesSentence(names: readonly string[]): string {
  if (names.length === 0) return "";
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  if (names.length === 3) return `${names[0]}, ${names[1]} and ${names[2]}`;
  const others = names.length - 2;
  return `${names[0]}, ${names[1]} and ${others} others`;
}

/** The two lines a summary toast says. */
export function summaryText(view: Extract<JoinToastView, { kind: "summary" }>): {
  title: string;
  detail: string | null;
} {
  const { joined, joining } = view;
  if (joined.length === 0) {
    return {
      title: `${namesSentence(joining.map((e) => e.name))} ${joining.length === 1 ? "is" : "are"} joining…`,
      detail: null,
    };
  }
  return {
    title: `${namesSentence(joined.map((e) => e.name))} joined`,
    detail: joining.length > 0 ? `${joining.length} more joining…` : null,
  };
}
