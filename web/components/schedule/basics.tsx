"use client";

import { useId } from "react";
import { useAppConfig } from "../providers";
import { WebinarImagePicker } from "../webinar-image-picker";
import type { PreparedWebinarImage } from "@/lib/webinar-image";
import { FormSection, Text } from "./chrome";
import type { FormState, SetForm } from "./form-state";

export function BasicsSection({
  form,
  set,
  fields,
  imagePreview,
  onImage,
  onImageRemove,
}: {
  form: FormState;
  set: SetForm;
  fields: Record<string, string>;
  imagePreview: string | null;
  onImage: (prepared: PreparedWebinarImage, preview: string) => void;
  onImageRemove: () => void;
}) {
  const config = useAppConfig();
  return (
    <FormSection
      title="Basics"
      description="What people see on the browse and registration pages."
      first
    >
      <div className="grid gap-3.5">
        {/* Topic, summary and description, then tag and type in the left column;
            the cover on the right. Below `lg`, `contents` lets the left fields join
            this grid and the cover follows the description. The tag and the type
            stay up front: the tag files the webinar on the browse page and the
            type decides one-off or series. */}
        <div className="grid grid-cols-1 items-start gap-3.5 lg:grid-cols-[minmax(0,1fr)_15rem] lg:gap-x-4">
          <div className="contents lg:flex lg:flex-col lg:gap-3.5">
            <div className="order-1 lg:order-none">
              <Text
                id="topic"
                label="Topic"
                value={form.topic}
                onChange={(v) => set("topic", v)}
                error={fields.topic}
                placeholder="What is this webinar called?"
                required
                large
              />
            </div>

            <div className="order-2 lg:order-none">
              <Text
                label="One-line summary"
                value={form.summary}
                onChange={(v) => set("summary", v)}
              />
            </div>

            <div className="order-3 lg:order-none">
              <label className="label" htmlFor="description">
                Description{" "}
                <span className="font-normal text-ink-3">(optional)</span>
              </label>
              <textarea
                id="description"
                className="field min-h-24"
                rows={3}
                placeholder="What you'll cover, who it's for, and what people will take away."
                value={form.description}
                onChange={(e) => set("description", e.target.value)}
              />
              <p className="mt-1 text-[11.5px] text-ink-3">
                The full story, on the registration page.
              </p>
            </div>

            <div className="order-5 grid gap-3.5 sm:grid-cols-2 lg:order-none">
              {/* Free text with suggestions from what already exists, rather
                  than a fixed list nobody can extend without a deploy. */}
              <div>
                <label className="label" htmlFor="track">
                  Topic tag
                </label>
                <input
                  id="track"
                  className="field"
                  list="track-suggestions"
                  placeholder="e.g. Productivity"
                  value={form.track}
                  onChange={(e) => set("track", e.target.value)}
                />
                <datalist id="track-suggestions">
                  {config.tracks.map((t) => (
                    <option key={t} value={t} />
                  ))}
                </datalist>
              </div>
              <KindControl value={form.kind} onChange={(v) => set("kind", v)} />
            </div>
          </div>

          <div className="order-4 lg:order-none">
            <WebinarImagePicker
              topic={form.topic}
              previewUrl={imagePreview}
              onChange={onImage}
              onRemove={onImageRemove}
            />
          </div>
        </div>
      </div>
    </FormSection>
  );
}

function KindControl({
  value,
  onChange,
}: {
  value: FormState["kind"];
  onChange: (next: FormState["kind"]) => void;
}) {
  const name = useId();
  const labelId = useId();
  const options = [
    ["live", "Live webinar"],
    ["recurring", "Recurring series"],
    // Only offered to a webinar that already is one: simulive is set up from
    // a recording elsewhere, and this form cannot pick that recording.
    ...(value === "simulive" ? ([["simulive", "Simulive"]] as const) : []),
  ] as const;
  return (
    <div>
      <span className="label" id={labelId}>
        Type
      </span>
      <div
        role="radiogroup"
        aria-labelledby={labelId}
        className="flex h-10 gap-0.5 rounded-lg border border-line bg-surface-2 p-0.5"
      >
        {options.map(([option, label]) => {
          const active = value === option;
          return (
            <label
              key={option}
              className={`flex flex-1 cursor-pointer items-center justify-center rounded-md text-[13px] font-medium has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-brand/40 ${
                active
                  ? "border border-line bg-surface text-ink"
                  : "border border-transparent text-ink-2"
              }`}
            >
              <input
                type="radio"
                name={name}
                value={option}
                checked={active}
                onChange={() => onChange(option)}
                className="sr-only"
              />
              {label}
            </label>
          );
        })}
      </div>
    </div>
  );
}
