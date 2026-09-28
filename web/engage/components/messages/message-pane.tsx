"use client";

import { useState, type ReactNode } from "react";
import { MaterialIcon } from "@/components/icons";
import {
  ChannelEmail,
  ChannelWhatsApp,
  SlotConfirmation,
  SlotReminder,
  SlotReplay,
  TimingAfterEnd,
  TimingBefore,
  TimingNextMorning,
  TimingOnPublish,
  type CRMMergeField,
  type CRMTemplate,
  type MessageSlot,
} from "@/lib/api-types";
import { exampleFor, renderTemplate } from "../crm-templates";
import { PhoneFrame, Switch } from "../wa-kit";
import { guessParams } from "../wa-messages";
import {
  hasChannel,
  isFollowup,
  laterWhen,
  metaFor,
  withChannel,
  wordingKind,
} from "./catalog";
import { WordingPicker } from "./wording-picker";

/* The selected message: switch, channels, when, wording, and the preview
 * as the attendee reads it — this webinar's title, the coach's own name. */

export type ReminderTimesEditor = (props: {
  value: number[];
  onChange: (next: number[]) => void;
  disabled?: boolean;
}) => ReactNode;

const AFTER_CHOICES: { label: string; minutes: number }[] = [
  { label: "1 hour after", minutes: 60 },
  { label: "2 hours after", minutes: 120 },
  { label: "1 day after", minutes: 24 * 60 },
];

function Tick({
  checked,
  label,
  onChange,
}: {
  checked: boolean;
  label: string;
  onChange: (on: boolean) => void;
}) {
  return (
    <label className="inline-flex cursor-pointer items-center gap-1.5 text-[13px] text-ink">
      <input
        type="checkbox"
        className="size-3.5 accent-brand"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      {label}
    </label>
  );
}

function Chip({
  on,
  children,
  onClick,
}: {
  on?: boolean;
  children: ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      className={`rounded-full border px-2.5 py-1 text-[12px] font-medium ${
        on
          ? "border-brand bg-brand-soft text-brand"
          : "border-line text-ink-2 hover:bg-surface-2"
      }`}
    >
      {children}
    </button>
  );
}

function emailCopy(slot: MessageSlot, topic: string, when: string, body: string) {
  const name = topic.trim() || "your webinar";
  const at = when || "the scheduled time";
  const subjects: Record<string, string> = {
    [SlotConfirmation]: `You're in: ${name}`,
    [SlotReminder]: `Starting soon: ${name}`,
    [SlotReplay]: `Replay: ${name}`,
  };
  const fallbacks: Record<string, string> = {
    [SlotConfirmation]: `You're registered for ${name}. It starts ${at}.`,
    [SlotReminder]: `${name} starts ${at}. Your link is in this email.`,
    [SlotReplay]: `The recording of ${name} is ready to watch.`,
  };
  return {
    subject: subjects[slot.kind] ?? name,
    body: body || fallbacks[slot.kind] || `A note about ${name}, which starts ${at}.`,
  };
}

export function MessagePane({
  slot,
  fields,
  templates,
  connected,
  coachName,
  topic,
  whenText,
  forAll,
  reminderTimes,
  onChange,
  onForAll,
  onWriteOwn,
}: {
  slot: MessageSlot;
  fields: CRMMergeField[];
  templates: CRMTemplate[];
  connected: boolean;
  coachName: string;
  topic: string;
  whenText: string;
  forAll: boolean;
  reminderTimes: ReminderTimesEditor;
  onChange: (next: MessageSlot) => void;
  onForAll: (on: boolean) => void;
  onWriteOwn: () => void;
}) {
  const meta = metaFor(slot.kind);
  const template = templates.find(
    (item) => item.name === slot.template && item.language === slot.language,
  );
  const values = (slot.params ?? []).map((token) => exampleFor(fields, token));
  const rendered = template ? renderTemplate(template.body ?? "", values) : "";
  const mail = emailCopy(slot, topic, whenText, rendered);
  const [channel, setChannel] = useState<"whatsapp" | "email">(
    hasChannel(slot, ChannelWhatsApp) ? "whatsapp" : "email",
  );

  return (
    <aside className="grid content-start gap-4 rounded-xl border border-line bg-surface p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-[15px] font-semibold text-ink">
            {meta?.title ?? slot.kind}
          </h3>
          <p className="text-[12px] text-ink-3">{meta?.blurb}</p>
        </div>
        <Switch
          checked={slot.enabled}
          onChange={(on) => onChange({ ...slot, enabled: on })}
          label={`${meta?.title ?? "Message"} on`}
        />
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <span className="text-[12px] font-semibold text-ink">Send this by</span>
        <Tick
          checked={hasChannel(slot, ChannelEmail)}
          label="Email"
          onChange={(on) => onChange(withChannel(slot, ChannelEmail, on))}
        />
        <Tick
          checked={hasChannel(slot, ChannelWhatsApp)}
          label="WhatsApp"
          onChange={(on) => onChange(withChannel(slot, ChannelWhatsApp, on))}
        />
      </div>

      <WhenEditor slot={slot} onChange={onChange} reminderTimes={reminderTimes} />

      <WordingPicker
        kind={slot.kind}
        templates={templates}
        templateName={slot.template}
        language={slot.language}
        params={slot.params ?? []}
        fields={fields}
        connected={connected}
        onPick={(next) =>
          onChange({
            ...slot,
            template: next.name,
            language: next.language,
            params: guessParams(next, wordingKind(slot.kind), fields),
            enabled: isFollowup(slot.kind) ? true : slot.enabled,
          })
        }
        onWriteOwn={onWriteOwn}
      />

      <Tick
        checked={forAll}
        label="Use this for all my webinars"
        onChange={onForAll}
      />

      <div className="flex gap-1 rounded-lg bg-surface-2 p-0.5 text-[12.5px] font-medium">
        {(["whatsapp", "email"] as const).map((item) => (
          <button
            key={item}
            type="button"
            onClick={() => setChannel(item)}
            className={`flex-1 rounded-md px-2 py-1 ${
              channel === item ? "bg-surface text-ink shadow-sm" : "text-ink-3"
            }`}
          >
            {item === "whatsapp" ? "WhatsApp" : "Email"}
          </button>
        ))}
      </div>

      {channel === "whatsapp" ? (
        <PhoneFrame title={coachName} subtitle="Business account">
          <div className="max-w-[92%] rounded-lg rounded-tl-none bg-white px-2.5 py-2 text-[12.5px] leading-relaxed whitespace-pre-wrap text-[#111] shadow-sm">
            {rendered || mail.body}
            {template && (template.buttons ?? []).length > 0 && (
              <div className="mt-1.5 flex flex-col gap-1 border-t border-black/5 pt-1.5">
                {template.buttons.map((button) => (
                  <span
                    key={button.text}
                    className="inline-flex items-center justify-center gap-1 text-[12px] font-medium text-[#027eb5]"
                  >
                    <MaterialIcon name="login" className="size-3.5" />
                    {button.text}
                  </span>
                ))}
              </div>
            )}
          </div>
        </PhoneFrame>
      ) : (
        <div className="rounded-xl border border-line bg-surface-2 p-3">
          <p className="text-[11px] text-ink-3">From {coachName}</p>
          <p className="mt-1 text-[13px] font-semibold text-ink">{mail.subject}</p>
          <p className="mt-2 text-[12.5px] leading-relaxed whitespace-pre-wrap text-ink-2">
            {mail.body}
          </p>
        </div>
      )}

      <p className="text-[11.5px] leading-relaxed text-ink-3">
        Channels, times and wording here are for this webinar. Tick “Use this for
        all my webinars” to make it your default.
      </p>
    </aside>
  );
}

function WhenEditor({
  slot,
  onChange,
  reminderTimes,
}: {
  slot: MessageSlot;
  onChange: (next: MessageSlot) => void;
  reminderTimes: ReminderTimesEditor;
}) {
  if (slot.kind === SlotConfirmation) {
    return (
      <p className="text-[12.5px] text-ink-2">
        <span className="font-semibold text-ink">When. </span>
        When they register.
      </p>
    );
  }
  if (slot.kind === SlotReminder) {
    return (
      <div className="grid gap-1.5">
        <span className="text-[12px] font-semibold text-ink">When</span>
        {reminderTimes({
          value: slot.timing.minutes ?? [],
          disabled: !slot.enabled,
          onChange: (minutes) =>
            onChange({
              ...slot,
              timing: { type: TimingBefore, minutes },
            }),
        })}
      </div>
    );
  }
  if (slot.kind === SlotReplay) {
    const published = slot.timing.type === TimingOnPublish;
    return (
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[12px] font-semibold text-ink">When</span>
        <Chip
          on={published}
          onClick={() => onChange({ ...slot, timing: { type: TimingOnPublish } })}
        >
          When you publish the recording
        </Chip>
        <Chip
          on={!published}
          onClick={() =>
            onChange({
              ...slot,
              timing: { type: TimingAfterEnd, minutes: [slot.timing.minutes?.[0] || 120] },
            })
          }
        >
          {published ? "2 hours after it ends" : laterWhen(slot)}
        </Chip>
      </div>
    );
  }
  const morning = slot.timing.type === TimingNextMorning;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-[12px] font-semibold text-ink">When</span>
      {AFTER_CHOICES.map((choice) => {
        const on =
          !morning &&
          slot.timing.type === TimingAfterEnd &&
          slot.timing.minutes?.[0] === choice.minutes;
        return (
          <Chip
            key={choice.label}
            on={on}
            onClick={() =>
              onChange({
                ...slot,
                timing: { type: TimingAfterEnd, minutes: [choice.minutes] },
              })
            }
          >
            {choice.label}
          </Chip>
        );
      })}
      <Chip
        on={morning}
        onClick={() =>
          onChange({
            ...slot,
            timing: { type: TimingNextMorning, hour: slot.timing.hour ?? 9 },
          })
        }
      >
        Next morning
      </Chip>
    </div>
  );
}
