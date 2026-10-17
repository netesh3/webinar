import assert from "node:assert/strict";
import {
  draftValues,
  fieldWorksIn,
  followsTemplate,
  insertField,
  mappingForSubmit,
  mappingParams,
  mappingTokens,
  renumber,
  sameAsDefaults,
  unmappedBlanks,
} from "./template-mapping.ts";

let passed = 0;
function test(name: string, fn: () => void) {
  fn();
  passed += 1;
  void name;
}

const fields = [
  { token: "first_name", onlyKind: undefined },
  { token: "topic", onlyKind: undefined },
  { token: "when", onlyKind: undefined },
  { token: "starts_in", onlyKind: "wa_reminder" as const },
  { token: "replay", onlyKind: "wa_replay" as const },
];

test("insert at the end takes the next number", () => {
  const out = insertField("Hi {{1}}, see you", 17, [{ field: "first_name" }], { field: "topic" });
  assert.equal(out.body, "Hi {{1}}, see you{{2}}");
  assert.deepEqual(out.mapping, [{ field: "first_name" }, { field: "topic" }]);
  assert.equal(out.at, out.body.length);
});

test("insert in the middle renumbers the blanks after it, mapping and all", () => {
  const body = "Hi {{1}}, it starts {{2}}.";
  const at = body.indexOf(", it");
  const out = insertField(body, at, [{ field: "first_name" }, { field: "starts_in" }], { field: "topic" });
  assert.equal(out.body, "Hi {{1}}{{2}}, it starts {{3}}.");
  assert.deepEqual(out.mapping, [{ field: "first_name" }, { field: "topic" }, { field: "starts_in" }]);
  assert.equal(out.body.slice(0, out.at), "Hi {{1}}{{2}}");
});

test("insert at the start makes the new blank {{1}}", () => {
  const out = insertField("{{1}} is live", 0, [{ field: "topic" }], { text: "Good news" });
  assert.equal(out.body, "{{1}}{{2}} is live");
  assert.deepEqual(out.mapping, [{ text: "Good news" }, { field: "topic" }]);
});

test("deleting a blank renumbers the rest and keeps their fields", () => {
  const out = renumber("Hi {{1}}, starts {{3}}", [
    { field: "first_name" },
    { field: "topic" },
    { field: "starts_in" },
  ]);
  assert.equal(out.body, "Hi {{1}}, starts {{2}}");
  assert.deepEqual(out.mapping, [{ field: "first_name" }, { field: "starts_in" }]);
});

test("blanks written out of order are put in reading order", () => {
  const out = renumber("{{2}} then {{1}} then {{2}}", [{ field: "first_name" }, { field: "topic" }]);
  assert.equal(out.body, "{{1}} then {{2}} then {{1}}");
  assert.deepEqual(out.mapping, [{ field: "topic" }, { field: "first_name" }]);
});

test("a {{n}} typed by hand is left unmapped, and said so", () => {
  const body = "Hi {{1}}, {{2}} starts soon";
  const mapping = [{ field: "first_name" }];
  assert.deepEqual(unmappedBlanks(body, mapping), [2]);
  assert.deepEqual(unmappedBlanks(body, [...mapping, { text: "  " }]), [2]);
  assert.deepEqual(unmappedBlanks(body, [...mapping, { field: "topic" }]), []);
});

test("renumbering moves the cursor with the text", () => {
  const body = "{{10}} and more";
  const out = renumber(body, [], body.length);
  assert.equal(out.body, "{{1}} and more");
  assert.equal(out.at, out.body.length);
});

test("submit sends one entry per blank, or nothing when nothing was chosen", () => {
  assert.equal(mappingForSubmit("Hi {{1}}", []), undefined);
  assert.equal(mappingForSubmit("No blanks", [{ field: "topic" }]), undefined);
  assert.deepEqual(mappingForSubmit("Hi {{1}}, {{2}}", [null, { field: "topic" }]), [{}, { field: "topic" }]);
});

test("a template's mapping per kind of message", () => {
  const t = { variables: 3, defaultParams: [{ field: "first_name" }, { text: "our workshop" }, { field: "starts_in" }] };
  assert.deepEqual(mappingParams(t, "wa_reminder", fields), [
    { field: "first_name" },
    { text: "our workshop" },
    { field: "starts_in" },
  ]);
  // starts_in has no value on a broadcast: that blank takes the fallback.
  assert.deepEqual(mappingParams(t, "wa_broadcast", fields, [{}, {}, { field: "when" }])[2], { field: "when" });
  // Token uses cannot hold words, so that blank takes the fallback too.
  assert.deepEqual(mappingTokens(t, "wa_reminder", fields, ["", "topic", ""]), ["first_name", "topic", "starts_in"]);
  assert.equal(fieldWorksIn("replay", "wa_reminder", fields), false);
  assert.equal(fieldWorksIn("replay", "", fields), true);
});

test("inherit is no values; customised is any", () => {
  assert.equal(followsTemplate([], 2), true);
  assert.equal(followsTemplate(undefined, 1), true);
  assert.equal(followsTemplate(["first_name"], 1), false);
  assert.equal(followsTemplate([], 0), false);
  assert.equal(sameAsDefaults([{ field: "topic" }], [{ field: "topic" }]), true);
  assert.equal(sameAsDefaults([{ text: "hi " }], [{ text: "hi" }]), true);
  assert.equal(sameAsDefaults([{ field: "topic" }], [{ text: "topic" }]), false);
});

test("the editor preview fills each blank with its field's example", () => {
  const ex = [
    { token: "first_name", example: "Asha" },
    { token: "when", example: "6:00 PM" },
  ];
  assert.deepEqual(
    draftValues("Hi {{1}}, at {{2}}, {{3}} and {{4}}", [{ field: "first_name" }, { field: "when" }, null, { text: " soon " }], ex),
    ["Asha", "6:00 PM", "", "soon"],
  );
  assert.deepEqual(draftValues("No blanks", [{ field: "first_name" }], ex), []);
});

console.log(`PASS ${passed}/${passed} template-mapping checks`);
