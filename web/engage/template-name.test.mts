/* Template names. The normaliser cases are the same as
 * api/internal/engage/template_name_test.go, so the hint shows what the server saves.
 *
 * Run with node --experimental-strip-types. */

import {
  TEMPLATE_NAME_MAX,
  friendlyTemplateName,
  normaliseTemplateName,
  templateLabel,
  templateNameProblem,
} from "./template-name.ts";

let failures = 0;
let checks = 0;

function eq(actual: unknown, expected: unknown, what: string): void {
  checks++;
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) return;
  failures++;
  console.log(`  FAIL  ${what}\n        got ${a}\n        want ${e}`);
}

const cases: [string, string][] = [
  ["Webinar reminder 1 hour", "webinar_reminder_1_hour"],
  ["  Webinar Reminder  ", "webinar_reminder"],
  ["follow-up - day 2", "follow_up_day_2"],
  ["Already_snake_case", "already_snake_case"],
  ["__Lots___of____underscores__", "lots_of_underscores"],
  ["Café déjà vu", "caf_dj_vu"],
  ["Reminder 🎉 party", "reminder_party"],
  ["नमस्ते", ""],
  ["🎉🎉", ""],
  ["", ""],
  ["   ", ""],
  ["1 hour reminder", "t_1_hour_reminder"],
  ["_1st", "t_1st"],
  ["2024", "t_2024"],
  ["Price: $49 / month!", "price_49_month"],
  ["a".repeat(80), "a".repeat(60)],
  // Cut at 60 lands on an underscore, which is trimmed.
  ["ab ".repeat(30), "ab_".repeat(19) + "ab"],
  ["9" + "x".repeat(70), "t_9" + "x".repeat(57)],
];
for (const [input, want] of cases) {
  const got = normaliseTemplateName(input);
  eq(got, want, `normalise ${JSON.stringify(input)}`);
  eq(got.length <= TEMPLATE_NAME_MAX, true, `length of ${JSON.stringify(input)}`);
  eq(normaliseTemplateName(got), got, `idempotent ${JSON.stringify(input)}`);
}

eq(templateNameProblem(""), "Give the template a name.", "empty title");
eq(templateNameProblem("🎉"), "Use at least one letter or number in the name.", "emoji title");
eq(templateNameProblem("Reminder"), null, "fine title");

// Shown as the coach typed it, else the name made readable; legacy names lose wl_own_.
eq(friendlyTemplateName("webinar_reminder_1_hour"), "Webinar reminder 1 hour", "friendly");
eq(friendlyTemplateName("missed_you_v2"), "Missed you", "friendly drops a version");
eq(friendlyTemplateName("wl_own_3fa9c2d1"), "3fa9c2d1", "legacy prefix stripped");
eq(templateLabel({ name: "webinar_reminder_1_hour", title: "Webinar Reminder – 1 hour" }), "Webinar Reminder – 1 hour", "title wins");
eq(templateLabel({ name: "webinar_reminder_1_hour", title: "" }), "Webinar reminder 1 hour", "no title");

if (failures) {
  console.log(`${failures} of ${checks} checks failed`);
  process.exit(1);
}
console.log(`ok  ${checks} checks`);
