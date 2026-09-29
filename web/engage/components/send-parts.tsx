"use client";

import { useState } from "react";
import type {
  CRMAudienceResponse,
  CRMAudienceSample,
  CRMTemplate,
} from "@/lib/api-types";
import { renderTemplate, templateKey } from "./crm-templates";
import {
  AvatarStack,
  CategoryPill,
  PhoneFrame,
  friendlyTemplateName,
} from "./wa-kit";

/* The send dialog's pieces: who gets it, the template cards, and the phone preview. */

/** Who gets it, as four numbers that add up to the group. */
export function RecipientStrip({
  audience,
  error,
}: {
  audience: CRMAudienceResponse | null;
  error: string | null;
}) {
  if (error) return <p className="text-[12.5px] text-live">{error}</p>;
  const cells: { n: number | string; label: string; tone?: string }[] = audience
    ? [
        { n: audience.recipients, label: "will get it", tone: "text-ok" },
        { n: audience.noOptIn, label: "didn't opt in" },
        { n: audience.optedOut, label: "opted out" },
        { n: audience.noNumber, label: "no number" },
      ]
    : [
        { n: "…", label: "will get it" },
        { n: "…", label: "didn't opt in" },
        { n: "…", label: "opted out" },
        { n: "…", label: "no number" },
      ];
  const people = (audience?.samples ?? []).map((s) => ({
    name: s.name,
    seed: s.contactId,
  }));
  return (
    <div className="grid gap-2">
      <div className="grid grid-cols-4 overflow-hidden rounded-lg border border-line">
        {cells.map((c, i) => (
          <div
            key={c.label}
            className={`px-3 py-2 ${i > 0 ? "border-l border-line" : ""}`}
          >
            <div
              className={`text-[17px] font-semibold tabular-nums ${c.tone ?? "text-ink"}`}
            >
              {c.n}
            </div>
            <div className="text-[11px] text-ink-3">{c.label}</div>
          </div>
        ))}
      </div>
      {people.length > 0 && audience && (
        <div className="flex items-center gap-2 text-[12px] text-ink-2">
          <AvatarStack people={people} />
          <span className="truncate">
            {namesLine(
              people.map((p) => p.name),
              audience.recipients,
            )}
          </span>
        </div>
      )}
    </div>
  );
}

function namesLine(names: string[], total: number): string {
  const first = names.slice(0, 3);
  const rest = total - first.length;
  if (rest <= 0) {
    return first.length <= 1
      ? first.join("")
      : `${first.slice(0, -1).join(", ")} and ${first[first.length - 1]}`;
  }
  return `${first.join(", ")} and ${rest} more`;
}

/** Templates as cards. The best one for this group goes first, marked. */
export function TemplateCards({
  templates,
  chosen,
  best,
  onPick,
}: {
  templates: CRMTemplate[];
  chosen: string;
  best: string;
  onPick: (key: string) => void;
}) {
  const [all, setAll] = useState(false);
  const shown = all ? templates : templates.slice(0, 3);
  return (
    <div className="grid gap-2" role="radiogroup" aria-label="Template">
      {shown.map((t) => {
        const key = templateKey(t);
        const on = key === chosen;
        return (
          <button
            key={key}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => onPick(key)}
            className={`flex gap-3 rounded-xl border px-3.5 py-3 text-left transition ${
              on
                ? "border-brand bg-brand-soft/40 ring-1 ring-brand"
                : "border-line hover:border-line-2"
            }`}
          >
            <span
              className={`mt-0.5 grid size-4 shrink-0 place-items-center rounded-full border ${
                on ? "border-brand" : "border-line-2"
              }`}
            >
              {on && <span className="size-2 rounded-full bg-brand" />}
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex flex-wrap items-center gap-1.5">
                <span className="text-[13px] font-semibold text-ink">
                  {friendlyTemplateName(t.name)}
                </span>
                <CategoryPill category={t.category} />
                {key === best && (
                  <span className="rounded bg-ok-soft px-1.5 py-0.5 text-[10px] font-semibold tracking-wide text-ok">
                    BEST FOR THIS GROUP
                  </span>
                )}
                {t.language && (
                  <span className="text-[10.5px] text-ink-3">{t.language}</span>
                )}
              </span>
              <span className="mt-1 line-clamp-2 block text-[12px] leading-relaxed text-ink-2">
                {t.body}
              </span>
            </span>
          </button>
        );
      })}
      {templates.length > 3 && (
        <button
          type="button"
          onClick={() => setAll((v) => !v)}
          className="justify-self-start text-[12px] font-medium text-brand hover:underline"
        >
          {all ? "Show fewer" : `Show all ${templates.length} templates`}
        </button>
      )}
    </div>
  );
}

/** Ranks templates for a group: a name or body with the group's words first. */
export function bestTemplate(
  templates: CRMTemplate[],
  hints: string[],
): string {
  if (hints.length === 0) return "";
  let best = "";
  let score = 0;
  for (const t of templates) {
    const text = `${t.name} ${t.body ?? ""}`.toLowerCase();
    const s = hints.reduce((n, h) => n + (text.includes(h) ? 1 : 0), 0);
    if (s > score) {
      score = s;
      best = templateKey(t);
    }
  }
  return best;
}

/** The message on a phone, for one real recipient at a time. */
export function PhonePreview({
  template,
  samples,
  fallback,
  from,
  cover,
}: {
  template: CRMTemplate;
  samples: CRMAudienceSample[];
  /** Values to show when there is nobody to preview for yet. */
  fallback: string[];
  from: string;
  /** The webinar's cover, for a template with an image header. */
  cover?: string;
}) {
  const [i, setI] = useState(0);
  const at = Math.min(i, Math.max(0, samples.length - 1));
  const who = samples[at];
  const values = who ? who.params : fallback;
  const time = new Date().toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
  return (
    <div className="grid gap-2">
      <div className="flex items-center justify-between gap-2 text-[12px] text-ink-2">
        <span className="truncate">
          {who ? (
            <>
              Preview for <b className="text-ink">{who.name}</b> · {at + 1} of{" "}
              {samples.length}
            </>
          ) : (
            "Preview"
          )}
        </span>
        {samples.length > 1 && (
          <span className="flex gap-1">
            {[
              { d: -1, l: "‹", a: "Previous person" },
              { d: 1, l: "›", a: "Next person" },
            ].map((b) => (
              <button
                key={b.l}
                type="button"
                aria-label={b.a}
                onClick={() =>
                  setI((at + b.d + samples.length) % samples.length)
                }
                className="grid size-7 place-items-center rounded-md border border-line text-[14px] hover:bg-surface-2"
              >
                {b.l}
              </button>
            ))}
          </span>
        )}
      </div>
      <PhoneFrame title={from} subtitle="Business account">
        <span className="justify-self-center rounded-md bg-white/80 px-2 py-0.5 text-[10px] text-ink-2">
          Today
        </span>
        <div className="max-w-[92%] overflow-hidden rounded-lg rounded-tl-none bg-white text-[12.5px] leading-relaxed whitespace-pre-wrap text-[#111] shadow-sm">
          {template.headerFormat === "IMAGE" && (
            <div
              className="relative aspect-[1.91/1] w-full bg-gradient-to-br from-brand to-[#5b8cff]"
              role="img"
              aria-label="The webinar's cover image"
            >
              <span className="absolute inset-0 grid place-items-center px-3 text-center text-[12px] font-semibold text-white/90">
                Your webinar&apos;s cover
              </span>
              {cover && (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={cover}
                  alt=""
                  className="absolute inset-0 size-full object-cover"
                  onError={(e) => {
                    e.currentTarget.style.display = "none";
                  }}
                />
              )}
            </div>
          )}
          <div className="px-2.5 py-1.5">
            {template.header && (
              <p className="font-semibold">{template.header}</p>
            )}
            {renderTemplate(template.body ?? "", values)}
            {template.footer && (
              <p className="mt-1 text-[10.5px] text-[#667781]">
                {template.footer}
              </p>
            )}
            <div className="mt-0.5 flex justify-end text-[10px] text-[#667781]">
              {time}
            </div>
          </div>
          {(template.buttons ?? []).length > 0 && (
            <div className="grid divide-y divide-black/5 border-t border-black/5">
              {template.buttons.map((b, k) => (
                <span
                  key={k}
                  className="flex items-center justify-center gap-1.5 py-1.5 text-[12.5px] font-medium text-[#027eb5]"
                >
                  {b.type === "URL"
                    ? "↗"
                    : b.type === "PHONE_NUMBER"
                      ? "✆"
                      : "↩"}{" "}
                  {b.text}
                </span>
              ))}
            </div>
          )}
        </div>
      </PhoneFrame>
    </div>
  );
}
