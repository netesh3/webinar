/* Labels for WhatsApp messages that are not text.
 *
 * Run with `make test-web`.
 *
 * The bug was a list preview and an italic bubble both saying "Sent a unsupported".
 * Meta's type "unsupported" is a real type (a payload the Cloud API dropped), and
 * an image we stored only as kind "image" must still read as a photo after the
 * label change, even when the original media id was never kept.
 */

import {
  previewLabel,
  threadModel,
  UNSUPPORTED_MESSAGE,
  type PreviewMessage,
} from "./message-kind.ts";

let failures = 0;
let checks = 0;

function ok(condition: boolean, what: string, detail = ""): void {
  checks++;
  if (condition) return;
  failures++;
  console.log(`  FAIL  ${what}${detail ? `\n        ${detail}` : ""}`);
}

function eq(actual: unknown, expected: unknown, what: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  ok(a === e, what, a === e ? "" : `got ${a}\n        want ${e}`);
}

const unsupported: PreviewMessage = { kind: "unsupported" };
eq(previewLabel(unsupported), UNSUPPORTED_MESSAGE, "unsupported preview");
ok(
  !previewLabel(unsupported).includes("Sent a"),
  "unsupported preview is not 'Sent a …'",
);
eq(threadModel(unsupported).type, "unsupported", "unsupported bubble");
eq(
  threadModel(unsupported),
  { type: "unsupported", text: UNSUPPORTED_MESSAGE },
  "unsupported bubble text",
);

eq(previewLabel({ kind: "image" }), "📷 Photo", "photo with no caption");
eq(
  previewLabel({ kind: "image", body: "the ticket" }),
  "📷 Photo — the ticket",
  "photo caption",
);
eq(
  threadModel({ id: "m1", kind: "image", body: "the ticket" }),
  { type: "photo", media: false, caption: "the ticket" },
  "old photo row has no thumbnail",
);
eq(
  threadModel({
    id: "m1",
    kind: "image",
    media: { id: "99", mimeType: "image/jpeg" },
  }),
  { type: "photo", media: true },
  "new photo row can show a thumbnail",
);

eq(previewLabel({ kind: "voice" }), "🎤 Voice message", "voice");
eq(
  threadModel({ kind: "voice" }),
  { type: "card", label: "Voice message" },
  "voice bubble",
);
eq(previewLabel({ kind: "video" }), "🎥 Video", "video");
eq(previewLabel({ kind: "audio" }), "🎵 Audio", "audio");
eq(previewLabel({ kind: "sticker" }), "Sticker", "sticker");

eq(
  previewLabel({ kind: "document", body: "invoice.pdf" }),
  "📄 Document: invoice.pdf",
  "old document stored its filename in the body",
);
eq(
  previewLabel({
    kind: "document",
    body: "please see",
    media: { filename: "invoice.pdf" },
  }),
  "📄 Document: invoice.pdf — please see",
  "document filename and caption",
);
eq(
  threadModel({ kind: "document", body: "invoice.pdf" }),
  { type: "document", filename: "invoice.pdf", media: false },
  "old document bubble",
);

eq(previewLabel({ kind: "location" }), "📍 Location", "location without a name");
eq(
  previewLabel({ kind: "location", media: { name: "Cubbon Park" } }),
  "📍 Cubbon Park",
  "location name",
);
eq(
  threadModel({
    kind: "location",
    media: {
      name: "Cubbon Park",
      address: "Bengaluru",
      latitude: 12.97,
      longitude: 77.59,
    },
  }).type,
  "location",
  "location bubble",
);
const loc = threadModel({
  kind: "location",
  media: { latitude: 12.97, longitude: 77.59, name: "Cubbon Park" },
});
ok(
  loc.type === "location" &&
    loc.href === "https://www.google.com/maps?q=12.97,77.59",
  "location links to maps from coordinates",
);

eq(
  previewLabel({ kind: "reaction", media: { emoji: "👍" } }),
  "Reacted 👍",
  "reaction",
);
eq(
  previewLabel({ kind: "reaction" }),
  "Removed a reaction",
  "reaction removed",
);
eq(
  previewLabel({ kind: "interactive", body: "Price for the course" }),
  "Price for the course",
  "list reply title",
);
eq(
  previewLabel({ kind: "button", body: "Remind me" }),
  "Remind me",
  "button title",
);
eq(
  previewLabel({ kind: "contacts", media: { contacts: ["Amlesh Kumar"] } }),
  "Amlesh Kumar",
  "contact name",
);

eq(previewLabel({ kind: "order" }), "Sent an order", "unknown type uses an");
eq(previewLabel({ kind: "system" }), "System message", "system without text");
ok(
  !previewLabel({ kind: "order" }).includes("unsupported"),
  "an unknown type is not relabelled unsupported",
);

eq(previewLabel({ body: "hello" }), "hello", "plain text");
eq(
  previewLabel({ templateName: "reminder_1h" }),
  "reminder 1h",
  "template fallback",
);

if (failures > 0) {
  console.log(`\n${failures} of ${checks} failed`);
  process.exit(1);
}
console.log(`${checks} checks passed`);
