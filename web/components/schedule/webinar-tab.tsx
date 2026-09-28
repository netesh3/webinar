"use client";

import { useMemo, type ReactNode } from "react";
import { openPickerOnClick, Select } from "../controls";
import { CalendarIcon } from "../icons";
import { useHydrated } from "@/lib/clock";
import {
  localTimeZone,
  timeZoneLabel,
  timeZoneNames,
  zonedToInstant,
} from "@/lib/format";
import type { Webinar } from "@/lib/api-types";
import type { PreparedWebinarImage } from "@/lib/webinar-image";
import { BasicsSection } from "./basics";
import { FormGroup, FormSection } from "./chrome";
import {
  DURATIONS,
  todayInputValue,
  type FormState,
  type SetForm,
} from "./form-state";
import { RegistrationSection } from "./registration";
import { RoomSection } from "./room";
import { SurveySection } from "./survey-section";
import { formatDuration } from "./summary";

/** The Details step: basics, time, registration, the room and the feedback survey. */
export function WebinarTab({
  form,
  set,
  fields,
  editing,
  webinar,
  imagePreview,
  onImage,
  onImageRemove,
  survey,
}: {
  form: FormState;
  set: SetForm;
  fields: Record<string, string>;
  editing: boolean;
  webinar: Webinar | null;
  imagePreview: string | null;
  onImage: (prepared: PreparedWebinarImage, preview: string) => void;
  onImageRemove: () => void;
  /** The feedback survey builder, owned by the form so it can save it. */
  survey: ReactNode;
}) {
  const allZones = useMemo(() => timeZoneNames(), []);
  /* The zone the webinar HAS is always an option. Browsers disagree on the
   * IANA list (Chrome has Asia/Calcutta, not Asia/Kolkata — the API's
   * default), and a <select> whose value is missing from its options shows
   * the first zone in the list while the form still holds the real one. */
  const zones = useMemo(
    () =>
      form.timeZone && !allZones.includes(form.timeZone)
        ? [form.timeZone, ...allZones]
        : allZones,
    [allZones, form.timeZone],
  );
  const hydrated = useHydrated();
  const startsAtPreview = useMemo(() => {
    return zonedToInstant(form.date, form.time, form.timeZone);
  }, [form.date, form.time, form.timeZone]);

  return (
    <div className="grid gap-5">
      <FormGroup label="The basics">
        <BasicsSection
          form={form}
          set={set}
          fields={fields}
          imagePreview={imagePreview}
          onImage={onImage}
          onImageRemove={onImageRemove}
        />
        <WhenSection
          form={form}
          set={set}
          fields={fields}
          editing={editing}
          zones={zones}
          hydrated={hydrated}
          startsAtPreview={startsAtPreview}
        />
      </FormGroup>
      <RegistrationSection form={form} set={set} fields={fields} />
      <RoomSection
        form={form}
        set={set}
        fields={fields}
        editing={editing}
        webinar={webinar}
      />
      <SurveySection survey={survey} />
    </div>
  );
}

function WhenSection({
  form,
  set,
  fields,
  editing,
  zones,
  hydrated,
  startsAtPreview,
}: {
  form: FormState;
  set: SetForm;
  fields: Record<string, string>;
  editing: boolean;
  zones: string[];
  hydrated: boolean;
  startsAtPreview: Date | null;
}) {
  return (
    <FormSection
      title="When"
      description="Defaults to today, at the next five-minute mark."
    >
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)_minmax(0,0.9fr)_minmax(0,1.5fr)]">
        <div>
          <label className="label" htmlFor="date">
            Date
          </label>
          <input
            id="date"
            type="date"
            onClick={openPickerOnClick}
            className="field"
            value={form.date}
            onChange={(e) => set("date", e.target.value)}
            // Only on a NEW webinar — an existing one may legitimately show a
            // past date (it already ran, or it's a draft nobody finished), and
            // an edit that touches an unrelated field must not be blocked by a
            // date the host never touched. The server enforces the real rule
            // (see normalizeWebinarInput's isCreate); this is a nudge so the
            // native picker does not even offer a date that will be refused.
            min={editing ? undefined : todayInputValue()}
            required
          />
        </div>
        <div>
          <label className="label" htmlFor="time">
            Start time
          </label>
          <input
            id="time"
            type="time"
            onClick={openPickerOnClick}
            className="field"
            value={form.time}
            onChange={(e) => set("time", e.target.value)}
            required
          />
        </div>
        <Select
          label="Duration"
          value={String(form.durationMin)}
          onChange={(v) => set("durationMin", Number(v))}
        >
          {/* The webinar's own length is always offered, like the zone
              below — an API-set 75 minutes would otherwise show as 15. */}
          {(DURATIONS.includes(form.durationMin)
            ? DURATIONS
            : [...DURATIONS, form.durationMin].sort((a, b) => a - b)
          ).map((m) => (
            <option key={m} value={m}>
              {formatDuration(m)}
            </option>
          ))}
        </Select>

        {/* Every IANA zone the browser knows. A four-city list is wrong for most
            of the world and stale the next time a country changes its rules. */}
        <Select
          label="Time zone"
          value={form.timeZone}
          onChange={(v) => set("timeZone", v)}
        >
          {zones.map((z) => (
            <option key={z} value={z}>
              {timeZoneLabel(z)}
            </option>
          ))}
        </Select>
      </div>

      {fields.startsAt && (
        <p className="mt-2 text-[12px] font-medium text-live">
          {fields.startsAt}
        </p>
      )}
      {fields.timeZone && (
        <p className="mt-2 text-[12px] font-medium text-live">
          {fields.timeZone}
        </p>
      )}
      {fields.durationMin && (
        <p className="mt-2 text-[12px] font-medium text-live">
          {fields.durationMin}
        </p>
      )}

      {startsAtPreview && hydrated && (
        <p className="mt-3 flex items-start gap-2 rounded-lg bg-surface-2 px-3 py-2.5 text-[12px] text-ink-3">
          <CalendarIcon className="mt-0.5 size-3.5 shrink-0 text-ink-2" />
          <span>
            Starts{" "}
            <strong className="font-medium text-ink-2">
              {startsAtPreview.toLocaleString(undefined, {
                dateStyle: "full",
                timeStyle: "short",
              })}
            </strong>{" "}
            in your local time
            {form.timeZone !== localTimeZone() && ` (${localTimeZone()})`}.
          </span>
        </p>
      )}
    </FormSection>
  );
}
