import assert from "node:assert/strict";
import type { QACluster, QADraft } from "./api-types.ts";
import type { Question } from "./realtime.ts";
import { askedLabel, clusterIdFor, draftFor, groupOpenQuestions, pickDraft, qaAssistOn, suggestError, topQuestions } from "./qa-clusters.ts";

const q = (id: string, who: string, votes = 0): Question => ({
  kind: "question",
  id,
  from: { identity: who, name: who, role: "attendee" },
  text: `question ${id}`,
  anonymous: false,
  at: 0,
  votes,
  answered: false,
  votedByMe: false,
  pinned: false,
  dismissed: false,
  answer: "",
});
const c = (id: string, questionIds: string[], canonical = `cluster ${id}`): QACluster => ({
  id,
  canonical,
  questionIds,
  askers: 0,
  upvotes: 0,
  open: questionIds.length,
  latestAt: "",
  score: 0,
});

// Gating: host or co-host, account AI, room switch on.
assert.equal(qaAssistOn(true, { aiAvailable: true, aiEnabled: true }), true);
assert.equal(qaAssistOn(true, { aiAvailable: true, aiEnabled: false }), false);
assert.equal(qaAssistOn(true, { aiAvailable: false, aiEnabled: true }), false);
assert.equal(qaAssistOn(false, { aiAvailable: true, aiEnabled: true }), false);
// Switched off and back on while live: the server keeps the session out of AI, so the panel
// neither polls nor waits for an assistant that will not come.
assert.equal(qaAssistOn(true, { aiAvailable: true, aiEnabled: true, aiOffThisSession: true }), false);
assert.equal(qaAssistOn(true, { aiAvailable: true, aiEnabled: true, aiOffThisSession: false }), true);

// Grouping: a cluster folds at its first question; lone and unclustered questions stay.
const open = [q("1", "a", 2), q("2", "b"), q("3", "b", 1), q("4", "c"), q("5", "d", 4)];
const clusters = [c("fee", ["1", "3", "5", "gone"]), c("solo", ["2"])];
const items = groupOpenQuestions(open, clusters);
assert.deepEqual(
  items.map((i) => (i.kind === "cluster" ? `C:${i.id}` : `Q:${i.question.id}`)),
  ["C:fee", "Q:2", "Q:4"],
);
const fee = items[0];
assert.ok(fee.kind === "cluster");
assert.equal(fee.votes, 7);
assert.equal(fee.askers, 3);
assert.deepEqual(fee.questions.map((m) => m.id), ["1", "3", "5"]);
// A cluster with one open question left is just that question.
assert.deepEqual(
  groupOpenQuestions([q("1", "a"), q("2", "b")], [c("fee", ["1", "3"])]).map((i) => i.kind),
  ["question", "question"],
);
// No clusters: the plain list.
assert.equal(groupOpenQuestions(open, []).length, open.length);

// A question's cluster, or itself as a provisional one.
assert.equal(clusterIdFor("3", clusters), "fee");
assert.equal(clusterIdFor("9", clusters), "q_9");

// The label.
assert.equal(askedLabel(3, 3), "3 people asked this");
assert.equal(askedLabel(1, 2), "Asked 2 times");

// Top: server order, live votes, answered ones dropped, nothing below two.
const top = topQuestions(["fee", "solo", "nope"], clusters, open);
assert.deepEqual(top.map((t) => [t.id, t.votes, t.askers]), [
  ["fee", 7, 3],
  ["solo", 0, 1],
]);
assert.deepEqual(topQuestions(["fee", "solo"], clusters, [q("1", "a")]), []);

// Errors: the server's sentence when there is one.
assert.equal(suggestError(new Error("AI limit reached for this month.")), "AI limit reached for this month.");
assert.equal(suggestError(null), "Couldn't draft an answer. Try again.");

// Drafts: the cluster's own, and the newer of this host's and the server's, minus one just
// posted or discarded.
const d = (id: string, at: string): QADraft => ({ id, answer: id, grounded: true, sources: [], auto: false, createdAt: at });
const withDraft = [{ ...c("fee", ["1"]), draft: d("server", "2026-10-22T10:00:00Z") }, c("solo", ["2"])];
assert.equal(draftFor("fee", withDraft)?.id, "server");
assert.equal(draftFor("solo", withDraft), undefined);
assert.equal(draftFor("q_9", withDraft), undefined);
assert.equal(pickDraft(null, undefined, null), null);
assert.equal(pickDraft(d("mine", "2026-10-22T10:00:05Z"), d("server", "2026-10-22T10:00:00Z"), null)?.id, "mine");
assert.equal(pickDraft(d("mine", "2026-10-22T09:00:00Z"), d("server", "2026-10-22T10:00:00Z"), null)?.id, "server");
assert.equal(pickDraft(d("mine", "2026-10-22T10:00:05Z"), d("server", "2026-10-22T10:00:00Z"), "mine")?.id, "server");
assert.equal(pickDraft(null, d("server", "2026-10-22T10:00:00Z"), "server"), null);
// A general answer from before the assistant stopped writing them is not shown.
assert.equal(pickDraft(null, { ...d("old", "2026-10-22T10:00:00Z"), grounded: false }, null), null);
assert.equal(
  pickDraft({ ...d("old", "2026-10-22T10:00:09Z"), grounded: false }, d("server", "2026-10-22T10:00:00Z"), null)?.id,
  "server",
);

console.log("qa-clusters: ok");
