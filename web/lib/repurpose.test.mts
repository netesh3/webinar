/* Content repurposing's pure half: formats, states, file names, length notes and the preview.
 *
 * Run: node --experimental-strip-types --no-warnings lib/repurpose.test.mts */

import assert from "node:assert/strict";
import type { RepurposeDraft } from "./api-types.ts";
import {
  REPURPOSE_FORMATS,
  draftBadge,
  draftFailedText,
  draftFileName,
  draftsPending,
  formatLabel,
  inline,
  isPlainFormat,
  lengthNote,
  markdownBlocks,
  repurposeBlockedText,
} from "./repurpose.ts";

const draft = (patch: Partial<RepurposeDraft>): RepurposeDraft => ({
  format: "blog",
  status: "ready",
  markdown: "",
  edited: false,
  reviewed: false,
  ...patch,
});

// Six formats, the server's ids, the social ones plain text.
assert.deepEqual(
  REPURPOSE_FORMATS.map((f) => f.id),
  ["blog", "newsletter", "whitepaper", "linkedin", "x_thread", "instagram"],
);
assert.equal(formatLabel("x_thread"), "X thread");
assert.equal(isPlainFormat("linkedin"), true);
assert.equal(isPlainFormat("blog"), false);

// Blocked states say why, in words; ready says nothing.
assert.equal(repurposeBlockedText("ready"), null);
assert.match(repurposeBlockedText("no_transcript")!, /nothing to write from/);
assert.match(repurposeBlockedText("something_new")!, /can't be written/);
assert.match(draftFailedText("ai_limit"), /allowance/);
assert.match(draftFailedText(undefined), /Try again/);

// A ready draft is flagged until the host has reviewed it.
assert.deepEqual(draftBadge(draft({})), { text: "AI draft, not reviewed", tone: "warn" });
assert.equal(draftBadge(draft({ reviewed: true })).text, "Reviewed");
assert.equal(draftBadge(draft({ status: "writing" })).text, "Writing…");
assert.equal(draftBadge(draft({ status: "failed" })).tone, "live");
assert.equal(draftsPending([draft({}), draft({ status: "queued" })]), true);
assert.equal(draftsPending([draft({}), draft({ status: "failed" })]), false);

assert.equal(draftFileName("blog", "Money basics: for young earners!"), "blog-post-money-basics-for-young-earners.md");
assert.equal(draftFileName("x_thread", "???"), "x-thread.md");

// X posts are counted one by one; LinkedIn and Instagram as a whole; long-form not at all.
const thread = `1/ ${"a".repeat(100)}\n\n2/ ${"b".repeat(290)}\n\n3/ done`;
assert.deepEqual(lengthNote("x_thread", thread), { text: "Post 2 is over X's 280 characters.", over: true });
assert.deepEqual(lengthNote("x_thread", "1/ hi\n\n2/ there"), { text: "2 posts, each under 280 characters.", over: false });
assert.equal(lengthNote("linkedin", "x".repeat(3001))!.over, true);
assert.equal(lengthNote("instagram", "short")!.text, "5 of Instagram's 2,200 characters.");
assert.equal(lengthNote("blog", "anything"), null);

// The preview: headings, paragraphs joined, lists, bold and italic.
assert.deepEqual(inline("Pay **yourself** first, *then* the rest"), [
  { text: "Pay " },
  { text: "yourself", bold: true },
  { text: " first, " },
  { text: "then", italic: true },
  { text: " the rest" },
]);
assert.deepEqual(inline("snake_case_word stays"), [{ text: "snake_case_word stays" }]);
const blocks = markdownBlocks("# Title\n\nOne line\nand the next.\n\n- first\n- second\n\n1. one\n2. two\n\n## Next\nText");
assert.deepEqual(
  blocks.map((b) => b.kind),
  ["heading", "paragraph", "list", "list", "heading", "paragraph"],
);
assert.deepEqual(blocks[1], { kind: "paragraph", text: [{ text: "One line and the next." }] });
assert.equal(blocks[2].kind === "list" && !blocks[2].ordered && blocks[2].items.length, 2);
assert.equal(blocks[3].kind === "list" && blocks[3].ordered, true);
// Plain formats keep their lines, and a "#hashtag" is not a heading.
const plain = markdownBlocks("Line one\nLine two\n\n#money #sip", true);
assert.deepEqual(
  plain.map((b) => b.kind),
  ["paragraph", "paragraph"],
);
assert.deepEqual(plain[0], { kind: "paragraph", text: [{ text: "Line one\nLine two" }] });

console.log("repurpose: ok");
