"use client";

import { useState, type ReactNode } from "react";
import { MaterialIcon } from "@/components/icons";
import {
  ChannelEmail,
  ChannelWhatsApp,
  MaxReminders,
  SlotConfirmation,
  SlotFollowupEngaged,
  SlotFollowupHigh,
  SlotFollowupNoShow,
  SlotFollowupPassive,
  SlotFollowupRisk,
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
import { durationLabel, hourLabel } from "../message-timing";
import { PersonAvatar, PhoneFrame } from "../wa-kit";
import { guessParams } from "../wa-messages";
import {
  hasChannel,
  isFollowup,
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

/* Who each follow-up is for, in the same words the rest of Engage uses. */
const FOLLOWUP_WHO: Record<string, string> = {
  [SlotFollowupHigh]: "People who stayed and joined in.",
  [SlotFollowupEngaged]: "People who stayed most of the session.",
  [SlotFollowupNoShow]: "People who registered but missed it.",
  [SlotFollowupPassive]: "People who stayed but didn't chat.",
  [SlotFollowupRisk]: "People who left before the end.",
};

const FOLLOWUP_PRESETS: { key: string; label: string; note: string; minutes?: number }[] = [
  { key: "hour", label: "1 hour after", note: "While they remember it", minutes: 60 },
  { key: "two", label: "2 hours after", note: "A little later", minutes: 120 },
  { key: "morning", label: "Next morning", note: "When they check their phone" },
  { key: "day", label: "Next day", note: "A full day later", minutes: 24 * 60 },
];

const MORNING_HOURS = [7, 8, 9, 10, 11];
const MAX_AFTER_MINUTES = 90 * 24 * 60;

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
  if (slot.kind === SlotReplay) return <ReplayWhen slot={slot} onChange={onChange} />;
  if (isFollowup(slot.kind)) return <FollowupWhen slot={slot} onChange={onChange} />;
  return null;
}

function FollowupWhen({
  slot,
  onChange,
}: {
  slot: MessageSlot;
  onChange: (next: MessageSlot) => void;
}) {
  const morning = slot.timing.type === TimingNextMorning;
  const minutes = slot.timing.minutes?.[0] ?? 60;
  const hour = slot.timing.hour ?? 9;
  const preset = morning
    ? "morning"
    : FOLLOWUP_PRESETS.find((choice) => choice.minutes === minutes)?.key;
  const setAfter = (next: number) =>
    onChange({ ...slot, timing: { type: TimingAfterEnd, minutes: [next] } });
  const setMorning = (next: number) =>
    onChange({ ...slot, timing: { type: TimingNextMorning, hour: next } });

  return (
    <WhenPanel>
      <p className="text-[12.5px] leading-snug text-ink">
        {FOLLOWUP_WHO[slot.kind] ?? "People in this group."}
      </p>
      <div className="grid grid-cols-2 gap-1.5">
        {FOLLOWUP_PRESETS.map((choice) => (
          <Choice
            key={choice.key}
            on={preset === choice.key}
            title={choice.label}
            note={choice.note}
            onClick={() =>
              choice.key === "morning" ? setMorning(hour) : setAfter(choice.minutes ?? 60)
            }
          />
        ))}
      </div>
      {morning ? (
        <MorningHour hour={hour} onChange={setMorning} />
      ) : (
        <OwnTime key={minutes} label="Or set your own" minutes={minutes} onCommit={setAfter} />
      )}
      <p className="text-[11.5px] text-ink-3">
        {morning
          ? `Sends the next morning at ${hourLabel(hour)}, in the webinar's time zone.`
          : minutes <= 0
            ? "Sends as soon as the webinar ends."
            : `Sends ${durationLabel(minutes)} after the webinar ends.`}
      </p>
    </WhenPanel>
  );
}

function ReplayWhen({
  slot,
  onChange,
}: {
  slot: MessageSlot;
  onChange: (next: MessageSlot) => void;
}) {
  const published = slot.timing.type === TimingOnPublish;
  const minutes = slot.timing.minutes?.[0] || 120;
  return (
    <WhenPanel>
      <p className="text-[12.5px] leading-snug text-ink">
        Everyone who registered, once there is a recording.
      </p>
      <div className="grid gap-1.5">
        <Choice
          on={published}
          title="When you publish it"
          note="You choose the moment."
          onClick={() => onChange({ ...slot, timing: { type: TimingOnPublish } })}
        />
        <Choice
          on={!published}
          title="After the webinar ends"
          note="A set wait, whether or not you have published."
          onClick={() =>
            onChange({ ...slot, timing: { type: TimingAfterEnd, minutes: [minutes] } })
          }
        />
      </div>
      {!published && (
        <OwnTime
          key={minutes}
          label="How long after it ends"
          minutes={minutes}
          onCommit={(next) =>
            onChange({ ...slot, timing: { type: TimingAfterEnd, minutes: [next] } })
          }
        />
      )}
      <p className="text-[11.5px] text-ink-3">
        {published
          ? "Sends the moment the recording is public."
          : minutes <= 0
            ? "Sends as soon as the webinar ends."
            : `Sends ${durationLabel(minutes)} after the webinar ends.`}
      </p>
    </WhenPanel>
  );
}

function Choice({
  on,
  title,
  note,
  onClick,
}: {
  on: boolean;
  title: string;
  note: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      className={`rounded-lg border px-2.5 py-2 text-left ${
        on ? "border-brand bg-brand-soft" : "border-line bg-surface hover:bg-surface-2"
      }`}
    >
      <span className={`block text-[12.5px] font-medium ${on ? "text-brand" : "text-ink"}`}>
        {title}
      </span>
      <span className="mt-0.5 block text-[11px] leading-snug text-ink-3">{note}</span>
    </button>
  );
}

function MorningHour({ hour, onChange }: { hour: number; onChange: (hour: number) => void }) {
  const hours = MORNING_HOURS.includes(hour)
    ? MORNING_HOURS
    : [...MORNING_HOURS, hour].sort((a, b) => a - b);
  return (
    <label className="flex flex-wrap items-center gap-2 text-[12.5px] text-ink">
      The next morning at
      <select
        aria-label="Morning hour"
        value={hour}
        onChange={(event) => onChange(Number(event.target.value))}
        className="rounded-lg border border-line bg-surface px-2 py-1.5 text-[13px] text-ink"
      >
        {hours.map((value) => (
          <option key={value} value={value}>
            {hourLabel(value)}
          </option>
        ))}
      </select>
    </label>
  );
}

type WaitUnit = "minutes" | "hours" | "days";

function splitWait(minutes: number): { amount: string; unit: WaitUnit } {
  if (minutes > 0 && minutes % (24 * 60) === 0) {
    return { amount: String(minutes / (24 * 60)), unit: "days" };
  }
  if (minutes > 0 && minutes % 60 === 0) {
    return { amount: String(minutes / 60), unit: "hours" };
  }
  return { amount: String(Math.max(0, minutes)), unit: "minutes" };
}

function OwnTime({
  label,
  minutes,
  onCommit,
}: {
  label: string;
  minutes: number;
  onCommit: (minutes: number) => void;
}) {
  const [amount, setAmount] = useState(() => splitWait(minutes).amount);
  const [unit, setUnit] = useState<WaitUnit>(() => splitWait(minutes).unit);
  const [error, setError] = useState("");

  const commit = (nextAmount: string, nextUnit: WaitUnit) => {
    const count = Math.round(Number(nextAmount));
    const factor = nextUnit === "days" ? 24 * 60 : nextUnit === "hours" ? 60 : 1;
    const next = count * factor;
    if (nextAmount.trim() === "" || !Number.isFinite(count) || count < 0 || next > MAX_AFTER_MINUTES) {
      setError("Choose a wait from right away up to 90 days.");
      return;
    }
    setError("");
    if (next !== minutes) onCommit(next);
  };

  return (
    <div className="grid gap-1">
      <label className="text-[11px] font-medium text-ink-2">{label}</label>
      <div className="flex flex-wrap items-center gap-1.5">
        <input
          type="number"
          min={0}
          inputMode="numeric"
          aria-label={label}
          value={amount}
          onChange={(event) => setAmount(event.target.value)}
          onBlur={() => commit(amount, unit)}
          className="w-16 rounded-lg border border-line bg-surface px-2 py-1.5 text-[13px] text-ink"
        />
        <select
          aria-label="Time unit"
          value={unit}
          onChange={(event) => {
            const next = event.target.value as WaitUnit;
            setUnit(next);
            commit(amount, next);
          }}
          className="rounded-lg border border-line bg-surface px-2 py-1.5 text-[13px] text-ink"
        >
          <option value="minutes">minutes</option>
          <option value="hours">hours</option>
          <option value="days">days</option>
        </select>
        <span className="text-[12px] text-ink-2">after it ends</span>
      </div>
      {error ? <p className="text-[11px] text-warn">{error}</p> : null}
    </div>
  );
}

function WhenPanel({ children }: { children: ReactNode }) {
  return (
    <div className="grid gap-2 rounded-[10px] border border-line bg-surface-2 px-2.5 py-2.5">
      <span className="text-[12px] font-medium text-ink-2">When</span>
      {children}
    </div>
  );
}
