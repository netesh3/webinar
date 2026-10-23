import assert from "node:assert/strict";
import type { SpamFlag } from "./api-types.ts";
import {
  actionsFor,
  alertText,
  categoryLabel,
  confidenceLabel,
  flagKey,
  flagsFor,
  newFlags,
  spamResultsNote,
  statusLabel,
  waitingCount,
  whyLabel,
} from "./spam.ts";

const f = (id: string, over: Partial<SpamFlag> = {}): SpamFlag => ({
  kind: "chat",
  id,
  identity: `att_${id}`,
  name: "Ravi",
  text: `message ${id}`,
  category: "promo",
  confidence: 0.9,
  source: "rules",
  reasons: ["whatsapp"],
  status: "flagged",
  at: "2026-10-23T10:00:00Z",
  ...over,
});

// The list: one kind, waiting first and newest first, "not spam" left out.
{
  const flags = [
    f("old", { at: "2026-10-23T09:00:00Z" }),
    f("done", { status: "deleted", at: "2026-10-23T11:00:00Z" }),
    f("new", { at: "2026-10-23T10:30:00Z" }),
    f("fine", { status: "not_spam" }),
    f("q1", { kind: "question" }),
  ];
  assert.deepEqual(flagsFor(flags, "chat").map((x) => x.id), ["new", "old", "done"]);
  assert.deepEqual(flagsFor(flags, "question").map((x) => x.id), ["q1"]);
  assert.equal(waitingCount(flags, "chat"), 2);
  assert.equal(waitingCount(flags, "question"), 1);
}

// The alert: only what is new, and what it says.
{
  const flags = [f("a"), f("b", { status: "deleted" }), f("c", { kind: "question", name: "" })];
  const seen = new Set([flagKey(flags[0])]);
  const fresh = newFlags(seen, flags);
  assert.deepEqual(fresh.map((x) => x.id), ["c"]);
  assert.equal(alertText(fresh), "Possible spam in Q&A from an attendee. Open the Flagged filter to review it.");
  assert.equal(alertText([]), null);
  assert.match(alertText([f("x"), f("y")]) ?? "", /^2 messages flagged/);
  assert.equal(alertText([f("h", { status: "auto_hidden" })]), "Spam from Ravi was hidden from chat.");
}

// Labels.
{
  assert.equal(categoryLabel("scam"), "Scam");
  assert.equal(categoryLabel("off_topic"), "Off-topic");
  assert.equal(categoryLabel("weird"), "Spam");
  assert.equal(confidenceLabel(0.924), "92%");
  assert.equal(confidenceLabel(3), "100%");
  assert.equal(whyLabel({ source: "rules", reasons: ["link", "phone"] }), "link, phone number");
  assert.equal(whyLabel({ source: "ai", reasons: [] }), "AI");
  assert.equal(statusLabel("auto_hidden"), "Auto-hidden");
  assert.equal(statusLabel("flagged"), "");
}

// Actions: Delete for chat, Hide for a question, Mute or Unmute, nothing after a removal.
{
  const labels = (x: SpamFlag, muted = false) => actionsFor(x, muted).map((a) => a.action);
  assert.deepEqual(labels(f("a")), ["delete", "remove", "mute", "not_spam"]);
  assert.deepEqual(labels(f("q", { kind: "question" })), ["hide", "remove", "mute", "not_spam"]);
  assert.deepEqual(labels(f("m", { status: "muted" }), true), ["remove", "unmute"]);
  assert.deepEqual(labels(f("h", { status: "auto_hidden" })), ["remove", "mute", "not_spam"]);
  assert.deepEqual(labels(f("r", { status: "removed" })), []);
}

// Results.
{
  assert.equal(spamResultsNote(0, 0), null);
  assert.equal(spamResultsNote(undefined, undefined), null);
  assert.equal(spamResultsNote(1, 0), "1 message flagged as spam.");
  assert.equal(spamResultsNote(4, 3), "4 messages flagged as spam, 3 removed.");
}

console.log("spam: ok");
