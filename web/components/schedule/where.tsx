"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { FeatureZoom, type DeliveryPolicy } from "@/lib/api-types";
import { deliveryOffer, EDGE_ONLY_NOTE } from "@/lib/delivery-policy";
import { useSession } from "../providers";
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
  deliveryPolicy,
}: {
  form: FormState;
  set: SetForm;
  fields: Record<string, string>;
  /** GET /api/host/delivery for this webinar, null while it loads. */
  deliveryPolicy: DeliveryPolicy | null;
}) {
  const { account, status } = useSession();
  const zoomAllowed =
    status === "signed-in" && (account?.features ?? []).includes(FeatureZoom);
  const [zoomConnected, setZoomConnected] = useState<boolean | null>(null);

  useEffect(() => {
    if (status === "loading" || zoomAllowed || form.venue === "app") return;
    set("venue", "app");
  }, [status, zoomAllowed, form.venue, set]);

  useEffect(() => {
    if (!zoomAllowed) return;
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
  }, [zoomAllowed]);

  const series = form.kind === "recurring" || form.seriesId !== "";
  // A simulive stays in this app too: the server refuses it a Zoom venue.
  const simulive = form.kind === "simulive";
  const appOnly = series || simulive;
  const choices =
    zoomAllowed && !appOnly ? CHOICES : CHOICES.filter((c) => c.id === "app");
  const zoomOff = zoomAllowed && zoomConnected !== true;
  const offer = deliveryOffer(deliveryPolicy, {
    kind: form.kind,
    venue: appOnly ? "app" : form.venue,
  });

  return (
    <FormGroup label="Where it runs">
      <FormSection
        title="Where people join"
        description={
          series
            ? "A recurring series runs in this app. WhatsApp and email still go out."
            : simulive
              ? "A simulive plays in this app. WhatsApp and email still go out."
              : "WhatsApp and email still go out either way."
        }
        first
      >
        <div
          id="where-it-runs"
          className={`grid gap-2 ${choices.length > 1 ? "sm:grid-cols-3" : ""}`}
        >
          {choices.map((choice) => {
            const selected = appOnly ? choice.id === "app" : form.venue === choice.id;
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
        {zoomAllowed && !appOnly && form.venue !== "app" && (
          <p className="mt-3 text-[12.5px] leading-relaxed text-ink-2">
            People still get your WhatsApp and email. The join link is a
            personal Zoom link. Meetings need a paid Zoom license.
          </p>
        )}
        {zoomOff && !appOnly && (
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
      {offer === "choice" && (
        <DeliverySection form={form} set={set} error={fields.delivery} />
      )}
      {offer === "edge-only" && (
        <FormSection title="Delivery" description={EDGE_ONLY_NOTE}>
          {fields.delivery && (
            <p id="delivery" className="text-[12px] font-medium text-live">{fields.delivery}</p>
          )}
        </FormSection>
      )}
    </FormGroup>
  );
}

const DELIVERY = [
  {
    id: "standard" as const,
    title: "Standard",
    detail: "Everyone joins the video room",
  },
  {
    id: "edge" as const,
    title: "Edge (beta)",
    detail: "Audience watches a low-latency stream",
  },
];

/** Edge delivery (docs/edge-delivery.md): the choice only on a video server that is not GCP
 *  or DigitalOcean (a dev SFU), for a webinar or series in this app. On GCP and DigitalOcean
 *  (production) every webinar is edge and WhereSection shows a note instead. The stage is the
 *  same either way. */
function DeliverySection({
  form,
  set,
  error,
}: {
  form: FormState;
  set: SetForm;
  error?: string;
}) {
  return (
    <FormSection
      title="Delivery"
      description="Edge puts the audience on a stream a few seconds behind, so far more people can watch. You, your panelists and anyone you bring on stage stay live. Chat, Q&A, polls and raised hands work the same."
    >
      <div id="delivery" className="grid gap-2 sm:grid-cols-2">
        {DELIVERY.map((choice) => {
          const selected = form.delivery === choice.id;
          return (
            <button
              key={choice.id}
              type="button"
              aria-pressed={selected}
              onClick={() => set("delivery", choice.id)}
              className={`rounded-xl border px-3 py-3 text-left ${
                selected ? "border-brand bg-brand-soft" : "border-line bg-surface hover:border-brand-line"
              }`}
            >
              <span className="block text-[13.5px] font-semibold text-ink">{choice.title}</span>
              <span className="mt-0.5 block text-[12px] leading-snug text-ink-3">{choice.detail}</span>
            </button>
          );
        })}
      </div>
      {error && <p className="mt-2 text-[12px] font-medium text-live">{error}</p>}
    </FormSection>
  );
}
