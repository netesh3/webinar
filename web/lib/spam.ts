/* Spam detection's view for the host team, the pure half (components/room/spam-alerts.tsx
 * draws it). The server flags (GET /spam, api/internal/api/spam.go): free rules on every
 * attendee message, and a batched AI pass over the suspicious ones. Here: which flags a panel
 * lists, what the alert says, and which one-click actions a flag offers. The audience never
 * reads a flag: nothing here runs for them. */

import type { SpamFlag } from "./api-types.ts";

export type SpamKind = "chat" | "question";

export type SpamAction = "delete" | "hide" | "remove" | "mute" | "unmute" | "not_spam";

/** A flag still waiting for the host team. */
export function isWaiting(f: Pick<SpamFlag, "status">): boolean {
  return f.status === "flagged";
}

/** The flags a panel's Flagged filter lists, for one kind: waiting first (newest first),
 *  then the ones already dealt with. "Not spam" drops out of the list. */
export function flagsFor(flags: readonly SpamFlag[], kind: SpamKind): SpamFlag[] {
  const mine = flags.filter((f) => f.kind === kind && f.status !== "not_spam");
  const at = (f: SpamFlag) => Date.parse(f.at) || 0;
  return mine.sort((a, b) => Number(isWaiting(b)) - Number(isWaiting(a)) || at(b) - at(a));
}

/** How many flags of one kind are waiting: the count on the Flagged filter. */
export function waitingCount(flags: readonly SpamFlag[], kind: SpamKind): number {
  return flags.filter((f) => f.kind === kind && isWaiting(f)).length;
}

export function flagKey(f: Pick<SpamFlag, "kind" | "id">): string {
  return `${f.kind}:${f.id}`;
}

/** The waiting flags not in `seen`: what a new alert is about. */
export function newFlags(seen: ReadonlySet<string>, flags: readonly SpamFlag[]): SpamFlag[] {
  return flags.filter((f) => (isWaiting(f) || f.status === "auto_hidden") && !seen.has(flagKey(f)));
}

/** The in-room alert for newly flagged messages; null when there is nothing new. */
export function alertText(fresh: readonly SpamFlag[]): string | null {
  if (fresh.length === 0) return null;
  if (fresh.length === 1) {
    const f = fresh[0];
    const where = f.kind === "question" ? "Q&A" : "chat";
    const who = f.name.trim() || "an attendee";
    return f.status === "auto_hidden"
      ? `Spam from ${who} was hidden from ${where}.`
      : `Possible spam in ${where} from ${who}. Open the Flagged filter to review it.`;
  }
  return `${fresh.length} messages flagged as possible spam. Open the Flagged filter to review them.`;
}

const CATEGORY: Record<string, string> = {
  promo: "Promotion",
  scam: "Scam",
  abuse: "Abuse",
  off_topic: "Off-topic",
  other: "Spam",
};

export function categoryLabel(category: string): string {
  return CATEGORY[category] ?? "Spam";
}

/** "92%", for the confidence chip. */
export function confidenceLabel(confidence: number): string {
  const pct = Math.round(Math.min(1, Math.max(0, confidence)) * 100);
  return `${pct}%`;
}

const REASON: Record<string, string> = {
  link: "link",
  phone: "phone number",
  whatsapp: "group invite",
  scam_words: "scam words",
  dm_me: "“DM me”",
  repeat: "repeated",
  copy_paste: "copy-pasted",
  flood: "flooding",
  caps: "all caps",
  emoji: "emoji flood",
};

/** Why it was flagged, in a few words: the rules that matched, or "AI" for the model's. */
export function whyLabel(f: Pick<SpamFlag, "source" | "reasons">): string {
  const rules = f.reasons.map((r) => REASON[r]).filter(Boolean);
  if (f.source === "ai") return rules.length ? `AI · ${rules.join(", ")}` : "AI";
  return rules.join(", ") || "rules";
}

const STATUS: Record<string, string> = {
  auto_hidden: "Auto-hidden",
  deleted: "Deleted",
  hidden: "Hidden",
  removed: "Person removed",
  muted: "Muted",
  not_spam: "Not spam",
};

/** What happened to it, for a flag already dealt with; "" while it is waiting. */
export function statusLabel(status: string): string {
  return STATUS[status] ?? "";
}

/** The one-click actions a flag offers. A waiting chat message offers Delete, a waiting
 *  question Hide; every flag offers Remove person, Mute chat (or Unmute) and Not spam until
 *  its sender is removed. */
export function actionsFor(f: Pick<SpamFlag, "kind" | "status">, muted: boolean): { action: SpamAction; label: string }[] {
  const out: { action: SpamAction; label: string }[] = [];
  if (isWaiting(f)) {
    out.push(f.kind === "chat" ? { action: "delete", label: "Delete" } : { action: "hide", label: "Hide" });
  }
  if (f.status === "removed") return out;
  out.push({ action: "remove", label: "Remove person" });
  out.push(muted ? { action: "unmute", label: "Unmute" } : { action: "mute", label: "Mute chat" });
  if (isWaiting(f) || f.status === "auto_hidden") out.push({ action: "not_spam", label: "Not spam" });
  return out;
}

/** The Results line: "4 messages flagged as spam, 3 removed."; null with nothing flagged. */
export function spamResultsNote(flagged: number | undefined, removed: number | undefined): string | null {
  if (!flagged) return null;
  const n = `${flagged} ${flagged === 1 ? "message" : "messages"} flagged as spam`;
  return removed ? `${n}, ${removed} removed.` : `${n}.`;
}
