/* Registration questions: the rules the host's builder, the attendee's form and the
 * roster share.
 *
 * Pure so the builder's behaviour is testable without a browser, and mirrored on the
 * server (api/internal/api/registration_questions.go), which is the authority.
 */
import type { CustomQuestion } from "./api-types";

export type QuestionType = "short" | "select" | "checkbox";

export const QUESTION_TYPES: { value: QuestionType; label: string }[] = [
  { value: "short", label: "Short text" },
  { value: "select", label: "Choose one" },
  { value: "checkbox", label: "Checkbox" },
];

/** A "Choose one" needs this many options to be a choice at all. */
export const MIN_OPTIONS = 2;

/** What a ticked registration checkbox is sent and stored as; unticked is "". */
export const CHECKBOX_YES = "yes";

/** A question switched to another type. Switching to "Choose one" opens enough empty
 *  option rows to fill in; options are kept otherwise, so switching back and forth does
 *  not throw away what was typed (the server drops them from non-choice questions). */
export function withType(q: CustomQuestion, type: string): CustomQuestion {
  if (type !== "select") return { ...q, type };
  const options = [...(q.options ?? [])];
  while (options.length < MIN_OPTIONS) options.push("");
  return { ...q, type, options };
}

/** Why a question cannot be saved yet, or null. Only "Choose one" has a rule of its own. */
export function optionsProblem(q: CustomQuestion): string | null {
  if (q.type !== "select") return null;
  const filled = (q.options ?? []).map((o) => o.trim()).filter(Boolean);
  const seen = new Set<string>();
  for (const o of filled) {
    const key = o.toLowerCase();
    if (seen.has(key)) return `“${o}” is listed twice.`;
    seen.add(key);
  }
  if (filled.length < MIN_OPTIONS) {
    return `Add at least ${MIN_OPTIONS} options to choose from.`;
  }
  return null;
}

/** An answer as the host reads it in the roster. */
export function answerText(q: CustomQuestion, answer: string | undefined): string {
  if (!answer) return "";
  if (q.type === "checkbox") return answer === CHECKBOX_YES ? "Yes" : answer;
  return answer;
}
