"use client";

import { useState } from "react";
import { ApiError, api } from "@/lib/api";
import type { Webinar } from "@/lib/api-types";
import {
  DOORS_OPEN_MINUTES,
  START_IN_MINUTES,
  doorsOpenMin,
  startInMinutes,
  startMode,
  type SimuliveStartMode,
} from "@/lib/simulive-create";
import { useToast } from "../providers";
import { Button, Card, SectionTitle } from "../ui";
import { FormSection } from "./chrome";
import type { FormState, SetForm } from "./form-state";

/* How a simulive starts (api/internal/api/simulive_live.go):
 *
 *   automatically   at the scheduled time, by itself — no host, no scheduler needed
 *   by the host     a Start Simulive button in their room; never started on its own, and it
 *                   lapses at its scheduled end if nobody starts it
 *
 * and how many minutes before the start the audience may come in to wait and chat (no video
 * until it starts, and then everybody at the same moment). On the schedule form, with "start
 * in N minutes" for a new one; and on the Setup tab until it starts. */

function Choices({
  mode,
  doors,
  onMode,
  onDoors,
  disabled = false,
}: {
  mode: SimuliveStartMode;
  doors: number;
  onMode: (m: SimuliveStartMode) => void;
  onDoors: (d: number) => void;
  disabled?: boolean;
}) {
  const offered = (DOORS_OPEN_MINUTES as readonly number[]).includes(doors)
    ? DOORS_OPEN_MINUTES
    : [...DOORS_OPEN_MINUTES, doors].sort((a, b) => a - b);
  return (
    <div className="grid gap-3">
      <div role="radiogroup" aria-label="How it starts" className="grid gap-2">
        {(
          [
            ["auto", "Start automatically at the scheduled time", "Plays for everyone at the start, whether or not you are there."],
            ["manual", "I'll start it", "You or a co-host press ▶ Start Simulive in the room. It does not start on its own."],
          ] as const
        ).map(([id, label, hint]) => (
          <label
            key={id}
            className={`flex cursor-pointer gap-2.5 rounded-lg border px-3 py-2.5 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-brand/40 ${
              mode === id ? "border-brand-line bg-brand-soft/40" : "border-line"
            }`}
          >
            <input
              type="radio"
              name="simulive-start"
              value={id}
              checked={mode === id}
              disabled={disabled}
              onChange={() => onMode(id)}
              className="mt-0.5"
            />
            <span>
              <span className="block text-[13px] font-medium text-ink">{label}</span>
              <span className="block text-[12px] text-ink-3">{hint}</span>
            </span>
          </label>
        ))}
      </div>
      <label className="flex flex-wrap items-center gap-2 text-[12.5px] text-ink-2">
        Doors open
        <select
          className="field h-9 w-[150px] text-[12.5px]"
          value={doors}
          disabled={disabled}
          onChange={(e) => onDoors(Number(e.target.value))}
          aria-label="Doors open"
        >
          {offered.map((m) => (
            <option key={m} value={m}>
              {m === 0 ? "at the start" : `${m} minutes before`}
            </option>
          ))}
        </select>
        <span className="text-ink-3">People can come in early to wait and chat.</span>
      </label>
    </div>
  );
}

/** On the schedule form. */
export function SimuliveStartSection({ form, set, editing }: { form: FormState; set: SetForm; editing: boolean }) {
  const mode = startMode(form.options);
  const doors = doorsOpenMin(form.options);
  return (
    <FormSection title="How it starts" description="By itself at the start time, or when you press Start.">
      <Choices
        mode={mode}
        doors={doors}
        onMode={(m) => set("options", { ...form.options, simuliveStart: m })}
        onDoors={(d) => set("options", { ...form.options, simuliveDoorsOpenMin: d })}
      />
      {!editing && (
        <div className="mt-3 flex flex-wrap items-center gap-1.5 text-[12.5px] text-ink-2">
          Start in
          {START_IN_MINUTES.map((n) => (
            <Button
              key={n}
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => {
                const when = startInMinutes(Date.now(), n, form.timeZone);
                set("date", when.date);
                set("time", when.time);
              }}
            >
              {n} min
            </Button>
          ))}
          <span className="text-ink-3">from now</span>
        </div>
      )}
    </FormSection>
  );
}

/** On the Setup tab, until the session starts. */
export function SimuliveStartCard({ webinar: w, onChanged }: { webinar: Webinar; onChanged?: () => void }) {
  const { notify } = useToast();
  const [mode, setMode] = useState<SimuliveStartMode>(() => startMode(w.options));
  const [doors, setDoors] = useState(() => doorsOpenMin(w.options));
  const [saving, setSaving] = useState(false);
  const locked = w.status !== "scheduled";

  const save = async (next: { mode: SimuliveStartMode; doors: number }) => {
    const before = { mode, doors };
    setMode(next.mode);
    setDoors(next.doors);
    setSaving(true);
    try {
      await api.setSimuliveStart(w.id, { simuliveStart: next.mode, doorsOpenMin: next.doors });
      onChanged?.();
    } catch (e) {
      setMode(before.mode);
      setDoors(before.doors);
      notify(e instanceof ApiError ? e.message : "Could not save how it starts.", "error");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card className="p-5">
      <SectionTitle>How it starts</SectionTitle>
      {locked && (
        <p className="-mt-1 mb-3 text-[12.5px] text-ink-3">
          {w.status === "live" ? "It has started." : "This session is over."} The start can only be changed before it starts.
        </p>
      )}
      <Choices
        mode={mode}
        doors={doors}
        disabled={locked || saving}
        onMode={(m) => void save({ mode: m, doors })}
        onDoors={(d) => void save({ mode, doors: d })}
      />
    </Card>
  );
}
