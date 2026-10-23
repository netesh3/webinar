import assert from "node:assert/strict";
import {
  answerProblem,
  addPrefill,
  draftSourceChips,
  knowledgeAddHref,
  NO_CONFIDENT_ANSWER,
  filterPastAnswers,
  folderTag,
  libraryFull,
  MAX_ANSWER_CHARS,
  PAST_ANSWER_MAX,
  pastAnswerProblem,
  pastAnswerSource,
  pastAnswersSummary,
  shortDate,
  sourceLabel,
  updatedFromLabel,
  uploadProblem,
  usageLabel,
  vaultProblem,
  wordsLabel,
} from "./knowledge.ts";

const MB = 1 << 20;
const limits = {
  maxDocs: 50,
  maxDocWords: 50_000,
  maxWords: 250_000,
  maxUploadBytes: 10 * MB,
};

// Uploads: the types the server reads, within the size.
assert.equal(uploadProblem("FAQ.PDF", 1000, 10 * MB), null);
assert.equal(uploadProblem("notes.md", 10, 10 * MB), null);
assert.equal(uploadProblem("guide.docx", 10, 10 * MB), null);
assert.match(uploadProblem("deck.pptx", 10, 10 * MB) ?? "", /PDF, Word/);
assert.match(uploadProblem("old.doc", 10, 10 * MB) ?? "", /PDF, Word/);
assert.equal(uploadProblem("a.txt", 0, 10 * MB), "That file is empty.");
assert.equal(
  uploadProblem("a.txt", 10 * MB + 1, 10 * MB),
  "Files must be under 10 MB.",
);

assert.equal(sourceLabel("text"), "Pasted text");
assert.equal(sourceLabel("docx"), "Word");
assert.equal(sourceLabel("pdf"), "PDF");
assert.equal(wordsLabel(1), "1 word");
assert.equal(wordsLabel(1234), "1,234 words");
assert.equal(
  usageLabel(3, 12000, limits),
  "12,000 of 2,50,000 words · 3 of 50 documents",
);
assert.equal(libraryFull(49, 1000, limits), false);
assert.equal(libraryFull(50, 1000, limits), true);
assert.equal(libraryFull(1, 250_000, limits), true);

// Draft chips: the documents it came from; nothing for an old ungrounded draft.
assert.deepEqual(
  draftSourceChips({ grounded: true, sources: ["Course FAQ", "Refunds"] }),
  ["From: Course FAQ", "From: Refunds"],
);
assert.deepEqual(draftSourceChips({ grounded: true, sources: [] }), [
  "From: this session",
]);
assert.deepEqual(
  draftSourceChips({ grounded: false, sources: ["Course FAQ"] }),
  [],
);

// Posting: not empty, not past the packet's limit (counted in characters, not UTF-16 units).
assert.equal(answerProblem("  "), "Write the answer to post.");
assert.equal(answerProblem("Fee 499 hai."), null);
assert.equal(answerProblem("x".repeat(MAX_ANSWER_CHARS)), null);
assert.match(
  answerProblem("x".repeat(MAX_ANSWER_CHARS + 1)) ?? "",
  /under 600/,
);
assert.equal(answerProblem("😀".repeat(MAX_ANSWER_CHARS)), null);

// Vaults: a zip, within the size; a note's folder as its tag.
assert.equal(vaultProblem("My Vault.ZIP", 1000, 10 * MB), null);
assert.match(vaultProblem("vault.rar", 1000, 10 * MB) ?? "", /\.zip/);
assert.equal(vaultProblem("v.zip", 0, 10 * MB), "That file is empty.");
assert.equal(
  vaultProblem("v.zip", 10 * MB + 1, 10 * MB),
  "Zipped vaults must be under 10 MB.",
);
assert.equal(folderTag("Course/Week 1"), "Course › Week 1");
assert.equal(folderTag(""), null);
assert.equal(folderTag(undefined), null);
assert.equal(folderTag("/a//b/"), "a › b");

// Past answers: where they came from, what a repeat changed, the count line.
assert.equal(shortDate("2026-10-22T18:30:00Z"), "22 Oct 2026");
assert.equal(shortDate(""), "");
assert.equal(shortDate("nonsense"), "");
assert.equal(
  pastAnswerSource({
    sourceTopic: "Money basics",
    sourceAt: "2026-10-22T10:00:00Z",
  }),
  "Money basics · 22 Oct 2026",
);
assert.equal(pastAnswerSource({}), "");
assert.equal(
  updatedFromLabel({
    canUndo: true,
    updatedFrom: "February batch",
    updatedFromAt: "2026-02-03T10:00:00Z",
  }),
  "Updated from February batch · 3 Feb 2026",
);
assert.equal(
  updatedFromLabel({ canUndo: false, updatedFrom: "February batch" }),
  null,
);
assert.equal(
  updatedFromLabel({ canUndo: true }),
  "Updated from a later session",
);
assert.equal(pastAnswersSummary(0, 14), "14 saved");
assert.equal(pastAnswersSummary(2, 1200), "2 to review · 1,200 saved");
assert.equal(pastAnswerProblem(" ", "a"), "Write the question.");
assert.equal(pastAnswerProblem("q", ""), "Write the answer.");
assert.equal(pastAnswerProblem("q", "a"), null);
assert.match(
  pastAnswerProblem("q", "x".repeat(PAST_ANSWER_MAX + 1)) ?? "",
  /under 2000/,
);
const entries = [
  { question: "What is the fee?", answer: "499 rupees" },
  { question: "Recording milegi?", answer: "Haan, 24 ghante mein" },
];
assert.equal(filterPastAnswers(entries, "").length, 2);
assert.deepEqual(filterPastAnswers(entries, "FEE 499"), [entries[0]]);
assert.deepEqual(filterPastAnswers(entries, "ghante"), [entries[1]]);
assert.deepEqual(filterPastAnswers(entries, "refund"), []);

// The panel declines rather than guessing, with a way to add what was missing.
assert.equal(NO_CONFIDENT_ANSWER, "No confident answer in your knowledge");
assert.equal(knowledgeAddHref("  Certificate milega? "), "/host/knowledge?add=Certificate%20milega%3F");
assert.equal(knowledgeAddHref("  "), "/host/knowledge");
assert.deepEqual(addPrefill("?add=Certificate%20milega%3F"), { title: "Certificate milega?", text: "Q: Certificate milega?\nA: " });
assert.equal(addPrefill(""), null);
assert.equal(addPrefill("?add=%20%20"), null);
assert.equal([...(addPrefill("?add=" + "x".repeat(300))?.title ?? "")].length, 120);
// The link and the prefill agree.
assert.equal(addPrefill(knowledgeAddHref("Do we get a certificate?").split("?")[1] ?? "")?.title, "Do we get a certificate?");

console.log("knowledge: ok");
