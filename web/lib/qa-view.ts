import type { Question } from "./realtime";

/* What a Q&A card says about who asked and how it was answered.
 *
 * Pure so the one rule here that matters — an anonymous question never reveals
 * its asker, not by name, not by initials, not by the identity-keyed colour —
 * is tested rather than remembered.
 */

export type QuestionAuthor =
  | { kind: "anonymous"; label: string; mine: boolean }
  | { kind: "person"; label: string; mine: boolean; name: string; identity: string; role: Question["from"]["role"] };

export function questionAuthor(
  q: Pick<Question, "anonymous" | "from">,
  myIdentity: string,
): QuestionAuthor {
  const mine = q.from.identity === myIdentity;
  if (q.anonymous) return { kind: "anonymous", label: "Anonymous", mine };
  return {
    kind: "person",
    label: mine ? "You" : q.from.name,
    mine,
    name: q.from.name,
    identity: q.from.identity,
    role: q.from.role,
  };
}

/** "live" is a question the stage marked answered without writing anything —
 *  what the host's tick does once they have said the answer out loud. "text" is
 *  one with a written reply. The data holds nothing else: no answerer and no
 *  answer time, so the card cannot say who answered. */
export function answerKind(q: Pick<Question, "answered" | "answer">): "live" | "text" | null {
  if (!q.answered) return null;
  return q.answer.trim() ? "text" : "live";
}
