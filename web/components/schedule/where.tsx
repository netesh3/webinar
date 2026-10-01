"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { FormGroup, FormSection } from "./chrome";
import type { FormState, SetForm } from "./form-state";

const CHOICES = [
  {
    id: "app" as const,
    title: "This app",
    detail: "People join in Webinar Liv",
  },
  {
    id: "zoom_meeting" as const,
    title: "Zoom meeting",
    detail: "A personal Zoom link",
  },
  {
    id: "zoom_webinar" as const,
    title: "Zoom webinar",
    detail: "Needs the Webinar add-on",
  },
];

/** Where the session runs. LiveKit is the default. Zoom needs this host's connection. */
export function WhereSection({
  form,
  set,
  fields,
}: {
  form: FormState;
  set: SetForm;
  fields: Record<string, string>;
}) {
  const [zoomConnected, setZoomConnected] = useState<boolean | null>(null);

  useEffect(() => {
    let active = true;
    api
      .hostIntegrations()
      .then((res) => {
        if (!active) return;
        const zoom = res.integrations.find((c) => c.id === "zoom");
        setZoomConnected(zoom?.status === "connected");
      })
      .catch(() => {
        if (active) setZoomConnected(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const zoomOff = zoomConnected !== true;

  return (
    <FormGroup label="Where it runs">
      <FormSection
        title="Where people join"
        description="WhatsApp and email still go out either way."
        first
      >
        <div id="where-it-runs" className="grid gap-2 sm:grid-cols-3">
          {CHOICES.map((choice) => {
            const selected = form.venue === choice.id;
            const disabled = choice.id !== "app" && zoomOff;
            return (
              <button
                key={choice.id}
                type="button"
                disabled={disabled}
                aria-pressed={selected}
                onClick={() => set("venue", choice.id)}
                className={`rounded-xl border px-3 py-3 text-left ${
                  selected
                    ? "border-brand bg-brand-soft"
                    : "border-line bg-surface"
                } ${disabled ? "cursor-not-allowed opacity-60" : "hover:border-brand-line"}`}
              >
                <span className="block text-[13.5px] font-semibold text-ink">
                  {choice.title}
                </span>
                <span className="mt-0.5 block text-[12px] leading-snug text-ink-3">
                  {choice.detail}
                </span>
              </button>
            );
          })}
        </div>
        {form.venue !== "app" && (
          <p className="mt-3 text-[12.5px] leading-relaxed text-ink-2">
            People still get your WhatsApp and email. The join link is a
            personal Zoom link. Meetings need a paid Zoom license.
          </p>
        )}
        {zoomOff && (
          <p className="mt-3 text-[12.5px] leading-relaxed text-ink-2">
            <Link href="/settings#integrations" className="font-medium text-brand hover:underline">
              Connect Zoom in Settings
            </Link>{" "}
            to choose a Zoom meeting or webinar.
          </p>
        )}
        {fields.venue && (
          <p className="mt-2 text-[12px] font-medium text-live">{fields.venue}</p>
        )}
      </FormSection>
    </FormGroup>
  );
}
