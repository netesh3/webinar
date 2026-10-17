"use client";

import { useState, type CSSProperties, type FocusEvent, type ReactNode } from "react";
import type { CRMMergeField, CRMParam } from "@/lib/api-types";
import { formatTemplate, slotContext, slotTone } from "../template-params";

/* The placeholders of a template, shown where they are.
 *
 * Every screen that fills {{1}}, {{2}}… uses these together:
 *   TemplateTextBlock  the template with a numbered, coloured chip at each blank, showing
 *                      what fills it; clicking a chip moves focus to that blank's control.
 *   ParamRow           one blank's control, headed by the same chip and the words around it.
 *   FilledText         the filled message for the WhatsApp preview, each value tinted with
 *                      its blank's colour, and outlined while its row is hovered or focused.
 * useActiveSlot ties them: the row being worked on is highlighted in all three places.
 */

/** What a blank shows in its chip: the field or words that fill it, or that nothing does. */
export type SlotView = { label: string; empty: boolean };

/** A broadcast-style param (a field, or the same words for everybody) as a chip. */
export function paramView(p: CRMParam | undefined, fields: CRMMergeField[]): SlotView {
  if (p?.field) {
    return { label: fields.find((f) => f.token === p.field)?.label ?? p.field, empty: false };
  }
  const text = (p?.text ?? "").trim();
  return text ? { label: `“${text}”`, empty: false } : { label: "empty", empty: true };
}

/** A field token (reminders, drips) as a chip. */
export function tokenView(token: string | undefined, fields: CRMMergeField[]): SlotView {
  if (!token) return { label: "empty", empty: true };
  return { label: fields.find((f) => f.token === token)?.label ?? token, empty: false };
}

/** The id a blank's control carries, so a chip can focus it. */
export function slotControlId(prefix: string, slot: number): string {
  return `${prefix}-${slot}`;
}

function focusSlot(prefix: string, slot: number) {
  const el = document.getElementById(slotControlId(prefix, slot));
  if (!el) return;
  el.scrollIntoView({ block: "nearest", behavior: "smooth" });
  el.focus({ preventScroll: true });
}

/** Which blank is being worked on: the hovered row, else the focused one. */
export function useActiveSlot() {
  const [focused, setFocused] = useState<number | null>(null);
  const [hovered, setHovered] = useState<number | null>(null);
  return {
    active: hovered ?? focused,
    rowProps: (slot: number) => ({
      onFocus: () => setFocused(slot),
      onBlur: (e: FocusEvent<HTMLElement>) => {
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
        setFocused((f) => (f === slot ? null : f));
      },
      onMouseEnter: () => setHovered(slot),
      onMouseLeave: () => setHovered((h) => (h === slot ? null : h)),
    }),
  };
}

const toneVars = (active: boolean): CSSProperties => ({
  background: "var(--tp-bg)",
  color: "var(--tp-fg)",
  boxShadow: active ? "0 0 0 2px var(--tp-ring)" : undefined,
});

/** A blank's chip: its number, and (optionally) what fills it. */
export function SlotChip({
  slot,
  view,
  active = false,
  onClick,
  numberOnly = false,
}: {
  slot: number;
  view?: SlotView;
  active?: boolean;
  onClick?: () => void;
  numberOnly?: boolean;
}) {
  const empty = view?.empty ?? false;
  const className = `tp-chip-${slotTone(slot)} mx-0.5 inline-flex max-w-full items-center gap-1 rounded-md px-1.5 py-px align-baseline text-[12px] font-medium leading-5 transition-shadow ${
    empty ? "border border-dashed border-warn/60 !bg-warn-soft !text-warn" : ""
  } ${onClick ? "cursor-pointer hover:brightness-[0.97]" : ""}`;
  const content = (
    <>
      <span className="tabular-nums font-semibold">{`{{${slot}}}`}</span>
      {!numberOnly && view && <span className="truncate">{view.label}</span>}
    </>
  );
  const title = view ? `{{${slot}}} — ${empty ? "nothing chosen yet" : view.label}` : `{{${slot}}}`;
  return onClick ? (
    <button type="button" className={className} style={toneVars(active)} onClick={onClick} title={title}>
      {content}
    </button>
  ) : (
    <span className={className} style={toneVars(active)} title={title}>
      {content}
    </span>
  );
}

function ChipText({
  text,
  views,
  active,
  controlPrefix,
}: {
  text: string;
  views: SlotView[];
  active: number | null;
  controlPrefix: string;
}) {
  return (
    <>
      {formatTemplate(text).map((s, i) =>
        s.kind === "text" ? (
          s.runs.map((r, k) => (
            <span key={`${i}-${k}`}>{styled(r.text, r.bold, r.italic)}</span>
          ))
        ) : (
          <SlotChip
            key={i}
            slot={s.slot}
            view={views[s.slot - 1] ?? { label: "empty", empty: true }}
            active={active === s.slot}
            onClick={() => focusSlot(controlPrefix, s.slot)}
          />
        ),
      )}
    </>
  );
}

/** The template's own words with a chip at each blank. */
export function TemplateTextBlock({
  body,
  header,
  views,
  active,
  controlPrefix,
}: {
  body: string;
  /** A text header, shown as written for context. Its own blanks are not filled here:
   *  the params a send supplies are the body's (CRMTemplate.variables), and a template
   *  with a variable header is not sendable from this app. */
  header?: string;
  views: SlotView[];
  active: number | null;
  controlPrefix: string;
}) {
  return (
    <div className="rounded-xl border border-line bg-surface-2 px-3 py-2.5">
      <p className="text-[11.5px] font-medium text-ink-3">Your template · click a blank to change it</p>
      {header?.trim() && (
        <p className="mt-1 text-[13px] font-semibold text-ink">{header.trim()}</p>
      )}
      <p className="mt-1 whitespace-pre-wrap text-[13px] leading-7 text-ink">
        <ChipText text={body} views={views} active={active} controlPrefix={controlPrefix} />
      </p>
    </div>
  );
}

/** One blank's control, headed by its chip and the words around it in the template. */
export function ParamRow({
  slot,
  text,
  active,
  rowProps,
  children,
}: {
  slot: number;
  /** The text the blank sits in (the body, or the header for a header blank). */
  text: string;
  active: boolean;
  rowProps: ReturnType<ReturnType<typeof useActiveSlot>["rowProps"]>;
  children: ReactNode;
}) {
  const { before, after } = slotContext(text, slot);
  return (
    <div
      {...rowProps}
      className={`tp-chip-${slotTone(slot)} grid gap-2 rounded-xl border px-3 py-2.5 transition-colors ${
        active ? "border-[var(--tp-ring)] bg-surface" : "border-line"
      }`}
    >
      <div className="flex min-w-0 items-center gap-2 text-[12px]">
        <SlotChip slot={slot} numberOnly active={active} />
        {(before || after) && (
          <span className="min-w-0 truncate text-ink-3" title={`${before} ___ ${after}`.trim()}>
            {before}
            {before && " "}
            <span className="font-semibold text-ink-2">___</span>
            {after && !/^[,.!?;:)]/.test(after) && " "}
            {after}
          </span>
        )}
      </div>
      {children}
    </div>
  );
}

/** The whole set for an editor that has no other use for the active blank: the template
 *  block, a row per blank around `control(i)`, then `preview(active)` — for screens that
 *  render several templates in a list, where each needs its own useActiveSlot. */
export function TemplateBlanks({
  body,
  header,
  views,
  controlPrefix,
  control,
  preview,
}: {
  body: string;
  header?: string;
  views: SlotView[];
  controlPrefix: string;
  /** Blank i's control (0-based); give it id slotControlId(controlPrefix, i + 1). */
  control: (i: number) => ReactNode;
  preview?: (active: number | null) => ReactNode;
}) {
  const { active, rowProps } = useActiveSlot();
  return (
    <>
      {views.length > 0 && (
        <>
          <TemplateTextBlock
            body={body}
            header={header}
            views={views}
            active={active}
            controlPrefix={controlPrefix}
          />
          {/* Columns by the space this sits in, not the window: in a side panel one row
              per blank, so a field's name is not cut short. */}
          <div className="@container">
            <div className="grid grid-cols-1 gap-2 @[34rem]:grid-cols-2">
            {views.map((_, i) => (
              <ParamRow
                key={i}
                slot={i + 1}
                text={body}
                active={active === i + 1}
                rowProps={rowProps(i + 1)}
              >
                {control(i)}
              </ParamRow>
            ))}
            </div>
          </div>
        </>
      )}
      {preview?.(active)}
    </>
  );
}

/* Words in WhatsApp's *bold* / _italic_, the marks already taken out. */
function styled(node: ReactNode, bold: boolean, italic: boolean): ReactNode {
  const leaning = italic ? <i>{node}</i> : node;
  return bold ? <b>{leaning}</b> : leaning;
}

/** The filled message, for inside a WhatsApp bubble: each value tinted with its blank's
 *  colour, a blank with nothing in it shown as {{n}} in warning colours. */
export function FilledText({
  text,
  values,
  active = null,
}: {
  text: string;
  /** Per blank, slot n at index n-1. */
  values: string[];
  active?: number | null;
}) {
  return (
    <>
      {formatTemplate(text).map((s, i) => {
        if (s.kind === "text") {
          return s.runs.map((r, k) => (
            <span key={`${i}-${k}`}>{styled(r.text, r.bold, r.italic)}</span>
          ));
        }
        const value = values[s.slot - 1] ?? "";
        const on = active === s.slot;
        return (
          <span
            key={i}
            className={`tp-mark-${slotTone(s.slot)} rounded-[3px] px-0.5 transition-shadow`}
            style={
              value
                ? {
                    background: "var(--tp-bg)",
                    color: "#111",
                    boxShadow: on
                      ? "0 0 0 1.5px var(--tp-ring)"
                      : "inset 0 -1.5px 0 var(--tp-ring)",
                  }
                : {
                    background: "#fef0c7",
                    color: "#93370d",
                    boxShadow: on ? "0 0 0 1.5px #f79009" : undefined,
                  }
            }
          >
            {styled(value || `{{${s.slot}}}`, s.bold, s.italic)}
          </span>
        );
      })}
    </>
  );
}
