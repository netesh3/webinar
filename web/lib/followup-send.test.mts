import assert from "node:assert/strict";
import { test } from "node:test";
import type { FollowupRecipient } from "./api-types.ts";
import {
  FOLLOWUP_TEMPLATE_BODY,
  alreadySent,
  chunk,
  pickChannel,
  reasonText,
  resultText,
  reviewRows,
  rowItem,
  summarize,
  templateParams,
  templateStatusText,
  templateVariable,
  whatsappPreview,
} from "./followup-send.ts";

function person(over: Partial<FollowupRecipient> = {}): FollowupRecipient {
  return {
    key: "k1",
    name: "Asha Rao",
    group: "attended",
    tag: "warm",
    email: "asha@test.dev",
    emailPlan: { available: true, mode: "email" },
    whatsappPlan: { available: true, mode: "freeform" },
    subject: "Thanks",
    body: "Hi Asha,\n\nThanks.",
    whatsappText: "Hi Asha, thanks!",
    ...over,
  };
}

test("WhatsApp when it can reach them, else the email fallback", () => {
  assert.deepEqual(pickChannel(person(), "auto"), { channel: "whatsapp", fallback: false });
  const noOptIn = person({ whatsappPlan: { available: false, reason: "no_opt_in" } });
  assert.deepEqual(pickChannel(noOptIn, "whatsapp"), { channel: "email", fallback: true });
  assert.deepEqual(pickChannel(noOptIn, "email"), { channel: "email", fallback: false });
  const nothing = person({ emailPlan: { available: false, reason: "unsubscribed" }, whatsappPlan: { available: false } });
  assert.deepEqual(pickChannel(nothing, "auto"), { channel: null, fallback: false });
  assert.deepEqual(pickChannel(person({ emailPlan: { available: false } }), "email"), { channel: null, fallback: false });
});

test("rows send what the host left in them", () => {
  const [row] = reviewRows([person()], "email");
  row.subject = "  Edited ";
  assert.deepEqual(rowItem(row), { key: "k1", channel: "email", subject: "Edited", body: "Hi Asha,\n\nThanks." });
  row.channel = "whatsapp";
  assert.deepEqual(rowItem(row), { key: "k1", channel: "whatsapp", body: "Hi Asha, thanks!" });
  row.channel = null;
  assert.equal(rowItem(row), null);
  const [sent] = reviewRows([person({ whatsappPlan: { available: true, sent: true } })], "auto");
  assert.equal(alreadySent(sent), true);
});

test("chunks", () => {
  assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.deepEqual(chunk([], 20), []);
});

test("template variables follow Meta's rules", () => {
  const v = templateVariable("a\n\nb\tc     d", 0);
  assert.equal(v, "a b c d");
  const long = templateVariable("x ".repeat(600), 30);
  assert.equal(Array.from(long).length, 30);
  assert.ok(long.endsWith("…"));
  const [name, topic, msg] = templateParams("", "", "Hi Asha,\nthe replay is up.");
  assert.equal(name, "there");
  assert.equal(topic, "the session");
  assert.equal(msg, "the replay is up.");
  const body = whatsappPreview("template", "Asha", "Money ".repeat(40), "Long text. ".repeat(200));
  assert.ok(Array.from(body).length <= 1024);
  assert.ok(FOLLOWUP_TEMPLATE_BODY.includes("{{3}}"));
  assert.equal(whatsappPreview("freeform", "Asha", "T", "  Hi Asha!\nSee you "), "Hi Asha!\nSee you");
});

test("words", () => {
  assert.match(reasonText("template_not_approved"), /template/);
  assert.equal(reasonText(undefined), "");
  assert.equal(resultText({ key: "k", channel: "whatsapp", status: "sent", mode: "template" }), "WhatsApp sent (template)");
  assert.equal(resultText({ key: "k", channel: "email", status: "skipped", reason: "unsubscribed" }), "Skipped: Unsubscribed from your emails");
  assert.deepEqual(
    summarize([
      { key: "a", channel: "email", status: "sent" },
      { key: "b", channel: "email", status: "failed" },
      { key: "c", channel: "email", status: "skipped" },
      { key: "d", channel: "email", status: "sent" },
    ]),
    { sent: 2, failed: 1, skipped: 1 },
  );
  assert.equal(templateStatusText("APPROVED").approved, true);
  assert.equal(templateStatusText("PENDING").approved, false);
  assert.equal(templateStatusText(undefined).label, "Not submitted");
});
