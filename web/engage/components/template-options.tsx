"use client";

import { useId } from "react";
import { MaterialIcon } from "@/components/icons";
import { Button } from "@/components/ui";
import type { CRMMediaFile, CRMTemplate } from "@/lib/api-types";
import {
  BUTTON_LABELS,
  CATEGORIES,
  DEFAULT_FOOTER,
  KINDS,
  LANGUAGES,
  LIMITS,
  addableButtons,
  allowsHeader,
  effectiveFooter,
  footerWarning,
  insertButton,
  kindsFor,
  languageLabel,
  newButton,
  newCard,
  withCategory,
  type ButtonDraft,
  type ButtonType,
  type CardDraft,
  type OptionsDraft,
  type TemplateKind,
} from "../template-options";
import { HeaderFileButton, HeaderMediaBlock, fileDetail, type HeaderDraft } from "./header-media";

/* The template editor's options and the WhatsApp-style preview of every shape. Rules
 * are in ../template-options.ts; this is the form and the bubble. */

const OTP_TOOLTIP =
  "WhatsApp's one-tap and zero-tap autofill need an Android app of your own to hand the code to. Webinar Liv has none, so the code comes with a copy button.";

/** The category, language, kind and every option for it. The message text and header stay with the caller. */
export function TemplateOptionsFields({
  value,
  onChange,
  disabled,
  ownNames,
}: {
  value: OptionsDraft;
  onChange: (next: OptionsDraft) => void;
  disabled?: boolean;
  /** The host's own templates (name → languages), to add a translation to. */
  ownNames?: Map<string, string[]>;
}) {
  const id = useId();
  const category = CATEGORIES.find((c) => c.id === value.category) ?? CATEGORIES[0];
  const kinds = kindsFor(value.category);
  const set = (patch: Partial<OptionsDraft>) => onChange({ ...value, ...patch });
  const translatable = [...(ownNames ?? new Map<string, string[]>()).entries()].filter(([n]) =>
    n.startsWith("wl_own_"),
  );
  const taken = value.translationOf ? (ownNames?.get(value.translationOf) ?? []) : [];

  return (
    <div className="grid gap-2.5">
      <div className="flex flex-wrap items-end gap-2">
        <label className="grid gap-1 text-[12px] text-ink-2" htmlFor={`${id}-cat`}>
          Category
          <select
            id={`${id}-cat`}
            className="field h-8 w-auto"
            value={value.category}
            disabled={disabled}
            onChange={(e) => onChange(withCategory(value, e.target.value as OptionsDraft["category"]))}
          >
            {CATEGORIES.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-1 text-[12px] text-ink-2" htmlFor={`${id}-lang`}>
          Language
          <select
            id={`${id}-lang`}
            className="field h-8 w-auto"
            value={value.language}
            disabled={disabled}
            onChange={(e) => set({ language: e.target.value })}
          >
            {LANGUAGES.map((l) => (
              <option key={l.code} value={l.code} disabled={taken.includes(l.code)}>
                {l.label}
                {taken.includes(l.code) ? " (already added)" : ""}
              </option>
            ))}
          </select>
        </label>
        {translatable.length > 0 && (
          <label className="grid gap-1 text-[12px] text-ink-2" htmlFor={`${id}-tr`}>
            Translation of
            <select
              id={`${id}-tr`}
              className="field h-8 w-auto max-w-[220px]"
              value={value.translationOf}
              disabled={disabled}
              onChange={(e) => set({ translationOf: e.target.value })}
            >
              <option value="">A new template</option>
              {translatable.map(([name, langs]) => (
                <option key={name} value={name}>
                  {name.replace(/^wl_own_/, "")} · {langs.map(languageLabel).join(", ")}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      <p className="text-[11.5px] leading-snug text-ink-3">{category.hint}</p>
      {value.translationOf && (
        <p className="text-[11.5px] leading-snug text-ink-3">
          Same name, another language: each contact gets the language the broadcast picks.
          Write it with the same blanks and buttons.
        </p>
      )}

      {kinds.length > 1 && (
        <fieldset className="grid gap-1.5">
          <legend className="mb-1 text-[12px] text-ink-2">Kind</legend>
          <div className="grid gap-1.5 sm:grid-cols-3">
            {kinds.map((k) => {
              const kind = KINDS.find((x) => x.id === k)!;
              const checked = value.kind === k;
              return (
                <label
                  key={k}
                  className={`cursor-pointer rounded-lg border px-2.5 py-1.5 ${
                    checked ? "border-brand ring-1 ring-brand" : "border-line hover:border-line-2"
                  }`}
                >
                  <input
                    type="radio"
                    className="sr-only"
                    name={`${id}-kind`}
                    checked={checked}
                    disabled={disabled}
                    onChange={() => set({ kind: k as TemplateKind })}
                  />
                  <span className="block text-[12.5px] font-medium text-ink">{kind.label}</span>
                  <span className="block text-[11px] leading-snug text-ink-3">{kind.hint}</span>
                </label>
              );
            })}
          </div>
        </fieldset>
      )}

      {value.kind === "AUTH" && <AuthFields value={value} onChange={onChange} disabled={disabled} />}

      {value.kind === "OFFER" && (
        <div className="grid gap-1.5 rounded-lg border border-line px-2.5 py-2">
          <label className="grid gap-1 text-[12px] text-ink-2">
            Offer line ({LIMITS.offerText} characters)
            <input
              className="field h-8"
              value={value.offer.text}
              maxLength={LIMITS.offerText}
              disabled={disabled}
              placeholder="20% off"
              onChange={(e) => set({ offer: { ...value.offer, text: e.target.value } })}
            />
          </label>
          <label className="flex items-center gap-2 text-[12px] text-ink-2">
            <input
              type="checkbox"
              checked={value.offer.hasExpiration}
              disabled={disabled}
              onChange={(e) => set({ offer: { ...value.offer, hasExpiration: e.target.checked } })}
            />
            Show a countdown — you pick when it ends on each broadcast
          </label>
          <p className="text-[11px] leading-snug text-ink-3">
            Message up to {LIMITS.offerBody} characters, no footer, and a coupon or link button.
            The offer card shows on phones; WhatsApp desktop and web show the plain message.
          </p>
        </div>
      )}

      {value.kind === "CAROUSEL" && <CardsEditor value={value} onChange={onChange} disabled={disabled} />}

      {(value.kind === "STANDARD" || value.kind === "OFFER") && (
        <ButtonsEditor
          kind={value.kind}
          buttons={value.buttons}
          disabled={disabled}
          onChange={(buttons) => set({ buttons })}
        />
      )}

      {value.kind === "STANDARD" && <FooterField value={value} onChange={onChange} disabled={disabled} />}
    </div>
  );
}

function AuthFields({
  value,
  onChange,
  disabled,
}: {
  value: OptionsDraft;
  onChange: (next: OptionsDraft) => void;
  disabled?: boolean;
}) {
  const a = value.auth;
  const set = (patch: Partial<OptionsDraft["auth"]>) => onChange({ ...value, auth: { ...a, ...patch } });
  return (
    <div className="grid gap-1.5 rounded-lg border border-line px-2.5 py-2">
      <p className="text-[11.5px] leading-snug text-ink-3">
        WhatsApp writes this message itself: “<b>123456</b> is your verification code.” You choose
        the options below.
      </p>
      <label className="flex items-center gap-2 text-[12px] text-ink-2">
        <input
          type="checkbox"
          checked={a.securityRecommendation}
          disabled={disabled}
          onChange={(e) => set({ securityRecommendation: e.target.checked })}
        />
        Add “For your security, do not share this code.”
      </label>
      <label className="flex items-center gap-2 text-[12px] text-ink-2">
        <input
          type="checkbox"
          checked={a.expirationMinutes > 0}
          disabled={disabled}
          onChange={(e) => set({ expirationMinutes: e.target.checked ? 10 : 0 })}
        />
        Say when it expires, after
        <input
          type="number"
          className="field h-7 w-16"
          min={1}
          max={LIMITS.authExpiry}
          value={a.expirationMinutes || ""}
          disabled={disabled || a.expirationMinutes === 0}
          onChange={(e) => set({ expirationMinutes: Math.max(0, Math.min(LIMITS.authExpiry, Number(e.target.value) || 0)) })}
          aria-label="Minutes until the code expires"
        />
        minutes
      </label>
      <label className="flex flex-wrap items-center gap-2 text-[12px] text-ink-2">
        Button
        <span className="rounded border border-line px-1.5 py-px text-[11px]">Copy code</span>
        <span className="inline-flex items-center text-ink-3" title={OTP_TOOLTIP} aria-label={OTP_TOOLTIP}>
          <MaterialIcon name="info" className="!text-[15px]" />
        </span>
        <input
          className="field h-7 w-40"
          value={a.buttonText}
          maxLength={LIMITS.buttonText}
          placeholder="Copy code"
          disabled={disabled}
          onChange={(e) => set({ buttonText: e.target.value })}
          aria-label="Button text"
        />
      </label>
      <p className="text-[11px] leading-snug text-ink-3">
        Authentication templates carry one person&apos;s code, so they aren&apos;t offered for
        broadcasts or reminders.
      </p>
    </div>
  );
}

function FooterField({
  value,
  onChange,
  disabled,
}: {
  value: OptionsDraft;
  onChange: (next: OptionsDraft) => void;
  disabled?: boolean;
}) {
  const shown = value.footer ?? effectiveFooter(value);
  const warning = footerWarning(value);
  return (
    <div className="grid gap-1">
      <label className="grid gap-1 text-[12px] text-ink-2">
        Footer (optional, {LIMITS.footer} characters, no blanks)
        <input
          className="field h-8"
          value={shown}
          maxLength={LIMITS.footer}
          disabled={disabled}
          placeholder={value.category === "MARKETING" ? DEFAULT_FOOTER : "Webinar Liv"}
          onChange={(e) => onChange({ ...value, footer: e.target.value })}
        />
      </label>
      {warning && (
        <p className="flex items-start gap-1 text-[11.5px] leading-snug text-warn">
          <MaterialIcon name="warning" className="!text-[14px]" />
          <span>
            {warning}{" "}
            <button
              type="button"
              className="underline"
              onClick={() => onChange({ ...value, footer: DEFAULT_FOOTER })}
            >
              Put it back
            </button>
          </span>
        </p>
      )}
    </div>
  );
}

/** A row of buttons: add by type, edit, remove. Quick replies stay together. */
export function ButtonsEditor({
  kind,
  buttons,
  onChange,
  disabled,
}: {
  kind: TemplateKind;
  buttons: ButtonDraft[];
  onChange: (next: ButtonDraft[]) => void;
  disabled?: boolean;
}) {
  const addable = addableButtons(buttons, kind);
  const max = kind === "CAROUSEL" ? LIMITS.cardButtons : LIMITS.buttons;
  const update = (i: number, patch: Partial<ButtonDraft>) =>
    onChange(buttons.map((b, j) => (j === i ? { ...b, ...patch } : b)));
  return (
    <div className="grid gap-1.5">
      <div className="flex flex-wrap items-center gap-1.5 text-[12px] text-ink-2">
        <span className="mr-1">
          Buttons{" "}
          <span className="text-ink-3">
            ({buttons.length}/{max})
          </span>
        </span>
        {addable.map((t) => (
          <Button
            key={t}
            type="button"
            size="sm"
            variant="ghost"
            className="h-6 px-1.5 text-[11.5px]"
            disabled={disabled}
            onClick={() => onChange(insertButton(buttons, newButton(t)))}
          >
            <MaterialIcon name="add" className="!text-[14px]" />
            {BUTTON_LABELS[t]}
          </Button>
        ))}
      </div>
      {buttons.map((b, i) => (
        <div key={i} className="flex flex-wrap items-center gap-1.5">
          <span className="w-[72px] shrink-0 text-[11.5px] text-ink-3">{BUTTON_LABELS[b.type]}</span>
          {b.type !== "COPY_CODE" && (
            <input
              className="field h-7 min-w-0 flex-1"
              value={b.text}
              maxLength={b.type === "PHONE_NUMBER" ? LIMITS.phoneText : LIMITS.buttonText}
              placeholder={b.type === "QUICK_REPLY" ? "Yes, I'm in" : b.type === "URL" ? "Book a seat" : "Call us"}
              disabled={disabled}
              onChange={(e) => update(i, { text: e.target.value })}
              aria-label={`Button ${i + 1} text`}
            />
          )}
          {b.type === "URL" && (
            <input
              className="field h-7 min-w-0 flex-[2]"
              value={b.url}
              placeholder="https://… (end with {{1}} for each person's own link)"
              disabled={disabled}
              onChange={(e) => update(i, { url: e.target.value })}
              aria-label={`Button ${i + 1} link`}
            />
          )}
          {b.type === "PHONE_NUMBER" && (
            <input
              className="field h-7 min-w-0 flex-1"
              value={b.phoneNumber}
              placeholder="+91 98765 43210"
              inputMode="tel"
              disabled={disabled}
              onChange={(e) => update(i, { phoneNumber: e.target.value })}
              aria-label={`Button ${i + 1} phone number`}
            />
          )}
          {b.type === "COPY_CODE" && (
            <input
              className="field h-7 min-w-0 flex-1 font-mono uppercase"
              value={b.code}
              maxLength={LIMITS.coupon}
              placeholder="SAVE20 (each broadcast can set its own)"
              disabled={disabled}
              onChange={(e) => update(i, { code: e.target.value.replace(/[^A-Za-z0-9]/g, "") })}
              aria-label="Coupon code"
            />
          )}
          <button
            type="button"
            className="grid size-7 place-items-center rounded text-ink-3 hover:bg-surface-2"
            disabled={disabled}
            onClick={() => onChange(buttons.filter((_, j) => j !== i))}
            aria-label={`Remove button ${i + 1}`}
          >
            <MaterialIcon name="close" className="!text-[16px]" />
          </button>
        </div>
      ))}
    </div>
  );
}

function CardsEditor({
  value,
  onChange,
  disabled,
}: {
  value: OptionsDraft;
  onChange: (next: OptionsDraft) => void;
  disabled?: boolean;
}) {
  const id = useId();
  const cards = value.cards;
  const setCards = (next: CardDraft[]) => onChange({ ...value, cards: next });
  const update = (i: number, patch: Partial<CardDraft>) => setCards(cards.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  /* Every card shares the first card's buttons and their text; a card keeps its own
   * link or number when the button in that place is still the same kind. */
  const setShape = (buttons: ButtonDraft[]) =>
    setCards(
      cards.map((c, j) =>
        j === 0
          ? { ...c, buttons }
          : {
              ...c,
              buttons: buttons.map((b, k) => {
                const own = c.buttons[k];
                return own?.type === b.type ? { ...b, url: own.url, phoneNumber: own.phoneNumber } : { ...b };
              }),
            },
      ),
    );
  return (
    <div className="grid gap-2">
      <fieldset className="flex flex-wrap items-center gap-2 text-[12px] text-ink-2">
        <legend className="sr-only">Card picture shape</legend>
        Card pictures
        {(["square", "wide"] as const).map((a) => (
          <label key={a} className="flex items-center gap-1">
            <input
              type="radio"
              name={`${id}-aspect`}
              checked={value.cardAspect === a}
              disabled={disabled}
              onChange={() => onChange({ ...value, cardAspect: a, cards: cards.map((c) => ({ ...c, file: c.file?.kind === "video" ? c.file : null })) })}
            />
            {a === "square" ? "Square (1:1)" : "Wide (1.91:1)"}
          </label>
        ))}
      </fieldset>
      <p className="-mt-1 text-[11px] leading-snug text-ink-3">
        WhatsApp needs every card the same shape, so each image is cut to it from the centre on
        upload. Changing the shape asks for the images again.
      </p>
      <div className="rounded-lg border border-line px-2.5 py-2">
        <p className="mb-1 text-[11.5px] text-ink-3">Every card&apos;s buttons (up to {LIMITS.cardButtons})</p>
        <ButtonsEditor kind="CAROUSEL" buttons={cards[0]?.buttons ?? []} onChange={setShape} disabled={disabled} />
      </div>
      {cards.map((c, i) => (
        <div key={i} className="grid gap-1.5 rounded-lg border border-line px-2.5 py-2">
          <div className="flex items-center gap-2 text-[12px] font-medium text-ink">
            Card {i + 1}
            <span className="mr-auto" />
            {cards.length > LIMITS.minCards && (
              <button
                type="button"
                className="text-[11.5px] text-ink-3 underline"
                disabled={disabled}
                onClick={() => setCards(cards.filter((_, j) => j !== i))}
              >
                Remove
              </button>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2 text-[11.5px] text-ink-3">
            <HeaderFileButton
              format="IMAGE"
              formats={["IMAGE", "VIDEO"]}
              aspect={value.cardAspect}
              label={c.file ? "Replace media" : "Choose media"}
              disabled={disabled}
              onUploaded={(file) => update(i, { file })}
            />
            {c.file && <span className="min-w-0 truncate">{fileDetail(c.file)}</span>}
          </div>
          <textarea
            className="field min-h-[44px] resize-y py-1.5"
            rows={2}
            value={c.body}
            maxLength={LIMITS.cardBody}
            disabled={disabled}
            placeholder="Yoga for beginners · 6 weeks"
            onChange={(e) => update(i, { body: e.target.value })}
            aria-label={`Card ${i + 1} text`}
          />
          {i > 0 &&
            c.buttons.map((b, k) =>
              b.type === "URL" || b.type === "PHONE_NUMBER" ? (
                <input
                  key={k}
                  className="field h-7"
                  value={b.type === "URL" ? b.url : b.phoneNumber}
                  placeholder={b.type === "URL" ? `Card ${i + 1}'s link` : `Card ${i + 1}'s number`}
                  disabled={disabled}
                  onChange={(e) =>
                    update(i, {
                      buttons: c.buttons.map((x, j) =>
                        j === k ? { ...x, ...(b.type === "URL" ? { url: e.target.value } : { phoneNumber: e.target.value }) } : x,
                      ),
                    })
                  }
                  aria-label={`Card ${i + 1} ${b.type === "URL" ? "link" : "number"}`}
                />
              ) : null,
            )}
        </div>
      ))}
      {cards.length < LIMITS.maxCards && (
        <div>
          <Button
            type="button"
            size="sm"
            variant="secondary"
            className="h-7 px-2.5 text-[12px]"
            disabled={disabled}
            onClick={() =>
              setCards([...cards, { ...newCard(), buttons: (cards[0]?.buttons ?? []).map((b) => ({ ...b })) }])
            }
          >
            <MaterialIcon name="add" className="!text-[15px]" />
            Add a card
          </Button>
        </div>
      )}
    </div>
  );
}

/* ---- Preview ---- */

type PreviewButton = { type: string; text: string };
type PreviewCard = { format: string; file?: CRMMediaFile | null; body: string; buttons: PreviewButton[] };

/** Everything a WhatsApp bubble shows, from a draft or from a synced template. */
export type PreviewModel = {
  headerFormat?: string;
  headerText?: string;
  headerFile?: CRMMediaFile | null;
  offer?: { text: string; hasExpiration: boolean; code?: string };
  body: string;
  footer?: string;
  buttons: PreviewButton[];
  cards?: PreviewCard[];
  cardAspect?: string;
  auth?: { securityRecommendation: boolean; expirationMinutes?: number; buttonText?: string };
};

function buttonLabel(b: { type: string; text?: string; code?: string }): string {
  if (b.type === "COPY_CODE") return "Copy offer code";
  return b.text?.trim() || BUTTON_LABELS[b.type as ButtonType] || "Button";
}

export function previewFromDraft(header: HeaderDraft, body: string, o: OptionsDraft): PreviewModel {
  if (o.kind === "AUTH") {
    return { body: "", buttons: [], auth: { ...o.auth } };
  }
  const coupon = o.buttons.find((b) => b.type === "COPY_CODE")?.code;
  return {
    headerFormat: allowsHeader(o.kind) ? header.format : undefined,
    headerText: header.format === "TEXT" ? header.text : undefined,
    headerFile: header.file,
    offer: o.kind === "OFFER" ? { ...o.offer, code: coupon } : undefined,
    body,
    footer: effectiveFooter(o),
    buttons: o.kind === "CAROUSEL" ? [] : o.buttons.map((b) => ({ type: b.type, text: buttonLabel(b) })),
    cards:
      o.kind === "CAROUSEL"
        ? o.cards.map((c) => ({
            format: c.file?.kind === "video" ? "VIDEO" : "IMAGE",
            file: c.file,
            body: c.body,
            buttons: c.buttons.map((b) => ({ type: b.type, text: buttonLabel(b) })),
          }))
        : undefined,
    cardAspect: o.cardAspect,
  };
}

export function previewFromTemplate(t: CRMTemplate): PreviewModel {
  const coupon = t.couponCode || t.buttons.find((b) => b.type === "COPY_CODE")?.example;
  return {
    headerFormat: t.headerFormat,
    headerText: (t.headerFormat ?? "").toUpperCase() === "TEXT" ? t.header : undefined,
    headerFile: t.headerFile,
    offer: t.offer ? { ...t.offer, code: coupon } : undefined,
    body: t.body ?? "",
    footer: t.footer,
    buttons: t.auth ? [] : t.buttons.map((b) => ({ type: b.type, text: buttonLabel(b) })),
    cards: t.cards?.map((c) => ({
      format: c.headerFormat,
      file: c.file,
      body: c.body,
      buttons: c.buttons.map((b) => ({ type: b.type, text: buttonLabel(b) })),
    })),
    cardAspect: t.cardAspect,
    auth: t.auth
      ? { ...t.auth, buttonText: t.buttons.find((b) => b.type === "OTP")?.text }
      : undefined,
  };
}

const BUTTON_ICON: Record<string, string> = {
  QUICK_REPLY: "reply",
  URL: "open_in_new",
  PHONE_NUMBER: "call",
  COPY_CODE: "content_copy",
  OTP: "content_copy",
};

function Buttons({ buttons }: { buttons: PreviewButton[] }) {
  if (!buttons.length) return null;
  // WhatsApp shows three; more fold under "See all options".
  const shown = buttons.length > 3 ? buttons.slice(0, 2) : buttons;
  return (
    <div className="divide-y divide-black/5 border-t border-black/5">
      {shown.map((b, i) => (
        <div key={i} className="flex items-center justify-center gap-1 py-1.5 text-[12.5px] font-medium text-[#027eb5]">
          <MaterialIcon name={BUTTON_ICON[b.type] ?? "reply"} className="!text-[15px]" />
          {b.text}
        </div>
      ))}
      {buttons.length > 3 && (
        <div className="flex items-center justify-center gap-1 py-1.5 text-[12.5px] font-medium text-[#027eb5]">
          <MaterialIcon name="list" className="!text-[15px]" />
          See all options
        </div>
      )}
    </div>
  );
}

function Body({ text }: { text: string }) {
  // WhatsApp's *bold* and _italic_, and blanks shown as they are.
  const parts = text.split(/(\*[^*\n]+\*|_[^_\n]+_)/g);
  return (
    <p className="whitespace-pre-wrap">
      {parts.map((p, i) =>
        /^\*[^*]+\*$/.test(p) ? (
          <b key={i}>{p.slice(1, -1)}</b>
        ) : /^_[^_]+_$/.test(p) ? (
          <i key={i}>{p.slice(1, -1)}</i>
        ) : (
          <span key={i}>{p}</span>
        ),
      )}
    </p>
  );
}

/** The template as WhatsApp shows it on a phone. */
export function WhatsAppPreview({ model, compact }: { model: PreviewModel; compact?: boolean }) {
  const bubble = "overflow-hidden rounded-lg rounded-tl-sm bg-white text-[12.5px] leading-relaxed text-[#111] shadow-sm";
  // Compact sits inside a PhoneFrame, which already draws the chat background.
  const wrap = compact ? "" : "rounded-xl px-3 py-3";
  const bg = compact ? undefined : { background: "#efeae2" };
  if (model.auth) {
    const a = model.auth;
    return (
      <div className={wrap} style={bg} aria-label="Preview">
        <div className={`${bubble} max-w-[92%]`}>
          <div className="px-2.5 py-1.5">
            <p>
              <b>123456</b> is your verification code.
              {a.securityRecommendation && " For your security, do not share this code."}
            </p>
            {Boolean(a.expirationMinutes) && (
              <p className="mt-0.5 text-[11px] text-[#667781]">This code expires in {a.expirationMinutes} minutes.</p>
            )}
          </div>
          <Buttons buttons={[{ type: "OTP", text: a.buttonText || "Copy code" }]} />
        </div>
      </div>
    );
  }
  const empty = !model.body.trim() && !model.cards?.length && (!model.headerFormat || model.headerFormat === "NONE");
  if (empty) return null;
  const head = (model.headerFormat ?? "").toUpperCase();
  return (
    <div className={wrap} style={bg} aria-label="Preview">
      <div className={`${bubble} max-w-[92%]`}>
        {head !== "TEXT" && <HeaderMediaBlock format={head} file={model.headerFile} />}
        {model.offer && (
          <div className="m-1 flex items-center gap-2 rounded-md bg-[#f0f2f5] px-2.5 py-2">
            <span className="grid size-8 shrink-0 place-items-center rounded-full bg-[#d9fdd3] text-[#1f7a3a]">
              <MaterialIcon name="sell" className="!text-[17px]" />
            </span>
            <span className="min-w-0">
              <b className="block truncate">{model.offer.text || "Your offer"}</b>
              {model.offer.hasExpiration && (
                <span className="block text-[11px] text-[#c0392b]">Ends in 2 days</span>
              )}
              {model.offer.code && (
                <span className="block text-[11px] text-[#667781]">Code {model.offer.code}</span>
              )}
            </span>
          </div>
        )}
        <div className="px-2.5 py-1.5">
          {head === "TEXT" && model.headerText?.trim() && <p className="font-semibold">{model.headerText.trim()}</p>}
          <Body text={model.body || "…"} />
          {model.footer && <p className="mt-0.5 text-[11px] text-[#667781]">{model.footer}</p>}
        </div>
        <Buttons buttons={model.buttons} />
      </div>
      {model.cards && model.cards.length > 0 && (
        <div className="mt-1.5 flex gap-1.5 overflow-x-auto pb-1" aria-label="Cards">
          {model.cards.map((c, i) => (
            <div key={i} className={`${bubble} w-[62%] max-w-[200px] shrink-0`}>
              {c.format.toUpperCase() === "VIDEO" ? (
                <HeaderMediaBlock format="VIDEO" file={c.file} />
              ) : (
                <div
                  className={`relative w-full bg-gradient-to-br from-brand to-[#5b8cff] ${
                    model.cardAspect === "wide" ? "aspect-[1.91/1]" : "aspect-square"
                  }`}
                >
                  {c.file?.url && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={c.file.url} alt="" className="absolute inset-0 size-full object-cover" />
                  )}
                </div>
              )}
              <div className="px-2 py-1.5 text-[12px]">{c.body || `Card ${i + 1}`}</div>
              <Buttons buttons={c.buttons} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ---- A broadcast's choices for its template ---- */

export type BroadcastExtrasDraft = {
  coupon: string;
  /** A datetime-local value, in this browser's time zone. */
  offerEnds: string;
  cardFiles: (CRMMediaFile | null)[];
};

function localInput(iso?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function seedExtras(
  seed?: { couponCode?: string; offerExpiresAt?: string; cardFiles?: CRMMediaFile[] } | null,
): BroadcastExtrasDraft {
  return {
    coupon: seed?.couponCode ?? "",
    offerEnds: localInput(seed?.offerExpiresAt),
    cardFiles: seed?.cardFiles ?? [],
  };
}

export const NO_EXTRAS: BroadcastExtrasDraft = { coupon: "", offerEnds: "", cardFiles: [] };

/** The coupon, the offer's end and the card pictures a broadcast brings, for templates that have them. */
export function BroadcastExtras({
  template,
  value,
  onChange,
}: {
  template: CRMTemplate;
  value: BroadcastExtrasDraft;
  onChange: (next: BroadcastExtrasDraft) => void;
}) {
  const id = useId();
  const coupon = template.buttons.find((b) => b.type === "COPY_CODE");
  const cards = template.cards ?? [];
  if (!coupon && !template.offer?.hasExpiration && !cards.length) return null;
  const fallback = template.couponCode || coupon?.example || "";
  const aspect =
    template.cardAspect === "wide" || template.cardAspect === "square" ? template.cardAspect : undefined;
  return (
    <div className="grid gap-2">
      {coupon && (
        <div>
          <label className="label" htmlFor={`${id}-coupon`}>
            Coupon code
          </label>
          <input
            id={`${id}-coupon`}
            className="field font-mono uppercase"
            value={value.coupon}
            maxLength={LIMITS.coupon}
            placeholder={fallback ? `${fallback} (the template's)` : "SAVE20"}
            onChange={(e) => onChange({ ...value, coupon: e.target.value.replace(/[^A-Za-z0-9]/g, "") })}
          />
          <p className="mt-1 text-[11.5px] text-ink-3">
            Copied to the phone when they tap “Copy offer code”.
          </p>
        </div>
      )}
      {template.offer?.hasExpiration && (
        <div>
          <label className="label" htmlFor={`${id}-ends`}>
            Offer ends
          </label>
          <input
            id={`${id}-ends`}
            type="datetime-local"
            className="field"
            value={value.offerEnds}
            onChange={(e) => onChange({ ...value, offerEnds: e.target.value })}
          />
          <p className="mt-1 text-[11.5px] text-ink-3">
            WhatsApp counts down to it on phones. Desktop and web show the message without the
            offer card.
          </p>
        </div>
      )}
      {cards.length > 0 && (
        <fieldset className="grid gap-1.5">
          <legend className="label">Card pictures</legend>
          <p className="text-[11.5px] text-ink-3">
            {template.needsCardFiles
              ? `This carousel was written in WhatsApp Manager, so upload a picture for each of its ${cards.length} cards.`
              : "Each card sends its template picture unless you choose new ones here — for every card, or none."}
          </p>
          <div className="grid gap-1.5 sm:grid-cols-2">
            {cards.map((c, i) => {
              const own = value.cardFiles[i] ?? null;
              const format = c.headerFormat.toUpperCase() === "VIDEO" ? "VIDEO" : "IMAGE";
              return (
                <div
                  key={i}
                  className="flex items-center gap-2 rounded-lg border border-line px-2 py-1.5 text-[12px]"
                >
                  <span className="w-12 shrink-0 text-ink-3">Card {i + 1}</span>
                  <span className="min-w-0 flex-1 truncate text-ink-2">
                    {own ? fileDetail(own) : c.file ? "Template's" : "—"}
                  </span>
                  <HeaderFileButton
                    format={format}
                    aspect={format === "IMAGE" ? aspect : undefined}
                    label={own ? "Replace" : "Choose"}
                    onUploaded={(f) =>
                      onChange({
                        ...value,
                        cardFiles: cards.map((_, j) => (j === i ? f : (value.cardFiles[j] ?? null))),
                      })
                    }
                  />
                </div>
              );
            })}
          </div>
          {value.cardFiles.some(Boolean) && !template.needsCardFiles && (
            <div>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-7 px-2 text-[12px]"
                onClick={() => onChange({ ...value, cardFiles: [] })}
              >
                Use the template&apos;s pictures
              </Button>
            </div>
          )}
        </fieldset>
      )}
    </div>
  );
}
