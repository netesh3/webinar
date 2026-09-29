"use client";

import { useEffect, useId, useMemo, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { engageApi } from "../api";
import { Alert, Spinner } from "@/components/controls";
import { MaterialIcon } from "@/components/icons";
import { useToast } from "@/components/providers";
import { Button } from "@/components/ui";
import { ApiError } from "@/lib/api";
import {
  SlotConfirmation,
  SlotFollowupEngaged,
  SlotFollowupHigh,
  SlotFollowupNoShow,
  SlotFollowupPassive,
  SlotFollowupRisk,
  SlotReminder,
  SlotReplay,
  type CRMMergeField,
  type CRMStarterTemplate,
  type CRMTemplate,
  type MessageSlot,
} from "@/lib/api-types";
import { templateKey } from "./crm-templates";
import { StarterTemplates } from "./starter-templates";
import { friendlyTemplateName, CategoryPill } from "./wa-kit";
import {
  resolveStarterTemplate,
  slotFromTemplate,
  slotWithWording,
} from "./write-wording-dialog";

/* The wording drawer (docs/mockups/simple/whatsapp-templates-drawer.html).
 *
 * Opened from one automatic message, already filtered to that kind, or from
 * "All your wording" with every kind. Use writes the account default for the
 * message in front of you — the same save as the slot editor. */

export const WORDING_FILTERS = [
  "All",
  "Confirmation",
  "Reminder",
  "Replay",
  "Follow up",
] as const;

export type WordingFilter = (typeof WORDING_FILTERS)[number];
export type WordingKind = Exclude<WordingFilter, "All">;

const KINDS: WordingKind[] = ["Confirmation", "Reminder", "Replay", "Follow up"];

const SLOT_OF: Record<Exclude<WordingKind, "Follow up">, string> = {
  Confirmation: SlotConfirmation,
  Reminder: SlotReminder,
  Replay: SlotReplay,
};

const FOLLOWUP_TITLE: Record<string, string> = {
  [SlotFollowupHigh]: "Very engaged",
  [SlotFollowupEngaged]: "Joined and engaged",
  [SlotFollowupNoShow]: "Didn't join",
  [SlotFollowupPassive]: "Watched quietly",
  [SlotFollowupRisk]: "Left early",
};

const HINTS: Record<WordingKind, string[]> = {
  Confirmation: ["confirm", "register", "registered", "welcome", "booked"],
  Reminder: ["remind", "starts", "hour", "nudge", "soon"],
  Replay: ["replay", "recording", "watch"],
  "Follow up": ["offer", "thank", "missed", "sorry", "follow"],
};

const MAX_BODY = 1024;

export function filterForSlot(kind: string): WordingKind | null {
  if (kind === SlotConfirmation) return "Confirmation";
  if (kind === SlotReminder) return "Reminder";
  if (kind === SlotReplay) return "Replay";
  if (kind.startsWith("followup_")) return "Follow up";
  return null;
}

function sameBody(a: string, b: string): boolean {
  return a.replace(/\s+/g, " ").trim() === b.replace(/\s+/g, " ").trim();
}

function variableCount(body: string): number {
  const nums = [...body.matchAll(/\{\{\s*(\d+)\s*\}\}/g)].map((m) => Number(m[1]));
  return nums.length ? Math.max(...nums) : 0;
}

export function WordingDrawer({
  filter,
  onFilter,
  slot,
  title,
  slots,
  templates,
  fields,
  connected,
  syncing,
  busy,
  error,
  templatesError,
  onClose,
  onRefresh,
  onUse,
  onCreated,
}: {
  filter: WordingFilter;
  onFilter: (next: WordingFilter) => void;
  /** The message that opened the drawer. Null when it was opened for everything. */
  slot: MessageSlot | null;
  title: string;
  slots: MessageSlot[];
  templates: CRMTemplate[] | null;
  fields: CRMMergeField[];
  connected: boolean;
  syncing: boolean;
  busy: boolean;
  error: string | null;
  templatesError?: string | null;
  onClose: () => void;
  onRefresh: () => void;
  /** Saves this slot on the account default. The label is the message name in the toast. */
  onUse: (next: MessageSlot, label: string) => Promise<boolean>;
  onCreated: () => void;
}) {
  const titleId = useId();
  const [query, setQuery] = useState("");
  const [starters, setStarters] = useState<CRMStarterTemplate[] | null>(null);
  const [usingKey, setUsingKey] = useState<string | null>(null);
  const list = templates ?? [];

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    document.addEventListener("keydown", onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previous;
    };
  }, [onClose]);

  const kindOf = useMemo(() => {
    return (template: CRMTemplate): WordingKind | null => {
      const starter = starters?.find((item) => item.name === template.name);
      if (starter && KINDS.includes(starter.use as WordingKind)) {
        return starter.use as WordingKind;
      }
      const used = slots.filter(
        (item) =>
          item.template === template.name && item.language === template.language,
      );
      const usedKinds = [
        ...new Set(used.map((item) => filterForSlot(item.kind)).filter(Boolean)),
      ] as WordingKind[];
      if (usedKinds.length === 1) return usedKinds[0];
      const hay = `${template.name} ${template.body ?? ""}`.toLowerCase();
      let best: WordingKind | null = null;
      let score = 0;
      for (const kind of KINDS) {
        const next = HINTS[kind].reduce(
          (n, hint) => n + (hay.includes(hint) ? 1 : 0),
          0,
        );
        if (next > score) {
          score = next;
          best = kind;
        }
      }
      return best;
    };
  }, [slots, starters]);

  function targetFor(kind: WordingKind): { slot: MessageSlot; label: string } | null {
    if (kind === "Follow up") {
      if (slot && filterForSlot(slot.kind) === "Follow up") {
        return { slot, label: title || "Follow up" };
      }
      const followups = slots.filter((item) => item.kind.startsWith("followup_"));
      const pick = followups.find((item) => !item.template) ?? followups[0];
      if (!pick) return null;
      return { slot: pick, label: FOLLOWUP_TITLE[pick.kind] ?? "Follow up" };
    }
    const found = slots.find((item) => item.kind === SLOT_OF[kind]);
    if (!found) return null;
    return { slot: found, label: kind };
  }

  function rowTarget(template: CRMTemplate): { slot: MessageSlot; label: string } | null {
    if (filter !== "All") return targetFor(filter);
    const kind = kindOf(template);
    if (kind) return targetFor(kind);
    if (slot) return { slot, label: title || "this message" };
    return null;
  }

  const q = query.trim().toLowerCase();
  const visible = list.filter((template) => {
    if (q) {
      const hay = `${template.name} ${friendlyTemplateName(template.name)} ${template.body ?? ""}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    if (filter === "All") return true;
    return kindOf(template) === filter;
  });

  const counts = { All: list.length, Confirmation: 0, Reminder: 0, Replay: 0, "Follow up": 0 };
  for (const template of list) {
    const kind = kindOf(template);
    if (kind) counts[kind] += 1;
  }

  const grouped = (filter === "All" ? [...KINDS, "Other" as const] : [filter]).flatMap(
    (kind) => {
      const items = visible
        .filter((template) =>
          kind === "Other" ? kindOf(template) === null : kindOf(template) === kind,
        )
        .slice()
        .sort((a, b) => {
          const au = rowTarget(a);
          const bu = rowTarget(b);
          const usingA = Boolean(
            au && au.slot.template === a.name && au.slot.language === a.language,
          );
          const usingB = Boolean(
            bu && bu.slot.template === b.name && bu.slot.language === b.language,
          );
          return Number(usingB) - Number(usingA) || a.name.localeCompare(b.name);
        });
      return items.length ? [{ kind, items }] : [];
    },
  );

  async function apply(template: CRMTemplate, starter?: CRMStarterTemplate) {
    const target = rowTarget(template);
    if (!target || usingKey) return;
    setUsingKey(templateKey(template));
    try {
      const next = starter
        ? {
            ...slotWithWording(target.slot, starter, template, fields),
            channels: slotFromTemplate(target.slot, template, fields).channels,
            timing: slotFromTemplate(target.slot, template, fields).timing,
            enabled: true,
          }
        : slotFromTemplate(target.slot, template, fields);
      await onUse(next, target.label);
    } finally {
      setUsingKey(null);
    }
  }

  const subtitle =
    filter === "All"
      ? "Default for every webinar"
      : filter === "Follow up" && title
        ? `${title} · default for every webinar`
        : `${filter} · default for every webinar`;

  const forLabel =
    filter === "All" ? "any message" : filter === "Follow up" && title ? title : filter;

  const node = (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div
        className="absolute inset-0 bg-ink/35"
        onClick={onClose}
        aria-hidden
      />
      <aside
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="relative flex h-full w-full max-w-[380px] flex-col bg-surface shadow-[-12px_0_32px_rgba(16,24,40,0.1)] outline-none"
      >
        <div className="flex items-start gap-2.5 border-b border-line bg-surface px-3.5 py-3">
          <span className="grid size-8 shrink-0 place-items-center rounded-[9px] bg-brand-soft text-brand">
            <MaterialIcon name="edit_note" className="!text-[18px]" />
          </span>
          <div className="min-w-0 flex-1">
            <b id={titleId} className="block text-[15px]">
              Your wording
            </b>
            <small className="mt-px block text-[12px] text-ink-3">{subtitle}</small>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="grid size-7 place-items-center rounded-md text-ink-3 hover:bg-surface-2 hover:text-ink"
          >
            <MaterialIcon name="close" className="!text-[18px]" />
          </button>
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-3.5 py-3">
          <div className="relative">
            <MaterialIcon
              name="search"
              className="pointer-events-none absolute top-1/2 left-2 !text-[16px] -translate-y-1/2 text-ink-3"
            />
            <input
              className="field h-8 w-full pl-8 text-[13px]"
              placeholder="Search wording"
              aria-label="Search wording"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>

          <div className="flex flex-wrap gap-1">
            {WORDING_FILTERS.map((kind) => {
              const on = filter === kind;
              return (
                <button
                  key={kind}
                  type="button"
                  onClick={() => onFilter(kind)}
                  className={`inline-flex h-[26px] items-center gap-1 rounded-full border px-2 text-[12px] ${
                    on
                      ? "border-brand bg-brand-soft font-medium text-brand"
                      : "border-line bg-surface text-ink-2 hover:border-line-2"
                  }`}
                >
                  {kind}
                  <b className="text-[11px] font-semibold">{counts[kind]}</b>
                </button>
              );
            })}
          </div>

          <div className="flex items-center justify-between gap-2">
            <b className="text-[13px]">Approved templates</b>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-[26px] px-2 text-[12px]"
              onClick={onRefresh}
              disabled={syncing}
            >
              {syncing ? (
                <Spinner className="size-3.5" />
              ) : (
                <MaterialIcon name="sync" className="!text-[14px]" />
              )}
              Check WhatsApp
            </Button>
          </div>

          {templatesError && <Alert tone="error">{templatesError}</Alert>}
          {error && <Alert tone="error">{error}</Alert>}

          {templates === null ? (
            <div className="flex justify-center py-6">
              <Spinner />
            </div>
          ) : grouped.length === 0 ? (
            <p className="text-[12.5px] text-ink-3">
              {q
                ? "No wording matches that."
                : filter === "All"
                  ? "No templates yet. Submit a starter, or write your own."
                  : `No ${filter.toLowerCase()} wording yet.`}
            </p>
          ) : (
            grouped.map((group) => (
              <div key={group.kind}>
                <div className="mb-1.5 text-[11px] font-semibold tracking-[0.06em] text-ink-3 uppercase">
                  {group.kind}
                </div>
                <div className="grid gap-1.5">
                  {group.items.map((template) => (
                    <TemplateRow
                      key={templateKey(template)}
                      template={template}
                      target={rowTarget(template)}
                      busy={busy || usingKey !== null}
                      using={usingKey === templateKey(template)}
                      onUse={() => void apply(template)}
                    />
                  ))}
                </div>
              </div>
            ))
          )}

          <StarterTemplates
            variant="rows"
            query={query}
            connected={connected}
            onCreated={onCreated}
            onItems={setStarters}
          />

          <WriteOwn
            filterLabel={forLabel}
            connected={connected}
            starters={starters}
            templates={list}
            fields={fields}
            target={filter === "All" ? null : targetFor(filter)}
            onCreated={onCreated}
            onUse={onUse}
          />
        </div>
      </aside>
    </div>
  );

  return createPortal(node, document.body);
}

function TemplateRow({
  template,
  target,
  busy,
  using,
  onUse,
}: {
  template: CRMTemplate;
  target: { slot: MessageSlot; label: string } | null;
  busy: boolean;
  using: boolean;
  onUse: () => void;
}) {
  const status = template.status.toUpperCase();
  const inUse = Boolean(
    target &&
      target.slot.template === template.name &&
      target.slot.language === template.language,
  );
  const badge =
    status === "APPROVED" || template.sendable
      ? { label: "Approved", tone: "bg-ok-soft text-ok" }
      : status === "REJECTED"
        ? { label: "Rejected", tone: "bg-live-soft text-live" }
        : status === "PENDING"
          ? { label: "Pending", tone: "bg-warn-soft text-warn" }
          : {
              label: status
                ? status.charAt(0) + status.slice(1).toLowerCase()
                : "Pending",
              tone: "bg-warn-soft text-warn",
            };
  const why =
    status === "REJECTED"
      ? template.unsupported || "Meta rejected this."
      : !template.sendable && status === "APPROVED"
        ? template.unsupported
        : "";

  return (
    <article
      className={`rounded-[10px] border px-2.5 py-2 ${
        inUse ? "border-brand-line bg-brand-soft" : "border-line bg-surface"
      }`}
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <b className="mr-auto text-[13px] font-semibold">
          {friendlyTemplateName(template.name)}
        </b>
        <span className={`rounded px-1.5 py-px text-[10.5px] font-semibold ${badge.tone}`}>
          {badge.label}
        </span>
      </div>
      <div className="mt-0.5 flex items-center gap-1 text-[11px] text-ink-3">
        <CategoryPill category={template.category} />
        {template.language}
      </div>
      {template.body && (
        <p className="mt-1 text-[12px] leading-snug text-ink-2">{template.body}</p>
      )}
      {why && <p className="mt-1 text-[11.5px] text-live">{why}</p>}
      <div className="mt-1.5 flex justify-end">
        {inUse ? (
          <span className="inline-flex items-center gap-0.5 text-[11.5px] font-semibold text-ok">
            <MaterialIcon name="check" className="!text-[14px]" />
            Using this
          </span>
        ) : template.sendable && target ? (
          <Button
            type="button"
            size="sm"
            variant="secondary"
            className="h-[26px] px-2 text-[11.5px]"
            disabled={busy}
            onClick={onUse}
          >
            {using && <Spinner className="size-3.5" />}
            Use for this message
          </Button>
        ) : status === "PENDING" || (!template.sendable && status !== "REJECTED" && !why) ? (
          <span className="text-[11.5px] font-semibold text-warn">Waiting on Meta</span>
        ) : null}
      </div>
    </article>
  );
}

function WriteOwn({
  filterLabel,
  connected,
  starters,
  templates,
  fields,
  target,
  onCreated,
  onUse,
}: {
  filterLabel: string;
  connected: boolean;
  starters: CRMStarterTemplate[] | null;
  templates: CRMTemplate[];
  fields: CRMMergeField[];
  target: { slot: MessageSlot; label: string } | null;
  onCreated: () => void;
  onUse: (next: MessageSlot, label: string) => Promise<boolean>;
}) {
  const { notify } = useToast();
  const [draft, setDraft] = useState("");
  const [category, setCategory] = useState<"UTILITY" | "MARKETING">("UTILITY");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const typed = draft.trim();
  const match = starters?.find(
    (item) => item.status === "APPROVED" && !item.error && sameBody(item.body, typed),
  );

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!typed || busy) return;
    setBusy(true);
    setNote(null);
    try {
      if (match) {
        if (!target) {
          setNote("Choose Confirmation, Reminder, Replay, or Follow up, then use it.");
          return;
        }
        const resolved = await resolveStarterTemplate(match, templates);
        if (!resolved?.template.sendable) {
          const msg =
            "That wording isn't ready to use yet. Refresh your templates once Meta has approved it.";
          setNote(msg);
          notify(msg, "error");
          return;
        }
        const saved = slotFromTemplate(target.slot, resolved.template, fields);
        const withStarter = slotWithWording(
          target.slot,
          match,
          resolved.template,
          fields,
        );
        const ok = await onUse(
          { ...withStarter, channels: saved.channels, timing: saved.timing, enabled: true },
          target.label,
        );
        if (ok) setDraft("");
        return;
      }
      const saved = await engageApi.createCrmWording({ body: typed, category });
      onCreated();
      if (saved.status === "APPROVED" && target) {
        const template: CRMTemplate = {
          name: saved.name,
          language: saved.language || "en",
          status: saved.status,
          category: saved.category,
          body: saved.body,
          variables: variableCount(saved.body),
          sendable: true,
          buttons: [],
        };
        const ok = await onUse(slotFromTemplate(target.slot, template, fields), target.label);
        if (ok) setDraft("");
        return;
      }
      setDraft("");
      setNote(
        "Submitted to Meta. You can use it on this message once it is approved, usually in a few minutes.",
      );
      notify("Submitted to Meta. Approval usually takes a few minutes.", "ok");
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : "Could not submit that wording.";
      setNote(msg);
      notify(msg, "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="rounded-[10px] border border-line p-2.5" onSubmit={(e) => void submit(e)}>
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <b className="text-[13px]">Write your own</b>
        <span className="text-[11.5px] text-ink-3">For {filterLabel}</span>
      </div>
      <label className="block">
        <span className="mb-1 block text-[12px] text-ink-2">Message</span>
        <textarea
          className="field min-h-[52px] w-full resize-y py-2"
          rows={2}
          value={draft}
          maxLength={MAX_BODY}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Hi {{1}}, {{2}} starts {{3}}."
          aria-label="Your wording"
          disabled={!connected}
        />
      </label>
      {!match && (
        <label className="mt-2 flex items-center gap-2 text-[12px] text-ink-2">
          Category
          <select
            className="field h-8 w-auto"
            value={category}
            onChange={(e) =>
              setCategory(e.target.value === "MARKETING" ? "MARKETING" : "UTILITY")
            }
            aria-label="Wording category"
          >
            <option value="UTILITY">Utility</option>
            <option value="MARKETING">Marketing</option>
          </select>
        </label>
      )}
      {note && <p className="mt-2 text-[12px] text-ink-2">{note}</p>}
      <div className="mt-2 flex items-center justify-between gap-2">
        <span className="text-[11.5px] text-ink-3">
          Meta checks it first, usually in minutes.
        </span>
        <Button type="submit" size="sm" className="h-7 shrink-0 px-2.5 text-[12px]" disabled={busy || !typed || !connected}>
          {busy && <Spinner className="size-3.5" />}
          {match ? "Use for this message" : "Submit to Meta"}
        </Button>
      </div>
    </form>
  );
}
