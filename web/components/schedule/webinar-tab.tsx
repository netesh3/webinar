"use client";

import { useMemo, type ReactNode } from "react";
import { Select } from "../controls";
import { DateTimeField } from "../date-picker";
import { CalendarIcon } from "../icons";
import { useHydrated, useNow } from "@/lib/clock";
import {
  instantToZoned,
  localTimeZone,
  timeZoneLabel,
  timeZoneNames,
  zonedToInstant,
} from "@/lib/format";
import type { CRMMediaFile, DeliveryPolicy, Webinar } from "@/lib/api-types";
import type { PreparedWebinarImage } from "@/lib/webinar-image";
import { BasicsSection } from "./basics";
import { FormGroup, FormSection, Text } from "./chrome";
import {
  DURATIONS,
  MIN_SCHEDULE_LEAD_MS,
  type FormState,
  type SetForm,
} from "./form-state";
import { RegistrationSection } from "./registration";
import { WhereSection } from "./where";
import { RoomSection } from "./room";
import { RecurrenceFields } from "./recurrence-fields";
import { SimuliveSourceSection } from "./simulive-source";
import { SimuliveStartSection } from "./simulive-start";
import { scheduleLeadMs } from "@/lib/simulive-create";
import { SurveySection } from "./survey-section";
import { formatDuration } from "./summary";

/** The Details step: basics, time, registration, the room and the feedback survey. */
export function WebinarTab({
  meeting = false,
  form,
  set,
  fields,
  editing,
  webinar,
  imagePreview,
  onImage,
  onImageFromMedia,
  onImageRemove,
  survey,
  polls,
  feedbackPreviews,
  deliveryPolicy = null,
}: {
  /** A meeting's form: the topic and When, nothing else. */
  meeting?: boolean;
  /** What delivery to offer (lib/delivery-policy.ts), null while it loads. */
  deliveryPolicy?: DeliveryPolicy | null;
  form: FormState;
  set: SetForm;
  fields: Record<string, string>;
  editing: boolean;
  webinar: Webinar | null;
  imagePreview: string | null;
  onImage: (prepared: PreparedWebinarImage, preview: string) => void;
  onImageFromMedia?: (file: CRMMediaFile, preview: string) => void;
  onImageRemove: () => void;
  /** The feedback survey builder, owned by the form so it can save it. */
  survey: ReactNode;
  /** Live polls under the survey, owned by the form so it can save them. */
  polls: ReactNode;
  /** Sticky Feedback column: survey + one poll + one quiz preview. */
  feedbackPreviews?: ReactNode;
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

  if (meeting) {
    return (
      <div className="grid gap-5">
        <FormGroup label="The meeting">
          <FormSection
            title="Topic"
            description="What the invite and the room are called."
            first
          >
            <Text
              id="topic"
              label="Topic"
              value={form.topic}
              onChange={(v) => set("topic", v)}
              error={fields.topic}
              placeholder="What is this meeting about?"
              required
              large
            />
          </FormSection>
          <WhenSection
            meeting
            form={form}
            set={set}
            fields={fields}
            editing={editing}
            zones={zones}
            hydrated={hydrated}
            startsAtPreview={startsAtPreview}
          />
        </FormGroup>
      </div>
    );
  }

  return (
    <div className="grid gap-5">
      <FormGroup label="The basics">
        <BasicsSection
          form={form}
          set={set}
          fields={fields}
          imagePreview={imagePreview}
          onImage={onImage}
          onImageFromMedia={onImageFromMedia}
          onImageRemove={onImageRemove}
        />
        {form.kind === "simulive" && (
          <SimuliveSourceSection
            form={form}
            set={set}
            fields={fields}
            editing={editing}
            slug={webinar?.id}
          />
        )}
        {form.kind === "simulive" && <SimuliveStartSection form={form} set={set} editing={editing} />}
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
      <WhereSection form={form} set={set} fields={fields} deliveryPolicy={deliveryPolicy} />
      <RegistrationSection form={form} set={set} fields={fields} />
      <RoomSection
        form={form}
        set={set}
        fields={fields}
        editing={editing}
        webinar={webinar}
      />
      <SurveySection
        survey={survey}
        polls={polls}
        previews={feedbackPreviews}
      />
    </div>
  );
}

function WhenSection({
  meeting = false,
  form,
  set,
  fields,
  editing,
  zones,
  hydrated,
  startsAtPreview,
}: {
  meeting?: boolean;
  form: FormState;
  set: SetForm;
  fields: Record<string, string>;
  editing: boolean;
  zones: string[];
  hydrated: boolean;
  startsAtPreview: Date | null;
}) {
  /* Only a new webinar. An existing one may already be in the past, and an
   * edit that does not move the start must not be blocked by it — the server
   * applies the lead only when the start changes. */
  const now = useNow(30_000);
  const minDate =
    !editing && now != null
      ? instantToZoned(new Date(now).toISOString(), form.timeZone).date
      : undefined;
  const notBeforeMs =
    !editing && now != null ? now + scheduleLeadMs(form.kind, MIN_SCHEDULE_LEAD_MS) : undefined;

  return (
    <FormSection
      title="When"
      description={
        meeting
          ? "The meeting has to start at least 15 minutes from now, which gives the video server time to start."
          : form.kind === "recurring" || form.seriesId
            ? "The first session uses this start time. It has to be at least 15 minutes from now."
            : form.kind === "simulive"
              ? "The recording plays to everyone from this time. It can be as soon as a minute from now."
              : "The webinar has to start at least 15 minutes from now."
      }
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,0.8fr)_minmax(0,1.4fr)]">
        <DateTimeField
          id="date"
          label="Starts"
          ariaLabel="Date and start time"
          date={form.date}
          time={form.time}
          timeZone={form.timeZone}
          minDate={minDate}
          notBeforeMs={notBeforeMs}
          rule="At least 15 minutes from now"
          invalid={Boolean(fields.startsAt)}
          onChange={(date, time) => {
            set("date", date);
            set("time", time);
          }}
        />
        {form.kind === "simulive" ? (
          /* A simulive runs as long as its recording: the length follows the recording
           * picked above and is not a choice of its own. */
          <div>
            <span className="label">Duration</span>
            <p
              className="field flex items-center text-ink-2"
              aria-readonly="true"
              title="Set by the recording"
            >
              {formatDuration(form.durationMin)}{" "}
              <span className="ml-1 text-[11.5px] text-ink-3">· the recording&apos;s length</span>
            </p>
          </div>
        ) : (
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
        )}

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

      {!meeting && (form.kind === "recurring" || form.seriesId !== "") && (
        <RecurrenceFields form={form} set={set} error={fields.recurrence} />
      )}
    </FormSection>
  );
}
