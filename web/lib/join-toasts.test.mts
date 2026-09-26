/* Tests for the host's "X is joining…" → "X joined" toasts.
 *
 * Run with `make test-web`.
 *
 * Every case here is about timing — a join that never lands, a burst of arrivals, a
 * reconnect, the host's own first roster — which a live room will not produce on
 * demand.
 */

import {
  ATTENDEE_TOAST_LIMIT,
  JOIN_TIMEOUT_MS,
  JOINED_LINGER_MS,
  JoinTracker,
  REJOIN_QUIET_MS,
  SUMMARY_KEY,
  namesSentence,
  personKey,
  summaryText,
  type JoinPerson,
  type JoinToastView,
} from "./join-toasts.ts";

let failures = 0;
let checks = 0;

function ok(condition: boolean, what: string, detail = ""): void {
  checks++;
  if (condition) return;
  failures++;
  console.log(`  FAIL  ${what}${detail ? `\n        ${detail}` : ""}`);
}

function eq<T>(actual: T, expected: T, what: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  ok(a === e, what, a === e ? "" : `got ${a}\n        want ${e}`);
}

const T = 1_700_000_000_000;
const ME = "host_me";

function att(identity: string, name = identity): JoinPerson {
  return { identity, name, role: "attendee" };
}
function pan(identity: string, name = identity): JoinPerson {
  return { identity, name, role: "panelist" };
}
const self: JoinPerson = { identity: ME, name: "Me", role: "host" };

/** A compact reading of what is on screen: key → phase, or the summary's counts. */
function shown(views: JoinToastView[]): string[] {
  return views.map((v) =>
    v.kind === "person" ? `${v.entry.identity}:${v.entry.phase}` : `summary:${v.joined.length}/${v.joining.length}`,
  );
}

function ready(extra: JoinPerson[] = []): JoinTracker {
  const t = new JoinTracker(ME);
  t.roster([self, ...extra], T);
  return t;
}

console.log("joining → joined");
{
  const t = ready();
  t.joining(att("att_a", "Asha"), T + 100);
  eq(shown(t.view()), ["att_a:joining"], "the server's hint shows 'joining', not 'joined'");
  t.roster([self], T + 2000);
  eq(shown(t.view()), ["att_a:joining"], "a roster without them keeps them joining");
  t.roster([self, att("att_a", "Asha")], T + 4000);
  eq(shown(t.view()), ["att_a:joined"], "the roster showing them is what turns it green");
  eq(t.view()[0]?.key, personKey("att_a"), "same key throughout, so the toast updates in place");
  eq(t.nextDeadline(), T + 4000 + JOINED_LINGER_MS, "a joined toast lingers from when it turned green");
  t.tick(T + 4000 + JOINED_LINGER_MS - 1);
  eq(shown(t.view()), ["att_a:joined"], "still up just before the linger ends");
  ok(t.tick(T + 4000 + JOINED_LINGER_MS), "tick reports the expiry");
  eq(shown(t.view()), [], "gone after the linger");
  eq(t.nextDeadline(), null, "nothing left to wake up for");
}

console.log("\nno baseline, no toasts");
{
  const t = new JoinTracker(ME);
  t.joining(att("att_a"), T);
  eq(shown(t.view()), [], "a hint before the first roster is ignored");
  t.roster([self, att("att_a"), att("att_b"), pan("pan_c")], T + 10);
  eq(shown(t.view()), [], "everyone on the first roster was already here — no burst on connect");
}

console.log("\nnever for yourself");
{
  const t = new JoinTracker(ME);
  t.roster([], T);
  t.joining(self, T + 1);
  t.roster([self], T + 2);
  eq(shown(t.view()), [], "your own arrival is not announced to you");
}

console.log("\nstraight to joined when the hint was missed");
{
  const t = ready();
  t.roster([self, att("att_h", "Hidden")], T + 1000);
  eq(shown(t.view()), ["att_h:joined"], "on the panel without a hint: say joined, not nothing");
}

console.log("\ntimeout and leaving");
{
  const t = ready();
  t.joining(att("att_slow"), T);
  eq(t.nextDeadline(), T + JOIN_TIMEOUT_MS, "joining times out on its own clock");
  t.tick(T + JOIN_TIMEOUT_MS);
  eq(shown(t.view()), [], "a join that never lands is dismissed quietly");
  t.roster([self, att("att_slow")], T + JOIN_TIMEOUT_MS + 5000);
  eq(shown(t.view()), ["att_slow:joined"], "...and still announced if they do turn up later");

  const u = ready();
  u.joining(att("att_quit"), T);
  u.left("att_quit");
  eq(shown(u.view()), [], "leaving before appearing drops the toast");

  const v = ready();
  v.joining(att("att_x"), T);
  v.roster([self, att("att_x")], T + 1000);
  v.left("att_x");
  eq(shown(v.view()), ["att_x:joined"], "a joined toast is left to finish — it was true");
}

console.log("\nreconnects and rejoins");
{
  const t = ready([att("att_r", "Ravi")]);
  t.joining(att("att_r", "Ravi"), T + 100);
  eq(shown(t.view()), [], "a fresh token for somebody already on the roster is a reconnect");

  t.roster([self], T + 1000);
  t.joining(att("att_r", "Ravi"), T + 3000);
  t.roster([self, att("att_r", "Ravi")], T + 6000);
  eq(shown(t.view()), [], "dropping off and back within the quiet window is silent");

  t.roster([self], T + 10_000);
  t.tick(T + 10_000 + REJOIN_QUIET_MS);
  t.joining(att("att_r", "Ravi"), T + 10_000 + REJOIN_QUIET_MS + 1);
  eq(shown(t.view()), ["att_r:joining"], "back after a real absence is a join again");

  const u = ready();
  u.joining(att("att_d", "Old name"), T);
  u.joining(att("att_d", "New name"), T + 20_000);
  const only = u.view()[0];
  eq(only?.kind === "person" ? only.entry.name : null, "New name", "a second hint refreshes the name");
  u.tick(T + JOIN_TIMEOUT_MS + 1);
  eq(shown(u.view()), ["att_d:joining"], "...and restarts the timeout");
}

console.log("\nbatching");
{
  const t = ready();
  t.joining(att("a1", "Asha"), T + 1);
  t.joining(att("a2", "Ravi"), T + 2);
  t.joining(att("a3", "Meera"), T + 3);
  eq(shown(t.view()), ["a1:joining", "a2:joining", "a3:joining"], "three stay individual");
  t.joining(att("a4", "Dev"), T + 4);
  eq(shown(t.view()), ["summary:0/4"], "a fourth folds the attendees into one summary");
  eq(t.view()[0]?.key, SUMMARY_KEY, "the summary has a key of its own");
  t.joining(pan("p1", "Priya"), T + 5);
  eq(shown(t.view()), ["p1:joining", "summary:0/4"], "a panelist keeps their own toast");
  t.roster([self, att("a1", "Asha"), att("a2", "Ravi"), att("a3", "Meera"), att("a4", "Dev"), pan("p1", "Priya")], T + 1000);
  eq(shown(t.view()), ["p1:joined", "summary:4/0"], "the summary turns green with them");
}

console.log("\nlarge audiences");
{
  const crowd: JoinPerson[] = [];
  for (let i = 0; i < ATTENDEE_TOAST_LIMIT; i++) crowd.push(att(`c${i}`));
  const t = ready(crowd);
  t.joining(att("late"), T + 1);
  t.roster([self, ...crowd, att("late2")], T + 2);
  eq(shown(t.view()), [], "past the limit, attendee arrivals are not toasted");
  t.joining(pan("p9", "Priya"), T + 3);
  eq(shown(t.view()), ["p9:joining"], "a panelist is always announced");
}

console.log("\ndismiss");
{
  const t = ready();
  t.joining(att("a1"), T);
  t.dismiss(["a1"]);
  eq(shown(t.view()), [], "a dismissed toast goes away");
}

console.log("\nwording");
{
  eq(namesSentence(["Asha"]), "Asha", "one");
  eq(namesSentence(["Asha", "Ravi"]), "Asha and Ravi", "two");
  eq(namesSentence(["Asha", "Ravi", "Meera"]), "Asha, Ravi and Meera", "three");
  eq(namesSentence(["Asha", "Ravi", "a", "b", "c", "d"]), "Asha, Ravi and 4 others", "many");
  const e = (identity: string, name: string, phase: "joining" | "joined") => ({
    identity,
    name,
    role: "attendee" as const,
    phase,
    startedAt: T,
  });
  eq(
    summaryText({ key: SUMMARY_KEY, kind: "summary", joined: [], joining: [e("a", "Asha", "joining"), e("b", "Ravi", "joining")] }),
    { title: "Asha and Ravi are joining…", detail: null },
    "all still joining",
  );
  eq(
    summaryText({
      key: SUMMARY_KEY,
      kind: "summary",
      joined: [e("a", "Asha", "joined"), e("b", "Ravi", "joined"), e("c", "C", "joined"), e("d", "D", "joined"), e("f", "F", "joined"), e("g", "G", "joined")],
      joining: [e("h", "H", "joining")],
    }),
    { title: "Asha, Ravi and 4 others joined", detail: "1 more joining…" },
    "mixed",
  );
}

console.log(`\n${failures === 0 ? "PASS" : "FAIL"}  ${checks - failures}/${checks} checks passed`);
process.exit(failures === 0 ? 0 : 1);
