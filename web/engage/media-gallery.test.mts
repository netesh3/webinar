/* The media gallery's rules: tabs, what can be picked, usage words, the space bar.
 *
 * Run with node --experimental-strip-types. */

import {
  acceptedKinds,
  deleteSummary,
  fitsAspect,
  formatForUpload,
  galleryTabs,
  listType,
  mergePage,
  pickProblem,
  spaceProblem,
  spaceSize,
  spaceSummary,
  uploadedText,
  usageText,
  whenText,
} from "./media-gallery.ts";

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

const MB = 1 << 20;

// Tabs follow what the caller takes; "All" only when there is a choice.
eq(galleryTabs(["IMAGE"]).map((t) => t.id), ["image"], "image only: one tab");
eq(galleryTabs(["VIDEO", "IMAGE"]).map((t) => t.id), ["all", "image", "video"], "card: all, images, videos");
eq(acceptedKinds(["DOCUMENT", "IMAGE", "IMAGE"]), ["image", "document"], "kinds ordered, no repeats");
eq(listType("all"), undefined, "all lists every type");
eq(listType("video"), "video", "a tab lists its type");

// An upload goes in as the accepted format its type belongs to.
eq(formatForUpload(["IMAGE", "VIDEO"], "video/mp4"), "VIDEO", "mp4 is a video");
eq(formatForUpload(["IMAGE"], "image/webp"), "IMAGE", "webp is an image");
eq(formatForUpload(["IMAGE"], "application/pdf"), null, "pdf where only images go");
eq(formatForUpload(["DOCUMENT"], "text/plain"), "DOCUMENT", "text is a document");

// Card shapes, with room for whole-pixel rounding.
eq(fitsAspect(800, 800, "square"), true, "800×800 is square");
eq(fitsAspect(1200, 628, "wide"), true, "1200×628 is wide");
eq(fitsAspect(1200, 628, "square"), false, "1200×628 is not square");
eq(fitsAspect(0, 0, "wide"), true, "unknown size passes");

eq(pickProblem({ kind: "image", width: 600, height: 600 }, ["IMAGE"]), null, "an image where images go");
eq(pickProblem({ kind: "document" }, ["IMAGE", "VIDEO"]), "This needs an image or a video.", "a document on a card");
eq(
  pickProblem({ kind: "image", width: 1200, height: 628 }, ["IMAGE", "VIDEO"], "square"),
  "Cards here are square (1:1); this image is 1200×628. Upload it again to crop it.",
  "a wide image on a square card",
);
eq(pickProblem({ kind: "video" }, ["IMAGE", "VIDEO"], "square"), null, "a video has no card shape here");

// Where a file is used, in words.
eq(usageText({ kind: "template", name: "promo_doc", language: "en" }), "Header of template promo_doc (en)", "template");
eq(usageText({ kind: "carousel", name: "courses", language: "hi" }), "Carousel card of template courses (hi)", "carousel");
eq(
  usageText({ kind: "broadcast", name: "Diwali offer", scheduledAt: "2026-11-01T12:30:00Z" }, "UTC"),
  "Broadcast “Diwali offer”, sending 1 Nov 2026, 12:30",
  "scheduled broadcast",
);
eq(whenText("not a date"), "not a date", "an unreadable time is shown as it came");

const now = new Date("2026-10-17T10:00:00Z");
eq(uploadedText("2026-10-17T08:00:00Z", now, "UTC"), "Today", "today");
eq(uploadedText("2026-10-16T08:00:00Z", now, "UTC"), "Yesterday", "yesterday");
eq(uploadedText("2026-03-03T08:00:00Z", now, "UTC"), "3 Mar 2026", "older");
eq(uploadedText(undefined, now), "", "no date");

// A delete's outcome.
eq(deleteSummary({ deleted: ["a", "b"], skipped: [], usedBytes: 0, limitBytes: 1 }), "Deleted 2 files.", "all deleted");
eq(
  deleteSummary({
    deleted: ["a"],
    skipped: [
      { id: "b", reason: "in_use", message: "" },
      { id: "c", reason: "storage", message: "" },
    ],
    usedBytes: 0,
    limitBytes: 1,
  }),
  "Deleted 1 file. 1 kept because it is still used (listed below). 1 could not be removed from storage — try again.",
  "partial",
);
eq(deleteSummary({ deleted: [], skipped: [], usedBytes: 0, limitBytes: 1 }), "Nothing was deleted.", "nothing");

// Pages append without repeating a file.
const f = (id: string) => ({ id, kind: "image", mimeType: "image/jpeg", bytes: 1, url: "" });
eq(mergePage([f("a"), f("b")], [f("b"), f("c")]).map((x) => x.id), ["a", "b", "c"], "merge pages");

// The library's space.
eq(spaceSize(12.4 * MB), "12.4 MB", "MB");
eq(spaceSize(10 * MB), "10 MB", "whole MB");
eq(spaceSize(2048 * MB), "2 GB", "GB");
eq(spaceSummary({ usedBytes: 2.5 * MB, limitBytes: 10 * MB }), { text: "2.5 MB of 10 MB used", fraction: 0.25, full: false }, "bar");
eq(spaceSummary({ usedBytes: 14 * MB, limitBytes: 10 * MB }).fraction, 1, "over the limit fills the bar");
eq(spaceSummary({ usedBytes: 14 * MB, limitBytes: 10 * MB }).full, true, "over the limit is full");

const space = { usedBytes: 9 * MB, limitBytes: 10 * MB };
eq(
  spaceProblem({ type: "application/pdf", size: 2 * MB }, space),
  "This file is 2 MB but only 1 MB of your 10 MB is left. Delete files you no longer use to make room.",
  "a document bigger than what is left",
);
eq(spaceProblem({ type: "application/pdf", size: MB / 2 }, space), null, "a document that fits");
eq(spaceProblem({ type: "image/jpeg", size: 8 * MB }, space), null, "an image is converted first, so not refused here");
eq(
  spaceProblem({ type: "image/jpeg", size: 1000 }, { usedBytes: 12 * MB, limitBytes: 10 * MB }),
  "Your media library is full (12 MB of 10 MB). Your files are kept, but delete some to upload more.",
  "a full library refuses even an image",
);

console.log(`${checks - failures}/${checks} media gallery checks passed`);
if (failures) process.exit(1);
