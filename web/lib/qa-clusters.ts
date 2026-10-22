/* The live Q&A assistant's view, the pure half (components/room/qa-assist.tsx draws it).
 *
 * The server says which questions belong together (GET /qa/clusters, api/internal/api/
 * qa_assist.go) and ranks the Top questions; the room's live list says what is open and how
 * many votes each has right now. Grouping here joins the two, so a vote cast a second ago is
 * counted without waiting for the next read of the clusters. Host and co-hosts only. */

import { sessionAIOn } from "./ai-session.ts";
import type { QACluster, QADraft, SessionControls } from "./api-types.ts";
import type { Question } from "./realtime.ts";

/** Whether this person gets the assistant: the host or a co-host, in a session whose
 *  account has AI, whose room AI switch is on, and which has not been out of AI at any point
 *  while live (sessionAIOn). Otherwise the panel is the plain list. */
export function qaAssistOn(
  isHost: boolean,
  controls: Pick<SessionControls, "aiAvailable" | "aiEnabled" | "aiOffThisSession">,
): boolean {
  return isHost && sessionAIOn(controls);
}

export type QAItem =
  | { kind: "question"; question: Question }
  | {
      kind: "cluster";
      id: string;
      canonical: string;
      /** The open questions in it, in the list's order. Two or more. */
      questions: Question[];
      /** Live votes, summed. */
      votes: number;
      /** Different people who asked it. */
      askers: number;
    };

/** The open list with every cluster of two or more open questions folded into one item, at
 *  the place of its first question. A question in no cluster, or alone in one, stays itself. */
export function groupOpenQuestions(open: readonly Question[], clusters: readonly QACluster[]): QAItem[] {
  const clusterOf = new Map<string, QACluster>();
  for (const c of clusters) for (const id of c.questionIds) clusterOf.set(id, c);

  const members = new Map<string, Question[]>();
  for (const q of open) {
    const c = clusterOf.get(q.id);
    if (!c) continue;
    const list = members.get(c.id) ?? [];
    list.push(q);
    members.set(c.id, list);
  }

  const out: QAItem[] = [];
  const placed = new Set<string>();
  for (const q of open) {
    const c = clusterOf.get(q.id);
    const group = c ? members.get(c.id) : undefined;
    if (!c || !group || group.length < 2) {
      out.push({ kind: "question", question: q });
      continue;
    }
    if (placed.has(c.id)) continue;
    placed.add(c.id);
    out.push({
      kind: "cluster",
      id: c.id,
      canonical: c.canonical,
      questions: group,
      votes: group.reduce((n, m) => n + m.votes, 0),
      askers: countAskers(group),
    });
  }
  return out;
}

function countAskers(qs: readonly Question[]): number {
  // An anonymous question has no identity for the stage either way; each one is a person.
  const who = new Set(qs.map((q) => q.from.identity || `?${q.id}`));
  return who.size;
}

/** The cluster a question is in, for its "Suggest an answer": a question no pass has reached
 *  yet is addressed as its own provisional cluster, "q_" + its id, as the server lists it. */
export function clusterIdFor(questionId: string, clusters: readonly QACluster[]): string {
  return clusters.find((c) => c.questionIds.includes(questionId))?.id ?? `q_${questionId}`;
}

/** The line on a cluster: "3 people asked this", or "Asked 2 times" when one person asked twice. */
export function askedLabel(askers: number, count: number): string {
  if (askers >= 2) return `${askers} people asked this`;
  return `Asked ${count} times`;
}

export type TopQuestion = {
  id: string;
  text: string;
  votes: number;
  askers: number;
  /** The open questions behind it, for Mark answered. */
  questionIds: string[];
};

/** The Top questions strip, in the server's order, with live votes, leaving out what has been
 *  answered or hidden since the ranking was read. Empty below two entries, like the server. */
export function topQuestions(
  top: readonly string[],
  clusters: readonly QACluster[],
  open: readonly Question[],
): TopQuestion[] {
  const byId = new Map(clusters.map((c) => [c.id, c]));
  const live = new Map(open.map((q) => [q.id, q]));
  const out: TopQuestion[] = [];
  for (const id of top) {
    const c = byId.get(id);
    if (!c) continue;
    const qs = c.questionIds.map((q) => live.get(q)).filter((q): q is Question => q !== undefined);
    if (qs.length === 0) continue;
    out.push({
      id,
      text: c.canonical,
      votes: qs.reduce((n, q) => n + q.votes, 0),
      askers: countAskers(qs),
      questionIds: qs.map((q) => q.id),
    });
  }
  return out.length >= 2 ? out : [];
}

/** The server's open draft for a cluster (or a provisional "q_" one), if it has one. */
export function draftFor(clusterId: string, clusters: readonly QACluster[]): QADraft | undefined {
  return clusters.find((c) => c.id === clusterId)?.draft;
}

/** The draft a card shows: the newer of this host's own suggestion and the server's (a
 *  co-host's, or one written when the question arrived), leaving out the one this host just
 *  posted or discarded until the next read drops it. */
export function pickDraft(
  mine: QADraft | null | undefined,
  server: QADraft | null | undefined,
  gone: string | null,
): QADraft | null {
  const live = [mine, server].filter((d): d is QADraft => !!d && d.id !== gone);
  if (live.length === 0) return null;
  return live.reduce((a, b) => (Date.parse(b.createdAt) > Date.parse(a.createdAt) ? b : a));
}

/** The sentence for a failed suggestion: the server's own for the ones it explains. */
export function suggestError(err: unknown): string {
  if (err && typeof err === "object" && "message" in err && typeof err.message === "string" && err.message) {
    return err.message;
  }
  return "Couldn't draft an answer. Try again.";
}
