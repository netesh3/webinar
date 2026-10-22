/* The AI knowledge, the pure half: the library page (components/knowledge/knowledge-screen.tsx),
 * a session's pick (session-knowledge-card.tsx) and the draft answers in the room's Q&A
 * (components/room/qa-assist.tsx). The server is api/internal/api/knowledge.go and
 * qa_drafts.go; it checks everything again. */

import type { KnowledgeLimits, QADraft } from "./api-types.ts";

/** The upload types the server reads, by extension. */
export const KNOWLEDGE_EXTENSIONS = [".pdf", ".docx", ".txt", ".md", ".markdown"] as const;

/** The file picker's accept attribute. */
export const KNOWLEDGE_ACCEPT = [
  ...KNOWLEDGE_EXTENSIONS,
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "text/plain",
  "text/markdown",
].join(",");

/** Why a file cannot be uploaded, before sending it; null when it can. */
export function uploadProblem(name: string, size: number, maxBytes: number): string | null {
  const lower = name.toLowerCase();
  if (!KNOWLEDGE_EXTENSIONS.some((ext) => lower.endsWith(ext))) {
    return "Upload a PDF, Word (.docx), text (.txt) or Markdown (.md) file.";
  }
  if (size === 0) return "That file is empty.";
  if (size > maxBytes) return `Files must be under ${Math.floor(maxBytes / (1 << 20))} MB.`;
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
export function usageLabel(docs: number, words: number, limits: KnowledgeLimits): string {
  return `${words.toLocaleString("en-IN")} of ${limits.maxWords.toLocaleString("en-IN")} words · ${docs} of ${limits.maxDocs} documents`;
}

/** Whether another document can be added at all (the server checks the words too). */
export function libraryFull(docs: number, words: number, limits: KnowledgeLimits): boolean {
  return docs >= limits.maxDocs || words >= limits.maxWords;
}

/** How a draft says where it came from, for the chips under it. */
export function draftSourceChips(draft: Pick<QADraft, "grounded" | "sources">): string[] {
  if (!draft.grounded) return [];
  if (draft.sources.length === 0) return ["From: this session"];
  return draft.sources.map((s) => `From: ${s}`);
}

/** The most a posted answer may be: what the room's answer packet carries. */
export const MAX_ANSWER_CHARS = 600;

/** Why an edited answer cannot be posted; null when it can. */
export function answerProblem(answer: string): string | null {
  const t = answer.trim();
  if (!t) return "Write the answer to post.";
  if ([...t].length > MAX_ANSWER_CHARS) return `Keep it under ${MAX_ANSWER_CHARS} characters.`;
  return null;
}

/** The sentence for a failed knowledge request: the server's own when it gave one. */
export function knowledgeError(err: unknown, fallback: string): string {
  if (err && typeof err === "object" && "message" in err && typeof err.message === "string" && err.message) {
    return err.message;
  }
  return fallback;
}
