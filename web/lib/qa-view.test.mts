/* Tests for what a Q&A card says about its asker and its answer.
 *
 * Run with `make test-web`.
 *
 * The anonymity case is the one worth a test: an anonymous question still carries
 * its sender in the packet, and a card that let the name, initials or identity
 * slip through would out the person who asked not to be named.
 */

import { answerKind, questionAuthor } from "./qa-view.ts";
import type { Sender } from "./realtime.ts";

let failures = 0;
let checks = 0;

function eq<T>(actual: T, expected: T, what: string): void {
  checks++;
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) return;
  failures++;
  console.log(`  FAIL  ${what}\n        got ${a}\n        want ${e}`);
}

const ana: Sender = { identity: "att_ana", name: "Ana Moreno", role: "attendee" };
const host: Sender = { identity: "user_h", name: "Priya Sharma", role: "host" };

console.log("questionAuthor");
{
  const anon = questionAuthor({ anonymous: true, from: ana }, "user_h");
  eq(anon, { kind: "anonymous", label: "Anonymous", mine: false }, "anonymous shows no one");
  const leaked = JSON.stringify(anon);
  eq(
    leaked.includes("Ana") || leaked.includes("att_ana"),
    false,
    "…and carries neither name nor identity, so nothing downstream can draw them",
  );
  eq(
    questionAuthor({ anonymous: true, from: ana }, "att_ana"),
    { kind: "anonymous", label: "Anonymous", mine: true },
    "the asker still knows it is theirs",
  );
  eq(
    questionAuthor({ anonymous: false, from: ana }, "user_h"),
    { kind: "person", label: "Ana Moreno", mine: false, name: "Ana Moreno", identity: "att_ana", role: "attendee" },
    "a named question names its asker",
  );
  eq(questionAuthor({ anonymous: false, from: host }, "user_h").label, "You", "your own is You");
}

console.log("\nanswerKind");
eq(answerKind({ answered: false, answer: "" }), null, "open");
eq(answerKind({ answered: true, answer: "" }), "live", "ticked with no text is answered live");
eq(answerKind({ answered: true, answer: "  " }), "live", "whitespace is not an answer");
eq(answerKind({ answered: true, answer: "Yes, in May." }), "text", "a written reply");

console.log(`\n${failures === 0 ? "PASS" : "FAIL"}  ${checks - failures}/${checks} checks passed`);
process.exit(failures === 0 ? 0 : 1);
