"use client";

import { useState } from "react";
import { MaterialIcon } from "@/components/icons";
import { Button } from "@/components/ui";
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
  type CRMTemplate,
  type MessageSlot,
} from "@/lib/api-types";
import { exampleFor, renderTemplate } from "./crm-templates";
import { timingLabel } from "./message-timing";
import { Switch, friendlyTemplateName } from "./wa-kit";
import { TimingPicker } from "./timing-picker";

const BEFORE = [
  { kind: SlotConfirmation, title: "Confirmation", icon: "how_to_reg", fixed: true },
  { kind: SlotReminder, title: "Reminder", icon: "alarm", fixed: false },
] as const;

const GROUPS: {
  kind: string;
  title: string;
  hint: string;
  gets: string;
  icon: string;
  hot?: boolean;
}[] = [
  {
    kind: SlotFollowupHigh,
    title: "Very engaged",
    hint: "stayed and joined in",
    gets: "your offer",
    icon: "local_fire_department",
    hot: true,
  },
  {
    kind: SlotFollowupEngaged,
    title: "Joined and engaged",
    hint: "stayed most of it",
    gets: "thank-you",
    icon: "favorite",
  },
  {
    kind: SlotFollowupNoShow,
    title: "Didn't join",
    hint: "registered but missed it",
    gets: "the replay",
    icon: "person_off",
  },
  {
    kind: SlotFollowupPassive,
    title: "Watched quietly",
    hint: "stayed but didn't chat",
    gets: "nothing yet",
    icon: "visibility_off",
  },
  {
    kind: SlotFollowupRisk,
    title: "Left early",
    hint: "left before the end",
    gets: "nothing yet",
    icon: "logout",
  },
];

function findSlot(slots: MessageSlot[], kind: string): MessageSlot | undefined {
  return slots.find((s) => s.kind === kind);
}

function snippet(
  slot: MessageSlot | undefined,
  templates: CRMTemplate[],
  fields: CRMMergeField[],
): string {
  if (!slot?.template) return "";
  const t = templates.find(
    (x) => x.name === slot.template && x.language === slot.language,
  );
  if (!t?.body) return "";
  return renderTemplate(
    t.body,
    (slot.params ?? []).map((p) => exampleFor(fields, p)),
  );
}

function Snip({ text, empty }: { text: string; empty: string }) {
  if (!text) {
    return (
      <p className="mt-2 flex-1 rounded-lg border border-dashed border-line-2 px-2 py-1.5 text-[11.5px] leading-snug text-ink-3">
        {empty}
      </p>
    );
  }
  return (
    <p className="mt-2 flex-1 rounded-lg rounded-bl-sm bg-[#eef6ea] px-2 py-1.5 text-[11.5px] leading-snug text-ink-2 italic">
      “{text}”
    </p>
  );
}

/* What goes out automatically: before the webinar, then after. Every switch,
 * wording and time writes the account default. */
export function WhatsAppAuto({
  slots,
  templates,
  fields,
  connected,
  busyKind,
  onToggle,
  onTiming,
  onEdit,
}: {
  slots: MessageSlot[];
  templates: CRMTemplate[] | null;
  fields: CRMMergeField[];
  connected: boolean;
  busyKind: string | null;
  onToggle: (slot: MessageSlot, enabled: boolean) => void;
  onTiming: (slot: MessageSlot, timing: MessageSlot["timing"]) => void;
  onEdit: (slot: MessageSlot, title: string) => void;
}) {
  const [open, setOpen] = useState<string | null>(null);

  return (
    <section className="grid gap-2.5">
      <div>
        <h2 className="text-[16px] font-semibold text-ink">What goes out automatically</h2>
        <p className="mt-0.5 text-[12.5px] text-ink-3">
          For every webinar. Switch any message off, change when it goes, or edit its words.
        </p>
      </div>
      <div className="rounded-xl border border-line bg-surface px-4 py-4 sm:px-[18px]">
        <GroupHead
          icon="event_upcoming"
          title="Before the webinar"
          hint="Everyone who registers gets these"
        />
        <div className="grid gap-3 md:grid-cols-3">
          {BEFORE.map((m) => {
            const slot = findSlot(slots, m.kind);
            if (!slot) return null;
            const text = snippet(slot, templates ?? [], fields);
            return (
              <article
                key={m.kind}
                className={`relative flex flex-col rounded-[10px] border border-line p-3 ${
                  open === slot.kind ? "z-20" : ""
                }`}
              >
                <div className="flex items-start gap-2">
                  <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-brand-soft text-brand">
                    <MaterialIcon name={m.icon} className="!text-[17px]" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-start justify-between gap-2">
                      <b className="block min-w-0 text-[13.5px]">{m.title}</b>
                      <Switch
                        checked={slot.enabled}
                        onChange={(v) => onToggle(slot, v)}
                        label={m.title}
                        disabled={!connected && !slot.enabled}
                      />
                    </div>
                    {m.fixed ? (
                      <span className="mt-0.5 inline-flex h-[22px] w-max shrink-0 items-center gap-0.5 whitespace-nowrap rounded-md border border-line bg-surface-2 px-1.5 text-[11.5px] font-medium text-ink-2">
                        <MaterialIcon name="lock" className="!text-[13px] shrink-0 text-ink-3" />
                        Right away
                      </span>
                    ) : (
                      <TimingChip
                        label={timingLabel(slot.kind, slot.timing)}
                        open={open === slot.kind}
                        onClick={() => setOpen(open === slot.kind ? null : slot.kind)}
                      />
                    )}
                    {open === slot.kind && (
                      <TimingPicker
                        mode="reminder"
                        title="Default for new webinars"
                        timing={slot.timing}
                        busy={busyKind === slot.kind}
                        onClose={() => setOpen(null)}
                        onSave={(timing) => {
                          onTiming(slot, timing);
                          setOpen(null);
                        }}
                      />
                    )}
                  </div>
                </div>
                <Snip text={slot.enabled ? text : ""} empty="Not sending this on WhatsApp." />
                <div className="mt-2.5 flex items-center justify-end">
                  <button
                    type="button"
                    className="text-[12px] font-medium text-brand hover:underline"
                    disabled={!connected || !templates}
                    onClick={() => onEdit(slot, m.title)}
                  >
                    {text ? "Edit" : "Set up"}
                  </button>
                </div>
              </article>
            );
          })}
          <div className="flex flex-col items-center justify-center gap-0.5 rounded-[10px] border border-dashed border-line-2 bg-surface-2 px-3 py-3 text-center text-ink-3">
            <MaterialIcon name="do_not_disturb_on" className="!text-[20px]" />
            <b className="text-[13px] text-ink-2">While you&apos;re live</b>
            <small className="max-w-[15rem] text-[11.5px] leading-snug">
              Nothing is sent, so no one is pulled away from the webinar
            </small>
          </div>
        </div>

        <GroupHead
          icon="event_available"
          title="After the webinar"
          hint="Everyone gets the replay; then each group gets its own message, based on how they took part"
          second
        />
        <ReplayRow
          slot={findSlot(slots, SlotReplay)}
          templates={templates}
          fields={fields}
          connected={connected}
          open={open === SlotReplay}
          busy={busyKind === SlotReplay}
          onOpen={() => setOpen(open === SlotReplay ? null : SlotReplay)}
          onClose={() => setOpen(null)}
          onToggle={onToggle}
          onTiming={onTiming}
          onEdit={onEdit}
        />
        <p className="mt-3 mb-2 flex items-center gap-1 text-[12px] font-medium text-ink-2">
          <MaterialIcon name="subdirectory_arrow_right" className="!text-[16px] text-ink-3" />
          Then each group gets its own message, at the time you pick
        </p>
        <div className="grid gap-2.5 sm:grid-cols-2 xl:grid-cols-5">
          {GROUPS.map((g) => {
            const slot = findSlot(slots, g.kind);
            if (!slot) return null;
            const text = snippet(slot, templates ?? [], fields);
            const on = slot.enabled && Boolean(slot.template);
            const gets = slot.template
              ? friendlyTemplateName(slot.template)
              : on
                ? g.gets
                : "nothing yet";
            return (
              <article
                key={g.kind}
                className={`relative flex flex-col rounded-[10px] border p-2.5 ${
                  open === slot.kind ? "z-20" : ""
                } ${on ? "border-line" : "border-dashed border-line bg-surface-2"}`}
              >
                <div className="mb-2 flex items-center justify-between">
                  <span
                    className={`grid size-7 place-items-center rounded-lg ${
                      g.hot ? "bg-[#fff1e6] text-[#c2410c]" : "bg-surface-2 text-ink-2"
                    }`}
                  >
                    <MaterialIcon name={g.icon} className="!text-[17px]" />
                  </span>
                  <Switch
                    checked={slot.enabled}
                    onChange={(v) => onToggle(slot, v)}
                    label={g.title}
                    disabled={!connected && !slot.enabled}
                  />
                </div>
                <b className={`text-[13px] leading-tight ${on ? "" : "opacity-60"}`}>{g.title}</b>
                <small className="mt-0.5 block text-[11.5px] text-ink-3">{g.hint}</small>
                <p className={`mt-2 flex items-center gap-0.5 text-[12.5px] font-semibold ${on ? "" : "opacity-60"}`}>
                  <MaterialIcon name="arrow_forward" className="!text-[14px] text-ink-3" />
                  {gets}
                </p>
                <Snip text={on ? text : ""} empty="Not sending anything to this group" />
                <div className="mt-2.5 flex flex-wrap items-end justify-between gap-1.5">
                  <TimingChip
                    label={timingLabel(slot.kind, slot.timing)}
                    open={open === slot.kind}
                    onClick={() => setOpen(open === slot.kind ? null : slot.kind)}
                  />
                  {on ? (
                    <button
                      type="button"
                      className="shrink-0 text-[12px] font-medium text-brand hover:underline"
                      disabled={!connected}
                      onClick={() => onEdit(slot, g.title)}
                    >
                      Edit
                    </button>
                  ) : (
                    <Button
                      size="sm"
                      variant="secondary"
                      className="shrink-0"
                      disabled={!connected || !templates}
                      onClick={() => onEdit(slot, g.title)}
                    >
                      Set up
                    </Button>
                  )}
                  {open === slot.kind && (
                    <TimingPicker
                      mode="followup"
                      title={`When does “${g.title}” get it?`}
                      timing={slot.timing}
                      busy={busyKind === slot.kind}
                      onClose={() => setOpen(null)}
                      onSave={(timing) => {
                        onTiming(slot, timing);
                        setOpen(null);
                      }}
                    />
                  )}
                </div>
              </article>
            );
          })}
        </div>
      </div>
    </section>
  );
}

function GroupHead({
  icon,
  title,
  hint,
  second,
}: {
  icon: string;
  title: string;
  hint: string;
  second?: boolean;
}) {
  return (
    <div
      className={`mb-2.5 flex items-center gap-2.5 ${
        second ? "mt-5 border-t border-line pt-4" : ""
      }`}
    >
      <span className="grid size-[30px] shrink-0 place-items-center rounded-full bg-brand text-white">
        <MaterialIcon name={icon} className="!text-[17px]" />
      </span>
      <div>
        <b className="block text-[14px]">{title}</b>
        <small className="block text-[12px] text-ink-3">{hint}</small>
      </div>
    </div>
  );
}

function TimingChip({
  label,
  open,
  onClick,
}: {
  label: string;
  open: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-expanded={open}
      className={`mt-0.5 inline-flex h-[22px] w-max min-w-max shrink-0 items-center gap-0.5 whitespace-nowrap rounded-md border bg-brand-soft px-1.5 text-[11.5px] font-medium text-brand ${
        open ? "border-brand ring-[3px] ring-brand/15" : "border-brand-line"
      }`}
    >
      <MaterialIcon name="schedule" className="!text-[14px] shrink-0" />
      {label}
      <MaterialIcon name="expand_more" className="!text-[15px] shrink-0" />
    </button>
  );
}

function ReplayRow({
  slot,
  templates,
  fields,
  connected,
  open,
  busy,
  onOpen,
  onClose,
  onToggle,
  onTiming,
  onEdit,
}: {
  slot: MessageSlot | undefined;
  templates: CRMTemplate[] | null;
  fields: CRMMergeField[];
  connected: boolean;
  open: boolean;
  busy: boolean;
  onOpen: () => void;
  onClose: () => void;
  onToggle: (slot: MessageSlot, enabled: boolean) => void;
  onTiming: (slot: MessageSlot, timing: MessageSlot["timing"]) => void;
  onEdit: (slot: MessageSlot, title: string) => void;
}) {
  if (!slot) return null;
  const text = snippet(slot, templates ?? [], fields);
  return (
    <div
      className={`relative grid items-center gap-3 rounded-[10px] border border-line p-3 sm:grid-cols-[auto_minmax(max-content,16rem)_minmax(0,1fr)_auto_auto_auto] ${
        open ? "z-20" : ""
      }`}
    >
      <span className="grid size-7 place-items-center rounded-lg bg-brand-soft text-brand">
        <MaterialIcon name="play_circle" className="!text-[17px]" />
      </span>
      <div>
        <b className="block text-[13.5px]">Replay</b>
        <small className="block text-[11.5px] text-ink-3">Goes to everyone</small>
        <TimingChip label={timingLabel(slot.kind, slot.timing)} open={open} onClick={onOpen} />
        {open && (
          <TimingPicker
            mode="replay"
            title="When does the replay go out?"
            timing={slot.timing}
            busy={busy}
            onClose={onClose}
            onSave={(timing) => {
            onTiming(slot, timing);
            onClose();
          }}
          />
        )}
      </div>
      <Snip text={slot.enabled ? text : ""} empty="Not sending the replay on WhatsApp." />
      <button
        type="button"
        className="text-[12px] font-medium text-brand hover:underline"
        disabled={!connected}
        onClick={() => onEdit(slot, "Replay")}
      >
        {text ? "Edit" : "Set up"}
      </button>
      <Switch
        checked={slot.enabled}
        onChange={(v) => onToggle(slot, v)}
        label="Replay"
        disabled={!connected && !slot.enabled}
      />
    </div>
  );
}
