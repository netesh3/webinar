/* "Write with AI": what a draft fills in, and what the host is told when it fails.
 *
 * Run: node --experimental-strip-types --no-warnings lib/ai-setup.test.mts */

import assert from "node:assert/strict";
import type { AIWebinarSetup } from "./api-types.ts";
import {
  aiErrorMessage,
  fillFromDraft,
  overwrites,
  registrationCopyText,
  socialPostList,
} from "./ai-setup.ts";

const draft: AIWebinarSetup = {
  title: "Money basics for young earners",
  description: "A calm hour on budgeting.\n\nFor anyone in their first job.",
  registrationHeadline: "Learn to budget your first salary",
  registrationBullets: ["Split your salary in three", "Start an emergency fund", "Pick one simple SIP"],
  socialPosts: { linkedin: "Join me.", instagram: "", whatsapp: "Register here:" },
};

// Fills topic and description; nothing else.
const empty = { topic: "", description: "" };
assert.deepEqual(fillFromDraft(draft, empty), { topic: draft.title, description: draft.description });
assert.equal(overwrites(empty, fillFromDraft(draft, empty)), false);

// An empty field in the draft keeps the host's own words.
const mine = { topic: "My own title", description: "My notes" };
assert.deepEqual(fillFromDraft({ ...draft, description: "  " }, mine), {
  topic: draft.title,
  description: "My notes",
});
assert.equal(overwrites(mine, fillFromDraft(draft, mine)), true);
assert.equal(overwrites(mine, mine), false);

// Registration copy as one paste-ready block.
assert.equal(
  registrationCopyText(draft),
  "Learn to budget your first salary\n\n• Split your salary in three\n• Start an emergency fund\n• Pick one simple SIP",
);

// Posts: WhatsApp first, empty ones dropped.
assert.deepEqual(
  socialPostList(draft).map((p) => p.channel),
  ["WhatsApp", "LinkedIn"],
);

// Errors, in the host's words.
assert.match(aiErrorMessage({ code: "ai_limit" }), /^AI limit reached for this month/);
assert.equal(aiErrorMessage({ code: "feature_off" }), "AI is off for your account.");
assert.equal(
  aiErrorMessage({ code: "validation_failed", fields: { idea: "Keep it under 300 characters." } }),
  "Keep it under 300 characters.",
);
assert.match(aiErrorMessage({ code: "ai_unavailable" }), /isn't available right now/);
assert.match(aiErrorMessage({ code: "internal" }), /Couldn't write a draft/);

console.log("ai-setup: ok");
