"use client";

import { useMemo, useState, type ReactNode } from "react";
import { MaterialIcon } from "@/components/icons";
import type { CRMMergeField, CRMTemplate } from "@/lib/api-types";
import { exampleFor, renderTemplate } from "../crm-templates";
import { friendlyTemplateName, rupees, templateRate } from "../wa-kit";
import { guessParams } from "../wa-messages";
import { wordingKind } from "./catalog";

/* Approved wordings for this kind. A few are shown; See all opens the rest.
 * Write your own starts from the webinar starter templates. */

const HINTS: Record<string, string[]> = {
  confirmation: ["confirm", "register", "welcome", "booked", "in"],
  reminder: ["remind", "start", "join", "hour", "soon"],
  replay: ["replay", "recording", "watch"],
  followup_high: ["offer", "program", "enrol", "spot"],
  followup_engaged: ["thank", "replay", "attend"],
  followup_passive: ["replay", "recap", "highlight"],
  followup_risk: ["left", "replay", "missed"],
  followup_no_show: ["missed", "sorry", "replay", "recording"],
};

const PREVIEW = 3;

function rank(template: CRMTemplate, kind: string): number {
  const hay = `${template.name} ${template.body ?? ""}`.toLowerCase();
  return (HINTS[kind] ?? []).reduce(
    (score, hint) => score + (hay.includes(hint) ? 1 : 0),
    0,
  );
}

function snippet(
  template: CRMTemplate,
  params: string[],
  fields: CRMMergeField[],
): string {
  const text = renderTemplate(
    template.body ?? "",
    params.map((token) => exampleFor(fields, token)),
  ).replace(/\s+/g, " ").trim();
  if (text.length <= 110) return text;
  return `${text.slice(0, 107)}…`;
}

export function WordingPicker({
  kind,
  templates,
  templateName,
  language,
  params,
  fields,
  connected,
  onPick,
  onWriteOwn,
  after,
}: {
  kind: string;
  templates: CRMTemplate[];
  templateName: string;
  language: string;
  params: string[];
  fields: CRMMergeField[];
  connected: boolean;
  onPick: (template: CRMTemplate) => void;
  onWriteOwn: () => void;
  /** Sits inside the card, under the helper line. The "for all webinars" tick. */
  after?: ReactNode;
}) {
  const [all, setAll] = useState(false);
  const usable = useMemo(() => {
    return templates
      .filter((template) => template.sendable)
      .slice()
      .sort((a, b) => rank(b, kind) - rank(a, kind) || a.name.localeCompare(b.name));
  }, [templates, kind]);
  const shown = all ? usable : usable.slice(0, PREVIEW);

  return (
    <div id="message-wording" className="grid min-w-0 gap-1.5 rounded-[10px] border border-line bg-surface px-2 pt-2 pb-2.5">
      <div className="flex items-baseline justify-between gap-1.5 px-0.5">
        <span className="text-[12px] text-ink-2">Message</span>
        <span className="text-[10.5px] text-ink-3">Wording approved by WhatsApp</span>
      </div>
      {!connected ? (
        <p className="text-[12.5px] text-ink-2">
          Connect WhatsApp to choose a wording. Email still sends without it.
        </p>
      ) : usable.length === 0 ? (
        <p className="text-[12.5px] text-ink-2">
          No approved wording yet. Write your own — WhatsApp usually checks it in
          minutes.
        </p>
      ) : (
        <div className="grid min-w-0 gap-0.5" role="radiogroup" aria-label="Message wording">
          {shown.map((template) => {
            const on =
              template.name === templateName && template.language === language;
            const filled = on
              ? params
              : guessParams(template, wordingKind(kind), fields);
            return (
              <button
                key={`${template.name}\u0000${template.language}`}
                type="button"
                role="radio"
                aria-checked={on}
                onClick={() => onPick(template)}
                className={`flex min-w-0 items-start gap-[7px] rounded-lg border px-[7px] py-1.5 text-left ${
                  on
                    ? "border-brand-line bg-brand-soft"
                    : "border-transparent hover:bg-surface-2"
                }`}
              >
                <MaterialIcon
                  name={on ? "radio_button_checked" : "radio_button_unchecked"}
                  className={`mt-px size-[17px] shrink-0 ${on ? "text-brand" : "text-ink-3"}`}
                />
                <span className="min-w-0 flex-1">
                  <span className="block text-[12.5px] font-semibold text-ink">
                    {friendlyTemplateName(template.name)}
                  </span>
                  <span className="block truncate text-[11px] text-ink-3">
                    {snippet(template, filled, fields) || "No preview text"}
                  </span>
                </span>
                <span className="mt-0.5 text-[10px] whitespace-nowrap text-ink-3">
                  ≈ {rupees(templateRate(template))}
                </span>
              </button>
            );
          })}
        </div>
      )}
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2 px-1 pt-1 text-[12px]">
        <button
          type="button"
          onClick={onWriteOwn}
          className="inline-flex items-center gap-0.5 font-medium text-brand hover:underline"
        >
          <MaterialIcon name="add" className="size-[15px]" />
          Write your own
        </button>
        {usable.length > PREVIEW && (
          <button
            type="button"
            onClick={() => setAll((open) => !open)}
            className="font-medium text-brand hover:underline"
          >
            {all ? "Show fewer" : `See all ${usable.length}`}
          </button>
        )}
      </div>
      <p className="px-1 text-[10.5px] text-ink-3">
        WhatsApp checks it first, usually in minutes.
      </p>
      {after && <div className="px-1 pt-1">{after}</div>}
    </div>
  );
}
