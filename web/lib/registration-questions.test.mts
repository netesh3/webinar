/* The registration-question builder's rules: what switching a question to "Choose one"
 * gives the host to fill in, when the builder says a question is not ready, and how an
 * answer reads in the host's roster.
 *
 * Run: node --experimental-strip-types --no-warnings lib/registration-questions.test.mts
 */
import type { CustomQuestion } from "./api-types.ts";
import { answerText, optionsProblem, withType } from "./registration-questions.ts";

let passed = 0;
let failed = 0;

function eq(label: string, got: unknown, want: unknown) {
  if (JSON.stringify(got) === JSON.stringify(want)) passed++;
  else {
    failed++;
    console.error(`  FAIL  ${label}\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`);
  }
}

const q = (patch: Partial<CustomQuestion>): CustomQuestion => ({
  id: "q",
  label: "Role",
  type: "short",
  required: false,
  options: [],
  ...patch,
});

// Switching to "Choose one" opens two option rows to fill in, and keeps any already typed.
eq("short → choose one opens two rows", withType(q({}), "select").options, ["", ""]);
eq(
  "existing options are kept",
  withType(q({ options: ["A", "B", "C"] }), "select").options,
  ["A", "B", "C"],
);
eq("the type actually changes", withType(q({}), "checkbox").type, "checkbox");
eq(
  "switching away keeps options for switching back",
  withType(q({ type: "select", options: ["A", "B"] }), "short").options,
  ["A", "B"],
);

// The builder's "not ready" message.
eq("fewer than two options", optionsProblem(q({ type: "select", options: ["A", " "] })) !== null, true);
eq("two options is enough", optionsProblem(q({ type: "select", options: ["A", "B"] })), null);
eq("an option with a comma is one option", optionsProblem(q({ type: "select", options: ["Yes, and my team", "No"] })), null);
eq("duplicates, case-insensitive", optionsProblem(q({ type: "select", options: ["Yes", "yes"] })) !== null, true);
eq("other types have no option rule", optionsProblem(q({ type: "checkbox" })), null);

// How an answer reads to the host.
eq("ticked checkbox", answerText(q({ type: "checkbox" }), "yes"), "Yes");
eq("unticked checkbox", answerText(q({ type: "checkbox" }), undefined), "");
eq("choose one", answerText(q({ type: "select" }), "Engineer"), "Engineer");

console.log(`registration-questions: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
