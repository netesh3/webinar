/* @mentions: everything that decides who can be tagged, how a tag lives in the draft,
 * and how a delivered message is drawn.
 *
 * Pure and free of React, so lib/mentions.test.mts can run it directly under node.
 *
 * The draft is a plain textarea, not a rich editor. A tag is "@Name" in the text plus
 * an entry in a side list — identity, name, and the offsets of that "@Name" — which
 * every edit revalidates. That keeps paste, IME, undo and phones working the way a
 * textarea already does, and it means the text a message carries is readable on its
 * own: an older client, the transcript export and a screen reader all see "@Name".
 *
 * The permission rules mirror filterMentions in api/internal/api/mentions.go. The
 * server is the authority; this copy only decides what the picker offers, so that a
 * person is never offered somebody the server would drop — or somebody the host has
 * hidden from them.
 */

import type { Role } from "./api-types";
import type { ChatDestination } from "./realtime";

/** The one mention that is not an identity. Mirrors types.MentionEveryone. */
export const MENTION_EVERYONE = "@everyone";
/** Mirrors maxMentions in api/internal/api/mentions.go. */
export const MAX_MENTIONS = 10;
/** Longest run after "@" still treated as a query. A name, not a paragraph. */
const MAX_QUERY_CHARS = 40;

export type MentionCandidate = {
  identity: string;
  name: string;
  role: Role;
  /** A panelist with the host's rights. Drawn as "Co-host"; changes nothing else here. */
  coHost?: boolean;
};

/** One tag in the draft. `text.slice(start, end)` is exactly "@" + name. */
export type DraftMention = {
  identity: string;
  name: string;
  start: number;
  end: number;
};

export type Draft = { text: string; mentions: DraftMention[] };

const onStage = (role: Role) => role === "host" || role === "panelist";

// ------------------------------------------------------------------ matching

/** Case- and diacritic-insensitive form: "José" and "jose" are the same query. */
export function fold(value: string): string {
  return value.normalize("NFD").replace(/\p{M}+/gu, "").toLocaleLowerCase();
}

function words(value: string): string[] {
  return fold(value).split(/[\s\-.']+/u).filter(Boolean);
}

/** Every word of the query is a prefix of some word of the name, so "al" finds
 *  "Alex Chen" and "Sam Alvarez", and "alex c" narrows to the first. */
export function matchesName(name: string, query: string): boolean {
  const needles = words(query);
  if (needles.length === 0) return true;
  const hay = words(name);
  return needles.every((n) => hay.some((w) => w.startsWith(n)));
}

/** How well a name matches, for ordering: the first word matching beats a later one. */
function matchRank(name: string, query: string): number {
  const first = words(query)[0];
  if (!first) return 1;
  return words(name)[0]?.startsWith(first) ? 0 : 1;
}

const ROLE_RANK: Record<string, number> = { host: 0, panelist: 1, attendee: 2 };

/** The picker's rows for a query: matches only, best first, then the stage ahead of
 *  the audience, then by name. @everyone, when offered, matches "e", "every", … */
export function filterCandidates(
  candidates: readonly MentionCandidate[],
  query: string,
): MentionCandidate[] {
  return candidates
    .filter((c) =>
      c.identity === MENTION_EVERYONE
        ? fold("everyone").startsWith(fold(query.trim()))
        : matchesName(c.name, query),
    )
    .map((c) => ({ c, rank: c.identity === MENTION_EVERYONE ? -1 : matchRank(c.name, query) }))
    .sort(
      (a, b) =>
        a.rank - b.rank ||
        (ROLE_RANK[a.c.role] ?? 3) - (ROLE_RANK[b.c.role] ?? 3) ||
        a.c.name.localeCompare(b.c.name),
    )
    .map(({ c }) => c);
}

// ---------------------------------------------------------------- permission

export type MentionContext = {
  me: { identity: string; role: Role };
  /** The host, or a co-host — the only people who may use @everyone. */
  canMentionEveryone: boolean;
  hideAttendees: boolean;
  /** Where the message being written will go. */
  destination: ChatDestination;
};

/** One person, by the same rules the server applies. */
export function canMention(ctx: MentionContext, target: MentionCandidate): boolean {
  if (target.identity === MENTION_EVERYONE) return ctx.canMentionEveryone;
  if (target.identity === ctx.me.identity) return false;
  if (onStage(target.role)) return true;
  // An attendee cannot read a panelists-only line, whoever wrote it.
  if (ctx.destination === "panelists") return false;
  // The audience may find each other only when the host has not hidden them.
  return onStage(ctx.me.role) || !ctx.hideAttendees;
}

/** Everyone this person may tag right now, from the people their client can see.
 *
 *  `people` may contain duplicates from several sources (the LiveKit list, the host's
 *  roster, recent chat senders); the first entry for an identity wins, so pass the most
 *  authoritative source first. Recorder and egress participants are never offered. */
export function mentionCandidates(
  ctx: MentionContext,
  people: readonly MentionCandidate[],
): MentionCandidate[] {
  const out: MentionCandidate[] = [];
  const seen = new Set<string>();
  if (ctx.canMentionEveryone) {
    out.push({ identity: MENTION_EVERYONE, name: "everyone", role: "host" });
    seen.add(MENTION_EVERYONE);
  }
  for (const p of people) {
    if (!p.identity || seen.has(p.identity)) continue;
    if (p.identity.startsWith("EG_") || p.identity.startsWith("REC_")) continue;
    seen.add(p.identity);
    if (canMention(ctx, p)) out.push(p);
  }
  return out;
}

// ------------------------------------------------------------------ the draft

/** The "@query" the caret is in, if any: where its "@" is, and what follows it.
 *
 *  Only at a word start — "ana@example.com" is an address, not a tag — and never
 *  inside a tag already placed, so moving the caret into "@Alex Chen" does not
 *  reopen the picker over it. Spaces are allowed, so "@alex c" can narrow by surname;
 *  the caller closes the picker when nothing matches. */
export function activeQuery(
  draft: Draft,
  caret: number,
): { start: number; query: string } | null {
  const { text, mentions } = draft;
  if (caret < 0 || caret > text.length) return null;
  if (mentions.some((m) => caret > m.start && caret <= m.end)) return null;

  const from = Math.max(0, caret - MAX_QUERY_CHARS - 1);
  const at = text.lastIndexOf("@", caret - 1);
  if (at < from || at < 0) return null;
  const before = at === 0 ? "" : text[at - 1];
  if (before && !/[\s([{"'“‘]/u.test(before)) return null;
  const query = text.slice(at + 1, caret);
  if (/[\n@]/.test(query) || /\s\s/.test(query) || /^\s/.test(query)) return null;
  // The "@" itself must not belong to a tag that ends right before the caret.
  if (mentions.some((m) => m.start === at)) return null;
  return { start: at, query };
}

/** Replaces the "@query" between `start` and `caret` with a tag and one space. */
export function insertMention(
  draft: Draft,
  start: number,
  caret: number,
  person: MentionCandidate,
): Draft & { caret: number } {
  const name = person.identity === MENTION_EVERYONE ? "everyone" : person.name;
  const token = `@${name}`;
  const after = draft.text.slice(caret);
  const spacer = after.startsWith(" ") ? "" : " ";
  const text = draft.text.slice(0, start) + token + spacer + after;
  const delta = token.length + spacer.length - (caret - start);
  const mentions = draft.mentions
    .filter((m) => m.end <= start || m.start >= caret)
    .map((m) => (m.start >= caret ? { ...m, start: m.start + delta, end: m.end + delta } : m));
  mentions.push({ identity: person.identity, name, start, end: start + token.length });
  mentions.sort((a, b) => a.start - b.start);
  return { text, mentions, caret: start + token.length + 1 };
}

/* Carries the tags across an arbitrary edit.
 *
 * The edit is found as the span between the common prefix and the common suffix of the
 * old and new text, which covers typing, deleting, pasting, autocorrect and IME in one
 * rule. A tag entirely outside that span shifts with it; a tag the span touches is
 * dropped — its "@Name" becomes ordinary text the person can keep editing — and every
 * survivor is checked against the text it claims to cover, so a stale offset can never
 * attach an identity to the wrong words.
 */
export function reconcileMentions(prev: Draft, nextText: string): DraftMention[] {
  const a = prev.text;
  const b = nextText;
  let head = 0;
  const limit = Math.min(a.length, b.length);
  while (head < limit && a[head] === b[head]) head++;
  let tail = 0;
  while (
    tail < limit - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) {
    tail++;
  }
  const oldEnd = a.length - tail;
  const delta = b.length - a.length;

  const out: DraftMention[] = [];
  for (const m of prev.mentions) {
    let next: DraftMention | null = null;
    if (m.end <= head) next = m;
    else if (m.start >= oldEnd) next = { ...m, start: m.start + delta, end: m.end + delta };
    if (next && b.slice(next.start, next.end) === `@${next.name}`) out.push(next);
  }
  return out;
}

/** Backspace or Delete next to a tag removes the whole tag. Returns null when the key
 *  should do what it always does. */
export function deleteMention(
  draft: Draft,
  selStart: number,
  selEnd: number,
  key: "Backspace" | "Delete",
): (Draft & { caret: number }) | null {
  if (selStart !== selEnd) return null;
  const hit = draft.mentions.find((m) =>
    key === "Backspace"
      ? selStart > m.start && selStart <= m.end
      : selStart >= m.start && selStart < m.end,
  );
  if (!hit) return null;
  const width = hit.end - hit.start;
  const text = draft.text.slice(0, hit.start) + draft.text.slice(hit.end);
  const mentions = draft.mentions
    .filter((m) => m !== hit)
    .map((m) => (m.start >= hit.end ? { ...m, start: m.start - width, end: m.end - width } : m));
  return { text, mentions, caret: hit.start };
}

/** The identities to send with this draft: every tag still intact, once each, in the
 *  order they appear, capped at the server's limit. */
export function outgoingMentions(draft: Draft): string[] {
  const out: string[] = [];
  for (const m of [...draft.mentions].sort((x, y) => x.start - y.start)) {
    if (draft.text.slice(m.start, m.end) !== `@${m.name}`) continue;
    if (!out.includes(m.identity)) out.push(m.identity);
    if (out.length === MAX_MENTIONS) break;
  }
  return out;
}

/** Highlight ranges for the composer's backdrop: plain text and tag runs, in order. */
export function draftSegments(draft: Draft): MentionSegment[] {
  const out: MentionSegment[] = [];
  let at = 0;
  for (const m of [...draft.mentions].sort((x, y) => x.start - y.start)) {
    if (m.start < at) continue;
    if (m.start > at) out.push({ text: draft.text.slice(at, m.start) });
    out.push({ text: draft.text.slice(m.start, m.end), mention: m.identity });
    at = m.end;
  }
  if (at < draft.text.length) out.push({ text: draft.text.slice(at) });
  return out;
}

// ---------------------------------------------------------------- rendering

export type MentionSegment = { text: string; mention?: string };

/** Whether a delivered message tags this person — by identity, or by @everyone from
 *  somebody else. The server only delivers @everyone to people who can read it. */
export function mentionsMe(
  message: { mentions?: string[]; from: { identity: string } },
  myIdentity: string,
): boolean {
  const list = message.mentions;
  if (!list || list.length === 0 || message.from.identity === myIdentity) return false;
  return list.includes(myIdentity) || list.includes(MENTION_EVERYONE);
}

/* Splits a delivered message into plain runs and "@Name" runs.
 *
 * The message carries identities, not offsets, so each tag is found by looking for "@"
 * followed by that person's name. `nameFor` resolves an identity to the name this
 * client knows them by — from the participant list, the roster, or who has spoken in
 * chat. An identity it cannot resolve (a hidden attendee, seen by another attendee) is
 * simply not highlighted: the text still reads "@Name".
 *
 * Longest name first, so "@Alex Chen" is never cut to "@Alex" by a second Alex, and a
 * name must end at a word boundary so "@Al" does not light up inside "@Alice".
 */
export function mentionSegments(
  text: string,
  mentions: readonly string[] | undefined,
  nameFor: (identity: string) => string | undefined,
): MentionSegment[] {
  if (!mentions || mentions.length === 0 || !text.includes("@")) return [{ text }];

  const names: { identity: string; token: string }[] = [];
  for (const identity of mentions) {
    const name = identity === MENTION_EVERYONE ? "everyone" : nameFor(identity);
    if (name && name.trim()) names.push({ identity, token: fold(`@${name.trim()}`) });
  }
  if (names.length === 0) return [{ text }];
  names.sort((x, y) => y.token.length - x.token.length);

  // Folding can change length (a precomposed "é" is one unit, a decomposed one two), so
  // matching runs per position against the folded slice of the original.
  const out: MentionSegment[] = [];
  let plain = "";
  let i = 0;
  while (i < text.length) {
    if (text[i] === "@" && (i === 0 || !/[\p{L}\p{N}_.]/u.test(text[i - 1]))) {
      const hit = names.find(({ token }) => {
        const end = matchEnd(text, i, token);
        return end !== -1;
      });
      if (hit) {
        const end = matchEnd(text, i, hit.token);
        if (plain) out.push({ text: plain });
        plain = "";
        out.push({ text: text.slice(i, end), mention: hit.identity });
        i = end;
        continue;
      }
    }
    plain += text[i];
    i++;
  }
  if (plain) out.push({ text: plain });
  return out;
}

/** Where `token` (already folded) ends if it matches `text` at `start` and is followed
 *  by a word boundary; -1 otherwise. */
function matchEnd(text: string, start: number, token: string): number {
  for (let end = start + 1; end <= text.length && end <= start + token.length * 2; end++) {
    const folded = fold(text.slice(start, end));
    if (folded.length > token.length) return -1;
    if (folded === token) {
      const next = text[end];
      return next === undefined || !/[\p{L}\p{N}_]/u.test(next) ? end : -1;
    }
  }
  return -1;
}

// ------------------------------------------------------------- notification

type Notifiable = {
  id: string;
  text: string;
  media?: unknown;
  mentions?: string[];
  from: { identity: string; name: string; role: Role };
};

/** Mirrors PREVIEW_CHARS in chat-notify.ts. Kept here rather than imported so this
 *  file stays free of React and runs under node for its tests. */
const MENTION_PREVIEW_CHARS = 90;

export type MentionPreview = {
  /** The message the panel scrolls to: the OLDEST unanswered mention, for the same
   *  reason the ordinary card anchors on the oldest of its run. */
  anchorId: string;
  sender: string;
  senderIdentity: string;
  senderRole: Role;
  text: string;
  /** How many mentions this card stands for. */
  count: number;
  /** The latest was an @everyone rather than a personal tag, which the card says. */
  everyone: boolean;
};

/** Folds the mentions of me in a batch of arrivals into the mention card. Returns
 *  `current` unchanged when nothing in the batch tags me. */
export function coalesceMentions(
  current: MentionPreview | null,
  fresh: readonly Notifiable[],
  myIdentity: string,
): MentionPreview | null {
  let next = current;
  for (const message of fresh) {
    if (!mentionsMe(message, myIdentity)) continue;
    const flat = message.text.replace(/\s+/g, " ").trim();
    const text = !flat
      ? message.media ? "Sent an image" : ""
      : flat.length > MENTION_PREVIEW_CHARS
        ? `${flat.slice(0, MENTION_PREVIEW_CHARS - 1)}…`
        : flat;
    const who = {
      sender: message.from.name,
      senderIdentity: message.from.identity,
      senderRole: message.from.role,
      text,
      everyone: !message.mentions?.includes(myIdentity),
    };
    next = next
      ? { anchorId: next.anchorId, ...who, count: next.count + 1 }
      : { anchorId: message.id, ...who, count: 1 };
  }
  return next;
}

/** The mention card's headline: "Alex mentioned you", "Alex mentioned everyone", or a
 *  count when several have piled up. */
export function mentionHeadline(preview: MentionPreview): string {
  if (preview.count > 1) return `${preview.count} mentions`;
  const first = preview.sender.split(/\s+/)[0] || preview.sender;
  return preview.everyone ? `${first} mentioned everyone` : `${first} mentioned you`;
}

/** Messages that tag me which I have not seen yet — the "@" on the Chat button.
 *
 *  By id, not by position, for the reason freshMessages gives: a reconnect merges
 *  history into the middle of the conversation. A mention scrolled past in an open
 *  panel counts as seen; one that arrived while the panel was shut does not until it
 *  is opened. */
export function unseenMentions(
  chat: readonly Notifiable[],
  myIdentity: string,
  seen: ReadonlySet<string>,
): string[] {
  const out: string[] = [];
  for (const m of chat) {
    if (!seen.has(m.id) && mentionsMe(m, myIdentity)) out.push(m.id);
  }
  return out;
}

/** What a tool's badge says. An unseen mention outranks the count — "@" is the thing
 *  worth opening Chat for, and "37" beside it would bury it. Null for no badge. */
export function badgeText(count: number | undefined, mentions = 0): string | null {
  if (mentions > 0) return "@";
  if (!count || count <= 0) return null;
  return count > 99 ? "99+" : String(count);
}
