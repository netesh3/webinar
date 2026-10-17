/* Template editor options: Meta's rules as the editor checks them, the request it
 * builds, and a broadcast's coupon / offer end / card pictures.
 *
 * Run with node --experimental-strip-types. */

import {
  DEFAULT_FOOTER,
  DEFAULT_OPTIONS,
  addableButtons,
  broadcastExtrasProblem,
  broadcastExtrasRequest,
  buttonsProblem,
  effectiveFooter,
  footerWarning,
  insertButton,
  isHeic,
  kindsFor,
  languagesByName,
  newButton,
  optionsProblem,
  optionsRequest,
  processedSummary,
  templateKindLabel,
  withCategory,
  type ButtonDraft,
  type OptionsDraft,
} from "./template-options.ts";

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

const btn = (type: ButtonDraft["type"], over: Partial<ButtonDraft> = {}): ButtonDraft => ({
  ...newButton(type),
  ...over,
});
const qr = (text: string) => btn("QUICK_REPLY", { text });
const file = (id: string, kind = "image") => ({ id, kind, mimeType: "image/jpeg", bytes: 1, url: "u" });
const opts = (over: Partial<OptionsDraft>): OptionsDraft => ({ ...DEFAULT_OPTIONS, ...over });

// Category and kind.
eq(kindsFor("UTILITY"), ["STANDARD"], "utility is standard only");
eq(kindsFor("AUTHENTICATION"), ["AUTH"], "authentication is a code");
eq(withCategory(opts({ category: "MARKETING", kind: "CAROUSEL" }), "UTILITY").kind, "STANDARD", "carousel leaves with marketing");
eq(withCategory(opts({}), "AUTHENTICATION").kind, "AUTH", "authentication picks the code kind");

// Footer.
eq(effectiveFooter(opts({ category: "MARKETING" })), DEFAULT_FOOTER, "marketing keeps the opt-out line");
eq(effectiveFooter(opts({ category: "UTILITY" })), "", "utility has none by default");
eq(effectiveFooter(opts({ category: "MARKETING", kind: "OFFER", footer: "x" })), "", "an offer has no footer");
eq(footerWarning(opts({ category: "MARKETING", footer: "" })) !== null, true, "removing opt-out warns");
eq(footerWarning(opts({ category: "MARKETING" })), null, "the default does not warn");
eq(footerWarning(opts({ category: "UTILITY", footer: "" })), null, "utility does not warn");

// Buttons.
eq(buttonsProblem([qr("Yes"), qr("No")]), null, "two quick replies");
eq(buttonsProblem([qr("a"), btn("URL", { text: "Go", url: "https://a.com" }), qr("b")]) !== null, true, "split quick replies");
eq(buttonsProblem(Array.from({ length: 11 }, () => qr("x"))) !== null, true, "eleven buttons");
eq(buttonsProblem([btn("PHONE_NUMBER", { text: "Call", phoneNumber: "+91 98765 43210" })]), null, "spaced phone is fine");
eq(buttonsProblem([btn("PHONE_NUMBER", { text: "Call", phoneNumber: "98765 43210" })]) !== null, true, "phone needs country code");
eq(buttonsProblem([btn("PHONE_NUMBER", { text: "x".repeat(21), phoneNumber: "+919876543210" })]) !== null, true, "phone text ≤20");
eq(buttonsProblem([btn("COPY_CODE", { code: "SAVE-20" })]) !== null, true, "coupon letters and numbers");
eq(buttonsProblem([btn("URL", { text: "Go", url: "https://a.com/{{1}}/x" })]) !== null, true, "blank mid-link");
eq(buttonsProblem([btn("URL", { text: "Go", url: "https://a.com/{{1}}" })]), null, "blank at the end");
eq(
  buttonsProblem([btn("COPY_CODE", { code: "A" }), btn("COPY_CODE", { code: "B" })]) !== null,
  true,
  "one coupon",
);
eq(addableButtons([btn("PHONE_NUMBER"), btn("COPY_CODE")], "STANDARD"), ["QUICK_REPLY", "URL"], "one phone, one coupon");
eq(addableButtons([qr("a"), qr("b")], "CAROUSEL"), [], "two buttons per card");
eq(addableButtons([], "CAROUSEL").includes("COPY_CODE"), false, "no coupon on a card");
eq(
  insertButton([qr("a"), btn("URL")], qr("b")).map((b) => b.text || b.type),
  ["a", "b", "URL"],
  "a new quick reply joins the others",
);

// Whole template.
eq(optionsProblem(opts({}), "Hi {{1}}"), null, "standard is fine");
eq(optionsProblem(opts({}), ""), "Write the message.", "needs a body");
eq(optionsProblem(opts({ kind: "AUTH", category: "AUTHENTICATION" }), ""), null, "a code needs no body");
eq(
  optionsProblem(opts({ kind: "AUTH", category: "AUTHENTICATION", auth: { securityRecommendation: true, expirationMinutes: 91, buttonText: "" } }), "") !== null,
  true,
  "expiry ≤90",
);
eq(optionsProblem(opts({ footer: "f".repeat(61) }), "x") !== null, true, "footer ≤60");
eq(optionsProblem(opts({ footer: "Hi {{1}}" }), "x") !== null, true, "footer has no blanks");
const offer = opts({ category: "MARKETING", kind: "OFFER", offer: { text: "20% off", hasExpiration: true } });
eq(optionsProblem(offer, "Seats") !== null, true, "an offer needs a coupon or link");
eq(optionsProblem({ ...offer, buttons: [btn("COPY_CODE", { code: "SAVE20" })] }, "Seats"), null, "offer with coupon");
eq(optionsProblem({ ...offer, buttons: [btn("COPY_CODE", { code: "SAVE20" })] }, "x".repeat(601)) !== null, true, "offer body ≤600");
eq(
  optionsProblem({ ...offer, offer: { text: "x".repeat(17), hasExpiration: true }, buttons: [btn("COPY_CODE", { code: "A" })] }, "x") !== null,
  true,
  "offer text ≤16",
);
const car = opts({
  category: "MARKETING",
  kind: "CAROUSEL",
  cards: [
    { body: "Yoga", file: file("1"), buttons: [qr("More")] },
    { body: "Breath", file: file("2"), buttons: [qr("More")] },
  ],
});
eq(optionsProblem(car, "Pick one"), null, "carousel is fine");
eq(optionsProblem({ ...car, cards: [car.cards[0]] }, "x") !== null, true, "two cards at least");
eq(
  optionsProblem({ ...car, cards: [car.cards[0], { ...car.cards[1], buttons: [] }] }, "x"),
  "Every card needs the same buttons in the same order — WhatsApp shows them as one set.",
  "cards share a shape",
);
eq(optionsProblem({ ...car, cards: [car.cards[0], { ...car.cards[1], file: null }] }, "x"), "Card 2 needs its picture or video.", "every card has media");
eq(
  optionsProblem({ ...car, cards: [car.cards[0], { ...car.cards[1], file: file("2", "video") }] }, "x") !== null,
  true,
  "cards are all images or all videos",
);
eq(optionsProblem({ ...car, cards: [{ ...car.cards[0], body: "x".repeat(161) }, car.cards[1]] }, "x") !== null, true, "card text ≤160");

// The request.
eq(
  optionsRequest(opts({ kind: "AUTH", category: "AUTHENTICATION", language: "hi" }), "ignored"),
  { language: "hi", body: "", category: "AUTHENTICATION", auth: { securityRecommendation: true, expirationMinutes: 10 } },
  "auth request",
);
eq(
  optionsRequest({ ...offer, buttons: [btn("COPY_CODE", { code: " SAVE20 " })], footer: "dropped" }, " Seats "),
  { language: "en", body: "Seats", category: "MARKETING", buttons: [{ type: "COPY_CODE", code: "SAVE20" }], offer: { text: "20% off", hasExpiration: true } },
  "offer request: no footer",
);
eq(
  optionsRequest({ ...car, translationOf: "wl_own_1", title: "ignored", language: "ta" }, "Pick"),
  {
    language: "ta",
    name: "wl_own_1",
    body: "Pick",
    category: "MARKETING",
    cardAspect: "square",
    cards: [
      { fileId: "1", body: "Yoga", buttons: [{ type: "QUICK_REPLY", text: "More" }] },
      { fileId: "2", body: "Breath", buttons: [{ type: "QUICK_REPLY", text: "More" }] },
    ],
  },
  "carousel translation request",
);
eq(optionsRequest(opts({ footer: "" }), "x").footer, "", "a removed footer is sent as empty");
eq(optionsRequest(opts({ title: "  Webinar reminder 1 hour " }), "x").title, "Webinar reminder 1 hour", "a new template sends its title");
eq(optionsRequest(opts({ title: "Webinar reminder", translationOf: "webinar_reminder" }), "x").title, undefined, "a translation sends no title");
eq(optionsRequest(opts({}), "x").footer, undefined, "an untouched footer is left to the server");
eq(
  optionsRequest(opts({ buttons: [btn("PHONE_NUMBER", { text: "Call", phoneNumber: "+91 (98765) 43210" })] }), "x").buttons,
  [{ type: "PHONE_NUMBER", text: "Call", phoneNumber: "+919876543210" }],
  "phone normalised",
);

// Lists.
eq(templateKindLabel({ cards: [{ headerFormat: "IMAGE", body: "", buttons: [] }, { headerFormat: "IMAGE", body: "", buttons: [] }] }), "Carousel · 2 cards", "carousel label");
eq(templateKindLabel({ auth: { securityRecommendation: true } }), "One-time code", "auth label");
eq(
  [...languagesByName([
    { name: "a", language: "en", own: true },
    { name: "a", language: "hi", own: true },
    { name: "b", language: "en", own: true },
    { name: "from_manager", language: "en" },
  ])],
  [["a", ["en", "hi"]], ["b", ["en"]]],
  "languages per name",
);

// A broadcast's choices.
const now = new Date("2026-10-17T10:00:00Z");
const lto = { offer: { text: "20% off", hasExpiration: true }, buttons: [{ type: "COPY_CODE", text: "" }] };
const none = { coupon: "", offerEnds: "", cardFiles: [] };
eq(broadcastExtrasProblem(lto, none, now) !== null, true, "offer needs an end");
eq(broadcastExtrasProblem(lto, { ...none, offerEnds: "2026-10-17T09:00" }, now), "The offer's end has to be in the future.", "end in the past");
eq(broadcastExtrasProblem(lto, { ...none, offerEnds: "2026-10-20T09:00", coupon: "SAVE 20" }, now) !== null, true, "coupon checked");
eq(broadcastExtrasProblem(lto, { ...none, offerEnds: "2026-10-20T09:00" }, now), null, "offer ready");
const ends = "2026-10-20T09:00:00Z";
eq(
  broadcastExtrasRequest(lto, { coupon: "SEAT30", offerEnds: ends, cardFiles: [] }),
  { couponCode: "SEAT30", offerExpiresAt: "2026-10-20T09:00:00Z" },
  "offer request fields",
);
const carT = { cards: [{ headerFormat: "IMAGE", body: "", buttons: [] }, { headerFormat: "IMAGE", body: "", buttons: [] }], needsCardFiles: true, buttons: [] };
eq(broadcastExtrasProblem(carT, none, now) !== null, true, "carousel without pictures");
eq(broadcastExtrasProblem(carT, { ...none, cardFiles: [file("1"), null] }, now) !== null, true, "all cards or none");
eq(broadcastExtrasRequest(carT, { ...none, cardFiles: [file("1"), file("2")] }), { cardFileIds: ["1", "2"] }, "card ids");
eq(broadcastExtrasRequest({ buttons: [] }, { coupon: "X", offerEnds: ends, cardFiles: [] }), {}, "nothing for a plain template");

// Images.
eq(isHeic({ type: "", name: "IMG_1.HEIC" }), true, "heic by name");
eq(isHeic({ type: "image/heif", name: "a" }), true, "heif by type");
eq(isHeic({ type: "image/jpeg", name: "a.jpg" }), false, "jpeg is not heic");
eq(processedSummary({ width: 1600, height: 900, bytes: 412 * 1024, originalBytes: 6.1 * (1 << 20) }), "1600×900 · 412 KB (was 6.1 MB)", "processed summary");

if (failures) {
  console.log(`${failures} of ${checks} checks failed`);
  process.exit(1);
}
console.log(`ok  ${checks} checks`);
