import assert from "node:assert/strict";
import {
  SLOT_TONES,
  formatTemplate,
  slotContext,
  slotCount,
  slotTone,
  splitTemplate,
} from "./template-params.ts";

let passed = 0;
function test(name: string, fn: () => void) {
  fn();
  passed += 1;
  void name;
}

test("plain text is one segment", () => {
  assert.deepEqual(splitTemplate("Hello there"), [{ kind: "text", text: "Hello there" }]);
  assert.equal(slotCount("Hello there"), 0);
});

test("numbered slots keep their number", () => {
  const segs = splitTemplate("Hi {{1}}, {{2}} starts {{3}}.");
  assert.deepEqual(
    segs.map((s) => (s.kind === "slot" ? `#${s.slot}` : s.text)),
    ["Hi ", "#1", ", ", "#2", " starts ", "#3", "."],
  );
  assert.equal(slotCount("Hi {{1}}, {{2}} starts {{3}}."), 3);
});

test("ten slots and spaces inside braces", () => {
  const body = Array.from({ length: 10 }, (_, i) => `{{ ${i + 1} }}`).join(" ");
  assert.equal(slotCount(body), 10);
  assert.equal(splitTemplate(body).filter((s) => s.kind === "slot").length, 10);
});

test("a repeated slot is the same slot", () => {
  const segs = splitTemplate("{{1}} and again {{1}}");
  assert.deepEqual(
    segs.filter((s) => s.kind === "slot").map((s) => (s.kind === "slot" ? s.slot : 0)),
    [1, 1],
  );
  assert.equal(slotCount("{{1}} and again {{1}}"), 1);
});

test("adjacent slots have no text between them", () => {
  const segs = splitTemplate("{{1}}{{2}}");
  assert.equal(segs.length, 2);
  assert.ok(segs.every((s) => s.kind === "slot"));
});

test("non-numeric names take reading order", () => {
  const segs = splitTemplate("Hi {{name}}, see {{link}}");
  assert.deepEqual(
    segs.filter((s) => s.kind === "slot").map((s) => (s.kind === "slot" ? s.slot : 0)),
    [1, 2],
  );
});

test("a text header with one variable", () => {
  assert.equal(slotCount("Reminder: {{1}}"), 1);
  assert.deepEqual(slotContext("Reminder: {{1}}", 1), { before: "Reminder:", after: "" });
});

test("context shows the words around a slot", () => {
  const body = "Hi {{1}}, your webinar {{2}} starts at {{3}} today. See you there!";
  assert.deepEqual(slotContext(body, 2), { before: "Hi …, your webinar", after: "starts at … today. …" });
});

test("context trims to the word count and marks the cut", () => {
  const body = "one two three four five six {{1}} seven eight nine ten eleven";
  assert.deepEqual(slotContext(body, 1), {
    before: "… three four five six",
    after: "seven eight nine ten …",
  });
  assert.deepEqual(slotContext(body, 1, 2), { before: "… five six", after: "seven eight …" });
});

test("context of a missing slot is empty", () => {
  assert.deepEqual(slotContext("Hello", 3), { before: "", after: "" });
});

test("bold marks around a slot make the value bold, marks removed", () => {
  const segs = formatTemplate("Your webinar *{{2}}* starts");
  assert.deepEqual(segs, [
    { kind: "text", runs: [{ text: "Your webinar ", bold: false, italic: false }] },
    { kind: "slot", slot: 2, raw: "{{2}}", bold: true, italic: false },
    { kind: "text", runs: [{ text: " starts", bold: false, italic: false }] },
  ]);
});

test("formatting within text and across a slot", () => {
  const segs = formatTemplate("_Hi {{1}}_, it is *today*. 5 * 3 stays");
  const flat = segs.map((s) =>
    s.kind === "slot"
      ? `[${s.slot}${s.italic ? "i" : ""}${s.bold ? "b" : ""}]`
      : s.runs.map((r) => (r.bold ? `<b>${r.text}</b>` : r.italic ? `<i>${r.text}</i>` : r.text)).join(""),
  );
  assert.deepEqual(flat, ["<i>Hi </i>", "[1i]", ", it is <b>today</b>. 5 * 3 stays"]);
  // A lone mark, or one across a line break, is just a character.
  const lone = formatTemplate("a *b\nc* d");
  assert.equal(lone.length, 1);
  assert.equal(lone[0].kind === "text" && lone[0].runs.map((r) => r.text).join(""), "a *b\nc* d");
});

test("context leaves WhatsApp marks out", () => {
  assert.deepEqual(slotContext("Hi {{1}}, your webinar *{{2}}* starts at {{3}}", 3), {
    before: "… webinar … starts at",
    after: "",
  });
});

test("tones are stable and cycle", () => {
  assert.equal(slotTone(1), 0);
  assert.equal(slotTone(2), 1);
  assert.equal(slotTone(SLOT_TONES), SLOT_TONES - 1);
  assert.equal(slotTone(SLOT_TONES + 1), 0);
  assert.equal(slotTone(0), 0);
  assert.equal(slotTone(3), slotTone(3));
});

console.log(`PASS ${passed}/${passed} template-params checks`);
