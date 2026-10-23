/* The AI knowledge, the pure half: the library page (components/knowledge/knowledge-screen.tsx),
 * a session's pick (session-knowledge-card.tsx) and the draft answers in the room's Q&A
 * (components/room/qa-assist.tsx). The server is api/internal/api/knowledge.go and
 * qa_drafts.go; it checks everything again. */

import { KnowledgeMaxTitleRunes, type KnowledgeLimits, type PastAnswer, type QADraft } from "./api-types.ts";

/** The upload types the server reads, by extension. */
export const KNOWLEDGE_EXTENSIONS = [
  ".pdf",
  ".docx",
  ".txt",
  ".md",
  ".markdown",
] as const;

/** The file picker's accept attribute. */
export const KNOWLEDGE_ACCEPT = [
  ...KNOWLEDGE_EXTENSIONS,
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "text/plain",
  "text/markdown",
].join(",");

/** Why a file cannot be uploaded, before sending it; null when it can. */
export function uploadProblem(
  name: string,
  size: number,
  maxBytes: number,
): string | null {
  const lower = name.toLowerCase();
  if (!KNOWLEDGE_EXTENSIONS.some((ext) => lower.endsWith(ext))) {
    return "Upload a PDF, Word (.docx), text (.txt) or Markdown (.md) file.";
  }
  if (size === 0) return "That file is empty.";
  if (size > maxBytes)
    return `Files must be under ${Math.floor(maxBytes / (1 << 20))} MB.`;
  return null;
}

/** A document's kind, as the list labels it. */
export function sourceLabel(source: string): string {
  switch (source) {
    case "text":
      return "Pasted text";
    case "pdf":
      return "PDF";
    case "docx":
      return "Word";
    case "md":
      return "Markdown";
    case "txt":
      return "Text file";
    default:
      return source.toUpperCase();
  }
}

/** "1 word", "1,234 words". */
export function wordsLabel(n: number): string {
  return `${n.toLocaleString("en-IN")} ${n === 1 ? "word" : "words"}`;
}

/** The library's fill, for the meter: "12,000 of 2,50,000 words · 3 of 50 documents". */
export function usageLabel(
  docs: number,
  words: number,
  limits: KnowledgeLimits,
): string {
  return `${words.toLocaleString("en-IN")} of ${limits.maxWords.toLocaleString("en-IN")} words · ${docs} of ${limits.maxDocs} documents`;
}

/** Whether another document can be added at all (the server checks the words too). */
export function libraryFull(
  docs: number,
  words: number,
  limits: KnowledgeLimits,
): boolean {
  return docs >= limits.maxDocs || words >= limits.maxWords;
}

/** How a draft says where it came from, for the chips under it. */
export function draftSourceChips(
  draft: Pick<QADraft, "grounded" | "sources">,
): string[] {
  if (!draft.grounded) return [];
  if (draft.sources.length === 0) return ["From: this session"];
  return draft.sources.map((s) => `From: ${s}`);
}

/** What the Q&A panel says when the assistant declines (the suggest call's noConfidentAnswer):
 *  it writes no general answers, so a question the knowledge does not clearly answer has no
 *  draft and stays open for the host. */
export const NO_CONFIDENT_ANSWER = "No confident answer in your knowledge";

/** The library, opened to add what a question needed: /host/knowledge?add=<question>. */
export function knowledgeAddHref(question: string): string {
  const q = question.trim();
  return q ? `/host/knowledge?add=${encodeURIComponent(q)}` : "/host/knowledge";
}

/** The library's paste form, prefilled from knowledgeAddHref's ?add=: the question as the
 *  title (within the server's title limit) and a Q/A skeleton for the host to finish. Null
 *  without one. */
export function addPrefill(search: string): { title: string; text: string } | null {
  const q = (new URLSearchParams(search).get("add") ?? "").replace(/\s+/g, " ").trim();
  if (!q) return null;
  const title = [...q].slice(0, KnowledgeMaxTitleRunes).join("");
  return { title, text: `Q: ${q}\nA: ` };
}

/** The most a posted answer may be: what the room's answer packet carries. */
export const MAX_ANSWER_CHARS = 600;

/** Why an edited answer cannot be posted; null when it can. */
export function answerProblem(answer: string): string | null {
  const t = answer.trim();
  if (!t) return "Write the answer to post.";
  if ([...t].length > MAX_ANSWER_CHARS)
    return `Keep it under ${MAX_ANSWER_CHARS} characters.`;
  return null;
}

/** The sentence for a failed knowledge request: the server's own when it gave one. */
export function knowledgeError(err: unknown, fallback: string): string {
  if (
    err &&
    typeof err === "object" &&
    "message" in err &&
    typeof err.message === "string" &&
    err.message
  ) {
    return err.message;
  }
  return fallback;
}

// ------------------------------------------------------------------ Obsidian vaults

/** The vault picker's accept attribute: a zipped vault. */
export const VAULT_ACCEPT = ".zip,application/zip,application/x-zip-compressed";

/** Why a zipped vault cannot be uploaded, before sending it; null when it can. */
export function vaultProblem(
  name: string,
  size: number,
  maxBytes: number,
): string | null {
  if (!name.toLowerCase().endsWith(".zip"))
    return "Zip your vault's folder and upload the .zip file.";
  if (size === 0) return "That file is empty.";
  if (size > maxBytes)
    return `Zipped vaults must be under ${Math.floor(maxBytes / (1 << 20))} MB.`;
  return null;
}

/** A vault note's folder as its tag: "Course › Week 1"; null for a note at the top. */
export function folderTag(folder: string | undefined): string | null {
  const parts = (folder ?? "")
    .split("/")
    .map((p) => p.trim())
    .filter(Boolean);
  return parts.length ? parts.join(" › ") : null;
}

// ------------------------------------------------------------------ past answers

/** "22 Oct 2026" for an RFC 3339 time; "" when there is none. */
export function shortDate(iso: string | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

/** Where an entry came from: "Money basics · 22 Oct 2026". */
export function pastAnswerSource(
  a: Pick<PastAnswer, "sourceTopic" | "sourceAt">,
): string {
  return [a.sourceTopic?.trim(), shortDate(a.sourceAt)]
    .filter(Boolean)
    .join(" · ");
}

/** "Updated from February batch · 22 Oct 2026" for an entry a repeat updated; null otherwise. */
export function updatedFromLabel(
  a: Pick<PastAnswer, "canUndo" | "updatedFrom" | "updatedFromAt">,
): string | null {
  if (!a.canUndo) return null;
  const from = [a.updatedFrom?.trim(), shortDate(a.updatedFromAt)]
    .filter(Boolean)
    .join(" · ");
  return from ? `Updated from ${from}` : "Updated from a later session";
}

/** The section's count line: "2 to review · 14 saved". */
export function pastAnswersSummary(pending: number, approved: number): string {
  const saved = `${approved.toLocaleString("en-IN")} saved`;
  return pending > 0 ? `${pending} to review · ${saved}` : saved;
}

/** The most an entry's question and answer may be, as the server holds them. */
export const PAST_QUESTION_MAX = 600;
export const PAST_ANSWER_MAX = 2000;

/** Why an edited entry cannot be saved; null when it can. */
export function pastAnswerProblem(
  question: string,
  answer: string,
): string | null {
  const q = question.trim();
  const a = answer.trim();
  if (!q) return "Write the question.";
  if (!a) return "Write the answer.";
  if ([...q].length > PAST_QUESTION_MAX)
    return `Keep the question under ${PAST_QUESTION_MAX} characters.`;
  if ([...a].length > PAST_ANSWER_MAX)
    return `Keep the answer under ${PAST_ANSWER_MAX} characters.`;
  return null;
}

/** The entries matching a search of the section, by question or answer, any case. */
export function filterPastAnswers<
  T extends Pick<PastAnswer, "question" | "answer">,
>(list: T[], query: string): T[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return list;
  return list.filter((a) => {
    const hay = `${a.question} ${a.answer}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}
