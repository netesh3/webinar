"use client";

import { useState, type ReactNode } from "react";
import { MaterialIcon } from "@/components/icons";
import {
  ChannelEmail,
  ChannelWhatsApp,
  MaxReminders,
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
import { PersonAvatar, PhoneFrame } from "../wa-kit";
import { guessParams } from "../wa-messages";
import {
  hasChannel,
  isFollowup,
  laterWhen,
  metaFor,
  withChannel,
  wordingKind,
} from "./catalog";
import { ChannelIcon } from "./channel-icon";
import { WordingPicker } from "./wording-picker";

/* The selected message. WhatsApp and Email are tabs at the top: each tab shows
 * only that channel, and a tick on the tab means this message sends there.
 * The row's switch is the only on/off control — this pane does not repeat it. */

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

function Check({
  checked,
  label,
  onChange,
  size = "send",
}: {
  checked: boolean;
  label: string;
  onChange: (on: boolean) => void;
  size?: "send" | "quiet";
}) {
  return (
    <label
      className={`inline-flex cursor-pointer items-center gap-1 ${
        size === "quiet" ? "text-[12px]" : "text-[12.5px]"
      } ${checked ? "font-medium text-ink" : "text-ink-2"}`}
    >
      <input
        type="checkbox"
        className="sr-only"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      <MaterialIcon
        name={checked ? "check_box" : "check_box_outline_blank"}
        fill={checked}
        className={`size-[18px] ${checked ? "text-brand" : "text-ink-3"}`}
      />
      {label}
    </label>
  );
}

function Chip({
  on,
  dashed,
  children,
  onClick,
}: {
  on?: boolean;
  dashed?: boolean;
  children: ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={dashed ? undefined : on}
      onClick={onClick}
      className={`inline-flex h-[26px] w-max min-w-max shrink-0 items-center gap-0.5 whitespace-nowrap rounded-full border px-[9px] text-[12px] font-medium ${
        dashed
          ? "border-dashed border-line-2 bg-surface text-ink-3 hover:bg-white"
          : on
            ? "border-brand-line bg-brand-soft text-brand"
            : "border-line-2 bg-surface text-ink-2 hover:bg-white"
      }`}
    >
      {children}
    </button>
  );
}

function WhenBox({ children }: { children: ReactNode }) {
  return (
    <div className="grid gap-1.5 rounded-[10px] border border-line bg-surface-2 px-2.5 py-2">
      <span className="text-[12px] text-ink-2">When</span>
      <div className="flex flex-wrap items-center gap-1.5">{children}</div>
    </div>
  );
}

function beforeLabel(minutes: number): string {
  if (minutes % (24 * 60) === 0) {
    const days = minutes / (24 * 60);
    return `${days} ${days === 1 ? "day" : "days"} before`;
  }
  if (minutes % 60 === 0) {
    const hours = minutes / 60;
    return `${hours} ${hours === 1 ? "hour" : "hours"} before`;
  }
  return `${minutes} ${minutes === 1 ? "minute" : "minutes"} before`;
}

function nextReminder(existing: number[]): number {
  return [60, 10, 24 * 60, 30, 5].find((minutes) => !existing.includes(minutes)) ?? 15;
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
  /** The schedule form still passes its editor. This pane draws When as chips. */
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

  const whatsappOn = hasChannel(slot, ChannelWhatsApp);
  const emailOn = hasChannel(slot, ChannelEmail);

  return (
    <aside className="grid min-w-0 content-start gap-3 rounded-xl border border-line bg-surface p-3.5 [&>*]:min-w-0">
      <div>
        <h3 className="text-[14px] font-semibold text-ink">
          {meta?.title ?? slot.kind}
        </h3>
        <p className="text-[11.5px] text-ink-3">{meta?.blurb}</p>
      </div>

      <div
        role="tablist"
        aria-label="Channel"
        className="flex gap-0.5 rounded-lg bg-surface-2 p-0.5 text-[13px] font-medium"
      >
        <ChannelTab
          label="WhatsApp"
          channel={ChannelWhatsApp}
          selected={channel === "whatsapp"}
          included={whatsappOn}
          onClick={() => setChannel("whatsapp")}
        />
        <ChannelTab
          label="Email"
          channel={ChannelEmail}
          selected={channel === "email"}
          included={emailOn}
          onClick={() => setChannel("email")}
        />
      </div>

      {channel === "whatsapp" ? (
        <>
          <SendOn
            label="Send on WhatsApp"
            checked={whatsappOn}
            onChange={(on) => onChange(withChannel(slot, ChannelWhatsApp, on))}
          />
          <WhenEditor slot={slot} onChange={onChange} />
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
          <div className="[&_.min-h-64]:min-h-0 [&_.min-h-64]:py-2.5">
            <PhoneFrame title={coachName} subtitle="Business account">
              <div className="max-w-[92%] rounded-lg rounded-tl-none bg-white px-2.5 py-2 text-[12.5px] leading-relaxed whitespace-pre-wrap text-[#111] shadow-sm">
                {rendered || mail.body}
                {template && (template.buttons ?? []).length > 0 && (
                  <div className="mt-1.5 flex flex-col border-t border-black/5 pt-1">
                    {template.buttons.map((button) => (
                      <span
                        key={button.text}
                        className="inline-flex items-center justify-center gap-1 py-1 text-[12px] font-medium text-[#027eb5]"
                      >
                        <MaterialIcon name="login" className="size-[14px]" />
                        {button.text}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </PhoneFrame>
          </div>
        </>
      ) : (
        <>
          <SendOn
            label="Send on Email"
            checked={emailOn}
            onChange={(on) => onChange(withChannel(slot, ChannelEmail, on))}
          />
          <WhenEditor slot={slot} onChange={onChange} />
          <div className="[&_.min-h-64]:min-h-0 [&_.min-h-64]:py-2.5">
            <EmailFrame from={coachName} subject={mail.subject} body={mail.body}>
              {template && (template.buttons ?? []).length > 0 && (
                <div className="mt-2.5 flex flex-col gap-1.5 border-t border-black/5 pt-2">
                  {template.buttons.map((button) => (
                    <span
                      key={button.text}
                      className="inline-flex items-center justify-center gap-1 rounded-md bg-brand-soft py-1.5 text-[12px] font-medium text-brand"
                    >
                      {button.text}
                    </span>
                  ))}
                </div>
              )}
            </EmailFrame>
          </div>
        </>
      )}

      <Check
        checked={forAll}
        label="Use this for all my webinars"
        size="quiet"
        onChange={onForAll}
      />

      <p className="text-[11.5px] leading-relaxed text-ink-3">
        Channels, times and wording here are for this webinar. Tick “Use this for
        all my webinars” to make it your default.
      </p>
    </aside>
  );
}

function ChannelTab({
  label,
  channel,
  selected,
  included,
  onClick,
}: {
  label: string;
  channel: string;
  selected: boolean;
  included: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={selected}
      onClick={onClick}
      className={`flex flex-1 items-center justify-center gap-1.5 rounded-md px-2 py-[6px] font-medium ${
        selected ? "bg-surface shadow-sm" : ""
      } ${channel === ChannelWhatsApp ? "text-ok" : "text-brand"}`}
    >
      <ChannelIcon
        channel={channel}
        className={`size-4 ${channel === ChannelWhatsApp ? "text-ok" : "text-brand"}`}
      />
      {label}
      {included && (
        <MaterialIcon
          name="check"
          className={`size-[14px] ${channel === ChannelWhatsApp ? "text-ok" : "text-brand"}`}
        />
      )}
    </button>
  );
}

/** The email as the attendee opens it, in the same frame as the WhatsApp phone. */
function EmailFrame({
  from,
  subject,
  body,
  children,
}: {
  from: string;
  subject: string;
  body: string;
  children?: ReactNode;
}) {
  return (
    <div className="mx-auto w-full max-w-[17rem] rounded-[2rem] border-[7px] border-[#1c1c1e] bg-[#1c1c1e] shadow-lg">
      <div className="overflow-hidden rounded-[1.5rem]">
        <div className="flex items-center gap-2 bg-brand px-3 py-2.5 text-white">
          <span className="grid size-[26px] shrink-0 place-items-center rounded-full bg-white/15">
            <MaterialIcon name="mail" className="!text-[15px]" />
          </span>
          <div className="min-w-0">
            <div className="truncate text-[12.5px] font-semibold">Inbox</div>
            <div className="truncate text-[10.5px] opacity-80">Email</div>
          </div>
        </div>
        <div className="grid min-h-64 content-start bg-[#f4f5f7] px-2.5 py-3">
          <div className="rounded-lg bg-white px-2.5 py-2.5 text-[#111] shadow-sm">
            <p className="text-[13px] leading-snug font-semibold">{subject}</p>
            <div className="mt-2 flex items-center gap-2">
              <PersonAvatar name={from} size={22} />
              <div className="min-w-0">
                <p className="truncate text-[11.5px] font-semibold">{from}</p>
                <p className="text-[10px] text-[#667]">to you</p>
              </div>
            </div>
            <p className="mt-2.5 text-[12.5px] leading-relaxed whitespace-pre-wrap">
              {body}
            </p>
            {children}
          </div>
        </div>
      </div>
    </div>
  );
}

function SendOn({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (on: boolean) => void;
}) {
  return (
    <div className="grid gap-0.5">
      <Check checked={checked} label={label} onChange={onChange} />
      <p className="pl-[22px] text-[11px] text-ink-3">
        Send on WhatsApp, email, or both.
      </p>
    </div>
  );
}

function WhenEditor({
  slot,
  onChange,
}: {
  slot: MessageSlot;
  onChange: (next: MessageSlot) => void;
}) {
  if (slot.kind === SlotConfirmation) {
    return (
      <WhenBox>
        <span className="text-[12px] text-ink-2">When they register.</span>
      </WhenBox>
    );
  }
  if (slot.kind === SlotReminder) {
    const minutes = [...(slot.timing.minutes ?? [])].sort((a, b) => b - a);
    const setMinutes = (next: number[]) =>
      onChange({ ...slot, timing: { type: TimingBefore, minutes: next } });
    return (
      <div className={slot.enabled ? undefined : "opacity-60"}>
        <WhenBox>
          {minutes.map((value) => (
            <Chip key={value} on onClick={() => setMinutes(minutes.filter((item) => item !== value))}>
              {beforeLabel(value)}
            </Chip>
          ))}
          {minutes.length < MaxReminders && (
            <Chip dashed onClick={() => setMinutes([...minutes, nextReminder(minutes)])}>
              <MaterialIcon name="add" className="size-[14px]" />
              Add a time
            </Chip>
          )}
        </WhenBox>
      </div>
    );
  }
  if (slot.kind === SlotReplay) {
    const published = slot.timing.type === TimingOnPublish;
    return (
      <WhenBox>
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
      </WhenBox>
    );
  }
  const morning = slot.timing.type === TimingNextMorning;
    return (
    <WhenBox>
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
    </WhenBox>
  );
}
