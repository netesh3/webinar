import assert from "node:assert/strict";
import {
  answerProblem,
  draftSourceChips,
  libraryFull,
  MAX_ANSWER_CHARS,
  sourceLabel,
  uploadProblem,
  usageLabel,
  wordsLabel,
} from "./knowledge.ts";

const MB = 1 << 20;
const limits = { maxDocs: 50, maxDocWords: 50_000, maxWords: 250_000, maxUploadBytes: 10 * MB };

// Uploads: the types the server reads, within the size.
assert.equal(uploadProblem("FAQ.PDF", 1000, 10 * MB), null);
assert.equal(uploadProblem("notes.md", 10, 10 * MB), null);
assert.equal(uploadProblem("guide.docx", 10, 10 * MB), null);
assert.match(uploadProblem("deck.pptx", 10, 10 * MB) ?? "", /PDF, Word/);
assert.match(uploadProblem("old.doc", 10, 10 * MB) ?? "", /PDF, Word/);
assert.equal(uploadProblem("a.txt", 0, 10 * MB), "That file is empty.");
assert.equal(uploadProblem("a.txt", 10 * MB + 1, 10 * MB), "Files must be under 10 MB.");

assert.equal(sourceLabel("text"), "Pasted text");
assert.equal(sourceLabel("docx"), "Word");
assert.equal(sourceLabel("pdf"), "PDF");
assert.equal(wordsLabel(1), "1 word");
assert.equal(wordsLabel(1234), "1,234 words");
assert.equal(usageLabel(3, 12000, limits), "12,000 of 2,50,000 words · 3 of 50 documents");
assert.equal(libraryFull(49, 1000, limits), false);
assert.equal(libraryFull(50, 1000, limits), true);
assert.equal(libraryFull(1, 250_000, limits), true);

// Draft chips: the documents it came from; nothing for a general answer.
assert.deepEqual(draftSourceChips({ grounded: true, sources: ["Course FAQ", "Refunds"] }), ["From: Course FAQ", "From: Refunds"]);
assert.deepEqual(draftSourceChips({ grounded: true, sources: [] }), ["From: this session"]);
assert.deepEqual(draftSourceChips({ grounded: false, sources: ["Course FAQ"] }), []);

// Posting: not empty, not past the packet's limit (counted in characters, not UTF-16 units).
assert.equal(answerProblem("  "), "Write the answer to post.");
assert.equal(answerProblem("Fee 499 hai."), null);
assert.equal(answerProblem("x".repeat(MAX_ANSWER_CHARS)), null);
assert.match(answerProblem("x".repeat(MAX_ANSWER_CHARS + 1)) ?? "", /under 600/);
assert.equal(answerProblem("😀".repeat(MAX_ANSWER_CHARS)), null);

console.log("knowledge: ok");
