/* Header media rules: Meta's limits, the list summary, and a broadcast's header fields.
 *
 * Run with node --experimental-strip-types. */

import {
  formatForKind,
  headerChoiceProblem,
  headerFileProblem,
  headerRequest,
  headerSummary,
  headerTextProblem,
} from "./header-media.ts";

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

eq(headerFileProblem("IMAGE", { type: "image/png", size: 5 * MB }), null, "5 MB png is fine");
eq(
  headerFileProblem("IMAGE", { type: "image/png", size: 5 * MB + 1 }),
  "WhatsApp takes an image of up to 5 MB.",
  "over 5 MB image refused",
);
eq(
  headerFileProblem("IMAGE", { type: "image/gif", size: 10 }),
  "An image header takes JPEG or PNG.",
  "gif refused",
);
eq(headerFileProblem("VIDEO", { type: "video/mp4", size: 16 * MB }), null, "16 MB mp4 fine");
eq(
  headerFileProblem("VIDEO", { type: "video/mp4", size: 17 * MB }) !== null,
  true,
  "17 MB video refused",
);
eq(headerFileProblem("DOCUMENT", { type: "application/pdf", size: 90 * MB }), null, "90 MB pdf");
eq(headerFileProblem("DOCUMENT", { type: "application/pdf", size: 0 }), "That file is empty.", "empty");
eq(headerFileProblem("DOCUMENT", { type: "video/mp4", size: 10 }) !== null, true, "video as doc");

eq(headerTextProblem("Welcome"), null, "plain header text");
eq(headerTextProblem("  ") !== null, true, "blank header text");
eq(headerTextProblem("x".repeat(61)) !== null, true, "61 characters");
eq(headerTextProblem("Hi {{1}}") !== null, true, "variables refused");

eq(formatForKind("video"), "VIDEO", "kind to format");
eq(formatForKind("sticker"), null, "unknown kind");

eq(headerSummary({ headerFormat: "TEXT" }), "", "text header has no media line");
eq(headerSummary({ headerFormat: "IMAGE" }), "Image header · the webinar's cover", "image cover");
eq(
  headerSummary({ headerFormat: "DOCUMENT", headerFile: { filename: "notes.pdf" } }),
  "Document header · notes.pdf",
  "document with file",
);
eq(
  headerSummary({ headerFormat: "VIDEO", needsHeaderFile: true }),
  "Video header · needs a file before it can be sent",
  "video without file",
);

eq(headerRequest("TEXT", { mode: "file", fileId: "x" }), {}, "no media header, no fields");
eq(headerRequest("IMAGE", { mode: "cover" }), { headerUseCover: true }, "cover on image");
eq(headerRequest("VIDEO", { mode: "cover" }), {}, "cover never on video");
eq(headerRequest("DOCUMENT", { mode: "file", fileId: "f1" }), { headerFileId: "f1" }, "own file");
eq(headerRequest("IMAGE", { mode: "default" }), {}, "default sends nothing extra");

eq(headerChoiceProblem({ headerFormat: "DOCUMENT" }, { mode: "default" }) !== null, true, "doc needs a file");
eq(headerChoiceProblem({ headerFormat: "DOCUMENT", headerFile: {} }, { mode: "default" }), null, "doc default file");
eq(headerChoiceProblem({ headerFormat: "VIDEO" }, { mode: "file", fileId: "x" }), null, "video own file");
eq(headerChoiceProblem({ headerFormat: "IMAGE" }, { mode: "default" }), null, "image falls back to cover");

console.log(`${checks - failures}/${checks} header media checks pass`);
if (failures > 0) process.exit(1);
