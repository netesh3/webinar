import assert from "node:assert/strict";
import {
  DEFAULT_CAPTIONS_LANGUAGE,
  captionsLanguageNote,
  captionsLanguageOptions,
  captionsLanguageValue,
} from "./captions-language.ts";

// What the server sends (api/types/captions_language.go), abridged.
const list = [
  { code: "en-IN", label: "English (India)", live: true },
  { code: "hi", label: "Hindi", live: true },
  { code: "multi", label: "Hindi + English (mixed)", live: true },
  { code: "ta", label: "Tamil", live: true },
  { code: "ml", label: "Malayalam", live: false },
];

// The select defaults to English (India): nothing chosen, nothing configured.
assert.equal(DEFAULT_CAPTIONS_LANGUAGE, "en-IN");
assert.equal(captionsLanguageValue(undefined, list, undefined), "en-IN");
assert.equal(captionsLanguageValue("", list, "en-IN"), "en-IN");
// The admin's default for new webinars, then the webinar's own choice.
assert.equal(captionsLanguageValue("", list, "hi"), "hi");
assert.equal(captionsLanguageValue("ta", list, "hi"), "ta");
// A code the list does not know falls back rather than showing a blank select.
assert.equal(captionsLanguageValue("ar", list, "xx"), "en-IN");

// Malayalam says captions will be off; a live language says nothing.
assert.equal(
  captionsLanguageNote("ml", list),
  "Malayalam captions are coming soon; captions will be off for this webinar.",
);
assert.equal(
  captionsLanguageNote("ml", list, "meeting"),
  "Malayalam captions are coming soon; captions will be off for this meeting.",
);
assert.equal(captionsLanguageNote("hi", list), null);
assert.equal(captionsLanguageNote("en-IN", list), null);

const opts = captionsLanguageOptions(list);
assert.deepEqual(opts[0], { value: "en-IN", label: "English (India)" });
assert.equal(opts.find((o) => o.value === "ml")?.label, "Malayalam (coming soon)");
assert.equal(opts.length, list.length);

console.log("captions-language: ok");
