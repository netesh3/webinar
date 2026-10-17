/* The template editor's options: category, language, the kind of template (standard,
 * limited-time offer, carousel, one-time code), the footer and the buttons.
 *
 * Meta's rules, mirrored from api/internal/engage/template_options.go so the editor
 * says what is wrong before submitting; the server checks again and is the one that
 * counts. Pure, so it runs under node's test runner. */

import type {
  CRMButtonInput,
  CRMMediaFile,
  CRMTemplate,
  CRMTemplateButton,
  CRMWordingRequest,
} from "../lib/api-types.ts";

export type Category = "UTILITY" | "MARKETING" | "AUTHENTICATION";
export type TemplateKind = "STANDARD" | "OFFER" | "CAROUSEL" | "AUTH";
export type ButtonType = "QUICK_REPLY" | "URL" | "PHONE_NUMBER" | "COPY_CODE";
export type CardAspect = "square" | "wide";

export const LANGUAGES: { code: string; label: string }[] = [
  { code: "en", label: "English" },
  { code: "hi", label: "Hindi" },
  { code: "ta", label: "Tamil" },
  { code: "te", label: "Telugu" },
  { code: "mr", label: "Marathi" },
  { code: "bn", label: "Bengali" },
  { code: "kn", label: "Kannada" },
  { code: "ml", label: "Malayalam" },
  { code: "gu", label: "Gujarati" },
  { code: "pa", label: "Punjabi" },
  { code: "ur", label: "Urdu" },
  { code: "en_US", label: "English (US)" },
];

export function languageLabel(code: string): string {
  return LANGUAGES.find((l) => l.code === code)?.label ?? code;
}

export const CATEGORIES: { id: Category; label: string; hint: string }[] = [
  {
    id: "UTILITY",
    label: "Utility",
    hint: "About something the person signed up for: confirmations, reminders, replays. Promotional wording is moved to Marketing automatically and charged as Marketing.",
  },
  {
    id: "MARKETING",
    label: "Marketing",
    hint: "Offers, launches, invitations to something new. Charged at Meta's marketing rate.",
  },
  {
    id: "AUTHENTICATION",
    label: "Authentication",
    hint: "A one-time code. WhatsApp writes the message itself; you choose the options.",
  },
];

export const KINDS: { id: TemplateKind; label: string; hint: string }[] = [
  { id: "STANDARD", label: "Standard", hint: "A header, the message, a footer and buttons." },
  { id: "OFFER", label: "Limited-time offer", hint: "An offer line with a countdown and a coupon or link." },
  { id: "CAROUSEL", label: "Carousel", hint: "2 to 10 cards people swipe through, each with a picture." },
  { id: "AUTH", label: "One-time code", hint: "A verification code with a copy button." },
];

export const LIMITS = {
  body: 1024,
  offerBody: 600,
  footer: 60,
  buttons: 10,
  quickReplies: 10,
  links: 2,
  buttonText: 25,
  phoneText: 20,
  coupon: 15,
  offerText: 16,
  cardBody: 160,
  cardButtons: 2,
  minCards: 2,
  maxCards: 10,
  authExpiry: 90,
} as const;

export const DEFAULT_FOOTER = "Reply STOP to opt out";

export type ButtonDraft = {
  type: ButtonType;
  text: string;
  url: string;
  phoneNumber: string;
  code: string;
};

export function newButton(type: ButtonType): ButtonDraft {
  return { type, text: "", url: "", phoneNumber: "", code: "" };
}

export const BUTTON_LABELS: Record<ButtonType, string> = {
  QUICK_REPLY: "Quick reply",
  URL: "Link",
  PHONE_NUMBER: "Call",
  COPY_CODE: "Coupon",
};

export type CardDraft = { body: string; file: CRMMediaFile | null; buttons: ButtonDraft[] };

export type OptionsDraft = {
  category: Category;
  language: string;
  kind: TemplateKind;
  /** null keeps the default opt-out line on Marketing; "" removes it. */
  footer: string | null;
  buttons: ButtonDraft[];
  auth: { securityRecommendation: boolean; expirationMinutes: number; buttonText: string };
  offer: { text: string; hasExpiration: boolean };
  cards: CardDraft[];
  cardAspect: CardAspect;
  /** A template of the host's own to add this language to; "" for a new one. */
  translationOf: string;
  /** A new template's name as typed; the server makes it Meta's (see template-name.ts). */
  title: string;
};

export function newCard(): CardDraft {
  return { body: "", file: null, buttons: [] };
}

export const DEFAULT_OPTIONS: OptionsDraft = {
  category: "UTILITY",
  language: "en",
  kind: "STANDARD",
  footer: null,
  buttons: [],
  auth: { securityRecommendation: true, expirationMinutes: 10, buttonText: "" },
  offer: { text: "", hasExpiration: true },
  cards: [newCard(), newCard()],
  cardAspect: "square",
  translationOf: "",
  title: "",
};

/** The kinds a category allows. Offers and carousels are Marketing; a code is Authentication. */
export function kindsFor(category: Category): TemplateKind[] {
  if (category === "AUTHENTICATION") return ["AUTH"];
  if (category === "MARKETING") return ["STANDARD", "OFFER", "CAROUSEL"];
  return ["STANDARD"];
}

/** Choosing a category moves the kind to one it allows. */
export function withCategory(o: OptionsDraft, category: Category): OptionsDraft {
  const kinds = kindsFor(category);
  return { ...o, category, kind: kinds.includes(o.kind) ? o.kind : kinds[0] };
}

/** The footer as it will be sent: the default on Marketing unless changed; none on offers and carousels. */
export function effectiveFooter(o: OptionsDraft): string {
  if (o.kind === "OFFER" || o.kind === "CAROUSEL" || o.kind === "AUTH") return "";
  if (o.footer === null) return o.category === "MARKETING" ? DEFAULT_FOOTER : "";
  return o.footer.trim();
}

/** A warning (not a refusal) when a Marketing template drops its opt-out line. */
export function footerWarning(o: OptionsDraft): string | null {
  if (o.category !== "MARKETING" || o.kind !== "STANDARD") return null;
  if (/stop|opt.?out|unsubscribe/i.test(effectiveFooter(o))) return null;
  return "Marketing messages without a way to opt out get blocked and reported more, which lowers your number's quality rating.";
}

const chars = (s: string) => [...s.trim()].length;
const PHONE = /^\+[1-9][0-9]{6,14}$/;
const COUPON = /^[A-Za-z0-9]+$/;

export function normalisePhone(raw: string): string {
  return raw.replace(/[\s\-()]/g, "");
}

/** Why this row of buttons cannot be submitted, or null. */
export function buttonsProblem(buttons: ButtonDraft[]): string | null {
  if (buttons.length > LIMITS.buttons) return `A template has up to ${LIMITS.buttons} buttons.`;
  let quick = 0;
  let links = 0;
  let phones = 0;
  let coupons = 0;
  let closed = false;
  for (const [i, b] of buttons.entries()) {
    const n = i + 1;
    if (b.type !== "QUICK_REPLY" && quick > 0) closed = true;
    switch (b.type) {
      case "QUICK_REPLY":
        if (closed) return "Keep the quick-reply buttons together, before or after the others.";
        quick++;
        if (!b.text.trim() || chars(b.text) > LIMITS.buttonText)
          return `Button ${n} needs its text, up to ${LIMITS.buttonText} characters.`;
        break;
      case "URL": {
        links++;
        const u = b.url.trim();
        if (!b.text.trim() || chars(b.text) > LIMITS.buttonText)
          return `Button ${n} needs its text, up to ${LIMITS.buttonText} characters.`;
        if (!/^https?:\/\//.test(u)) return `Button ${n}'s link must start with https://.`;
        if (u.includes("{{") && (!u.endsWith("{{1}}") || u.split("{{").length !== 2))
          return "A link can end in {{1}} for the person's own link, and nowhere else.";
        break;
      }
      case "PHONE_NUMBER":
        phones++;
        if (!b.text.trim() || chars(b.text) > LIMITS.phoneText)
          return `Button ${n} needs its text, up to ${LIMITS.phoneText} characters.`;
        if (!PHONE.test(normalisePhone(b.phoneNumber)))
          return `Button ${n}'s number needs its country code, like +91 98765 43210.`;
        break;
      case "COPY_CODE":
        coupons++;
        if (!COUPON.test(b.code.trim()) || b.code.trim().length > LIMITS.coupon)
          return `The coupon is up to ${LIMITS.coupon} letters and numbers, like SAVE20.`;
        break;
    }
  }
  if (quick > LIMITS.quickReplies) return `Up to ${LIMITS.quickReplies} quick replies.`;
  if (links > LIMITS.links) return `Up to ${LIMITS.links} link buttons.`;
  if (phones > 1) return "One phone-number button.";
  if (coupons > 1) return "One coupon button.";
  return null;
}

/** Which button types can still be added to this row. */
export function addableButtons(buttons: ButtonDraft[], kind: TemplateKind): ButtonType[] {
  const count = (t: ButtonType) => buttons.filter((b) => b.type === t).length;
  const max = kind === "CAROUSEL" ? LIMITS.cardButtons : LIMITS.buttons;
  if (buttons.length >= max) return [];
  const out: ButtonType[] = [];
  if (count("QUICK_REPLY") < LIMITS.quickReplies) out.push("QUICK_REPLY");
  if (count("URL") < LIMITS.links) out.push("URL");
  if (count("PHONE_NUMBER") < 1) out.push("PHONE_NUMBER");
  if (kind !== "CAROUSEL" && count("COPY_CODE") < 1) out.push("COPY_CODE");
  return out;
}

/** Quick replies kept together: a new one goes after the last quick reply. */
export function insertButton(buttons: ButtonDraft[], b: ButtonDraft): ButtonDraft[] {
  if (b.type !== "QUICK_REPLY") return [...buttons, b];
  const last = buttons.map((x) => x.type).lastIndexOf("QUICK_REPLY");
  if (last < 0) return [b, ...buttons];
  return [...buttons.slice(0, last + 1), b, ...buttons.slice(last + 1)];
}

/** The shape of a card's buttons, which every card has to share. */
export function cardShape(c: CardDraft): string {
  return c.buttons.map((b) => b.type).join(",");
}

/** Why the template cannot be submitted, or null. body is the message text. */
export function optionsProblem(o: OptionsDraft, body: string): string | null {
  if (o.kind === "AUTH") {
    if (o.auth.expirationMinutes < 0 || o.auth.expirationMinutes > LIMITS.authExpiry)
      return `The code can expire after 1 to ${LIMITS.authExpiry} minutes.`;
    if (chars(o.auth.buttonText) > LIMITS.buttonText)
      return `Keep the button text to ${LIMITS.buttonText} characters.`;
    return null;
  }
  const bodyMax = o.kind === "OFFER" ? LIMITS.offerBody : LIMITS.body;
  if (!body.trim()) return "Write the message.";
  if (chars(body) > bodyMax) return `The message is up to ${bodyMax} characters.`;
  if (o.footer !== null && (chars(o.footer) > LIMITS.footer || /\{\{/.test(o.footer)))
    return `The footer is up to ${LIMITS.footer} characters, with no {{1}} blanks.`;
  if (o.kind === "CAROUSEL") {
    if (o.cards.length < LIMITS.minCards || o.cards.length > LIMITS.maxCards)
      return `A carousel has ${LIMITS.minCards} to ${LIMITS.maxCards} cards.`;
    const shape = cardShape(o.cards[0]);
    for (const [i, c] of o.cards.entries()) {
      if (!c.body.trim() || chars(c.body) > LIMITS.cardBody)
        return `Card ${i + 1} needs its text, up to ${LIMITS.cardBody} characters.`;
      if (/\{\{/.test(c.body)) return `Card ${i + 1}'s text can't have {{1}} blanks.`;
      if (!c.file) return `Card ${i + 1} needs its picture or video.`;
      if (c.buttons.length > LIMITS.cardButtons) return `A card has up to ${LIMITS.cardButtons} buttons.`;
      const p = buttonsProblem(c.buttons);
      if (p) return `Card ${i + 1}: ${p}`;
      if (cardShape(c) !== shape)
        return "Every card needs the same buttons in the same order — WhatsApp shows them as one set.";
    }
    const kinds = new Set(o.cards.map((c) => c.file?.kind));
    if (kinds.size > 1) return "Every card needs the same kind of media — all images or all videos.";
    return null;
  }
  const p = buttonsProblem(o.buttons);
  if (p) return p;
  if (o.kind === "OFFER") {
    if (!o.offer.text.trim() || chars(o.offer.text) > LIMITS.offerText)
      return `Write the offer line, up to ${LIMITS.offerText} characters — like "20% off".`;
    if (!o.buttons.some((b) => b.type === "COPY_CODE" || b.type === "URL"))
      return "A limited-time offer needs a coupon (copy-code) button or a link button.";
  }
  return null;
}

function buttonInput(b: ButtonDraft): CRMButtonInput {
  switch (b.type) {
    case "URL":
      return { type: b.type, text: b.text.trim(), url: b.url.trim() };
    case "PHONE_NUMBER":
      return { type: b.type, text: b.text.trim(), phoneNumber: normalisePhone(b.phoneNumber) };
    case "COPY_CODE":
      return { type: b.type, code: b.code.trim() };
    default:
      return { type: b.type, text: b.text.trim() };
  }
}

/** The request's options. The header is the caller's (it has the file picker). */
export function optionsRequest(
  o: OptionsDraft,
  body: string,
): Omit<CRMWordingRequest, "header"> {
  const base = {
    language: o.language,
    ...(o.translationOf
      ? { name: o.translationOf }
      : o.title.trim()
        ? { title: o.title.trim() }
        : {}),
  };
  if (o.kind === "AUTH") {
    return {
      ...base,
      body: "",
      category: "AUTHENTICATION",
      auth: {
        securityRecommendation: o.auth.securityRecommendation,
        expirationMinutes: o.auth.expirationMinutes || undefined,
        buttonText: o.auth.buttonText.trim() || undefined,
      },
    };
  }
  const req: Omit<CRMWordingRequest, "header"> = { ...base, body: body.trim(), category: o.category };
  if (o.kind === "STANDARD" && o.footer !== null) req.footer = o.footer.trim();
  if (o.kind === "CAROUSEL") {
    req.cardAspect = o.cardAspect;
    req.cards = o.cards.map((c) => ({
      fileId: c.file?.id ?? "",
      body: c.body.trim(),
      buttons: c.buttons.map(buttonInput),
    }));
    return req;
  }
  if (o.buttons.length) req.buttons = o.buttons.map(buttonInput);
  if (o.kind === "OFFER") req.offer = { text: o.offer.text.trim(), hasExpiration: o.offer.hasExpiration };
  return req;
}

/** Can this template have a header above the message? (Not a carousel or a code.) */
export function allowsHeader(kind: TemplateKind): boolean {
  return kind === "STANDARD" || kind === "OFFER";
}

/** What a template is, for a list: "Carousel · 3 cards", "Limited-time offer", … */
export function templateKindLabel(t: Pick<CRMTemplate, "offer" | "cards" | "auth">): string {
  if (t.auth) return "One-time code";
  if (t.cards?.length) return `Carousel · ${t.cards.length} cards`;
  if (t.offer) return "Limited-time offer";
  return "";
}

/** The host's own templates (written here, so they take translations) by name, with the
 *  languages each is in. */
export function languagesByName(
  templates: Pick<CRMTemplate, "name" | "language" | "own">[],
): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const t of templates) {
    if (!t.own) continue;
    const list = out.get(t.name) ?? [];
    if (!list.includes(t.language)) list.push(t.language);
    out.set(t.name, list);
  }
  return out;
}

/* ---- A broadcast's choices for its template ---- */

export function hasCouponButton(t: { buttons?: CRMTemplateButton[] }): boolean {
  return Boolean(t.buttons?.some((b) => b.type === "COPY_CODE"));
}

/** Why the broadcast's coupon, offer end or card pictures are not ready, or null. */
export function broadcastExtrasProblem(
  t: Pick<CRMTemplate, "offer" | "cards" | "needsCardFiles" | "buttons">,
  extras: { coupon: string; offerEnds: string; cardFiles: (CRMMediaFile | null)[] },
  now: Date = new Date(),
): string | null {
  const c = extras.coupon.trim();
  if (c && (!COUPON.test(c) || c.length > LIMITS.coupon))
    return `The coupon is up to ${LIMITS.coupon} letters and numbers, like SAVE20.`;
  if (t.offer?.hasExpiration) {
    if (!extras.offerEnds) return "Choose when the offer ends — WhatsApp counts down to it.";
    const at = new Date(extras.offerEnds);
    if (Number.isNaN(at.getTime()) || at <= now) return "The offer's end has to be in the future.";
  }
  const cards = t.cards ?? [];
  if (cards.length) {
    const own = extras.cardFiles.filter(Boolean).length;
    if (own > 0 && own !== cards.length) return `Give a picture for each of the ${cards.length} cards, or none.`;
    if (own === 0 && t.needsCardFiles) return `Upload a picture for each of the ${cards.length} cards.`;
  }
  return null;
}

/** The request's fields for those choices. offerEnds is a datetime-local value. */
export function broadcastExtrasRequest(
  t: Pick<CRMTemplate, "offer" | "cards" | "buttons">,
  extras: { coupon: string; offerEnds: string; cardFiles: (CRMMediaFile | null)[] },
): { couponCode?: string; offerExpiresAt?: string; cardFileIds?: string[] } {
  const out: { couponCode?: string; offerExpiresAt?: string; cardFileIds?: string[] } = {};
  if (hasCouponButton(t) && extras.coupon.trim()) out.couponCode = extras.coupon.trim();
  if (t.offer?.hasExpiration && extras.offerEnds) {
    const at = new Date(extras.offerEnds);
    if (!Number.isNaN(at.getTime())) out.offerExpiresAt = at.toISOString().replace(/\.\d{3}Z$/, "Z");
  }
  const files = extras.cardFiles.filter((f): f is CRMMediaFile => Boolean(f));
  if (t.cards?.length && files.length === t.cards.length) out.cardFileIds = files.map((f) => f.id);
  return out;
}

/* ---- Images on upload ---- */

const MB = 1 << 20;

/** Image types the server converts. HEIC is converted in the browser first, where it can be. */
export const IMAGE_INPUT_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"];
export const IMAGE_INPUT_LIMIT = 25 * MB;

export function isHeic(file: { type: string; name: string }): boolean {
  return /^image\/hei[cf]/i.test(file.type) || /\.hei[cf]$/i.test(file.name);
}

/** "1600×900 · 412 KB (was 6.1 MB)" for a processed upload. */
export function processedSummary(f: Pick<CRMMediaFile, "width" | "height" | "bytes" | "originalBytes">): string {
  const parts: string[] = [];
  if (f.width && f.height) parts.push(`${f.width}×${f.height}`);
  parts.push(sizeText(f.bytes));
  let out = parts.join(" · ");
  if (f.originalBytes && f.originalBytes !== f.bytes) out += ` (was ${sizeText(f.originalBytes)})`;
  return out;
}

export function sizeText(bytes: number): string {
  if (bytes >= MB) return `${(bytes / MB).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}
